"""Server-side JSON-LD builders.

Pure functions. No DB writes. Each returns a plain dict (a single node) or a
list of nodes. `assemble(path)` composes the per-page @graph and is the only
function that touches the ORM (read-only). Exposed via
GET seo/resolve/<path>/ and GET settings/site/schema/organization/.

Escaping: JSON-LD is emitted inside <script type="application/ld+json">, so a
literal "</script>" or "<" in a string value can break out. `escape_jsonld`
walks the structure and replaces "<" with "\\u003c" on emit. Callers that
serialise these dicts to a page MUST run them through it (the resolve
endpoint does).
"""

import json
import re


def escape_jsonld(obj):
    """Recursively replace '<' with its \\u003c escape in every string."""
    if isinstance(obj, str):
        return obj.replace("<", "\\u003c")
    if isinstance(obj, dict):
        return {k: escape_jsonld(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [escape_jsonld(v) for v in obj]
    return obj


def _clean(node):
    """Drop keys whose value is None, "" or []."""
    return {k: v for k, v in node.items() if v not in (None, "", [], {})}


def _image_object(url, alt=""):
    if not url:
        return None
    node = {"@type": "ImageObject", "url": url}
    if alt:
        node["caption"] = alt
    return node


def _absolute(url, base_url):
    if url and base_url and str(url).startswith("/") and not str(url).startswith("//"):
        return base_url.rstrip("/") + str(url)
    return url


def organization(site):
    """Organization / LocalBusiness / <type> node from SiteSettings.data."""
    site = site or {}
    org = site.get("organization") or {}
    contact = site.get("contact") or {}
    seo = site.get("seoDefaults") or {}
    schema_cfg = site.get("schema") or {}
    locations = site.get("locations") or []

    org_type = schema_cfg.get("organizationType") or "Organization"
    base_url = seo.get("siteUrl") or site.get("siteUrl") or ""

    node = {
        "@type": org_type,
        "@id": (base_url + "#organization") if base_url else "#organization",
        "name": org.get("name") or seo.get("defaultTitle") or "",
        "legalName": org.get("legalName") or "",
        "url": base_url,
        "description": org.get("description") or seo.get("defaultDescription") or "",
        "foundingDate": org.get("foundingDate") or "",
        # Search engines need an absolute logo URL; site-relative paths
        # ("/images/brand/logo.png") resolve against the site URL.
        "logo": _image_object(_absolute(org.get("logo"), base_url), org.get("logoAlt")),
        "sameAs": [s for s in (org.get("sameAs") or []) if s],
    }

    if contact.get("email") or contact.get("phone"):
        node["contactPoint"] = _clean({
            "@type": "ContactPoint",
            "email": contact.get("email") or "",
            "telephone": contact.get("phone") or "",
            "contactType": contact.get("contactType") or "customer support",
            "availableLanguage": contact.get("availableLanguages") or [],
        })

    if locations:
        node["location"] = [_local_business(loc, node["name"]) for loc in locations]

    return _clean(node)


def _local_business(loc, org_name):
    loc = loc or {}
    node = {
        "@type": "LocalBusiness",
        "name": loc.get("name") or org_name,
        "address": _clean({
            "@type": "PostalAddress",
            "streetAddress": loc.get("streetAddress") or "",
            "addressLocality": loc.get("addressLocality") or "",
            "addressRegion": loc.get("addressRegion") or "",
            "postalCode": loc.get("postalCode") or "",
            "addressCountry": loc.get("addressCountry") or "",
        }),
        "telephone": loc.get("telephone") or "",
        "priceRange": loc.get("priceRange") or "",
    }
    lat, lng = loc.get("latitude"), loc.get("longitude")
    if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
        node["geo"] = {"@type": "GeoCoordinates", "latitude": lat, "longitude": lng}
    hours = loc.get("openingHours") or []
    spec = []
    for h in hours:
        if not isinstance(h, dict):
            continue
        spec.append(_clean({
            "@type": "OpeningHoursSpecification",
            "dayOfWeek": h.get("days") or [],
            "opens": h.get("opens") or "",
            "closes": h.get("closes") or "",
        }))
    if spec:
        node["openingHoursSpecification"] = spec
    return _clean(node)


def website(site):
    site = site or {}
    seo = site.get("seoDefaults") or {}
    base_url = seo.get("siteUrl") or site.get("siteUrl") or ""
    if not base_url:
        return None
    node = {
        "@type": "WebSite",
        "@id": base_url + "#website",
        "url": base_url,
        "name": (site.get("organization") or {}).get("name") or seo.get("defaultTitle") or "",
        "inLanguage": (seo.get("locale") or "en_US").replace("_", "-"),
    }
    search_url = seo.get("searchUrl") or site.get("searchUrl")
    if search_url:
        node["potentialAction"] = {
            "@type": "SearchAction",
            "target": {
                "@type": "EntryPoint",
                "urlTemplate": search_url.replace("{query}", "{search_term_string}"),
            },
            "query-input": "required name=search_term_string",
        }
    return _clean(node)


def breadcrumb(path, labels=None, base_url=""):
    """BreadcrumbList from a '/'-separated path. `labels` maps a segment path
    to a display label; otherwise the segment is title-cased."""
    labels = labels or {}
    segments = [s for s in (path or "").strip("/").split("/") if s]
    items = [{
        "@type": "ListItem", "position": 1, "name": "Home",
        "item": base_url or "/",
    }]
    acc = ""
    for i, seg in enumerate(segments, start=2):
        acc = f"{acc}/{seg}" if acc else seg
        items.append({
            "@type": "ListItem",
            "position": i,
            "name": labels.get(acc) or seg.replace("-", " ").title(),
            "item": (base_url.rstrip("/") + "/" + acc) if base_url else "/" + acc,
        })
    return {"@type": "BreadcrumbList", "itemListElement": items}


def article(obj, site, base_url=""):
    """obj: a dict with keys title/excerpt/author/published_at/updated_at/
    og_image/path/word_count/section/keywords/locale."""
    obj = obj or {}
    org = organization(site)
    author_name = obj.get("author") or org.get("name") or ""
    node = {
        "@type": obj.get("schema_type") or "BlogPosting",
        "headline": obj.get("title") or "",
        "description": obj.get("excerpt") or obj.get("description") or "",
        "datePublished": obj.get("published_at") or "",
        "dateModified": obj.get("updated_at") or obj.get("published_at") or "",
        "author": {"@type": "Person", "name": author_name} if author_name else org,
        "publisher": {"@id": org.get("@id")} if org.get("@id") else org,
        "image": [obj["og_image"]] if obj.get("og_image") else [],
        "articleSection": obj.get("section") or "",
        "keywords": obj.get("keywords") or [],
        "wordCount": obj.get("word_count") or None,
        "inLanguage": (obj.get("locale") or "en-US").replace("_", "-"),
    }
    if obj.get("path") and base_url:
        node["mainEntityOfPage"] = {
            "@type": "WebPage", "@id": base_url.rstrip("/") + "/" + obj["path"].strip("/"),
        }
    return _clean(node)


def faq(items):
    valid = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        q = it.get("question") or it.get("q")
        a = it.get("answer") or it.get("a")
        if q and a:
            valid.append({
                "@type": "Question",
                "name": q,
                "acceptedAnswer": {"@type": "Answer", "text": a},
            })
    if not valid:
        return None
    return {"@type": "FAQPage", "mainEntity": valid}


def product(data):
    data = data or {}
    if not data.get("name"):
        return None
    node = {
        "@type": "Product",
        "name": data.get("name"),
        "description": data.get("description") or "",
        "image": data.get("image") or [],
        "sku": data.get("sku") or "",
        "brand": {"@type": "Brand", "name": data["brand"]} if data.get("brand") else None,
    }
    if data.get("price"):
        node["offers"] = _clean({
            "@type": "Offer",
            "price": str(data.get("price")),
            "priceCurrency": data.get("currency") or "USD",
            "availability": data.get("availability") or "https://schema.org/InStock",
            "url": data.get("url") or "",
        })
    if data.get("ratingValue"):
        node["aggregateRating"] = {
            "@type": "AggregateRating",
            "ratingValue": str(data["ratingValue"]),
            "reviewCount": str(data.get("reviewCount") or 0),
        }
    return _clean(node)


def service(data, site):
    data = data or {}
    if not data.get("name"):
        return None
    org = organization(site)
    return _clean({
        "@type": "Service",
        "name": data.get("name"),
        "description": data.get("description") or "",
        "provider": {"@id": org.get("@id")} if org.get("@id") else org,
        "areaServed": data.get("areaServed") or "",
        "serviceType": data.get("serviceType") or "",
    })


def person(data):
    data = data or {}
    if not data.get("name"):
        return None
    return _clean({
        "@type": "Person",
        "name": data.get("name"),
        "jobTitle": data.get("jobTitle") or "",
        "description": data.get("bio") or "",
        "image": data.get("image") or "",
        "sameAs": data.get("sameAs") or [],
        "url": data.get("url") or "",
    })


def event(data):
    data = data or {}
    if not data.get("name"):
        return None
    return _clean({
        "@type": "Event",
        "name": data.get("name"),
        "startDate": data.get("startDate") or "",
        "endDate": data.get("endDate") or "",
        "eventStatus": data.get("eventStatus") or "https://schema.org/EventScheduled",
        "location": data.get("location") or "",
        "description": data.get("description") or "",
    })


def howto(data):
    data = data or {}
    steps = data.get("steps") or []
    if not data.get("name") or not steps:
        return None
    return _clean({
        "@type": "HowTo",
        "name": data.get("name"),
        "step": [
            {"@type": "HowToStep", "position": i + 1,
             "name": (s.get("title") if isinstance(s, dict) else str(s)) or "",
             "text": (s.get("body") if isinstance(s, dict) else str(s)) or ""}
            for i, s in enumerate(steps)
        ],
    })


def video_object(data):
    data = data or {}
    if not data.get("name"):
        return None
    return _clean({
        "@type": "VideoObject",
        "name": data.get("name"),
        "description": data.get("description") or "",
        "thumbnailUrl": data.get("thumbnailUrl") or "",
        "uploadDate": data.get("uploadDate") or "",
        "contentUrl": data.get("contentUrl") or "",
        "embedUrl": data.get("embedUrl") or "",
    })


BUILDER_MAP = {
    "FAQPage": lambda ctx: faq(ctx.get("faq_items")),
    "Product": lambda ctx: product(ctx.get("product")),
    "Service": lambda ctx: service(ctx.get("service"), ctx.get("site")),
    "Person": lambda ctx: person(ctx.get("person")),
    "Event": lambda ctx: event(ctx.get("event")),
    "HowTo": lambda ctx: howto(ctx.get("howto")),
    "VideoObject": lambda ctx: video_object(ctx.get("video")),
    "BreadcrumbList": lambda ctx: breadcrumb(
        ctx.get("path", ""), ctx.get("labels"), ctx.get("base_url", "")
    ),
}


def assemble(path, page_seo_data=None, site_data=None, article_ctx=None, base_url=""):
    """Compose the @graph for a page. Read-only helper; callers pass the data.

    - always: organization + website (when a site URL is known)
    - breadcrumb from the path
    - article/product/service/faq/etc. from page_seo_data.schema.builders
    - appends page_seo_data.schema.data (raw manual JSON-LD) last
    - full-document override: site.schema.raw or page schema.data being a
      complete JSON-LD doc (has @context) is honoured verbatim
    """
    page_seo_data = page_seo_data or {}
    site_data = site_data or {}
    schema_cfg = page_seo_data.get("schema") or {}

    # Full manual override
    raw_page = schema_cfg.get("data")
    if isinstance(raw_page, dict) and "@context" in raw_page:
        return raw_page
    site_schema = site_data.get("schema") or {}
    if isinstance(site_schema.get("raw"), dict) and "@context" in site_schema["raw"]:
        return site_schema["raw"]

    graph = []
    org = organization(site_data)
    if org.get("name"):
        graph.append(org)
    web = website(site_data)
    if web:
        graph.append(web)

    graph.append(breadcrumb(path, (page_seo_data.get("breadcrumbLabels") or {}), base_url))

    ctx = {
        "site": site_data,
        "path": path,
        "base_url": base_url,
        "faq_items": page_seo_data.get("faqItems") or (article_ctx or {}).get("faq_items"),
        "product": page_seo_data.get("product"),
        "service": page_seo_data.get("service"),
        "person": page_seo_data.get("person"),
        "event": page_seo_data.get("event"),
        "howto": page_seo_data.get("howto"),
        "video": page_seo_data.get("video"),
        "labels": page_seo_data.get("breadcrumbLabels") or {},
    }

    builders = schema_cfg.get("builders") or []
    if article_ctx:
        graph.append(article(article_ctx, site_data, base_url))
    elif ("Article" in builders or "BlogPosting" in builders) and page_seo_data.get("article"):
        graph.append(article(page_seo_data["article"], site_data, base_url))
    for name in builders:
        # breadcrumb + article are already composed above; don't double-add.
        if name in ("BreadcrumbList", "Article", "BlogPosting"):
            continue
        fn = BUILDER_MAP.get(name)
        if not fn:
            continue
        node = fn(ctx)
        if node:
            graph.append(node)

    if isinstance(raw_page, dict) and raw_page:
        graph.append(raw_page)
    elif isinstance(raw_page, list):
        graph.extend(raw_page)

    return {"@context": "https://schema.org", "@graph": graph}


_REQUIRED_PROPS = {
    "Organization": ["name"],
    "LocalBusiness": ["name", "address"],
    "WebSite": ["url"],
    "Article": ["headline", "datePublished", "author"],
    "BlogPosting": ["headline", "datePublished", "author"],
    "NewsArticle": ["headline", "datePublished", "author"],
    "Product": ["name"],
    "Offer": ["price", "priceCurrency"],
    "FAQPage": ["mainEntity"],
    "BreadcrumbList": ["itemListElement"],
    "Person": ["name"],
    "Event": ["name", "startDate"],
    "HowTo": ["name", "step"],
    "VideoObject": ["name", "thumbnailUrl", "uploadDate"],
    "Recipe": ["name", "recipeIngredient", "recipeInstructions"],
    "Course": ["name", "description", "provider"],
    "JobPosting": ["title", "description", "datePosted", "hiringOrganization"],
}

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}(T[\d:.\-+Z]+)?$")


def validate_schema(obj):
    """Structural JSON-LD validation. Returns a list of
    {level: 'error'|'warning', path, message}. Used by the audit engine and
    POST seo/validate-schema/."""
    issues = []
    if isinstance(obj, str):
        try:
            obj = json.loads(obj)
        except ValueError as e:
            return [{"level": "error", "path": "", "message": f"Invalid JSON: {e}"}]

    if isinstance(obj, dict) and "@context" not in obj and "@graph" not in obj and "@type" not in obj:
        issues.append({"level": "warning", "path": "", "message": "No @context / @type at the root."})

    if isinstance(obj, dict) and "@context" in obj:
        ctx = obj["@context"]
        if not (isinstance(ctx, str) and "schema.org" in ctx):
            issues.append({"level": "warning", "path": "@context",
                           "message": "@context is not schema.org."})

    nodes = []
    if isinstance(obj, dict) and isinstance(obj.get("@graph"), list):
        nodes = obj["@graph"]
    elif isinstance(obj, list):
        nodes = obj
    elif isinstance(obj, dict):
        nodes = [obj]

    seen_types = []
    for i, node in enumerate(nodes):
        p = f"@graph[{i}]" if len(nodes) > 1 else ""
        if not isinstance(node, dict):
            issues.append({"level": "error", "path": p, "message": "Node is not an object."})
            continue
        t = node.get("@type")
        if not t:
            issues.append({"level": "error", "path": p, "message": "Node has no @type."})
            continue
        seen_types.append(t)
        req = _REQUIRED_PROPS.get(t)
        if req:
            for prop in req:
                if not node.get(prop):
                    issues.append({"level": "error", "path": f"{p}.{prop}".lstrip("."),
                                   "message": f"{t} requires '{prop}'."})
        for date_key in ("datePublished", "dateModified", "startDate", "endDate", "uploadDate"):
            v = node.get(date_key)
            if isinstance(v, str) and v and not _ISO_DATE.match(v):
                issues.append({"level": "warning", "path": f"{p}.{date_key}".lstrip("."),
                               "message": f"{date_key} is not ISO-8601."})
        for img_key in ("image", "logo", "thumbnailUrl", "contentUrl"):
            v = node.get(img_key)
            urls = v if isinstance(v, list) else [v]
            for u in urls:
                if isinstance(u, str) and u and not u.startswith(("http://", "https://")):
                    issues.append({"level": "warning", "path": f"{p}.{img_key}".lstrip("."),
                                   "message": f"{img_key} should be an absolute URL."})
        if t == "BreadcrumbList":
            items = node.get("itemListElement") or []
            positions = [it.get("position") for it in items if isinstance(it, dict)]
            if positions != list(range(1, len(positions) + 1)):
                issues.append({"level": "warning", "path": f"{p}.itemListElement".lstrip("."),
                               "message": "ListItem positions are not 1..n in order."})

    if len(set(seen_types)) != len(seen_types):
        dupes = [t for t in set(seen_types) if seen_types.count(t) > 1]
        issues.append({"level": "warning", "path": "@graph",
                       "message": f"Repeated @type(s): {', '.join(dupes)}."})

    return issues


def to_script_json(graph):
    """Serialise a graph for embedding in a <script> tag, '<' escaped."""
    return json.dumps(escape_jsonld(graph), separators=(",", ":"))
