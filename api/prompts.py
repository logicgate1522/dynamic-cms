"""Every AI prompt the CMS hands an admin — the single source of truth.

The admin UI never writes prompt text itself: it asks one of the ai/*
endpoints (api/ai_views.py), shows the prompt with a Copy button, and sends
the AI's reply to POST ai/normalize/ (api/ai_normalize.py) before applying it.
That keeps every site built on this CMS producing the same strict prompts,
and lets one fix here improve all of them.

Prompts are built from SiteSettings (organisation name, `ai` block) so nothing
here is specific to one business:

    SiteSettings.data.ai = {
      "brandVoice":  "clear, warm, plain English",       # tone for all copy
      "audience":    "UK small-business owners",          # default audience
      "location":    "Leeds, West Yorkshire",              # default service area
      "pageKinds":   {"services": "Service page", ...},    # path prefix -> label
      "extraRules":  ["Always spell 'organisation' with an s", ...]
    }

Prompt families (all reply formats are JSON, parsed by ai_normalize):

    page_prompt          new page / rewrite an existing page   -> page JSON
    section_prompt       one section or component             -> its content object
    page_assist_prompt   every editable section on a page      -> {id: content}
    seo_prompt           a page's SEO fields                    -> ```json {fields}```
    keyword_prompt       keyword research for a page            -> ```json {fields}```
    copy_structure_prompt  reproduce an existing page as JSON  -> page JSON
"""

import json

from .dynamic_pages import (
    PER_ITEM_IMAGE_SECTION_TYPES,
    SECTION_SCHEMA,
    SECTION_TYPES,
    SINGLE_IMAGE_SECTION_TYPES,
)
from .keywords import section_coverage

SEARCH_INTENTS = ("informational", "commercial", "transactional", "navigational", "local")

DEFAULT_PAGE_KINDS = {
    "blog": "Blog post",
    "services": "Service page",
    "service": "Service page",
    "resources": "Resource / guide article",
    "guides": "Resource / guide article",
    "locations": "Local service-area page",
    "areas": "Local service-area page",
    "case-studies": "Case study page",
    "projects": "Project case-study page",
    "products": "Product page",
    "about": "About page",
    "contact": "Contact page",
    "faqs": "FAQ page",
    "faq": "FAQ page",
    "pricing": "Pricing page",
    "legal": "Legal page",
}

PAGE_TYPE_LABELS = {
    "generic": "Generic page",
    "landing": "Landing page",
    "service": "Service page",
    "article": "Blog article",
    "resource-article": "Resource article",
    "local-service": "Local service page",
    "product": "Product page",
}

SEO_PRINCIPLES = """SEO RULES — apply to every word you write:
1. The H1 (hero heading / page title) and at least one H2 contain the primary keyword, or a close natural variation, worded the way a person would search it. Never stuff it or repeat it mechanically.
2. Headings follow real search intent: each H2 answers a question or covers a sub-topic a searcher for this keyword expects.
3. "seo.title" is 50–60 characters and leads with the keyword; "seo.description" is 120–160 characters, specific, and ends with a reason to click. Neither is generic boilerplate.
4. Copy is concrete: real details, numbers, steps, deadlines, prices or examples where they exist. No filler, no lorem ipsum, no interchangeable "we provide quality service" sentences.
5. Use secondary keywords and variations once each where they read naturally. Never force them.
6. Every page has one clear next step (a CTA) that matches the search intent.
7. Mention related services, locations or topics naturally so internal links can point to them.
8. Never invent facts you were not given: no fake statistics, awards, accreditations, prices, reviews or legal claims. If a detail is unknown, write around it.
"""

JSON_ONLY = (
    "Return ONLY valid JSON — no markdown code fences, no commentary before or after, no comments "
    "inside the JSON. Keep every URL, path and image reference a plain string exactly as given "
    '(never markdown-linkified as "[https://x.jpg](https://x.jpg)").'
)

ARRAY_RULE = (
    "DATA ARRAYS (FAQ items, cards, steps, team, links, locations, gallery images, and similar lists): "
    "NEVER remove, shorten or reorder an existing item unless the request explicitly asks for it — keep "
    "every existing item, in order, with its ids, even in a section you are not otherwise changing. Do ADD "
    "items when the list is thin or empty and the section's purpose needs more."
)


