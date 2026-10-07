"""Validation for the SiteSettings.data blob.

The blob stays free-form and deep-merged, but a handful of shapes are
load-bearing (raw script injection, geo coordinates, opening hours) and a
malformed value there silently breaks the frontend or the schema builder.
This checks only the *canonical* keys that are present in the incoming
PATCH; unknown keys pass through untouched. Returns {dotted.path: message}.
"""

import re

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
TRACKING_IDS = (
    ("gtmId", r"^GTM-[A-Z0-9]{4,12}$", "GTM-ABC1234"),
    ("ga4Id", r"^G-[A-Z0-9]{4,16}$", "G-ABC123XYZ"),
    ("googleAdsId", r"^AW-\d{6,14}$", "AW-123456789"),
    ("googleAdsLeadLabel", r"^[A-Za-z0-9_-]{4,40}$", "AbC-D_efG-h12_34-567"),
    ("metaPixelId", r"^\d{10,20}$", "123456789012345"),
    ("tiktokPixelId", r"^[A-Z0-9]{15,30}$", "C4ABCDEFGH1234567890"),
    ("linkedinPartnerId", r"^\d{4,12}$", "1234567"),
    ("linkedinLeadConversionId", r"^\d{4,12}$", "12345678"),
    ("clarityId", r"^[a-z0-9]{8,16}$", "abcd1234ef"),
    ("hotjarId", r"^\d{5,12}$", "1234567"),
)

_STR_ARRAY_KEYS = [
    ("analytics", "customHead"),
    ("analytics", "customBodyStart"),
    ("analytics", "customBodyEnd"),
]


