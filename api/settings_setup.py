"""Site setup: what a site SHOULD always have set, how complete it is, and the one-go AI fill-in.

`FIELDS` is the single list behind (a) the Settings page's "Setup" card (percent + what is missing),
(b) the "Fill it in with AI" prompt (all the context, missing fields first, questions when the context
is not enough) and (c) the apply step (only these dotted keys are written, each checked). Things that
only matter when needed (extra pixels, custom code, opening hours, social handles…) are NOT in
`ASK`: they stay in their own cards and are never nagged.
"""
import json
import re
from urllib.parse import urlparse

from .ai_normalize import NormalizeError, extract_json, strip_markdown_links
from .settings_validation import EMAIL_RE, TRACKING_IDS, validate_site_settings, verification_code
from .utils import deep_merge

LOCAL = ("localhost", "127.0.0.1", "0.0.0.0")

GROUPS = [
    ("business", "Your business", "Who you are — shown in search results, schema and the footer."),
    ("search", "Search & sharing", "How the site appears on Google and when a link is shared."),
    ("leads", "Enquiries", "Where leads are sent."),
    ("voice", "Voice for AI writing", "So every AI-written page sounds like you."),
    ("tracking", "Tracking", "So you can see what brings results."),
]


def _get(data, path):
    cur = data
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _text(v):
    return str(v or "").strip()


def _is_url(v):
    p = urlparse(_text(v))
    return p.scheme == "https" and bool(p.hostname) and p.hostname not in LOCAL


# key: dotted path (or "a|b" = any of). `ai`: the AI/paste may fill it (an owner-only asset like a logo
# or a verification code is `ai: False`, shown in the checklist only). `ask`: question for the owner.
FIELDS = [
    dict(key="organization.name", group="business", label="Business name", kind="text", ai=True,
         ask="What is the business's trading name?", check=lambda v: bool(_text(v))),
    dict(key="organization.description", group="business", label="What the business does (1–2 sentences)", kind="text", ai=True,
         ask="In one or two plain sentences, what does the business do and for whom?", limit=300,
         check=lambda v: len(_text(v)) >= 40),
    dict(key="organization.logo", group="business", label="Logo", kind="image", ai=False,
         ask="", check=lambda v: bool(_text(v))),
    dict(key="contact.email", group="business", label="Public contact email", kind="email", ai=True,
         ask="Which email address should customers see and write to?", check=lambda v: bool(EMAIL_RE.match(_text(v)))),
    dict(key="contact.phone|contact.whatsapp", group="business", label="A phone or WhatsApp number", kind="phone", ai=True,
         ask="Which phone or WhatsApp number (with country code) do you publish? Say 'none' if you publish neither.",
         check=lambda v: bool(_text(v)), fill="contact.phone"),
    dict(key="seoDefaults.siteUrl", group="search", label="Live site address", kind="url", ai=True,
         ask="What is the live https:// address of the site?", check=_is_url),
    dict(key="seoDefaults.defaultTitle", group="search", label="Default page title", kind="text", ai=True,
         ask="", limit=60, check=lambda v: 15 <= len(_text(v)) <= 70),
    dict(key="seoDefaults.defaultDescription", group="search", label="Default description (120–160 characters)", kind="text", ai=True,
         ask="", limit=160, check=lambda v: 70 <= len(_text(v)) <= 170),
    dict(key="seoDefaults.defaultOgImage", group="search", label="Social share image (1200×630)", kind="image", ai=False,
         ask="", check=lambda v: bool(_text(v))),
    dict(key="seoDefaults.locale", group="search", label="Language and region", kind="text", ai=True,
         ask="Which language and region does the site use (for example en_GB or en_US)?",
         check=lambda v: bool(re.match(r"^[a-z]{2}_[A-Z]{2}$", _text(v)))),
    dict(key="schema.organizationType", group="search", label="Type of business (schema)", kind="text", ai=True,
         ask="", check=lambda v: _text(v) not in ("", "Organization")),
    dict(key="verification.google|verification.bing", group="search", label="Search Console verification", kind="code", ai=False,
         ask="", check=lambda v: bool(_text(v))),
    dict(key="forms.notifyEmail", group="leads", label="Where enquiries are emailed", kind="email", ai=True,
         ask="Which email address should receive new enquiries?", check=lambda v: bool(EMAIL_RE.match(_text(v)))),
    dict(key="ai.brandVoice", group="voice", label="Brand voice", kind="text", ai=True,
         ask="How should the writing sound (for example: warm and plain-spoken, or formal and precise)?",
         check=lambda v: len(_text(v)) >= 10),
    dict(key="ai.audience", group="voice", label="Who you serve", kind="text", ai=True,
         ask="Who are your customers (type of business or person, and what they need)?", check=lambda v: len(_text(v)) >= 10),
    dict(key="ai.location", group="voice", label="Where you work", kind="text", ai=True,
         ask="Where are you based and which areas or countries do you serve?", check=lambda v: bool(_text(v))),
    dict(key="analytics.gtmId|analytics.ga4Id", group="tracking", label="Google Tag Manager or Analytics ID", kind="id", ai=True,
         ask="Do you have a Google Tag Manager container ID (GTM-…) or a GA4 measurement ID (G-…)? Say 'not yet' if not.",
         check=lambda v: bool(_text(v)), fill="analytics.gtmId"),
]

