"""Collections — the only pages an admin creates from the site itself.

Most pages are one-offs (home, about, contact, legal): their structure is
fixed by the site and admins edit their copy inline. A *collection* is a set
of pages that share ONE reusable structure and are listed from an index page:
blog articles listed on /blog, service pages listed on /services, projects on
/projects. Only collections get "+ New <item>" — on their index page, not
everywhere — and every entry is built from the collection's template, so a
new entry is laid out exactly like its siblings.

Collections are site-specific, configured in SiteSettings.data.collections:

    "collections": {
      "services": {
        "label": "Service", "plural": "Services",
        "hostKind": "content",            # "content" (ContentPage) | "blog" (BlogPost)
        "indexPath": "services",          # listing page that shows "+ New service"
        "pathPrefix": "services",         # entries live at /<pathPrefix>/<slug>
        "pageType": "service",
        "sections": ["hero", "features", "steps", "rich_text", "faq", "cta"],   # the template
        "allowAdd": [],                   # section types an admin may add/move/remove on an entry
        "fields": {                       # extra per-entry fields (blog: excerpt, category...)
          "excerpt": {"label": "Excerpt", "type": "textarea"},
          "category": {"label": "Category", "options": ["VAT", "Tax"]}
        },
        "listingNote": "Link new services from the home Services cards."
      }
    }

A "blog" collection stores entries as BlogPost (one blog per site); "content"
collections store ContentPage rows whose path starts with pathPrefix/.
"""

import copy

from django.utils.text import slugify

from .dynamic_pages import SECTION_SCHEMA, starter_content

HOST_KINDS = ("content", "blog")
MODEL_FIELDS = {"blog": ("excerpt", "author"), "content": ()}


class CollectionError(Exception):
    pass


def _site_data():
    from .models import SiteSettings
    row = SiteSettings.objects.filter(pk=1).first()
    return (row.data if row else {}) or {}


def _clean(key, raw):
    raw = raw if isinstance(raw, dict) else {}
    host_kind = raw.get("hostKind") if raw.get("hostKind") in HOST_KINDS else "content"
    prefix = str(raw.get("pathPrefix") or ("blog" if host_kind == "blog" else key)).strip("/")
    sections = [t for t in (raw.get("sections") or []) if t in SECTION_SCHEMA]
    label = str(raw.get("label") or key.replace("-", " ").title().rstrip("s")).strip()
    return {
        "key": key,
        "label": label,
        "plural": str(raw.get("plural") or f"{label}s").strip(),
        "hostKind": host_kind,
        "indexPath": str(raw.get("indexPath") or prefix).strip("/"),
        "pathPrefix": prefix,
        "pageType": str(raw.get("pageType") or ("article" if host_kind == "blog" else "generic")),
        "sections": sections or ["hero", "rich_text", "cta"],
        "allowAdd": [t for t in (raw.get("allowAdd") or []) if t in SECTION_SCHEMA],
        "fields": raw.get("fields") if isinstance(raw.get("fields"), dict) else {},
        "listingNote": str(raw.get("listingNote") or "").strip(),
    }


def all_collections():
    raw = _site_data().get("collections") or {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): _clean(str(k), v) for k, v in raw.items()}


def get_collection(key):
    found = all_collections().get(key)
    if not found:
        raise CollectionError(f'No collection "{key}" is configured.')
    return found


# --------------------------------------------------------------- entries

def entry_path(cfg, slug):
    return f'{cfg["pathPrefix"]}/{slug}'


def entries_qs(cfg):
    from .models import BlogPost, ContentPage
    if cfg["hostKind"] == "blog":
        return BlogPost.objects.all().order_by("-updated_at")
    return ContentPage.objects.filter(path__startswith=f'{cfg["pathPrefix"]}/').order_by("-updated_at")


def entry_slug(cfg, host):
    if cfg["hostKind"] == "blog":
        return host.slug
    return host.path[len(cfg["pathPrefix"]) + 1:]


def get_entry(cfg, slug):
    from .models import BlogPost, ContentPage
    if cfg["hostKind"] == "blog":
        return BlogPost.objects.filter(slug=slug).first()
    return ContentPage.objects.filter(path=entry_path(cfg, slug)).first()


