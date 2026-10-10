"""Site facts for the tracking plan (R31): what this site actually has.

Two sources, merged:
- the database: settings (business type, locale, contact channels,
  locations, tracking IDs), form definitions, published pages, collections
  and their entries, FAQ sections;
- the latest scan of the rendered site (`TrackingScan`, POSTed by the admin's
  browser or the headless runner): blocks, CTAs, nav, FAQ items, forms on
  each page, pricing blocks, downloads, outbound links. Frontend-only copy
  (defaults that were never saved) is only visible here.

The library (tracking_library.py) and the AI prompt use these facts; trigger
resolution (tracking_plan.py) refuses anything that isn't in them.
"""

import hashlib
import json
import re

LEGAL_RE = re.compile(r"(^|/)(privacy|terms|cookies?|legal|disclaimer|accessibility)(/|$)", re.I)
CONTACT_RE = re.compile(r"(^|/)(contact|book|booking|enquir|quote|get-started|appointment)", re.I)
FAQ_RE = re.compile(r"(^|/)(faqs?|help|questions)(/|$)", re.I)
ABOUT_RE = re.compile(r"(^|/)(about|team|our-story|who-we-are)(/|$)", re.I)
PRICING_RE = re.compile(r"pric|fee|plan|package|cost", re.I)
SEGMENT_BLOCK_RE = re.compile(r"who|help|audience|industr|sector|client|customer", re.I)

CURRENCY_BY_COUNTRY = {"GB": "GBP", "US": "USD", "IE": "EUR", "DE": "EUR", "FR": "EUR", "ES": "EUR", "IT": "EUR",
                       "NL": "EUR", "BE": "EUR", "AT": "EUR", "PT": "EUR", "FI": "EUR", "CA": "CAD", "AU": "AUD",
                       "NZ": "NZD", "IN": "INR", "AE": "AED", "PK": "PKR", "ZA": "ZAR", "SG": "SGD", "CH": "CHF"}


def norm_path(path):
    """'/services/payroll/' -> '/services/payroll'; 'home' -> '/'."""
    p = str(path or "").split("?")[0].split("#")[0].strip()
    if p in ("", "/", "home"):
        return "/"
    return "/" + p.strip("/")


def _option_values(options):
    out = []
    for opt in options or []:
        if isinstance(opt, dict):
            value = opt.get("value", opt.get("label"))
            label = opt.get("label", opt.get("value"))
        else:
            value = label = opt
        if value not in (None, ""):
            out.append({"value": str(value), "label": str(label)})
    return out


def page_type_for(path, collections, form_pages):
    p = norm_path(path)
    if p == "/":
        return "home"
    for c in collections:
        if p == norm_path(c["indexPath"]):
            return "index"
    for c in collections:
        prefix = norm_path(c["pathPrefix"])
        if prefix != "/" and p.startswith(prefix + "/"):
            return c.get("pageType") or ("article" if c.get("hostKind") == "blog" else "entry")
    # A specific purpose wins over "has a form" (many sites repeat the
    # enquiry form on About, FAQ or legal pages).
    if LEGAL_RE.search(p):
        return "legal"
    if FAQ_RE.search(p):
        return "faq"
    if ABOUT_RE.search(p):
        return "about"
    if CONTACT_RE.search(p):
        return "contact"
    if p.startswith("/blog/"):
        return "article"
    if p in form_pages:
        return "contact"
    return "other"