# Accepted from an AI/pasted reply on top of FIELDS: optional extras that are written only when given.
EXTRA_KEYS = {
    "organization.sameAs": "list", "organization.legalName": "text", "seoDefaults.twitterHandle": "text",
    "seoDefaults.titleTemplate": "text", "seoDefaults.themeColor": "text", "contact.location": "text",
    "ai.extraRules": "list", "forms.subjectPrefix": "text",
}
ID_PATTERNS = {f"analytics.{key}": (re.compile(pattern), example) for key, pattern, example in TRACKING_IDS}


def _fill_key(field):
    return field.get("fill") or field["key"].split("|")[0]


def _filled(data, field):
    return any(field["check"](_get(data, part)) for part in field["key"].split("|"))


def report(data, plan_approved=None):
    """{percent, items:[{key,group,label,filled,ai,ask}], missing:[...], groups:[...]}"""
    items = []
    for f in FIELDS:
        items.append({"key": f["key"], "group": f["group"], "label": f["label"], "kind": f["kind"],
                      "filled": _filled(data, f), "ai": f["ai"], "ask": f.get("ask", "")})
    if plan_approved is not None:
        items.append({"key": "analytics.plan", "group": "tracking", "label": "Tracking plan approved", "kind": "plan",
                      "filled": bool(plan_approved), "ai": False, "ask": ""})
    done = sum(1 for i in items if i["filled"])
    return {"percent": round(100 * done / len(items)) if items else 100, "done": done, "total": len(items),
            "items": items, "missing": [i for i in items if not i["filled"]],
            "groups": [{"id": g, "label": label, "help": help_text} for g, label, help_text in GROUPS]}


def plan_is_approved(data):
    plan = _get(data, "analytics.plan") or {}
    return plan.get("status") == "approved" and bool(plan.get("conversions"))


def _context(data):
    from .models import ContentPage, ComponentData
    sitemap = data.get("sitemap")
    listed = sitemap.get("extraPaths") if isinstance(sitemap, dict) else sitemap
    pages = [p for p in (listed or []) if isinstance(p, str)][:40]
    titles = list(ContentPage.objects.filter(status="published").values_list("title", flat=True)[:25])
    forms = [r.name[len("form-"):] for r in ComponentData.objects.filter(name__startswith="form-")][:10]
    cols = [str((v or {}).get("plural") or k) for k, v in (data.get("collections") or {}).items()][:8]
    return pages, titles, forms, cols


def _current(data):
    """Present values of every askable key, secrets never included."""
    out = {}
    for f in FIELDS:
        if not f["ai"]:
            continue
        for part in f["key"].split("|"):
            v = _get(data, part)
            if _text(v):
                out[part] = v
    for key in EXTRA_KEYS:
        v = _get(data, key)
        if v:
            out[key] = v
    return out