def validate_site_settings(payload):
    errors = {}
    if not isinstance(payload, dict):
        return {"_": "Body must be a JSON object."}

    for parent, key in _STR_ARRAY_KEYS:
        section = payload.get(parent)
        if isinstance(section, dict) and key in section:
            val = section[key]
            if not (isinstance(val, list) and all(isinstance(x, str) for x in val)):
                errors[f"{parent}.{key}"] = "Must be an array of strings."

    if "locations" in payload:
        locs = payload["locations"]
        if not isinstance(locs, list):
            errors["locations"] = "Must be a list of objects."
        else:
            for i, loc in enumerate(locs):
                if not isinstance(loc, dict):
                    errors[f"locations[{i}]"] = "Must be an object."
                    continue
                for coord in ("latitude", "longitude"):
                    if coord in loc and loc[coord] is not None and not _is_number(loc[coord]):
                        errors[f"locations[{i}].{coord}"] = "Must be a number or null."
                if "openingHours" in loc and not isinstance(loc["openingHours"], list):
                    errors[f"locations[{i}].openingHours"] = "Must be a list."

    org = payload.get("organization")
    if isinstance(org, dict) and "sameAs" in org:
        if not (isinstance(org["sameAs"], list) and all(isinstance(x, str) for x in org["sameAs"])):
            errors["organization.sameAs"] = "Must be an array of URL strings."

    ai = payload.get("ai")
    if ai is not None:
        if not isinstance(ai, dict):
            errors["ai"] = "Must be an object."
        else:
            for key in ("brandVoice", "audience", "location"):
                if key in ai and not isinstance(ai[key], str):
                    errors[f"ai.{key}"] = "Must be a string."
            if "extraRules" in ai and not (
                isinstance(ai["extraRules"], list) and all(isinstance(x, str) for x in ai["extraRules"])
            ):
                errors["ai.extraRules"] = "Must be an array of strings."
            if "pageKinds" in ai and not (
                isinstance(ai["pageKinds"], dict) and all(isinstance(v, str) for v in ai["pageKinds"].values())
            ):
                errors["ai.pageKinds"] = 'Must be an object of {"path-prefix": "Label"}.'

    sitemap = payload.get("sitemap")
    if sitemap is not None:
        if not isinstance(sitemap, dict):
            errors["sitemap"] = "Must be an object."
        else:
            extra = sitemap.get("extraPaths")
            if extra is not None and not (isinstance(extra, list) and all(isinstance(x, str) for x in extra)):
                errors["sitemap.extraPaths"] = "Must be an array of path strings."
            overrides = sitemap.get("overrides")
            if overrides is not None and not (
                isinstance(overrides, dict) and all(isinstance(v, dict) for v in overrides.values())
            ):
                errors["sitemap.overrides"] = 'Must be an object of {"path": {"include", "priority", "changefreq"}}.'

    # Form notifications (FormSubmit.co): an email, or the FormSubmit alias
    # it issues after activation.
    forms = payload.get("forms")
    if forms is not None:
        if not isinstance(forms, dict):
            errors["forms"] = "Must be an object."
        else:
            email = str(forms.get("notifyEmail") or "").strip()
            if email and not (EMAIL_RE.match(email) or re.match(r"^[A-Za-z0-9]{16,64}$", email)):
                errors["forms.notifyEmail"] = "Must be an email address (or the FormSubmit alias from its activation email)."
            if "subjectPrefix" in forms and not isinstance(forms["subjectPrefix"], str):
                errors["forms.subjectPrefix"] = "Must be a string."

    # Tracking IDs: a wrong ID silently tracks nothing, so check the shape.
    analytics = payload.get("analytics")
    if isinstance(analytics, dict):
        for key, pattern, example in TRACKING_IDS:
            value = str(analytics.get(key) or "").strip()
            if value and not re.match(pattern, value):
                errors[f"analytics.{key}"] = f"Doesn't look like a valid ID (expected e.g. {example})."
        if analytics.get("googleAdsLeadLabel") and not analytics.get("googleAdsId"):
            errors["analytics.googleAdsLeadLabel"] = "Set the Google Ads ID (AW-…) too."
        layer = analytics.get("dataLayer")
        if layer is not None:
            if not isinstance(layer, list):
                errors["analytics.dataLayer"] = 'Must be a list of {"key", "value"}.'
            else:
                for i, row in enumerate(layer):
                    if not isinstance(row, dict) or not re.match(r"^[A-Za-z_][A-Za-z0-9_.]{0,63}$", str(row.get("key") or "")):
                        errors[f"analytics.dataLayer[{i}].key"] = "Use letters, digits, _ or . (e.g. site_section)."
                    elif not isinstance(row.get("value"), (str, int, float, bool)):
                        errors[f"analytics.dataLayer[{i}].value"] = "Must be text, a number or true/false."
        if analytics.get("consentDefault") not in (None, "", "granted", "denied"):
            errors["analytics.consentDefault"] = 'Must be "granted" or "denied".'
        events = analytics.get("events")
        if events is not None and not (isinstance(events, dict) and all(isinstance(v, bool) for v in events.values())):
            errors["analytics.events"] = "Must be an object of true/false switches."

    collections = payload.get("collections")
    if collections is not None:
        from .dynamic_pages import SECTION_SCHEMA
        if not isinstance(collections, dict):
            errors["collections"] = 'Must be an object of {"key": {collection}}.'
        else:
            for key, cfg in collections.items():
                where = f"collections.{key}"
                if not re.match(r"^[a-z0-9][a-z0-9-]*$", str(key)):
                    errors[where] = "Key must be lowercase letters, digits and hyphens."
                    continue
                if not isinstance(cfg, dict):
                    errors[where] = "Must be an object."
                    continue
                if cfg.get("hostKind", "content") not in ("content", "blog"):
                    errors[f"{where}.hostKind"] = 'Must be "content" or "blog".'
                for field in ("sections", "allowAdd"):
                    value = cfg.get(field)
                    if value is None:
                        continue
                    bad = [t for t in value if t not in SECTION_SCHEMA] if isinstance(value, list) else None
                    if bad is None:
                        errors[f"{where}.{field}"] = "Must be an array of section types."
                    elif bad:
                        errors[f"{where}.{field}"] = f"Unknown section type(s): {', '.join(map(str, bad))}."
                if "sections" in cfg and isinstance(cfg["sections"], list) and not cfg["sections"]:
                    errors[f"{where}.sections"] = "A collection needs at least one section in its template."
                for field in ("label", "plural", "indexPath", "pathPrefix", "pageType", "listingNote"):
                    if field in cfg and not isinstance(cfg[field], str):
                        errors[f"{where}.{field}"] = "Must be a string."
                if "fields" in cfg and not isinstance(cfg["fields"], dict):
                    errors[f"{where}.fields"] = 'Must be an object of {"name": {"label", "type"?, "options"?}}.'

    seo = payload.get("seoDefaults")
    if isinstance(seo, dict) and "robots" in seo and not isinstance(seo["robots"], dict):
        errors["seoDefaults.robots"] = "Must be an object."

    return errors


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)
