"""robots.txt + sitemap.xml, built from SiteSettings and a pluggable
content-source registry.

A cloned project adds its own URL sets (products, services, locations…) by
setting ``SITEMAP_SOURCES`` in settings to a list of "dotted.path:callable"
strings. Each callable takes no args and returns an iterable of dicts:

    {"path": "products/widget", "changefreq": "weekly",
     "priority": 0.7, "lastmod": "2026-08-01"}

``pages`` and ``blog`` are always registered, plus ``extra``: paths listed
in SiteSettings.data.sitemap.extraPaths (routes that exist only in the
frontend code, e.g. "about", "contact").

Admins fine-tune any URL from any source with
SiteSettings.data.sitemap.overrides = {"<path>": {"include", "priority",
"changefreq"}}. GET api/sitemap/report/ lists every URL, included or not,
with its source and effective settings (admin).
"""

from datetime import datetime
from importlib import import_module
from xml.sax.saxutils import escape

from django.conf import settings
from django.http import HttpResponse
from django.utils import timezone


# --------------------------------------------------------------- builtin sources

def _pages_source():
    from .models import PageSEO

    for row in PageSEO.objects.all():
        data = row.data or {}
        sm = data.get("sitemap") or {}
        if sm.get("include", True) is False:
            continue
        robots = data.get("robots") or {}
        if robots.get("index") is False:
            continue
        yield {
            "path": row.path,
            "changefreq": sm.get("changefreq", "weekly"),
            "priority": sm.get("priority", 0.7),
            "lastmod": sm.get("lastmod") or row.updated_at.date().isoformat(),
        }


def _blog_source():
    from .models import BlogPost

    qs = BlogPost.objects.filter(status="published",
                                 published_at__lte=timezone.now())
    for post in qs:
        yield {
            "path": f"blog/{post.slug}",
            "changefreq": "weekly",
            "priority": 0.6,
            "lastmod": (post.updated_at or post.published_at).date().isoformat(),
        }


def _extra_source():
    sitemap_cfg = _site_data().get("sitemap") or {}
    for path in sitemap_cfg.get("extraPaths") or []:
        if isinstance(path, str):
            yield {"path": path.strip("/"), "changefreq": "monthly", "priority": 0.7}


BUILTIN_SOURCES = {"pages": _pages_source, "blog": _blog_source, "extra": _extra_source}


def _normal(path):
    clean = str(path or "").strip("/")
    return "" if clean == "home" else clean


def all_entries(include_excluded=False):
    """Every URL from every source, de-duplicated (first source wins), with
    admin overrides applied. Excluded entries are kept only on request."""
    cfg = _site_data().get("sitemap") or {}
    overrides = {_normal(k): v for k, v in (cfg.get("overrides") or {}).items() if isinstance(v, dict)}
    seen = set()
    for name, fn in get_sources().items():
        for entry in fn():
            path = _normal(entry.get("path"))
            if path in seen:
                continue
            seen.add(path)
            item = {**entry, "path": path, "source": name, "included": True, "overridden": False}
            override = overrides.get(path)
            if override:
                item["overridden"] = True
                for key in ("priority", "changefreq"):
                    if override.get(key) not in (None, ""):
                        item[key] = override[key]
                if override.get("include") is False:
                    item["included"] = False
            if item["included"] or include_excluded:
                yield item


def get_sources():
    sources = dict(BUILTIN_SOURCES)
    for spec in getattr(settings, "SITEMAP_SOURCES", []) or []:
        try:
            mod_path, attr = spec.split(":")
            fn = getattr(import_module(mod_path), attr)
            sources[attr] = fn
        except (ValueError, ImportError, AttributeError):
            continue
    return sources


# --------------------------------------------------------------- rendering

def _base_url(request):
    row = _site_data()
    seo = row.get("seoDefaults") or {}
    return (seo.get("siteUrl") or row.get("siteUrl")
            or request.build_absolute_uri("/")).rstrip("/")


def _site_data():
    from .models import SiteSettings

    row = SiteSettings.objects.filter(pk=1).first()
    return (row.data if row else {}) or {}


def _url_xml(base, entry):
    loc = f"{base}/{entry['path'].strip('/')}" if entry["path"].strip("/") else base
    parts = [f"<loc>{escape(loc)}</loc>"]
    if entry.get("lastmod"):
        parts.append(f"<lastmod>{escape(str(entry['lastmod']))}</lastmod>")
    if entry.get("changefreq"):
        parts.append(f"<changefreq>{escape(str(entry['changefreq']))}</changefreq>")
    if entry.get("priority") is not None:
        parts.append(f"<priority>{float(entry['priority']):.1f}</priority>")
    return "<url>" + "".join(parts) + "</url>"


def sitemap_index(request):
    base = _base_url(request)
    names = list(get_sources().keys())
    body = ['<?xml version="1.0" encoding="UTF-8"?>',
            '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for name in names:
        body.append(f"<sitemap><loc>{escape(base)}/sitemap-{name}.xml</loc>"
                    f"<lastmod>{datetime.utcnow().date().isoformat()}</lastmod></sitemap>")
    body.append("</sitemapindex>")
    return HttpResponse("\n".join(body), content_type="application/xml")


def sitemap_section(request, section):
    sources = get_sources()
    fn = sources.get(section)
    if fn is None:
        return HttpResponse(status=404)
    base = _base_url(request)
    body = ['<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for entry in all_entries():
        if entry["source"] == section:
            body.append(_url_xml(base, entry))
    body.append("</urlset>")
    return HttpResponse("\n".join(body), content_type="application/xml")


def sitemap_all(request):
    """Flat sitemap.xml combining every source (small sites). The index at
    /sitemap-index.xml is preferred once a section exceeds 50k URLs."""
    base = _base_url(request)
    body = ['<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for entry in all_entries():
        body.append(_url_xml(base, entry))
    body.append("</urlset>")
    return HttpResponse("\n".join(body), content_type="application/xml")


def robots_txt(request):
    data = _site_data()
    base = _base_url(request)
    robots_cfg = data.get("robotsTxt") or {}
    seo_robots = (data.get("seoDefaults") or {}).get("robots") or {}

    lines = ["User-agent: *"]
    disallow = robots_cfg.get("disallow")
    if disallow is None:
        disallow = ["/api/", "/admin/"]
    for rule in disallow:
        lines.append(f"Disallow: {rule}")
    for rule in robots_cfg.get("allow", []):
        lines.append(f"Allow: {rule}")

    # A site-wide noindex default turns robots.txt into a full block (useful
    # for staging). Only when explicitly set.
    if seo_robots.get("index") is False:
        lines = ["User-agent: *", "Disallow: /"]

    lines.append("")
    lines.append(f"Sitemap: {base}/sitemap.xml")
    return HttpResponse("\n".join(lines), content_type="text/plain")


# --------------------------------------------------------------- admin report

from rest_framework.permissions import IsAdminUser  # noqa: E402
from rest_framework.response import Response  # noqa: E402
from rest_framework.views import APIView  # noqa: E402


class SitemapReportView(APIView):
    """GET sitemap/report/ — every URL the sitemap knows about (included or
    excluded), its source and effective priority/changefreq. Edit with
    PATCH settings/site/ {"sitemap": {"overrides": {...}, "extraPaths": [...]}}."""
    permission_classes = [IsAdminUser]

    def get(self, request):
        rows = list(all_entries(include_excluded=True))
        return Response({
            "entries": rows,
            "included": sum(1 for r in rows if r["included"]),
            "sources": list(get_sources().keys()),
        })
