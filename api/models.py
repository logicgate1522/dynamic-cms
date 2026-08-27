import os

from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone
from django.utils.text import slugify


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

    slug = models.SlugField(max_length=255, unique=True)
    title = models.CharField(max_length=255)
    excerpt = models.TextField(blank=True)
    content = models.JSONField(default=dict)  # {"coverImage": "", "coverImageAlt": "", "sections": [...]}
    author = models.CharField(max_length=120, blank=True)
    seo_title = models.CharField(max_length=255, blank=True)
    meta_description = models.CharField(max_length=300, blank=True)
    og_image = models.CharField(max_length=500, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="draft")
    published_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-published_at", "-created_at"]

    def save(self, *args, **kwargs):
        # Flipping status to "published" without an explicit date means
        # "publish now" — set it here so the public queryset's
        # published_at__lte=now filter doesn't hide the post indefinitely.
        if self.status == "published" and self.published_at is None:
            self.published_at = timezone.now()
        super().save(*args, **kwargs)

    def __str__(self):
        return self.title


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