def db_facts():
    from .models import BlogPost, ComponentData, ContentPage, DynamicSection, PageSEO, SiteSettings
    from .site_collections import all_collections

    site = (SiteSettings.objects.filter(pk=1).first() or SiteSettings()).data or {}
    org = site.get("organization") or {}
    seo = site.get("seoDefaults") or {}
    contact = site.get("contact") or {}
    locale = seo.get("locale") or "en_US"
    country = (locale.split("_")[1] if "_" in locale else "").upper()
    locations = [l for l in (site.get("locations") or []) if isinstance(l, dict) and (l.get("streetAddress") or l.get("addressLocality"))]

    collections = []
    for key, cfg in (all_collections() or {}).items():
        collections.append({
            "key": key, "label": cfg.get("label", key), "plural": cfg.get("plural", key),
            "indexPath": norm_path(cfg.get("indexPath", key)), "pathPrefix": norm_path(cfg.get("pathPrefix", key)),
            "pageType": cfg.get("pageType") or "", "hostKind": cfg.get("hostKind", "content"), "entries": [],
        })

    forms = []
    for row in ComponentData.objects.filter(name__startswith="form-"):
        data = row.data or {}
        fields = []
        for f in data.get("fields") or []:
            if not isinstance(f, dict) or not f.get("name"):
                continue
            fields.append({"name": str(f["name"]), "type": str(f.get("type") or "text"), "label": str(f.get("label") or ""),
                           "required": bool(f.get("required")), "options": _option_values(f.get("options"))})
        forms.append({"name": row.name[len("form-"):], "fields": fields, "pages": []})

    pages = {}

    def add_page(path, title="", source="db"):
        p = norm_path(path)
        pages.setdefault(p, {"path": p, "title": title or "", "sources": []})
        if title and not pages[p]["title"]:
            pages[p]["title"] = title
        if source not in pages[p]["sources"]:
            pages[p]["sources"].append(source)

    for row in PageSEO.objects.all():
        add_page(row.path, (row.data or {}).get("title", ""))
    for page in ContentPage.objects.filter(status="published"):
        add_page(page.path, page.title)
    for post in BlogPost.objects.filter(status="published"):
        add_page(f"blog/{post.slug}", post.title)

    faqs = []
    for row in PageSEO.objects.all():
        for item in (row.data or {}).get("faqItems") or []:
            q = (item or {}).get("question") or (item or {}).get("q")
            if q:
                faqs.append({"question": str(q)[:200], "path": norm_path(row.path), "source": "seo"})
    for section in DynamicSection.objects.filter(section_type="faq"):
        for item in (section.content or {}).get("items") or []:
            q = (item or {}).get("question") or (item or {}).get("title") or (item or {}).get("q")
            if q:
                faqs.append({"question": str(q)[:200], "block": f"section-{section.id}", "source": "section"})

    analytics = site.get("analytics") or {}
    tools = {k: bool(str(analytics.get(v) or "").strip()) for k, v in (
        ("gtm", "gtmId"), ("ga4", "ga4Id"), ("googleAds", "googleAdsId"), ("meta", "metaPixelId"),
        ("tiktok", "tiktokPixelId"), ("linkedin", "linkedinPartnerId"), ("clarity", "clarityId"), ("hotjar", "hotjarId"))}

    return {
        "org": {"name": org.get("name") or "", "type": (site.get("schema") or {}).get("organizationType") or "Organization",
                "description": org.get("description") or "", "locale": locale, "country": country,
                "currency": CURRENCY_BY_COUNTRY.get(country, "USD")},
        "channels": {"phone": bool(str(contact.get("phone") or "").strip()), "email": bool(str(contact.get("email") or "").strip()),
                     "address": bool(locations), "whatsapp": False},
        "collections": collections, "forms": forms, "pages": pages, "faqs": faqs, "tools": tools,
        "formPage": norm_path((site.get("forms") or {}).get("page") or ""),
    }