# --------------------------------------------------------------- context

def site_context():
    """Brand + AI config from SiteSettings, with safe defaults."""
    from .models import SiteSettings
    row = SiteSettings.objects.filter(pk=1).first()
    data = (row.data if row else {}) or {}
    ai = data.get("ai") or {}
    seo = data.get("seoDefaults") or {}
    kinds = dict(DEFAULT_PAGE_KINDS)
    if isinstance(ai.get("pageKinds"), dict):
        kinds.update({str(k).strip("/"): str(v) for k, v in ai["pageKinds"].items() if v})
    return {
        "brand": ((data.get("organization") or {}).get("name") or "").strip(),
        "voice": (ai.get("brandVoice") or "clear, professional, plain English").strip(),
        "audience": (ai.get("audience") or "").strip(),
        "location": (ai.get("location") or "").strip(),
        "locale": seo.get("locale") or "en_GB",
        "page_kinds": kinds,
        "extra_rules": [str(r).strip() for r in (ai.get("extraRules") or []) if str(r).strip()],
    }


def describe_page_kind(path="", page_type="", host_kind="", site=None):
    """A precise label for what a page IS, so the AI is never just told
    "generic page" when it is a service page, a case study, an article..."""
    site = site or site_context()
    if host_kind == "blog":
        return "Blog post"
    clean = str(path or "").strip("/")
    if not clean or clean == "home":
        return "Homepage"
    first = clean.split("/")[0]
    if first in site["page_kinds"]:
        return site["page_kinds"][first]
    return PAGE_TYPE_LABELS.get(page_type or "generic", f"{page_type} page".capitalize())


def _where(path):
    clean = str(path or "").strip("/")
    return "/" if not clean or clean == "home" else f"/{clean}"


def _voice_block(site):
    lines = [f"Brand: {site['brand']}." if site["brand"] else "",
             f"Voice: {site['voice']}.",
             f"Spelling and conventions: {site['locale'].replace('_', '-')}."]
    if site["extra_rules"]:
        lines.append("House rules:\n" + "\n".join(f"- {r}" for r in site["extra_rules"]))
    return "\n".join(line for line in lines if line)


def _brief_block(brief, site):
    brief = brief or {}
    values = [
        ("Primary keyword", brief.get("keyword")),
        ("Search intent", brief.get("intent")),
        ("Service area / location", brief.get("location") or site["location"]),
        ("Target audience", brief.get("audience") or site["audience"]),
        ("Supporting keywords", brief.get("supporting")),
        ("Primary call to action", brief.get("cta")),
    ]
    filled = [(label, str(v).strip()) for label, v in values if str(v or "").strip()]
    if not any(label == "Primary keyword" for label, _ in filled):
        filled.insert(0, ("Primary keyword", "not given — choose the single best one from the title, topic and "
                                             "path, and use it consistently"))
    return "PAGE BRIEF:\n" + "\n".join(f"- {label}: {value}" for label, value in filled)


def _schema_block(section_types):
    types = [t for t in (section_types or SECTION_TYPES) if t in SECTION_SCHEMA]
    return types, json.dumps({t: SECTION_SCHEMA[t] for t in types}, indent=2)


def _image_rules(types):
    single = sorted(SINGLE_IMAGE_SECTION_TYPES & set(types))
    per_item = sorted(PER_ITEM_IMAGE_SECTION_TYPES & set(types))
    parts = []
    if single:
        parts.append(f'{", ".join(single)} (one top-level image)')
    if per_item:
        parts.append(f'each item of {", ".join(per_item)}')
    if not parts:
        return ""
    return (
        "- Images: for " + "; ".join(parts) + ', set "image_required": true and an "image_prompt" that '
        "describes exactly what the photo shows (subject, setting, mood) so it can be shot or sourced. "
        "Never put an image URL you invented.\n"
    )


# --------------------------------------------------------------- page

