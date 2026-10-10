"""The fixed tracking vocabulary (R31): event names, their parameters, and
each tool's native name for them.

One vocabulary for every site, so data looks the same in every GA4 property
and ad account. The kit receives these maps from `GET tracking/config/`
(lib/track.js has no copy of its own), and the server-side dispatcher uses
them directly, so the browser and server copies of an event always agree.
"""

import re

# GA4 / Meta / TikTok limits (the strictest wins).
MAX_NAME = 40
MAX_PARAM_NAME = 40
MAX_PARAM_VALUE = 100
MAX_PARAMS = 25

COMMON_PARAMS = (
    "page_path", "page_type", "content_group", "intent", "segment", "stage", "block", "item",
    "event_id", "cms_v", "debug_mode", "traffic_type", "cms_verify_run", "conversion_id",
)

# name -> spec. `server`: a server copy is sent (conversion-level events only;
# engagement stays browser-only to keep volume and cost down).
EVENTS = {
    "page_view": {"params": (), "server": False, "meta": "PageView", "tiktok": None},
    "cta_click": {"params": ("cta_label", "cta_target"), "server": False, "meta": "CtaClick", "tiktok": "ClickButton"},
    "nav_click": {"params": ("nav_area", "nav_label"), "server": False, "meta": None, "tiktok": None},
    "section_view": {"params": (), "server": False, "meta": None, "tiktok": None},
    "scroll_depth": {"params": ("percent",), "server": False, "meta": None, "tiktok": None},
    "service_engaged": {"params": (), "server": True, "meta": "ViewContent", "tiktok": "ViewContent"},
    "faq_open": {"params": ("faq_id", "faq_topic"), "server": False, "meta": None, "tiktok": None},
    "form_start": {"params": ("form_name",), "server": False, "meta": None, "tiktok": None},
    "form_error": {"params": ("form_name", "field"), "server": False, "meta": None, "tiktok": None},
    "form_abandon": {"params": ("form_name", "last_field"), "server": False, "meta": None, "tiktok": None},
    "generate_lead": {"params": ("form_name", "services", "value", "currency"), "server": True, "meta": "Lead", "tiktok": "SubmitForm"},
    "contact_click": {"params": ("method",), "server": False, "meta": "Contact", "tiktok": "Contact"},
    "outbound_click": {"params": ("link_domain",), "server": False, "meta": None, "tiktok": None},
    "file_download": {"params": ("file_ext", "file_name"), "server": False, "meta": "Download", "tiktok": "Download"},
    "search": {"params": ("search_term",), "server": False, "meta": "Search", "tiktok": "Search"},
    # A plan conversion matched (fired alongside the event that triggered it).
    "conversion": {"params": ("conversion_id", "tier", "value", "currency"), "server": True, "meta": None, "tiktok": None},
}

# Meta standard events a conversion may map to (custom conversions use these
# as their category).
META_STANDARD = ("Lead", "Schedule", "Contact", "SubmitApplication", "CompleteRegistration", "ViewContent",
                 "Search", "Subscribe", "StartTrial", "Purchase", "AddToCart", "InitiateCheckout", "Donate",
                 "FindLocation", "CustomizeProduct")
TIKTOK_STANDARD = ("SubmitForm", "Contact", "ViewContent", "ClickButton", "CompleteRegistration", "Download",
                   "Search", "Subscribe", "PlaceAnOrder", "CompletePayment", "AddToCart", "InitiateCheckout")

PAGE_TYPES = ("home", "service", "article", "entry", "index", "contact", "legal", "faq", "about", "other")

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"\+?\d[\d\s().-]{6,}\d")
QUERY_RE = re.compile(r"\?[^\s#]*")
UTM_KEYS = ("utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content")
NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def clean_value(value):
    """Strip personal data from one parameter value. Numbers and booleans
    pass; text loses emails, phone-like digit runs and query strings."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, (list, tuple)):
        return ", ".join(str(clean_value(v)) for v in value)[:MAX_PARAM_VALUE]
    text = str(value)
    text = EMAIL_RE.sub("[email]", text)
    text = PHONE_RE.sub("[number]", text)
    text = QUERY_RE.sub("", text)
    return text.strip()[:MAX_PARAM_VALUE]


def clean_params(name, params):
    """The params an event may carry, cleaned. Unknown keys are dropped (so a
    site can't leak a form field into an event by accident)."""
    spec = EVENTS.get(name)
    if not spec or not isinstance(params, dict):
        return {}
    allowed = set(COMMON_PARAMS) | set(spec["params"])
    out = {}
    for key, value in params.items():
        if key not in allowed or not NAME_RE.match(str(key)):
            continue
        cleaned = clean_value(value)
        if cleaned in ("", None):
            continue
        out[key] = cleaned
        if len(out) >= MAX_PARAMS:
            break
    return out


def meta_name(name, params=None, mapping=None):
    """Meta event name: a conversion's mapped standard event, else the
    standard name for the event, else a PascalCase custom name."""
    if mapping:
        return mapping
    spec = EVENTS.get(name) or {}
    if spec.get("meta"):
        return spec["meta"]
    return "".join(part.capitalize() for part in name.split("_"))[:50]


def tiktok_name(name, mapping=None):
    if mapping and mapping in TIKTOK_STANDARD:
        return mapping
    return (EVENTS.get(name) or {}).get("tiktok")


def public_vocab():
    """What the kit needs at runtime (served in tracking/config/)."""
    return {
        "events": {name: {"params": list(spec["params"]), "server": spec["server"], "meta": spec["meta"], "tiktok": spec["tiktok"]}
                   for name, spec in EVENTS.items()},
        "common": list(COMMON_PARAMS),
        "limits": {"name": MAX_NAME, "paramName": MAX_PARAM_NAME, "paramValue": MAX_PARAM_VALUE, "params": MAX_PARAMS},
    }