def prompt(data, extra_context=""):
    rep = report(data, plan_approved=plan_is_approved(data))
    pages, titles, forms, cols = _context(data)
    askable = [i for i in rep["missing"] if i["ai"]]
    owner_only = [i for i in rep["missing"] if not i["ai"]]
    keys = [_fill_key(f) for f in FIELDS if f["ai"]]
    by_key = {f["key"]: f for f in FIELDS}
    todo = "\n".join(
        f"- {_fill_key(by_key[i['key']])} — {i['label']}" + (f" (ask: “{i['ask']}”)" if i["ask"] else " (write this from the rest)")
        for i in askable if i["key"] in by_key) or "- nothing: every field is already set"
    spec = []
    for f in FIELDS:
        if f["ai"] and f.get("limit"):
            spec.append(f"{_fill_key(f)}: at most {f['limit']} characters")
    return f"""You are setting up the website settings for a small business so the owner fills everything in ONE go.

WHAT THE SITE ALREADY KNOWS
- Site: {json.dumps(_current(data), indent=2, ensure_ascii=False)}
- Published pages: {', '.join(titles) or 'none yet'}
- Page paths: {', '.join(pages) or 'not listed'}
- Forms: {', '.join(forms) or 'none'}; content types: {', '.join(cols) or 'none'}
{f"- Owner's notes: {extra_context.strip()}" if (extra_context or '').strip() else ""}

STILL TO FILL IN ({rep['done']} of {rep['total']} complete, {rep['percent']}%):
{todo}

HOW TO ANSWER
1. If the information above is NOT enough to fill a field truthfully, do NOT guess. Reply with ONLY a short numbered list of questions (one per field you cannot answer, at most 8, plain words, no jargon) and wait for the owner's answers. Never ask about anything that is not in the list above.
2. When you can fill the fields (from the context or the owner's answers), reply with ONE ```json block and nothing after it. Use exactly these flat keys, only for fields that should be set or changed: {', '.join(keys)}.
   Optional extras are written only if the owner gave them: {', '.join(EXTRA_KEYS)} (lists are JSON arrays).
3. Rules:
   - Nothing is invented: no phone number, address, email, ID, statistic, year or credential that was not given. If the owner says they have none, leave that key out.
   - organization.description: 1–2 plain sentences, 40–300 characters, what the business does and for whom.
   - seoDefaults.defaultTitle: 30–60 characters, business name and main offer. seoDefaults.defaultDescription: 120–160 characters, ends with a reason to click.
   - seoDefaults.siteUrl is the live https:// address (never localhost). seoDefaults.locale looks like en_GB.
   - schema.organizationType is a schema.org type that fits the business (for example ProfessionalService, LocalBusiness, AccountingService, LegalService, Organization only if nothing fits).
   - ai.brandVoice, ai.audience, ai.location are one plain sentence each.
   - Every value is a plain string (or array for lists): no markdown, no HTML, URLs written out in full.
   - Tracking IDs look like GTM-XXXXXXX, G-XXXXXXXXXX, AW-123456789; leave them out unless given.
{chr(10).join('   - ' + s for s in spec)}
{('4. Owner-only items you cannot fill (do not mention them): ' + ', '.join(i['label'] for i in owner_only)) if owner_only else ''}
The ```json block is pasted straight into the CMS: real values only, no placeholders."""


def _coerce(key, value, kind):
    if kind == "list":
        if isinstance(value, str):
            value = [v.strip() for v in re.split(r"[\n,]", value) if v.strip()]
        if not isinstance(value, list):
            raise ValueError("must be a list")
        return [str(strip_markdown_links(v)).strip() for v in value if str(v).strip()][:20]
    value = strip_markdown_links(value, key)
    if not isinstance(value, (str, int, float)):
        raise ValueError("must be text")
    return str(value).strip()


def apply(data, raw):
    """Parse an AI/pasted reply into a settings patch. Returns (patch, applied, skipped); nothing is saved here."""
    try:
        payload = extract_json(raw)
    except NormalizeError as exc:
        raise ValueError(exc.args[0] if exc.args else "Could not read that reply.")
    if not isinstance(payload, dict):
        raise ValueError("The reply must be a JSON object of settings.")
    # allow nested {"organization": {"name": ...}} as well as flat dotted keys
    flat = {}

    def walk(prefix, obj):
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict) and path not in EXTRA_KEYS:
                walk(path, v)
            else:
                flat[path] = v
    walk("", payload)
    allowed = {}
    for f in FIELDS:
        if f["ai"]:
            for part in f["key"].split("|"):
                allowed[part] = (f["kind"], f)
    for key, kind in EXTRA_KEYS.items():
        allowed[key] = (kind, None)
    patch, applied, skipped = {}, [], []
    for key, value in flat.items():
        if key not in allowed:
            skipped.append({"key": key, "reason": "not a setting the assistant can fill"})
            continue
        kind, field = allowed[key]
        if value in (None, "", [], "none", "None", "not yet", "n/a"):
            continue
        try:
            value = _coerce(key, value, "list" if kind == "list" else "text")
        except ValueError as exc:
            skipped.append({"key": key, "reason": str(exc)})
            continue
        if kind == "email" and not EMAIL_RE.match(value):
            skipped.append({"key": key, "reason": "not a valid email address"})
            continue
        if kind == "url" and not _is_url(value):
            skipped.append({"key": key, "reason": "must be the live https:// address"})
            continue
        if key in ID_PATTERNS and not ID_PATTERNS[key][0].match(value):
            skipped.append({"key": key, "reason": f"doesn't look like {ID_PATTERNS[key][1]}"})
            continue
        if field and field.get("limit") and len(value) > field["limit"] + 20:
            skipped.append({"key": key, "reason": f"too long (over {field['limit']} characters)"})
            continue
        cur = patch
        parts = key.split(".")
        for p in parts[:-1]:
            cur = cur.setdefault(p, {})
        cur[parts[-1]] = value
        applied.append(key)
    errors = validate_site_settings(patch)
    if errors:
        raise ValueError("; ".join(f"{k}: {v}" for k, v in errors.items()))
    return patch, applied, skipped
