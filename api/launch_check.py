"""Launch readiness: everything that silently hurts a live site.

GET launch-check/ (admin) returns {ready, blockers, warnings, items: [...]} where
each item is {id, level: "blocker"|"warning", label, detail, fix, where?}.

Blockers mean "do not launch": visitors would see placeholder text, leads
would never reach anyone, search engines would be told to stay away, or the
site would advertise the wrong domain. The admin dashboard shows this list,
and frontend-kit/acceptance/site-audit.mjs fails on any blocker.
"""

import re
from urllib.parse import urlparse

from django.conf import settings

PLACEHOLDER = re.compile(
    r"\[(?:insert|registered|company|your|add|todo)[^\]]*\]"   # [Insert …], [Registered Office Address]
    r"|\b0{4}\s?0{6}\b|\(0\)\s?0{4}"                             # 0000 000000, (0) 0000
    r"|@example\.(?:com|org|co\.uk)\b|\bexample\.(?:com|co\.uk)\b"
    r"|lorem ipsum|\bTBD\b|\bTODO\b"
    r"|\bNew section\b|Write the first paragraph|Describe the offer in one|What it does\b|\bEyebrow\b",
    re.IGNORECASE,
)
# Claims a new business can't usually back up: client counts, ratings,
# percentages, credentials and price promises. Each must be confirmed by the
# owner (or removed) before launch — R26.
CLAIMS = re.compile(
    r"\b\d{2,}[,\d]*\s?\+(?=\s|$|[^\w])"                               # 250+, 1,000+
    r"|\b\d(?:\.\d)?\s?/\s?5\b|★{3,}"                                    # 4.9/5, ★★★★★
    r"|\b\d{2,3}\s?%\s*(?:client|customer|satisf|success|retention)"     # 98% satisfaction
    r"|\b\d+\+?\s*years?\s+(?:of\s+)?experience"                          # 15 years experience
    r"|\b(?:trusted|chosen|used)\s+by\s+(?:over\s+)?\d"                    # trusted by 500
    r"|\bfixed[- ](?:fees?|prices?|pricing)\b"                             # fixed fees
    r"|\baward[- ]winning\b|\bchartered\b|\bregistered\s+agents?\b",     # credentials
    re.IGNORECASE,
)
EMAIL_LIKE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", ""}
DEV_EMAIL_BACKENDS = ("console", "locmem", "dummy", "filebased")