def serialize_entry(cfg, host):
    slug = entry_slug(cfg, host)
    return {
        "slug": slug,
        "key": host.slug if cfg["hostKind"] == "blog" else host.path,
        "kind": cfg["hostKind"],
        "title": host.title,
        "status": host.status,
        "href": "/" + entry_path(cfg, slug),
        "fields": read_fields(cfg, host),
        "published_at": host.published_at.isoformat() if host.published_at else None,
        "updated_at": host.updated_at.isoformat() if host.updated_at else None,
    }


def unique_slug(cfg, wanted, exclude=None):
    from .models import BlogPost, ContentPage
    base = slugify(wanted or "") or "untitled"
    candidate, n = base, 2
    while True:
        if cfg["hostKind"] == "blog":
            qs = BlogPost.objects.filter(slug=candidate)
        else:
            qs = ContentPage.objects.filter(path=entry_path(cfg, candidate))
        if exclude is not None:
            qs = qs.exclude(pk=exclude.pk)
        if not qs.exists():
            return candidate
        candidate = f"{base}-{n}"
        n += 1


def read_fields(cfg, host):
    out = {}
    for name in cfg["fields"]:
        if name in MODEL_FIELDS[cfg["hostKind"]]:
            out[name] = getattr(host, name, "") or ""
        else:
            out[name] = (host.content or {}).get(name, "") if isinstance(host.content, dict) else ""
    return out


def write_fields(cfg, host, values):
    """Store configured entry fields: model columns where the host has one,
    otherwise inside host.content. Unknown names are ignored."""
    if not isinstance(values, dict):
        return []
    changed = []
    content = dict(host.content or {}) if isinstance(host.content, dict) else {}
    for name, value in values.items():
        spec = cfg["fields"].get(name)
        if spec is None:
            continue
        value = "" if value is None else value
        options = spec.get("options") if isinstance(spec, dict) else None
        if options and value not in options:
            continue
        if name in MODEL_FIELDS[cfg["hostKind"]]:
            setattr(host, name, str(value))
            changed.append(name)
        else:
            content[name] = value
    if content != (host.content or {}):
        host.content = content
        changed.append("content")
    return changed


def reference_sections(cfg, exclude=None):
    """The newest published entry's sections — the style and structure
    model for new entries (None when the collection is empty)."""
    from .section_views import _sections_qs
    for host in entries_qs(cfg).filter(status="published"):
        if exclude is not None and host.pk == exclude.pk:
            continue
        rows = list(_sections_qs(host, published_only=True))
        if rows:
            return [{"type": r.section_type, "content": r.content} for r in rows]
    return None


def reference_image_types(cfg, exclude=None):
    """Section types that carry an uploaded image in the reference entry.
    New entries require images only there, so they render like siblings
    (a hero with no image keeps the no-image layout). None = no reference."""
    from .section_views import _sections_qs
    for host in entries_qs(cfg).filter(status="published"):
        if exclude is not None and host.pk == exclude.pk:
            continue
        rows = list(_sections_qs(host, published_only=True).prefetch_related("media"))
        if rows:
            return {r.section_type for r in rows if any(m.image_id for m in r.media.all())}
    return None


def apply_image_policy(sections, image_types):
    """Make image slots match the reference: required where siblings have an
    image, optional (no forced upload before publish) everywhere else."""
    from .dynamic_pages import PER_ITEM_IMAGE_SECTION_TYPES, SINGLE_IMAGE_SECTION_TYPES
    if image_types is None:
        return sections
    for section in sections:
        section_type = section["section_type"]
        if section_type in image_types:
            continue
        if section_type in SINGLE_IMAGE_SECTION_TYPES:
            section["media"] = [{"slot": "image", "image_prompt": "", "required": False}]
        elif section_type in PER_ITEM_IMAGE_SECTION_TYPES:
            section["media"] = []
            for item in (section.get("content") or {}).get("items") or []:
                if isinstance(item, dict):
                    item.pop("image_required", None)
                    item.pop("image_prompt", None)
    return sections


# --------------------------------------------------------------- template

def _list_len(sections, section_type):
    for s in sections or []:
        if s.get("type") == section_type and isinstance((s.get("content") or {}).get("items"), list):
            return len(s["content"]["items"])
    return 1


