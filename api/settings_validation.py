"""Validation for the SiteSettings.data blob.

The blob stays free-form and deep-merged, but a handful of shapes are
load-bearing (raw script injection, geo coordinates, opening hours) and a
malformed value there silently breaks the frontend or the schema builder.
This checks only the *canonical* keys that are present in the incoming
PATCH; unknown keys pass through untouched. Returns {dotted.path: message}.
"""

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

    seo = payload.get("seoDefaults")
    if isinstance(seo, dict) and "robots" in seo and not isinstance(seo["robots"], dict):
        errors["seoDefaults.robots"] = "Must be an object."

    return errors


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)