def page_prompt(section_types=None, context=None):
    """Create a new page, or rewrite an existing one.

    context: mode "create"|"edit", host_kind "content"|"blog", path, title,
    page_type, topic (create: what the page is about; edit: the change
    requested), strategy "expand"|"override", existing_sections
    [{section_type, content, existing_media?}], brief {keyword, intent,
    location, audience, supporting, cta}.
    """
    context = context or {}
    site = site_context()
    mode = context.get("mode") or "create"
    kind = describe_page_kind(context.get("path"), context.get("page_type"), context.get("host_kind"), site)
    title = (context.get("title") or "").strip()
    topic = (context.get("topic") or "").strip()
    where = f" at {_where(context.get('path'))}" if context.get("path") else ""
    types, schema = _schema_block(section_types)

    if mode == "edit":
        strategy = (context.get("strategy") or "expand").lower()
        if strategy == "override":
            strategy_text = (
                "EDIT STRATEGY — override: you may rewrite every section from scratch. Treat the current "
                "content only as background on what the page covers and which images exist."
            )
        else:
            strategy_text = (
                "EDIT STRATEGY — expand: keep what is already strong and only sharpen it; rewrite thin, "
                "generic or placeholder sections with concrete, specific content; add sections only where "
                'the page is missing something a searcher expects. Where a section lists "existing_media", '
                "that image is already live — keep it unless the change needs a new one."
            )
        opening = (
            f"You are editing an existing {kind}{where}"
            + (f' titled "{title}"' if title else "")
            + ".\n\nCURRENT SECTIONS (the live page, in order):\n"
            + json.dumps(context.get("existing_sections") or [], indent=2, ensure_ascii=False)
            + (f"\n\nCHANGE REQUESTED: {topic}" if topic else "\n\nCHANGE REQUESTED: improve the page against the brief and the SEO rules.")
            + f"\n\n{strategy_text}\n\n{ARRAY_RULE}"
        )
        output = (
            'Return the FULL page JSON with the complete "sections" array in final order — every section, '
            "including ones you kept unchanged."
        )
    else:
        opening = (
            f"You are writing a NEW {kind}{where}"
            + (f' titled "{title}"' if title else "")
            + (f" about: {topic}" if topic else "")
            + ". Write it from scratch."
        )
        output = "Return the page JSON."

    return f"""{opening}

{_voice_block(site)}

{_brief_block(context.get("brief"), site)}

{SEO_PRINCIPLES}
OUTPUT FORMAT — {output} {JSON_ONLY}

{{
  "page_type": "{context.get("page_type") or "generic"}",
  "title": "<page title / H1 wording>",
  "seo": {{ "title": "<50-60 chars>", "description": "<120-160 chars>", "keywords": ["<primary>", "<secondary>", "..."] }},
  "sections": [ {{ "type": "<section type>", ...fields }} ]
}}

SECTION TYPES — use only these; "required"/"required_list" fields must be present, "optional" may be omitted:
{schema}

SECTION RULES:
- Every section object has "type" set to one of: {", ".join(types)}.
- The first section is a "hero" unless the page clearly needs something else first; its "heading" is the H1.
- rich_text / image_text "content" is plain paragraphs separated by a blank line. No HTML, no markdown.
- "video_url" must be a YouTube or Vimeo embed URL (https://www.youtube.com/embed/… or https://player.vimeo.com/video/…).
- Links ("*_href") are site paths like "/contact" or full https URLs.
{_image_rules(types)}- Do not invent section types or fields that are not listed above.
"""


# --------------------------------------------------------------- one section

