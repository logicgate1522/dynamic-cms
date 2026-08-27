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

    class Meta:
        ordering = ["-uploaded_at"]

    def __str__(self):
        return f"{self.image.name} - {self.category}"

    def save(self, *args, **kwargs):
        base_filename, ext = os.path.splitext(self.image.name)
        max_filename_length = 100

        if len(base_filename) > max_filename_length:
            base_filename = base_filename[:max_filename_length]

        new_filename = f"{slugify(base_filename)}{ext}"
        self.image.name = f"uploaded_images/{new_filename}"

        super().save(*args, **kwargs)


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
    source = models.CharField(max_length=500, unique=True)
    destination = models.CharField(max_length=500)
    permanent = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["source"]

    def __str__(self):
        return f"{self.source} -> {self.destination}"


class FormSubmission(models.Model):
    """A single submission of a named form (e.g. 'booking', 'contact')."""
    form_name = models.CharField(max_length=100)
    data = models.JSONField(default=dict)
    is_read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.form_name} submission #{self.pk}"
