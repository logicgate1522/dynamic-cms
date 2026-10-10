import os

from django.contrib.auth.models import AbstractUser
from django.contrib.contenttypes.fields import GenericForeignKey, GenericRelation
from django.contrib.contenttypes.models import ContentType
from django.db import models
from django.utils import timezone
from django.utils.text import slugify

from .utils import build_unique_slug


class CustomUser(AbstractUser):
    """
    The project's user model. Lives in `api` so the entire backend —
    content, SEO, blog, forms, images, and auth — is one self-contained
    Django app. `IsAdminUser` (is_staff) is the only thing every admin-gated
    endpoint in this app checks; nothing else about this model is special.
    """
    phone_number = models.CharField(max_length=20, blank=True, null=True)


class ComponentData(models.Model):
    """Generic named JSON blob backing inline-editable page/component content.

    `data` is the live/published payload the public GET returns — a plain
    PATCH (no ?mode=draft) writes it directly, identical to the original
    contract. `draft_data` is the editor's working copy, written by
    PATCH ?mode=draft; POST home/<name>/publish/ copies draft_data -> data.
    """
    STATUS_CHOICES = [("draft", "Draft"), ("published", "Published")]

    name = models.CharField(max_length=255, unique=True)
    data = models.JSONField(default=dict)
    draft_data = models.JSONField(default=dict, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="published")
    schema_key = models.CharField(max_length=100, blank=True)
    updated_by = models.ForeignKey(
        "CustomUser", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="+",
    )
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name


class ComponentRevision(models.Model):
    """Immutable snapshot of a ComponentData payload, written on every admin
    PATCH / publish / revert. Revert restores one as a *new* revision."""
    component = models.ForeignKey(
        ComponentData, on_delete=models.CASCADE, related_name="revisions"
    )
    data = models.JSONField(default=dict)
    saved_by = models.ForeignKey(
        "CustomUser", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    note = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.component.name} @ {self.created_at:%Y-%m-%d %H:%M}"


class ComponentSchema(models.Model):
    """A reusable field contract for a class of component (hero, cards, faq…).

    Powers the AI prompt generator, optional server-side PATCH validation
    (when a ComponentData row sets `schema_key`), and the frontend
    "what is editable" discovery endpoint GET home/schemas/.
    """
    key = models.CharField(max_length=100, unique=True)
    label = models.CharField(max_length=255, blank=True)
    schema = models.JSONField(default=dict)
    builtin = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["key"]

    def __str__(self):
        return self.key