def section_prompt(*, content, section_type="", label="", path="", page_type="", host_kind="",
                   fields=None, keyword="", strategy="expand", instruction="", existing_media=None):
    """Rewrite ONE section/component. `fields` is its field contract
    ({field: rule} for dynamic sections, or a ComponentSchema), when known."""
    site = site_context()
    kind = describe_page_kind(path, page_type, host_kind, site)
    if not fields and section_type in SECTION_SCHEMA:
        fields = SECTION_SCHEMA[section_type]
    name = f'a "{section_type}" section' if section_type else f'the "{label or "content"}" block'
    strategy_text = (
        "EDIT STRATEGY — override: rewrite this block freely; use the current content only as background."
        if (strategy or "").lower() == "override" else
        "EDIT STRATEGY — expand: keep what is strong and sharpen it; rewrite thin or generic text with "
        "concrete, specific detail; fill empty lists the block clearly needs."
    )
    media = ""
    if existing_media:
        media = "Existing images on this block (keep them):\n" + "\n".join(f"- {m}" for m in existing_media) + "\n\n"
    contract = ""
    if fields:
        contract = "Field contract:\n" + json.dumps(fields, indent=2) + "\n\n"
    return (
        f"You are rewriting {name} on a {kind} at {_where(path)}"
        + (f' (labelled "{label}")' if label and section_type else "")
        + ".\n\nCURRENT CONTENT:\n"
        + json.dumps(content or {}, indent=2, ensure_ascii=False)
        + "\n\n" + media + contract
        + _voice_block(site) + "\n\n"
        + (f"Primary keyword to work in naturally: {keyword}\n\n" if keyword else "")
        + (f"CHANGE REQUESTED: {instruction}\n\n" if instruction else "")
        + strategy_text + "\n\n"
        + SEO_PRINCIPLES + "\n" + ARRAY_RULE + "\n\n"
        "OUTPUT FORMAT — return ONLY this block's content object: the exact same keys and nesting as "
        "CURRENT CONTENT (keep fields you did not change), NOT wrapped in another key, NOT the whole page. "
        + JSON_ONLY
    )


# --------------------------------------------------------------- whole page

def page_assist_prompt(*, path, sections, seo=None):
    """One prompt covering every editable block on a page.

    sections: {id: {"label", "content", "excludeFromKeywordAudit"?}}
    Returns (prompt, audit). The reply is {id: content} for changed blocks.
    """
    site = site_context()
    seo = seo or {}
    keyword = ((seo.get("keywords") or {}).get("primary") or "").strip()
    audit = section_coverage(keyword, sections)
    audit["rules"] = seo_rule_checks(seo, keyword)
    payload = {sid: {"label": (e or {}).get("label") or sid, "content": (e or {}).get("content") or {}}
               for sid, e in (sections or {}).items()}

    missing = [f'{r["id"]} ({r["label"]})' for r in audit["sections"] if r["hasKeyword"] is False and not r["excluded"]]
    if keyword:
        precheck = (
            f'MECHANICAL PRE-CHECK (data, not judgment — verify it and go deeper): the keyword "{keyword}" '
            f'appears in {audit["withKeyword"]} of {audit["total"]} blocks ({audit["percent"]}%). '
            + (f"Blocks NOT mentioning it: {', '.join(missing)}." if missing else "Every block already mentions it.")
        )
    else:
        precheck = ("No primary keyword is set for this page. Infer the single best one from the content and "
                    "use it consistently.")

    secondary = ", ".join((seo.get("keywords") or {}).get("secondary") or [])
    prompt = f"""You are auditing and improving every editable block on the {describe_page_kind(path, site=site)} at {_where(path)}.
{f'Primary keyword: "{keyword}".' if keyword else ""}{f" Secondary keywords: {secondary}." if secondary else ""}{f' SEO title: "{seo.get("seoTitle")}".' if seo.get("seoTitle") else ""}

{_voice_block(site)}

EVERY EDITABLE BLOCK, keyed by id:
{json.dumps(payload, indent=2, ensure_ascii=False)}

{precheck}

Check every block for TWO separate problems:
1. KEYWORD: does it mention the primary keyword (or a natural variation) where it reads naturally — a heading, subheading or sentence? Every block flagged above as not mentioning it MUST get it, unless the block is so narrow (a legal line, a phone number) that it cannot fit naturally. One or two words changed is enough.
2. QUALITY: is anything thin, vague, generic or missing? An empty or near-empty list that the block's purpose needs (no FAQ items, no steps) is a quality problem — write real, specific entries.

Fix only what each block needs. Change copy, not structure — except adding entries to a thin list.

{SEO_PRINCIPLES}
{ARRAY_RULE}

OUTPUT FORMAT — a JSON object containing ONLY the blocks you changed, keyed by block id, each mapped DIRECTLY to that block's full content object (same keys and nesting as its "content" above — not wrapped in {{"label","content"}}). Omit blocks you left alone. If nothing needs changing, return {{}}. {JSON_ONLY}
"""
    return prompt, audit


