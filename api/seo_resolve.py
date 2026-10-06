"""Resolve a fully frontend-ready metadata object for a path.

Precedence (highest first) — this is a HARD RULE, documented in the frontend
prompt and mirrored here:

    PageSEO.data  >  BlogPost.seo_*  (blog/<slug> paths only)
                  >  SiteSettings.data.seoDefaults
                  >  built-in default

`generateMetadata()` in a frontend should be a thin mapping of this output,
never a re-implementation of the precedence.
"""

from .models import BlogPost, PageSEO, SiteSettings
from . import schema_builders

BUILTIN_DEFAULTS = {
    "twitterCard": "summary_large_image",
    "ogType": "website",
    "robots": {"index": True, "follow": True},
    "locale": "en_US",
}


def _first(*values):
    for v in values:
        if v not in (None, "", [], {}):
            return v
    return None


HOME_KEYS = ("", "home")


def cache_version(name):
    """Version stamp folded into resolver cache keys; bumped on every write
    that can change the answer (api/revalidation.py), so a save is visible
    immediately instead of after the 5-minute cache window."""
    from django.core.cache import cache
    return cache.get(f"cms-cache-version:{name}") or 1


def bump_cache_version(name):
    from django.core.cache import cache
    key = f"cms-cache-version:{name}"
    try:
        cache.incr(key)
    except ValueError:
        cache.set(key, 2, None)


def resolve_seo(path, base_url=""):
    path = (path or "").strip("/")
    # The home page is stored under "home" but lives at "/": resolve both
    # seo/resolve/ and seo/resolve/home/ to the same root answer.
    if path in HOME_KEYS:
        path = ""
    page = PageSEO.objects.filter(path=path or "home").first()
    page_data = (page.data if page else {}) or {}

    site_row = SiteSettings.objects.filter(pk=1).first()
    site_data = (site_row.data if site_row else {}) or {}
    seo_defaults = site_data.get("seoDefaults") or {}
    base_url = seo_defaults.get("siteUrl") or site_data.get("siteUrl") or base_url or ""

    blog = None
    if path.startswith("blog/"):
        blog = BlogPost.objects.filter(slug=path.split("/", 1)[1]).first()
    blog_seo = {}
    if blog:
        blog_seo = {
            "seoTitle": blog.seo_title or blog.title,
            "metaDescription": blog.meta_description or blog.excerpt,
            "social": {"ogImage": blog.og_image, "ogType": "article"},
        }

    social_in = page_data.get("social") or {}
    blog_social = blog_seo.get("social") or {}

    title = _first(page_data.get("seoTitle"), blog_seo.get("seoTitle"),
                   seo_defaults.get("defaultTitle"))
    template = seo_defaults.get("titleTemplate") or "%s"
    resolved = {
        "path": path,
        "title": title,
        "titleTemplate": template,
        "fullTitle": (template.replace("%s", title) if title else
                      seo_defaults.get("defaultTitle") or ""),
        "description": _first(page_data.get("metaDescription"),
                              blog_seo.get("metaDescription"),
                              seo_defaults.get("defaultDescription")) or "",
        "canonical": _resolve_canonical(page_data, path, base_url),
        "robots": {**BUILTIN_DEFAULTS["robots"],
                   **(seo_defaults.get("robots") or {}),
                   **(page_data.get("robots") or {})},
        "keywords": page_data.get("keywords") or {},
        "focusKeyword": page_data.get("focusKeyword") or "",
        "social": {
            "ogTitle": _first(social_in.get("ogTitle"), title),
            "ogDescription": _first(social_in.get("ogDescription"),
                                    page_data.get("metaDescription"),
                                    seo_defaults.get("defaultDescription")) or "",
            "ogImage": _first(social_in.get("ogImage"), blog_social.get("ogImage"),
                              seo_defaults.get("defaultOgImage")) or "",
            "ogImageAlt": _first(social_in.get("ogImageAlt"),
                                 seo_defaults.get("defaultOgImageAlt")) or "",
            "ogType": _first(social_in.get("ogType"), blog_social.get("ogType"),
                             BUILTIN_DEFAULTS["ogType"]),
            "twitterCard": _first(social_in.get("twitterCard"),
                                  seo_defaults.get("twitterCard"),
                                  BUILTIN_DEFAULTS["twitterCard"]),
            "twitterTitle": _first(social_in.get("twitterTitle"), social_in.get("ogTitle"), title),
            "twitterDescription": _first(social_in.get("twitterDescription"),
                                         social_in.get("ogDescription"),
                                         page_data.get("metaDescription")) or "",
            "twitterImage": _first(social_in.get("twitterImage"), social_in.get("ogImage"),
                                   seo_defaults.get("defaultOgImage")) or "",
            "twitterHandle": seo_defaults.get("twitterHandle") or "",
        },
        "hreflang": page_data.get("hreflang") or [],
        "alternates": page_data.get("alternates") or {},
        "prev": page_data.get("prev") or "",
        "next": page_data.get("next") or "",
        "sitemap": page_data.get("sitemap") or {"include": True},
        "locale": seo_defaults.get("locale") or BUILTIN_DEFAULTS["locale"],
        "themeColor": seo_defaults.get("themeColor") or "",
        "verification": site_data.get("verification") or {},
    }

    article_ctx = None
    if blog:
        article_ctx = {
            "title": blog.title,
            "excerpt": blog.excerpt,
            "author": blog.author,
            "published_at": blog.published_at.isoformat() if blog.published_at else "",
            "updated_at": blog.updated_at.isoformat() if blog.updated_at else "",
            "og_image": resolved["social"]["ogImage"],
            "path": path,
            "keywords": (page_data.get("keywords") or {}).get("secondary") or [],
            "locale": resolved["locale"],
            "schema_type": "BlogPosting",
        }

    graph = schema_builders.assemble(
        path, page_seo_data=page_data, site_data=site_data,
        article_ctx=article_ctx, base_url=base_url,
    )
    resolved["jsonLd"] = schema_builders.escape_jsonld(graph)
    return resolved


def _resolve_canonical(page_data, path, base_url):
    explicit = (page_data.get("canonicalUrl") or "").strip()
    if explicit:
        return explicit
    if page_data.get("canonicalSelf", True) and base_url:
        return base_url.rstrip("/") + "/" + path if path else base_url
    return ""