class UploadedImage(models.Model):
    category = models.CharField(max_length=255)
    image = models.FileField(upload_to="uploaded_images/")
    uploaded_at = models.DateTimeField(auto_now_add=True)

    # Image SEO metadata
    alt_text = models.CharField(max_length=255, blank=True)
    title = models.CharField(max_length=255, blank=True)
    caption = models.CharField(max_length=500, blank=True)
    description = models.TextField(blank=True)
    credit = models.CharField(max_length=255, blank=True)
    license = models.CharField(max_length=255, blank=True)

    # Technical metadata (filled on save)
    width = models.PositiveIntegerField(null=True, blank=True)
    height = models.PositiveIntegerField(null=True, blank=True)
    file_size = models.PositiveIntegerField(null=True, blank=True)
    mime_type = models.CharField(max_length=100, blank=True)
    format = models.CharField(max_length=20, blank=True)
    checksum = models.CharField(max_length=64, blank=True, db_index=True)

    # Art-directed cropping focal point (0..1)
    focal_x = models.FloatField(default=0.5)
    focal_y = models.FloatField(default=0.5)

    # Best-effort back-references: [{"type": "...", "ref": "..."}]
    usage = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ["-uploaded_at"]

    def __str__(self):
        return f"{self.image.name} - {self.category}"

    def _seo_stem(self):
        """Priority chain: alt -> title -> category+rand -> original stem -> random."""
        import secrets
        stem, _ = os.path.splitext(os.path.basename(self.image.name or ""))
        for candidate in (self.alt_text, self.title):
            if candidate and candidate.strip():
                return slugify(candidate)[:100]
        if self.category:
            return f"{slugify(self.category)[:80]}-{secrets.token_hex(3)}"
        if stem:
            return slugify(stem)[:100] or secrets.token_hex(6)
        return secrets.token_hex(6)

    def save(self, *args, **kwargs):
        name = self.image.name or ""
        # Only slugify + fingerprint a *newly uploaded* file. A metadata-only
        # update (e.g. PATCH alt_text) must never rewrite image.name — the
        # file on disk isn't moved, so that would dangle the reference.
        is_new_file = bool(name) and not name.startswith("uploaded_images/")
        if is_new_file:
            _, ext = os.path.splitext(name)
            ext = ext.lower() or ".jpg"
            f = getattr(self.image, "file", None)
            if f is not None:
                # Checksum the ORIGINAL bytes so re-uploading the same file
                # still dedupes after it has been re-encoded below.
                self._fill_metadata(f)
                original_checksum = self.checksum
                ext = self._optimize(f, ext)
                self._fill_metadata(self.image.file)
                self.checksum = original_checksum
            self.image.name = f"uploaded_images/{self._seo_stem()}{ext}"

        super().save(*args, **kwargs)

    def _optimize(self, f, ext):
        """Re-encode a new raster upload to WebP (smaller, capped at
        IMAGE_OPTIMIZE_MAX_DIMENSION) when that actually saves bytes.
        Returns the extension to use. Off with IMAGE_OPTIMIZE=False."""
        from django.conf import settings
        from django.core.files.base import ContentFile

        from .image_optimize import optimize_to_webp

        if not getattr(settings, "IMAGE_OPTIMIZE", True):
            return ext
        try:
            f.seek(0)
            raw = f.read()
        except (OSError, AttributeError):
            return ext
        result = optimize_to_webp(raw, ext)
        if result is None:
            try:
                f.seek(0)
            except OSError:
                pass
            return ext
        webp_bytes, new_ext = result
        self.image.file = ContentFile(webp_bytes)
        return new_ext

    def _fill_metadata(self, f):
        import hashlib
        try:
            pos = f.tell()
        except (OSError, AttributeError):
            pos = None
        try:
            f.seek(0)
            raw = f.read()
        except OSError:
            raw = b""
        finally:
            if pos is not None:
                try:
                    f.seek(pos)
                except OSError:
                    pass
        if raw:
            self.checksum = hashlib.sha256(raw).hexdigest()
            self.file_size = len(raw)
        try:
            from PIL import Image
            import io
            with Image.open(io.BytesIO(raw)) as img:
                self.width, self.height = img.size
                self.format = (img.format or "").upper()
                self.mime_type = Image.MIME.get(img.format, "")
        except Exception:
            pass


class SiteSettings(models.Model):
    """Singleton row holding site-wide identity, default SEO, and injected scripts."""
    data = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def __str__(self):
        return "Site settings"


class PageSEO(models.Model):
    """Per-page SEO metadata, keyed by the page's path (e.g. 'home', 'about', 'services/x')."""
    path = models.CharField(max_length=255, unique=True)  # e.g. "home", "about", "services/web-development"
    data = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["path"]

    def __str__(self):
        return self.path


