"""Where is an uploaded image used?

Images are referenced by URL inside JSON blobs (component content, drafts,
page SEO, site settings, blog content, dynamic sections) and by FK from
SectionMedia. This scans all of them, so "unused" really means unused and
deleting an image that a live page shows is refused (unless forced).
"""

import json
import re

_NAME = re.compile(r"uploaded_images/[^\"'\s?#)\\]+")


def _blobs():
    from .models import BlogPost, ComponentData, DynamicSection, PageSEO, SiteSettings
    for c in ComponentData.objects.only("name", "data", "draft_data"):
        yield f"content block “{c.name}”", c.data
        yield f"draft of “{c.name}”", c.draft_data
    for p in PageSEO.objects.only("path", "data"):
        yield f"SEO for /{p.path}", p.data
    for s in SiteSettings.objects.all():
        yield "site settings", s.data
    for b in BlogPost.objects.only("slug", "content", "og_image"):
        yield f"blog post “{b.slug}”", {"content": b.content, "og": b.og_image}
    for d in DynamicSection.objects.only("id", "section_type", "content", "draft_content"):
        yield f"{d.section_type} section #{d.id}", {"c": d.content, "d": d.draft_content}


def referenced_names():
    """{file name: [where, ...]} for every image referenced anywhere."""
    from .models import SectionMedia
    refs = {}
    for where, blob in _blobs():
        if not blob:
            continue
        for name in set(_NAME.findall(json.dumps(blob))):
            refs.setdefault(name, []).append(where)
    for m in SectionMedia.objects.filter(image__isnull=False).select_related("section", "image"):
        refs.setdefault(m.image.image.name, []).append(f"{m.section.section_type} section #{m.section_id} ({m.slot})")
    return refs


def usage_for(image):
    return referenced_names().get(image.image.name, [])