def _strings(value, path=""):
    """Every string in a JSON blob, with a readable path. Anything an admin
    hid (`_hidden: true`) is skipped — visitors never see it."""
    if isinstance(value, dict) and value.get("_hidden"):
        return
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from _strings(item, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _strings(item, f"{path}[{index}]")


def placeholder_hits():
    """Placeholder text in anything visitors can see (published data only)."""
    return published_hits(PLACEHOLDER)


def claim_hits():
    """Unverified-looking claims (R26) in published content, plus any
    testimonials visitors can see — reviews must be real (UK DMCC Act)."""
    from .models import BlogPost, ComponentData, ContentPage, DynamicSection
    hits = [h for h in published_hits(CLAIMS, whole=True) if "testimonial" not in h["where"].lower()]
    for row in ComponentData.objects.all():
        data = row.data or {}
        if not data.get("_hidden") and any(isinstance(v, list) and v for k, v in data.items() if "testimonial" in k.lower()):
            hits.append({"where": f"block “{row.name}”", "text": "testimonials are visible"})
    live_pages = set(ContentPage.objects.filter(status="published").values_list("pk", flat=True))
    live_posts = set(BlogPost.objects.filter(status="published").values_list("pk", flat=True))
    for section in DynamicSection.objects.filter(status="published", section_type="testimonials").select_related("content_type"):
        model = section.content_type.model
        live = (model == "contentpage" and section.object_id in live_pages) or (model == "blogpost" and section.object_id in live_posts)
        if live and not (section.content or {}).get("_hidden"):
            hits.append({"where": f"{model} #{section.object_id} section {section.order + 1}", "text": "testimonials are visible"})
    return hits


def published_hits(pattern, whole=False):
    """Matches of `pattern` in anything visitors can see (published data only).
    `whole` reports the full string (trimmed) instead of just the match."""
    from .models import BlogPost, ComponentData, ContentPage, DynamicSection, PageSEO, SiteSettings
    hits = []

    def scan(where, blob):
        for path, text in _strings(blob):
            match = pattern.search(text)
            if match:
                shown = (text if len(text) <= 90 else text[:87] + "…") if whole else match.group(0)
                hits.append({"where": f"{where} → {path}" if path else where, "text": shown})

    for row in ComponentData.objects.all():
        if not (row.name or "").startswith("form-"):
            scan(f"block “{row.name}”", row.data)
    site = SiteSettings.objects.filter(pk=1).first()
    if site:
        scan("site settings", {k: v for k, v in (site.data or {}).items() if k not in ("ai", "collections")})
    for row in PageSEO.objects.all():
        scan(f"SEO /{row.path}", {k: (row.data or {}).get(k) for k in ("seoTitle", "metaDescription", "social")})
    live_pages = {p.pk for p in ContentPage.objects.filter(status="published")}
    live_posts = {p.pk for p in BlogPost.objects.filter(status="published")}
    for section in DynamicSection.objects.filter(status="published").select_related("content_type"):
        model = section.content_type.model
        if (model == "contentpage" and section.object_id in live_pages) or (model == "blogpost" and section.object_id in live_posts):
            scan(f"{model} #{section.object_id} section {section.order + 1} ({section.section_type})", section.content)
    for post in BlogPost.objects.filter(status="published"):
        scan(f"article “{post.slug}”", {"title": post.title, "excerpt": post.excerpt})
    return hits


def run_launch_check():
    from .models import ComponentData, PageSEO, SiteSettings
    items = []

    def add(item_id, level, label, detail="", fix="", where=None):
        items.append({"id": item_id, "level": level, "label": label, "detail": detail, "fix": fix,
                      **({"where": where} if where else {})})

    site = (SiteSettings.objects.filter(pk=1).first() or SiteSettings()).data or {}
    seo_defaults = site.get("seoDefaults") or {}

    # 1. The site's own address (canonicals, sitemap, social links).
    site_url = seo_defaults.get("siteUrl") or ""
    host = urlparse(site_url).hostname or ""
    if host in LOCAL_HOSTS:
        add("site-url", "blocker", "Site URL is not the live domain",
            f"seoDefaults.siteUrl is “{site_url or 'empty'}” — canonicals, the sitemap and social links would point there.",
            "Set Settings → SEO defaults → Site URL to https://your-domain.")
    elif not site_url.startswith("https://"):
        add("site-url-https", "warning", "Site URL is not https", site_url, "Use the https:// address.")

    # 2. Search engines.
    if (seo_defaults.get("robots") or {}).get("index") is False:
        add("robots-off", "blocker", "Search engines are blocked site-wide",
            "seoDefaults.robots.index is false (a staging setting).", "Turn indexing back on in Settings → SEO defaults.")

    # 3. Leads must reach someone: FormSubmit (Settings → Form notifications)
    #    is the standard; backend SMTP (FORM_NOTIFICATION_EMAIL) is optional.
    formsubmit = str((site.get("forms") or {}).get("notifyEmail") or "").strip()
    recipients = [getattr(settings, "FORM_NOTIFICATION_EMAIL", "") or ""]
    for row in ComponentData.objects.filter(name__startswith="form-"):
        recipients.append(((row.data or {}).get("notify") or {}).get("email") or "")
    smtp_recipient = any(r.strip() for r in recipients)
    if not formsubmit and not smtp_recipient:
        add("lead-email", "blocker", "Form submissions notify nobody",
            "No notification email is set — leads would only sit in the inbox.",
            "Site tools → Settings → Form notifications: enter the address, then click “Send a test email” and confirm FormSubmit's activation email.")
    backend = getattr(settings, "EMAIL_BACKEND", "")
    if smtp_recipient and not formsubmit and any(name in backend for name in DEV_EMAIL_BACKENDS):
        add("email-backend", "blocker", "Emails are not actually sent",
            f"Notifications rely on the backend's email, but EMAIL_BACKEND is the "
            f"{next(n for n in DEV_EMAIL_BACKENDS if n in backend)} backend.",
            "Use Settings → Form notifications (FormSubmit), or configure SMTP in the backend .env.")
    if formsubmit and EMAIL_LIKE.match(formsubmit):
        add("formsubmit-alias", "warning", "Form notification address is public",
            "FormSubmit uses the address in the page's requests. After activation it emails you a private alias.",
            "Replace the address with that alias in Settings → Form notifications.")

    # 4. Visitors must see edits.
    if not getattr(settings, "FRONTEND_REVALIDATE_URL", "") or not getattr(settings, "REVALIDATE_SECRET", ""):
        add("webhook", "warning", "Cache refresh webhook is off",
            "Published edits reach visitors only when the page cache expires.",
            "Set FRONTEND_REVALIDATE_URL and REVALIDATE_SECRET on both sides.")
    if getattr(settings, "DEBUG", False):
        add("debug", "warning", "Backend is in DEBUG mode", "", "Set DEBUG=False in production.")

    # 5. Placeholder text visitors would see.
    hits = placeholder_hits()
    if hits:
        add("placeholders", "blocker", f"Placeholder text is published ({len(hits)})",
            "; ".join(f"{h['text']} in {h['where']}" for h in hits[:8]) + (" …" if len(hits) > 8 else ""),
            "Replace each with real details (click it on the page).", where=hits)

    # 5b. Claims the owner must confirm are true (R26).
    claims = claim_hits()
    if claims:
        add("claims", "warning", f"Confirm these claims are true ({len(claims)})",
            "; ".join(f"“{h['text']}” in {h['where']}" for h in claims[:8]) + (" …" if len(claims) > 8 else ""),
            "Keep only numbers, ratings, credentials, prices and reviews the business can prove; hide or reword the rest.",
            where=claims)

    # 6. Sharing.
    if not seo_defaults.get("defaultOgImage"):
        add("og-default", "warning", "No default social image",
            "Pages without their own image share with no picture.",
            "Upload a 1200×630 image in Settings → SEO defaults.")

    # 7. Page SEO quality — judged on what search engines actually get (the
    #    resolved title/description), with the same hard limits as
    #    frontend-kit/acceptance/site-audit.mjs. (50–60 / 120–160 is the
    #    ideal the SEO panel coaches towards; these are the fail lines.)
    from .models import BlogPost, ContentPage
    from .seo_resolve import resolve_seo
    paths = {row.path for row in PageSEO.objects.all()}
    paths |= {p.seo_path or p.path for p in ContentPage.objects.filter(status="published")}
    paths |= {f"blog/{p.slug}" for p in BlogPost.objects.filter(status="published")}
    weak = []
    for path in sorted(paths):
        resolved = resolve_seo(path)
        title = resolved.get("fullTitle") or ""
        desc = resolved.get("description") or ""
        problems = []
        if not 25 <= len(title) <= 65:
            problems.append(f"title {len(title)} chars (25–65)")
        if not 110 <= len(desc) <= 165:
            problems.append(f"description {len(desc)} chars (110–165)")
        if (resolved.get("robots") or {}).get("index") is False:
            problems.append("noindex")
        if problems:
            weak.append({"where": f"/{'' if path == 'home' else path}", "text": ", ".join(problems)})
    if weak:
        add("page-seo", "warning", f"{len(weak)} page(s) have weak SEO fields",
            "; ".join(f"{w['where']}: {w['text']}" for w in weak[:6]), "Open SEO → Ask AI on each page.", where=weak)

    blockers = [i for i in items if i["level"] == "blocker"]
    return {"ready": not blockers, "blockers": len(blockers),
            "warnings": len(items) - len(blockers), "items": items}