def merge_scan(facts, scan):
    """Fold a rendered-site scan into DB facts. The scan wins for what visitors
    see (CTAs, nav, blocks, FAQ items on pages); the DB wins for definitions."""
    scan = scan or {}
    blocks, ctas, nav, pricing, segment_blocks = {}, [], [], [], []
    downloads = outbound = search = False
    channels = facts["channels"]
    forms_by_name = {f["name"]: f for f in facts["forms"]}
    for page in scan.get("pages") or []:
        path = norm_path(page.get("path"))
        facts["pages"].setdefault(path, {"path": path, "title": page.get("title") or "", "sources": []})
        entry = facts["pages"][path]
        if "scan" not in entry["sources"]:
            entry["sources"].append("scan")
        entry["title"] = entry["title"] or page.get("title") or ""
        entry["words"] = page.get("words") or 0
        for b in page.get("blocks") or []:
            name = str(b.get("name") or "")[:80]
            if not name:
                continue
            info = blocks.setdefault(name, {"name": name, "paths": [], "heading": b.get("heading") or "", "items": b.get("items") or 0})
            if path not in info["paths"]:
                info["paths"].append(path)
            if PRICING_RE.search(name) or PRICING_RE.search(b.get("heading") or ""):
                pricing.append({"block": name, "path": path})
            if SEGMENT_BLOCK_RE.search(name) or SEGMENT_BLOCK_RE.search(b.get("heading") or ""):
                segment_blocks.append({"block": name, "path": path, "items": b.get("itemLabels") or []})
        for c in page.get("ctas") or []:
            ctas.append({"label": str(c.get("label") or "")[:60], "target": norm_path(c.get("target")), "block": c.get("block") or "", "path": path})
        for n in page.get("nav") or []:
            nav.append({"label": str(n.get("label") or "")[:60], "href": norm_path(n.get("href")), "area": n.get("area") or "header"})
        for q in page.get("faqs") or []:
            facts["faqs"].append({"question": str(q.get("question") or "")[:200], "block": q.get("block") or "",
                                  "item": q.get("item") or "", "topic": q.get("topic") or "", "path": path, "source": "scan"})
        for f in page.get("forms") or []:
            name = f.get("name")
            if not name:
                continue
            form = forms_by_name.get(name)
            if form is None:
                form = {"name": name, "fields": f.get("fields") or [], "pages": []}
                facts["forms"].append(form)
                forms_by_name[name] = form
            if path not in form["pages"]:
                form["pages"].append(path)
        downloads = downloads or bool(page.get("downloads"))
        outbound = outbound or bool(page.get("outbound"))
        search = search or bool(page.get("search"))
        channels["phone"] = channels["phone"] or bool(page.get("tel"))
        channels["email"] = channels["email"] or bool(page.get("mailto"))
        channels["whatsapp"] = channels["whatsapp"] or bool(page.get("whatsapp"))
    facts.update({"blocks": blocks, "ctas": ctas, "nav": nav, "pricing": pricing, "segmentBlocks": segment_blocks,
                  "has": {"downloads": downloads, "outbound": outbound, "search": search}, "scanned": bool(scan.get("pages"))})
    return facts


def finalise(facts):
    form_pages = set()
    for f in facts["forms"]:
        form_pages.update(f["pages"])
    if facts.get("formPage") and facts["formPage"] != "/":
        form_pages.add(facts["formPage"])
    facts["formPages"] = sorted(form_pages)
    for c in facts["collections"]:
        c["entries"] = sorted(
            ({"path": p["path"], "title": p["title"]} for p in facts["pages"].values()
             if c["pathPrefix"] != "/" and p["path"].startswith(c["pathPrefix"] + "/")),
            key=lambda e: e["path"])
    for p in facts["pages"].values():
        p["type"] = page_type_for(p["path"], facts["collections"], form_pages)
    # Where a call-to-action leads: the dedicated contact/booking pages that
    # hold a form — never the home page (a logo link isn't a CTA), even when
    # the home page also shows the form.
    # A form repeated on many pages (a site-wide enquiry block) doesn't make
    # each of them a destination: prefer the pages that ARE the contact or
    # booking page; fall back to the form pages only if none is.
    named = sorted(p["path"] for p in facts["pages"].values() if p["path"] in form_pages and CONTACT_RE.search(p["path"]))
    contact_pages = sorted(p["path"] for p in facts["pages"].values() if p["type"] == "contact" and p["path"] in form_pages)
    facts["ctaPages"] = named or contact_pages or sorted(p for p in form_pages if p != "/")
    facts["pages"] = sorted(facts["pages"].values(), key=lambda p: p["path"])
    facts["has"]["articles"] = any(p["type"] == "article" for p in facts["pages"])
    # De-duplicate FAQ questions (same text from SEO data and the scan).
    seen, faqs = set(), []
    for q in facts["faqs"]:
        key = q["question"].strip().lower()
        if key and key not in seen:
            seen.add(key)
            faqs.append(q)
        elif key:
            for existing in faqs:
                if existing["question"].strip().lower() == key:
                    for k in ("block", "item", "topic", "path"):
                        existing[k] = existing.get(k) or q.get(k) or ""
    facts["faqs"] = faqs
    facts["hash"] = facts_hash(facts)
    return facts


