"""Optional server-side validation of a ComponentData payload against a
ComponentSchema. Only invoked when the row (or the incoming PATCH) sets a
`schema_key` that resolves to a ComponentSchema row.

Deliberately lenient for partial PATCHes: only fields *present* in the
payload are type-checked, plus any `required` field that is present-but-empty
is flagged. Unknown fields are allowed (schemas are extensible per project).
Returns a {dotted.field: message} dict; empty dict means valid.
"""

_TYPE_CHECKS = {
    "string": lambda v: isinstance(v, str),
    "text": lambda v: isinstance(v, str),
    "url": lambda v: isinstance(v, str),
    "image": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "list": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
}


def validate_against_schema(payload, schema):
    """`schema` is the ComponentSchema.schema dict. `payload` is the incoming
    (partial) data. Returns {field_path: message}."""
    errors = {}
    fields = (schema or {}).get("fields") or {}
    _walk(payload if isinstance(payload, dict) else {}, fields, "", errors)
    return errors


def _walk(payload, fields, prefix, errors):
    for name, spec in fields.items():
        if name not in payload:
            continue
        path = f"{prefix}{name}"
        value = payload[name]
        ftype = spec.get("type", "string")
        checker = _TYPE_CHECKS.get(ftype)
        if checker and not checker(value):
            errors[path] = f"Expected {ftype}."
            continue
        if spec.get("required") and _is_empty(value):
            errors[path] = "This field is required and cannot be empty."
            continue
        if ftype == "object" and spec.get("fields"):
            _walk(value, spec["fields"], path + ".", errors)
        if ftype == "list" and isinstance(spec.get("item"), dict):
            for i, item in enumerate(value):
                if isinstance(item, dict):
                    _walk(item, spec["item"], f"{path}[{i}].", errors)


def _is_empty(value):
    if value is None:
        return True
    if isinstance(value, (str, list, dict)) and len(value) == 0:
        return True
    return False
