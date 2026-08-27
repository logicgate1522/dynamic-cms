from django.utils.text import slugify


def build_unique_slug(model, value, instance_pk=None, field="slug"):
    """Slugify `value` and append -2, -3… until unique for `model`."""
    base = slugify(value) or "page"
    candidate = base
    n = 2
    qs = model.objects.all()
    if instance_pk is not None:
        qs = qs.exclude(pk=instance_pk)
    while qs.filter(**{field: candidate}).exists():
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def deep_merge(base, incoming):
    """
    Recursively merge `incoming` into `base`.

    - dict + dict at any depth: merge key by key, recursing into nested dicts.
    - anything else (lists, scalars, type mismatches): `incoming` wins outright.
      Lists are intentionally replaced wholesale rather than merged — there's
      no generic way to know whether an admin reordered, added, or removed
      list items, so the whole list is treated as one field.
    """
    if isinstance(base, dict) and isinstance(incoming, dict):
        merged = dict(base)
        for key, incoming_value in incoming.items():
            if key in merged:
                merged[key] = deep_merge(merged[key], incoming_value)
            else:
                merged[key] = incoming_value
        return merged
    return incoming