def facts_hash(facts):
    """Changes when something a plan can reference changes (not on copy edits
    elsewhere): paths, forms/fields/options, blocks, CTA targets, FAQ text."""
    basis = {
        "paths": sorted(p["path"] if isinstance(p, dict) else p for p in (facts["pages"].values() if isinstance(facts["pages"], dict) else facts["pages"])),
        "forms": sorted((f["name"], tuple(sorted((x["name"], tuple(o["value"] for o in x.get("options") or [])) for x in f["fields"]))) for f in facts["forms"]),
        "blocks": sorted((facts.get("blocks") or {}).keys()),
        "ctas": sorted({(c["block"], c["target"]) for c in facts.get("ctas") or []}),
        "faqs": sorted({q["question"].strip().lower() for q in facts["faqs"]}),
    }
    return hashlib.sha256(json.dumps(basis, sort_keys=True, default=str).encode()).hexdigest()[:16]


def get_facts():
    from .models import TrackingScan
    scan = TrackingScan.objects.filter(pk=1).first()
    facts = merge_scan(db_facts(), scan.data if scan else {})
    facts["scannedAt"] = scan.scanned_at.isoformat() if scan and scan.scanned_at else None
    return finalise(facts)


SCAN_LIMITS = {"pages": 200, "blocks": 80, "ctas": 60, "nav": 60, "faqs": 200, "forms": 10, "fields": 40, "links": 300, "text": 6000}
LINK_AREAS = ("main", "header", "footer", "nav")


def clean_scan(payload):
    """Validate and bound a scan POSTed by a browser (admin-only endpoint, but
    still untrusted input)."""
    if not isinstance(payload, dict) or not isinstance(payload.get("pages"), list):
        raise ValueError("Scan must be {pages: [...]}")

    def s(value, n=200):
        return str(value or "")[:n]

    pages = []
    for page in payload["pages"][:SCAN_LIMITS["pages"]]:
        if not isinstance(page, dict):
            continue
        pages.append({
            "path": norm_path(s(page.get("path"), 300)), "title": s(page.get("title")), "words": int(page.get("words") or 0),
            "blocks": [{"name": s(b.get("name"), 80), "heading": s(b.get("heading"), 120), "items": int(b.get("items") or 0),
                        "itemLabels": [s(x, 60) for x in (b.get("itemLabels") or [])[:20]]}
                       for b in (page.get("blocks") or [])[:SCAN_LIMITS["blocks"]] if isinstance(b, dict)],
            "ctas": [{"label": s(c.get("label"), 60), "target": s(c.get("target"), 300), "block": s(c.get("block"), 80)}
                     for c in (page.get("ctas") or [])[:SCAN_LIMITS["ctas"]] if isinstance(c, dict)],
            "nav": [{"label": s(n.get("label"), 60), "href": s(n.get("href"), 300), "area": s(n.get("area"), 20)}
                    for n in (page.get("nav") or [])[:SCAN_LIMITS["nav"]] if isinstance(n, dict)],
            "faqs": [{"question": s(q.get("question")), "block": s(q.get("block"), 80), "item": s(q.get("item"), 80), "topic": s(q.get("topic"), 80)}
                     for q in (page.get("faqs") or [])[:SCAN_LIMITS["faqs"]] if isinstance(q, dict)],
            "forms": [{"name": s(f.get("name"), 60),
                       "fields": [{"name": s(x.get("name"), 60), "type": s(x.get("type"), 20),
                                   "options": [{"value": s(o.get("value"), 100), "label": s(o.get("label"), 100)} for o in (x.get("options") or [])[:40] if isinstance(o, dict)]}
                                  for x in (f.get("fields") or [])[:SCAN_LIMITS["fields"]] if isinstance(x, dict)]}
                      for f in (page.get("forms") or [])[:SCAN_LIMITS["forms"]] if isinstance(f, dict)],
            "downloads": bool(page.get("downloads")), "outbound": bool(page.get("outbound")), "search": bool(page.get("search")),
            "tel": bool(page.get("tel")), "mailto": bool(page.get("mailto")), "whatsapp": bool(page.get("whatsapp")),
            # Internal links, H1 and main text: the link audit (R34, api/link_audit.py).
            "h1": s(page.get("h1"), 200), "text": s(page.get("text"), SCAN_LIMITS["text"]),
            **({"links": [{"to": norm_path(s(l.get("to"), 300)), "text": s(l.get("text"), 120),
                           "area": l.get("area") if l.get("area") in LINK_AREAS else "main", "rel": s(l.get("rel"), 60)}
                          for l in page["links"][:SCAN_LIMITS["links"]] if isinstance(l, dict) and l.get("to")]}
               if isinstance(page.get("links"), list) else {}),
        })
    return {"pages": pages}