def _placeholder(key, sample):
    """Placeholder for a field the sibling uses but the starter lacks."""
    if isinstance(sample, str):
        if key.endswith("href"):
            return sample or "/contact"
        return key.replace("_", " ").capitalize()
    if isinstance(sample, (int, float, bool)):
        return sample
    return copy.deepcopy(sample) if not isinstance(sample, (dict, list)) else type(sample)()


def _shape_like(content, reference_content):
    """Give `content` every key the reference section has (same fields =>
    same rendered layout), including keys inside list items."""
    if not isinstance(reference_content, dict):
        return content
    for key, sample in reference_content.items():
        if key == "items" and isinstance(sample, list) and sample and isinstance(sample[0], dict):
            for item in content.get("items") or []:
                if isinstance(item, dict):
                    for item_key, item_sample in sample[0].items():
                        item.setdefault(item_key, _placeholder(item_key, item_sample))
        elif key not in content or (content[key] == "" and isinstance(sample, str) and sample):
            content[key] = _placeholder(key, sample)
    return content


def blank_sections(cfg, title, reference=None):
    """A new entry's starting sections: the template, with placeholder copy
    and as many list items as the reference entry has (same layout)."""
    out = []
    for index, section_type in enumerate(cfg["sections"]):
        content = starter_content(section_type, items=_list_len(reference, section_type),
                                  heading=title if index == 0 and section_type == "hero" else None)
        ref = next((r for r in (reference or [])[index:index + 1] if r.get("type") == section_type), None) \
            or next((r for r in reference or [] if r.get("type") == section_type), None)
        if ref:
            content = _shape_like(content, ref.get("content"))
        out.append({"section_type": section_type, "order": index, "content": content, "media": []})
    return out


def fit_to_template(cfg, sections, title=""):
    """Force parsed sections ({section_type, content, media}) onto the
    collection's structure. Returns (sections, warnings).

    Fixed template (allowAdd empty): exactly the template's types in order —
    each slot takes the first unused reply section of its type, a missing slot
    gets placeholder content, anything else is dropped.
    Flexible template: reply order is kept for template + allowAdd types,
    other types are dropped, and missing template types are inserted at their
    template position.
    """
    template = cfg["sections"]
    allowed = set(template) | set(cfg["allowAdd"])
    warnings = []
    incoming = list(sections or [])

    if not cfg["allowAdd"]:
        used = [False] * len(incoming)
        out = []
        for index, section_type in enumerate(template):
            match = next((i for i, s in enumerate(incoming) if not used[i] and s["section_type"] == section_type), None)
            if match is None:
                warnings.append(f'Section {index + 1} ("{section_type}") was missing from the reply — added with placeholder text.')
                out.append({"section_type": section_type,
                            "content": starter_content(section_type, heading=title if index == 0 and section_type == "hero" else None),
                            "media": []})
            else:
                used[match] = True
                out.append(copy.deepcopy(incoming[match]))
        dropped = [s["section_type"] for i, s in enumerate(incoming) if not used[i]]
        if dropped:
            warnings.append(f"Dropped section(s) that are not part of the template: {', '.join(dropped)}.")
    else:
        out = [copy.deepcopy(s) for s in incoming if s["section_type"] in allowed]
        dropped = [s["section_type"] for s in incoming if s["section_type"] not in allowed]
        if dropped:
            warnings.append(f"Dropped section type(s) this collection does not use: {', '.join(dropped)}.")
        present = [s["section_type"] for s in out]
        for index, section_type in enumerate(template):
            if section_type not in present:
                warnings.append(f'"{section_type}" was missing from the reply — added with placeholder text.')
                out.insert(min(index, len(out)), {"section_type": section_type,
                                                  "content": starter_content(section_type), "media": []})
                present.insert(min(index, len(present)), section_type)

    for order, section in enumerate(out):
        section["order"] = order
    return out, warnings


def collection_for_path(path):
    """(collection, role) for a site path: role is "index" or "entry"."""
    clean = str(path or "").strip("/")
    for cfg in all_collections().values():
        if clean == cfg["indexPath"]:
            return cfg, "index"
        if clean.startswith(cfg["pathPrefix"] + "/") and clean.count("/") == cfg["pathPrefix"].count("/") + 1:
            return cfg, "entry"
    return None, None
