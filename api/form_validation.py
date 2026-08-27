"""Server-side validation of a form submission against its field definition
(stored in ComponentData as `form-<name>`).

`validate_submission(definition, payload)` -> (cleaned_dict, errors_dict).
errors_dict is {field_name: message}; empty means valid.
"""

import re
from datetime import datetime

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_URL_RE = re.compile(r"^https?://", re.IGNORECASE)

CHOICE_TYPES = {"select", "radio"}
MULTI_TYPES = {"multiselect", "checkboxes"}


def validate_submission(definition, payload):
    definition = definition or {}
    fields = definition.get("fields") or []
    errors = {}
    cleaned = {}

    for spec in fields:
        if not isinstance(spec, dict):
            continue
        name = spec.get("name")
        if not name or spec.get("type") == "hidden":
            if name and name in payload:
                cleaned[name] = payload[name]
            continue

        ftype = spec.get("type", "text")
        raw = payload.get(name)
        present = raw not in (None, "", [], {})

        if spec.get("required") and not present:
            errors[name] = f"{spec.get('label', name)} is required."
            continue
        if not present:
            continue

        err = _validate_value(spec, ftype, raw)
        if err:
            errors[name] = err
        else:
            cleaned[name] = raw

    # consent
    consent = definition.get("consent") or {}
    if consent.get("required") and not payload.get("consent"):
        errors["consent"] = consent.get("text") or "Consent is required."
    elif "consent" in payload:
        cleaned["consent"] = payload["consent"]

    return cleaned, errors


def _validate_value(spec, ftype, value):
    v = spec.get("validation") or {}
    label = spec.get("label", spec.get("name"))

    if ftype == "email" and not _EMAIL_RE.match(str(value)):
        return f"{label} must be a valid email address."
    if ftype == "url" and not _URL_RE.match(str(value)):
        return f"{label} must be a valid URL."
    if ftype in ("number", "range", "rating"):
        try:
            num = float(value)
        except (TypeError, ValueError):
            return f"{label} must be a number."
        if v.get("min") is not None and num < v["min"]:
            return f"{label} must be at least {v['min']}."
        if v.get("max") is not None and num > v["max"]:
            return f"{label} must be at most {v['max']}."
    if ftype in ("date", "time", "datetime"):
        fmt = {"date": "%Y-%m-%d", "time": "%H:%M",
               "datetime": "%Y-%m-%dT%H:%M"}[ftype]
        try:
            datetime.strptime(str(value)[:len("2026-01-01T00:00")], fmt)
        except ValueError:
            return f"{label} is not a valid {ftype}."

    if isinstance(value, str):
        if v.get("minLength") and len(value) < v["minLength"]:
            return f"{label} must be at least {v['minLength']} characters."
        if v.get("maxLength") and len(value) > v["maxLength"]:
            return f"{label} must be at most {v['maxLength']} characters."
        if v.get("pattern"):
            try:
                if not re.search(v["pattern"], value):
                    return f"{label} is not in the expected format."
            except re.error:
                pass

    options = [o["value"] if isinstance(o, dict) else o for o in (spec.get("options") or [])]
    if options:
        if ftype in CHOICE_TYPES and value not in options:
            return f"{label}: '{value}' is not an allowed option."
        if ftype in MULTI_TYPES:
            vals = value if isinstance(value, list) else [value]
            bad = [x for x in vals if x not in options]
            if bad:
                return f"{label}: {', '.join(map(str, bad))} not allowed."
    return None