class SEOAuditResult(models.Model):
    """Persisted result of one seo_analyzer.analyze_page run."""
    page = models.ForeignKey(PageSEO, on_delete=models.CASCADE, related_name="audits")
    score = models.IntegerField(default=0)
    technical_score = models.IntegerField(default=0)
    content_score = models.IntegerField(default=0)
    metadata_score = models.IntegerField(default=0)
    schema_score = models.IntegerField(default=0)
    issues = models.JSONField(default=list)
    checks = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class SEOChangeHistory(models.Model):
    """Old->new snapshot of a PageSEO.data on every admin PATCH. Revert
    restores an old_data as a new PATCH (non-destructive)."""
    page = models.ForeignKey(PageSEO, on_delete=models.CASCADE, related_name="history")
    changed_by = models.ForeignKey(
        "CustomUser", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    old_data = models.JSONField(default=dict)
    new_data = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class BlogPost(models.Model):
    STATUS_CHOICES = [
        ("draft", "Draft"),
        ("published", "Published"),
    ]

    slug = models.SlugField(max_length=255, unique=True, blank=True)
    title = models.CharField(max_length=255)
    excerpt = models.TextField(blank=True)
    content = models.JSONField(default=dict)  # {"coverImage": "", "coverImageAlt": "", "sections": [...]}
    author = models.CharField(max_length=120, blank=True)
    seo_title = models.CharField(max_length=255, blank=True)
    meta_description = models.CharField(max_length=300, blank=True)
    og_image = models.CharField(max_length=500, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="draft")
    published_at = models.DateTimeField(null=True, blank=True)
    # "legacy" = content.sections blob (existing posts). "dynamic" = real
    # DynamicSection rows drive the render.
    body_mode = models.CharField(
        max_length=10, choices=[("legacy", "Legacy"), ("dynamic", "Dynamic")],
        default="legacy",
    )
    updated_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    dynamic_sections = GenericRelation("DynamicSection")

    class Meta:
        ordering = ["-published_at", "-created_at"]

    def save(self, *args, **kwargs):
        # Flipping status to "published" without an explicit date means
        # "publish now" — set it here so the public queryset's
        # published_at__lte=now filter doesn't hide the post indefinitely.
        if self.status == "published" and self.published_at is None:
            self.published_at = timezone.now()
        if not self.slug:
            self.slug = build_unique_slug(BlogPost, self.title, instance_pk=self.pk)
        super().save(*args, **kwargs)

    def __str__(self):
        return self.title


class ContentPage(models.Model):
    """Generic host for dynamic (section-built) or legacy (blob) page content.

    Complements BlogPost — articles stay on BlogPost, everything else
    (landing, service, product, generic…) lives here. Both share the
    DynamicSection / SectionMedia models via a generic relation.
    """
    STATUS_CHOICES = [("draft", "Draft"), ("published", "Published")]
    BODY_MODES = [("legacy", "Legacy"), ("dynamic", "Dynamic")]

    path = models.CharField(max_length=255, unique=True)
    title = models.CharField(max_length=255)
    page_type = models.CharField(max_length=50, default="generic")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="draft")
    published_at = models.DateTimeField(null=True, blank=True)
    seo_path = models.CharField(max_length=255, blank=True)
    body_mode = models.CharField(max_length=10, choices=BODY_MODES, default="dynamic")
    content = models.JSONField(default=dict, blank=True)  # legacy-mode blob
    updated_by = models.ForeignKey(
        "CustomUser", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    updated_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    sections = GenericRelation("DynamicSection")

    class Meta:
        ordering = ["path"]

    def save(self, *args, **kwargs):
        if self.status == "published" and self.published_at is None:
            self.published_at = timezone.now()
        if not self.seo_path:
            self.seo_path = self.path
        super().save(*args, **kwargs)

    def __str__(self):
        return self.path


class DynamicSection(models.Model):
    """One ordered, typed section attached (via generic FK) to a ContentPage
    or a BlogPost. Validity of `section_type` and `content` is enforced by
    dynamic_pages.parse_and_validate / the serializer, not the DB."""
    STATUS_CHOICES = [("draft", "Draft"), ("published", "Published")]

    content_type = models.ForeignKey(ContentType, on_delete=models.CASCADE)
    object_id = models.PositiveIntegerField()
    host = GenericForeignKey("content_type", "object_id")

    section_type = models.CharField(max_length=40)
    order = models.PositiveIntegerField(default=0)
    content = models.JSONField(default=dict)
    # Unpublished edit of `content` (PATCH ?mode=draft). Public reads always
    # get `content`; POST drafts/publish/ copies this over and clears it.
    draft_content = models.JSONField(null=True, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="published")

    class Meta:
        ordering = ["content_type", "object_id", "order"]
        indexes = [models.Index(fields=["content_type", "object_id", "order"])]

    def __str__(self):
        return f"{self.section_type} #{self.order}"


class SectionMedia(models.Model):
    """A named image slot inside a section (image, items[0].image, …)."""
    section = models.ForeignKey(DynamicSection, on_delete=models.CASCADE, related_name="media")
    slot = models.CharField(max_length=100, default="image")
    image = models.ForeignKey(
        UploadedImage, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    image_prompt = models.TextField(blank=True)
    alt_override = models.CharField(max_length=255, blank=True)
    required = models.BooleanField(default=False)

    class Meta:
        unique_together = ["section", "slot"]

    def __str__(self):
        return f"{self.section_id}:{self.slot}"


class Redirect(models.Model):
    STATUS_CHOICES = [(301, "301 Moved Permanently"), (302, "302 Found"),
                      (307, "307 Temporary Redirect"), (308, "308 Permanent Redirect")]

    source = models.CharField(max_length=500, unique=True)
    destination = models.CharField(max_length=500)
    permanent = models.BooleanField(default=True)
    status_code = models.PositiveSmallIntegerField(choices=STATUS_CHOICES, null=True, blank=True)
    is_active = models.BooleanField(default=True)
    hit_count = models.PositiveIntegerField(default=0)
    last_hit_at = models.DateTimeField(null=True, blank=True)
    notes = models.CharField(max_length=500, blank=True)
    created_by = models.ForeignKey(
        "CustomUser", null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True, null=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["source"]

    @property
    def effective_status(self):
        return self.status_code or (301 if self.permanent else 302)

    def __str__(self):
        return f"{self.source} -> {self.destination}"


class FormSubmission(models.Model):
    """A single submission of a named form (e.g. 'booking', 'contact')."""
    form_name = models.CharField(max_length=100)
    data = models.JSONField(default=dict)
    is_read = models.BooleanField(default=False)
    is_spam = models.BooleanField(default=False)
    ip_hash = models.CharField(max_length=64, blank=True)
    user_agent = models.CharField(max_length=400, blank=True)
    referer = models.CharField(max_length=500, blank=True)
    # Tracking (R31): the visitor's intent profile and the lead's event id,
    # sent by the kit's submitForm() as `_cms` and never part of `data`.
    event_id = models.CharField(max_length=64, blank=True, db_index=True)
    profile = models.JSONField(default=dict, blank=True)
    consent = models.JSONField(default=dict, blank=True)
    is_test = models.BooleanField(default=False, db_index=True)
    country = models.CharField(max_length=2, blank=True)
    region = models.CharField(max_length=100, blank=True)
    city = models.CharField(max_length=100, blank=True)
    contact = models.ForeignKey("Contact", null=True, blank=True, on_delete=models.SET_NULL, related_name="submissions")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.form_name} submission #{self.pk}"


# ==================== TRACKING (R31–R33) ====================
# See TRACKING_IMPLEMENTATION_PLAN.md. The plan itself lives in
# SiteSettings.data.analytics.plan; these models hold state around it.

class TrackingScan(models.Model):
    """What the site looks like to a visitor (pages, blocks, CTAs, forms,
    FAQs), collected by the admin's browser or the headless runner. Singleton
    (pk=1). Combined with DB facts in site_facts.py."""
    data = models.JSONField(default=dict)
    scanned_at = models.DateTimeField(null=True, blank=True)
    source = models.CharField(max_length=20, blank=True)  # browser | headless


class TrackingJob(models.Model):
    """Work for `manage.py tracking_worker` (a separate process, so the
    request→worker handoff must be in the database, not the cache)."""
    kind = models.CharField(max_length=20)  # sync|verify|audience_sync|contact_purge
    payload = models.JSONField(default=dict, blank=True)
    status = models.CharField(max_length=20, default="pending", db_index=True)  # pending|running|done|error
    result = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at"]


class TrackingConnection(models.Model):
    TOOLS = [(t, t) for t in ("google", "meta", "tiktok", "linkedin", "google_ads")]
    tool = models.CharField(max_length=20, choices=TOOLS, unique=True)
    status = models.CharField(max_length=20, default="not_connected")  # not_connected|connected|error|needs_reauth
    account = models.JSONField(default=dict, blank=True)   # non-secret ids (pixel, ad account, property…)
    secret = models.TextField(blank=True)                  # Fernet-encrypted JSON; never serialised
    secret_hint = models.CharField(max_length=12, blank=True)
    connected_at = models.DateTimeField(null=True, blank=True)
    last_ok_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True)


class TrackingSyncItem(models.Model):
    """One plan item as it exists in one tool (the CMS only manages what it created)."""
    tool = models.CharField(max_length=20)
    kind = models.CharField(max_length=40)
    plan_id = models.CharField(max_length=60)
    remote_id = models.CharField(max_length=200, blank=True)
    desired_hash = models.CharField(max_length=64, blank=True)
    remote_hash = models.CharField(max_length=64, blank=True)
    status = models.CharField(max_length=20, default="pending")  # pending|in_sync|failed|refused|orphaned|manual|drifted|unmanaged
    error = models.TextField(blank=True)
    detail = models.JSONField(default=dict, blank=True)
    synced_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = [("tool", "kind", "plan_id")]


class EventOutbox(models.Model):
    """Server-side copies of events, delivered to each tool with retries."""
    event_id = models.CharField(max_length=64)
    name = models.CharField(max_length=60)
    params = models.JSONField(default=dict)
    consent = models.JSONField(default=dict)
    identifiers = models.JSONField(default=dict)   # hashed only
    context = models.JSONField(default=dict)       # url, ua, ip, click ids, client ids
    tools_pending = models.JSONField(default=list)
    results = models.JSONField(default=dict)       # tool -> {ok, status, detail, at}
    attempts = models.IntegerField(default=0)
    next_at = models.DateTimeField(default=timezone.now, db_index=True)
    status = models.CharField(max_length=20, default="pending", db_index=True)  # pending|done|dead|skipped
    locked_until = models.DateTimeField(null=True, blank=True)
    is_test = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        unique_together = [("event_id", "name")]


class TrackingDaily(models.Model):
    """Aggregate counts only (no visitor data): powers "last seen" and anomaly alerts."""
    date = models.DateField()
    name = models.CharField(max_length=60)
    conversion_id = models.CharField(max_length=60, blank=True)
    intent = models.CharField(max_length=60, blank=True)
    count = models.IntegerField(default=0)
    test_count = models.IntegerField(default=0)
    last_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = [("date", "name", "conversion_id", "intent")]


class VerificationRun(models.Model):
    trigger = models.CharField(max_length=20, default="manual")  # manual|publish|deploy|schedule
    mode = models.CharField(max_length=20, default="in_browser")  # in_browser|headless|static
    status = models.CharField(max_length=20, default="pending")  # pending|running|passed|failed|error
    scope = models.JSONField(default=list, blank=True)           # conversion ids ([] = all)
    tests = models.JSONField(default=list, blank=True)           # compiled steps
    summary = models.JSONField(default=dict, blank=True)
    nonce = models.CharField(max_length=64, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]


class VerificationResult(models.Model):
    run = models.ForeignKey(VerificationRun, on_delete=models.CASCADE, related_name="results")
    conversion_id = models.CharField(max_length=60)
    tool = models.CharField(max_length=20, blank=True)
    step = models.CharField(max_length=20)  # trigger|sent|received
    status = models.CharField(max_length=20)  # ok|fail|skipped|blocked|inactive|warn
    detail = models.TextField(blank=True)
    evidence = models.JSONField(default=dict, blank=True)


class TrackingAlert(models.Model):
    key = models.CharField(max_length=120, unique=True)
    level = models.CharField(max_length=10, default="warning")
    message = models.TextField()
    opened_at = models.DateTimeField(auto_now_add=True)
    notified_at = models.DateTimeField(null=True, blank=True)
    resolved_at = models.DateTimeField(null=True, blank=True)


class Contact(models.Model):
    """A person who contacted the business (R33). Admin-only; never public."""
    email_norm = models.CharField(max_length=254, blank=True, db_index=True)
    phone_e164 = models.CharField(max_length=20, blank=True, db_index=True)
    name = models.CharField(max_length=200, blank=True)
    name_locked = models.BooleanField(default=False)
    status = models.CharField(max_length=40, default="new")
    status_history = models.JSONField(default=list, blank=True)
    notes = models.JSONField(default=list, blank=True)
    tags = models.JSONField(default=list, blank=True)
    marketing_opt_in = models.BooleanField(default=False)
    opt_in_at = models.DateTimeField(null=True, blank=True)
    opt_in_source = models.JSONField(default=dict, blank=True)
    country = models.CharField(max_length=2, blank=True)
    region = models.CharField(max_length=100, blank=True)
    city = models.CharField(max_length=100, blank=True)
    first_source = models.JSONField(default=dict, blank=True)
    last_source = models.JSONField(default=dict, blank=True)
    intents = models.JSONField(default=dict, blank=True)
    segment = models.CharField(max_length=60, blank=True)
    stages = models.JSONField(default=list, blank=True)
    answers = models.JSONField(default=dict, blank=True)  # latest non-free-text form answers
    value = models.FloatField(default=0)
    visits = models.IntegerField(default=0)
    vid = models.CharField(max_length=64, blank=True, db_index=True)
    is_client = models.BooleanField(default=False)
    first_seen = models.DateTimeField(default=timezone.now)
    last_seen = models.DateTimeField(default=timezone.now)
    retain_until = models.DateTimeField(null=True, blank=True)
    merge_suggestions = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-last_seen"]


class ContactEvent(models.Model):
    contact = models.ForeignKey(Contact, on_delete=models.CASCADE, related_name="events")
    at = models.DateTimeField(default=timezone.now)
    name = models.CharField(max_length=60)
    params = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-at"]


class ContactGroup(models.Model):
    key = models.CharField(max_length=60, unique=True)
    label = models.CharField(max_length=100)
    kind = models.CharField(max_length=10, default="custom")  # auto|custom
    rule = models.JSONField(default=dict, blank=True)
    sync_to = models.JSONField(default=list, blank=True)
    remote = models.JSONField(default=dict, blank=True)      # tool -> {id, size, synced_at, error}
    created_at = models.DateTimeField(auto_now_add=True)


class ErasureTombstone(models.Model):
    """Hash of an erased contact's identifiers: blocks re-creation from
    in-flight events for 30 days (never the identifiers themselves)."""
    key_hash = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)


class ConsentLog(models.Model):
    visitor_hash = models.CharField(max_length=64)
    choice = models.JSONField(default=dict)
    banner_version = models.CharField(max_length=20, blank=True)
    at = models.DateTimeField(auto_now_add=True)


class AdminAuditLog(models.Model):
    user = models.CharField(max_length=150)
    action = models.CharField(max_length=40)
    target = models.CharField(max_length=200, blank=True)
    detail = models.JSONField(default=dict, blank=True)
    at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-at"]