# --------------------------------------------------------------- SEO fields

SEO_FIELD_KEYS = (
    "seoTitle", "metaDescription", "canonicalUrl", "primaryKeyword", "secondaryKeywords",
    "variations", "searchIntent", "ogTitle", "ogDescription", "ogImageAlt", "twitterTitle",
    "twitterDescription", "breadcrumbName", "robotsIndex", "robotsFollow", "schemaBuilders",
)


def seo_rule_checks(seo, keyword=None):
    """Fast metadata rules shared by the SEO panel and the whole-page assist."""
    seo = seo or {}
    keyword = keyword if keyword is not None else ((seo.get("keywords") or {}).get("primary") or "")
    title = seo.get("seoTitle") or ""
    desc = seo.get("metaDescription") or ""
    from .keywords import contains_keyword
    rules = [
        {"id": "keyword-set", "label": "Primary keyword is set", "pass": bool(keyword), "field": "keywords.primary"},
        {"id": "title-keyword", "label": "SEO title contains the keyword", "field": "seoTitle",
         "pass": bool(keyword and title and contains_keyword(title, keyword)), "skip": not keyword},
        {"id": "title-length", "label": "SEO title is 30–60 characters", "field": "seoTitle",
         "pass": 30 <= len(title) <= 60},
        {"id": "desc-keyword", "label": "Meta description contains the keyword", "field": "metaDescription",
         "pass": bool(keyword and desc and contains_keyword(desc, keyword)), "skip": not keyword},
        {"id": "desc-length", "label": "Meta description is 120–160 characters", "field": "metaDescription",
         "pass": 120 <= len(desc) <= 160},
        {"id": "intent-set", "label": "Search intent is set", "field": "searchIntent",
         "pass": seo.get("searchIntent") in SEARCH_INTENTS},
        {"id": "indexable", "label": "Page can be indexed", "field": "robots.index",
         "pass": (seo.get("robots") or {}).get("index", True) is not False},
        {"id": "og-image", "label": "Social share image is set", "field": "social.ogImage",
         "pass": bool((seo.get("social") or {}).get("ogImage"))},
    ]
    return rules


def seo_prompt(*, path, seo, failing=None, page_text=""):
    """Audit a page's SEO fields; reply is a fenced ```json block of only the
    fields that should change (keys: SEO_FIELD_KEYS)."""
    site = site_context()
    seo = seo or {}
    kw = seo.get("keywords") or {}
    social = seo.get("social") or {}
    current = {
        "seoTitle": seo.get("seoTitle", ""),
        "metaDescription": seo.get("metaDescription", ""),
        "canonicalUrl": seo.get("canonicalUrl", ""),
        "primaryKeyword": kw.get("primary", ""),
        "secondaryKeywords": kw.get("secondary") or [],
        "variations": kw.get("variations") or [],
        "searchIntent": seo.get("searchIntent", ""),
        "ogTitle": social.get("ogTitle", ""),
        "ogDescription": social.get("ogDescription", ""),
        "ogImageAlt": social.get("ogImageAlt", ""),
        "twitterTitle": social.get("twitterTitle", ""),
        "twitterDescription": social.get("twitterDescription", ""),
        "breadcrumbName": (seo.get("breadcrumbLabels") or {}).get(str(path).strip("/"), ""),
        "robotsIndex": (seo.get("robots") or {}).get("index", True),
        "robotsFollow": (seo.get("robots") or {}).get("follow", True),
        "schemaBuilders": (seo.get("schema") or {}).get("builders") or [],
    }
    failing = failing or []
    issues = "\n".join(f"- {f.get('label')}" + (f" — fix: {f['fix']}" if f.get("fix") else "") for f in failing)
    excerpt = (page_text or "").strip()[:2500]
    return f"""You are an expert SEO editor auditing the {describe_page_kind(path, site=site)} at {_where(path)}{f" for {site['brand']}" if site["brand"] else ""}.

CURRENT SEO FIELDS:
{json.dumps(current, indent=2, ensure_ascii=False)}

AUTOMATED CHECKS FAILING (mechanical rules only — length, presence, keyword-in-field; not judgment):
{issues or "- none"}

{f"VISIBLE PAGE TEXT (rough excerpt, may include navigation):{chr(10)}{excerpt}{chr(10)}" if excerpt else ""}
Do this in order:
1. Judge each field like an expert, not a character counter: would it win the click for someone searching this keyword? Is the keyword the one this page can actually rank for, given its content? Note what is missing, weak or wrong. Do not rewrite fields that are already good.
2. In plain text (not JSON), say whether the page CONTENT backs up the keyword and intent, and exactly what to add or change and in which section. Content is edited in the page itself, not here.
3. Then output ONE fenced block labelled ```json containing ONLY the fields that should change, using exactly these keys: {", ".join(SEO_FIELD_KEYS)}.
   - seoTitle: 50–60 characters, keyword first, brand last if it fits.
   - metaDescription: 120–160 characters, specific, ends with a reason to click.
   - searchIntent: one of {", ".join(SEARCH_INTENTS)}.
   - secondaryKeywords / variations: arrays of 3–8 short phrases people actually search.
   - schemaBuilders: array from Service, FAQPage, HowTo, Product, Event, Person, VideoObject — only types the visible content supports.
   If every field is already good, output ```json
{{}}
```.
{SEO_PRINCIPLES}
The ```json block is pasted back into the CMS as-is — real changes only, no placeholders."""


