"""Keep related rows in step when a page goes away.

Deleting a ContentPage or BlogPost also deletes its PageSEO row (otherwise the
orphan keeps showing in the SEO list, audits and launch checks), and any
SectionMedia/DynamicSection rows hanging off it.
"""

from django.db.models.signals import post_delete


def _delete_seo(sender, instance, **kwargs):
    from .models import BlogPost, DynamicSection, PageSEO
    from django.contrib.contenttypes.models import ContentType
    if isinstance(instance, BlogPost):
        paths = [f"blog/{instance.slug}"]
    else:
        paths = {p for p in (instance.path, getattr(instance, "seo_path", "")) if p}
    PageSEO.objects.filter(path__in=list(paths)).delete()
    DynamicSection.objects.filter(content_type=ContentType.objects.get_for_model(type(instance)),
                                  object_id=instance.pk).delete()


def connect():
    from .models import BlogPost, ContentPage
    post_delete.connect(_delete_seo, sender=ContentPage, dispatch_uid="cleanup-contentpage")
    post_delete.connect(_delete_seo, sender=BlogPost, dispatch_uid="cleanup-blogpost")
