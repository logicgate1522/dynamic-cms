"""robots.txt + sitemap.xml, built from SiteSettings and a pluggable
content-source registry.

A cloned project adds its own URL sets (products, services, locations…) by
setting ``SITEMAP_SOURCES`` in settings to a list of "dotted.path:callable"
strings. Each callable takes no args and returns an iterable of dicts:

    {"path": "products/widget", "changefreq": "weekly",
     "priority": 0.7, "lastmod": "2026-08-01"}

``pages`` and ``blog`` are always registered.
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


BUILTIN_SOURCES = {"pages": _pages_source, "blog": _blog_source}


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
    for entry in fn():
        body.append(_url_xml(base, entry))
    body.append("</urlset>")
    return HttpResponse("\n".join(body), content_type="application/xml")


def sitemap_all(request):
    """Flat sitemap.xml combining every source (small sites). The index at
    /sitemap-index.xml is preferred once a section exceeds 50k URLs."""
    base = _base_url(request)
    body = ['<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for fn in get_sources().values():
        for entry in fn():
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