def keyword_prompt(*, path, page_text="", seo=None, brief=None):
    """Keyword research for one page. Reply: ```json {primaryKeyword,
    secondaryKeywords, variations, searchIntent}```."""
    site = site_context()
    seo = seo or {}
    brief = brief or {}
    excerpt = (page_text or "").strip()[:2500]
    known = (seo.get("keywords") or {})
    return f"""You are doing keyword research for the {describe_page_kind(path, site=site)} at {_where(path)}{f" for {site['brand']}" if site["brand"] else ""}.

{_brief_block({**brief, "keyword": brief.get("keyword") or known.get("primary")}, site)}

{f"VISIBLE PAGE TEXT (rough excerpt):{chr(10)}{excerpt}{chr(10)}" if excerpt else ""}
Pick keywords this page can realistically rank for:
- primaryKeyword: ONE phrase of 2–5 words that matches the page's main topic and the way people actually search (include the location if the business serves a local area).
- secondaryKeywords: 4–8 closely related phrases the page should also cover.
- variations: 3–6 natural rewordings / synonyms of the primary keyword.
- searchIntent: one of {", ".join(SEARCH_INTENTS)}.
Prefer specific, lower-competition phrases over broad head terms. Do not invent search volumes.

Explain your choice in 2–4 plain sentences, then output ONE fenced block labelled ```json with exactly those four keys.
Never output anything after the json block."""


def copy_structure_prompt():
    """Reproduce an existing page/screenshot as page JSON (structure + copy verbatim)."""
    return f"""You are given an existing web page or component (HTML, JSX, markup, or a screenshot description). Reproduce its STRUCTURE and COPY as CMS page JSON — do not redesign or rewrite it.

{JSON_ONLY}

{{
  "page_type": "generic",
  "title": "<the page's main heading>",
  "seo": {{ "title": "", "description": "", "keywords": [] }},
  "sections": [ ... ]
}}

- Walk the page top to bottom. Emit one section per visual block, in order, keeping headings, body copy, list items and button text VERBATIM.
- Map each block to the closest type: {", ".join(SECTION_TYPES)}.
- For every image in the original set "image_required": true and an "image_prompt" describing what it shows, so it can be re-uploaded.
- Text stays plain paragraphs separated by blank lines. No HTML, no markdown.
- Fill "seo" with a 50–60 character title and a 120–160 character description written from the page's own copy.

Section field reference:
{json.dumps(SECTION_SCHEMA, indent=2)}
"""
