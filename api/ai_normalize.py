"""Clean and validate an AI reply before the admin UI applies it.

AI replies are trusted for intent, never for shape. Every paste box in the
admin UI sends its text to POST ai/normalize/ and applies only what comes back:

- strips ``` fences and prose around the JSON (takes the ```json block, or
  the outermost {...}/[...] in the text)
- unwraps markdown-linkified URLs: "[https://x.jpg](https://x.jpg)" -> "https://x.jpg"
- unwraps a stray {"content": {...}} / {"label", "content"} layer
- deep-merges onto the current content, so a field the AI omitted is kept
- refuses to shrink an existing list of 3+ items (a classic AI truncation
  failure) and keeps the original, with a warning the admin sees
- maps the flat SEO keys the seo/keyword prompts ask for onto PageSEO's
  nested shape
"""

import json
import re

ARRAY_SHRINK_GUARD_MIN_LENGTH = 3

_FENCE = re.compile(r"```(?:json|JSON)?\s*\n?(.*?)```", re.DOTALL)
_MD_LINK = re.compile(r"^\[([^\]]+)\]\(([^)]+)\)$")
_BRACKETED_URL = re.compile(r"^\[(https?://[^\]]+)\]$")
_INLINE_MD_LINK = re.compile(r"\[([^\]\n]+)\]\((?:https?://|mailto:|tel:|/)[^)\s]*\)")
# Body-copy fields where "[anchor](/internal-path)" is a real link (rendered
# by components/dynamic/EditableParagraphs.jsx). Mirrors INTERNAL_LINK there.
LINKABLE_FIELDS = {"content"}
INTERNAL_LINK = re.compile(r"\[([^\]\n]+)\]\((/(?!/)[^)\s]*)\)")


class NormalizeError(ValueError):
    pass


def extract_json(raw):
    """The JSON value inside an AI reply (fenced block preferred)."""
    text = (raw or "").strip()
    if not text:
        raise NormalizeError("The reply is empty.")
    candidates = [m.group(1).strip() for m in _FENCE.finditer(text)]
    candidates.append(text)
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = text.find(opener), text.rfind(closer)
        if start != -1 and end > start:
            candidates.append(text[start:end + 1])
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except (ValueError, TypeError):
            continue
    raise NormalizeError(
        "That isn't valid JSON — check for a stray comma, a missing quote, or text cut off at the end."
    )


def _keep_internal(match):
    """Inside body copy, an internal link "[anchor](/path)" stays (the kit
    renders it, R34); any other link keeps only its words."""
    return match.group(0) if INTERNAL_LINK.fullmatch(match.group(0)) else match.group(1)


def strip_markdown_links(value, key=None):
    if isinstance(value, str):
        m = _MD_LINK.match(value.strip())
        if m and key not in LINKABLE_FIELDS:
            label, target = m.groups()
            return target if re.match(r"^(https?://|/)", target) else label
        m = _BRACKETED_URL.match(value.strip())
        if m:
            return m.group(1)
        # Links inside prose: only body copy (LINKABLE_FIELDS) renders
        # internal links; everywhere else the site shows plain text.
        if key in LINKABLE_FIELDS:
            return _INLINE_MD_LINK.sub(_keep_internal, value)
        return _INLINE_MD_LINK.sub(r"\1", value)
    if isinstance(value, list):
        return [strip_markdown_links(v, key) for v in value]
    if isinstance(value, dict):
        return {k: strip_markdown_links(v, k) for k, v in value.items()}
    return value


def unwrap_content(value):
    """{"content": {...}} or {"label": ..., "content": {...}} -> {...}"""
    if isinstance(value, dict) and isinstance(value.get("content"), dict):
        extra = set(value) - {"content", "label", "type", "id"}
        if not extra:
            return value["content"]
    return value


def guarded_merge(base, patch, warnings, path=""):
    """Deep-merge `patch` onto `base`: objects merge key by key, arrays
    replace — unless the array shrank from 3+ items, which is refused."""
    if isinstance(patch, list):
        if isinstance(base, list) and len(base) >= ARRAY_SHRINK_GUARD_MIN_LENGTH and len(patch) < len(base):
            warnings.append(
                f"{path or 'a list'}: kept the existing {len(base)} items — the AI returned only {len(patch)}, "
                "which looks like accidental data loss. Trim it by hand if you really meant to."
            )
            return base
        return patch
    if isinstance(patch, dict):
        merged = dict(base) if isinstance(base, dict) else {}
        for key, value in patch.items():
            merged[key] = guarded_merge(merged.get(key), value, warnings, f"{path}.{key}" if path else key)
        return merged
    return base if patch is None else patch


# --------------------------------------------------------------- kinds

def normalize_section(raw, current):
    parsed = unwrap_content(strip_markdown_links(extract_json(raw)))
    if not isinstance(parsed, dict):
        raise NormalizeError("Expected a JSON object for this block's content.")
    warnings = []
    return {"content": guarded_merge(current or {}, parsed, warnings), "warnings": warnings}


def normalize_page_assist(raw, current):
    """current: {id: content}. Reply: {id: content} for changed blocks."""
    parsed = strip_markdown_links(extract_json(raw))
    if not isinstance(parsed, dict):
        raise NormalizeError("Expected a JSON object keyed by block id.")
    current = current or {}
    applied, unmatched, warnings = {}, [], []
    for block_id, value in parsed.items():
        if block_id not in current:
            unmatched.append(block_id)
            continue
        block_warnings = []
        applied[block_id] = guarded_merge(current[block_id] or {}, unwrap_content(value), block_warnings)
        warnings.extend(f"{block_id}: {w}" for w in block_warnings)
    return {"applied": applied, "unmatched": unmatched, "warnings": warnings}


_SEO_FIELD_PATCH = {
    "seoTitle": lambda v: {"seoTitle": v},
    "metaDescription": lambda v: {"metaDescription": v},
    "canonicalUrl": lambda v: {"canonicalUrl": v},
    "primaryKeyword": lambda v: {"keywords": {"primary": v}},
    "secondaryKeywords": lambda v: {"keywords": {"secondary": _str_list(v)}},
    "variations": lambda v: {"keywords": {"variations": _str_list(v)}},
    "searchIntent": lambda v: {"searchIntent": v},
    "ogTitle": lambda v: {"social": {"ogTitle": v}},
    "ogDescription": lambda v: {"social": {"ogDescription": v}},
    "ogImageAlt": lambda v: {"social": {"ogImageAlt": v}},
    "twitterTitle": lambda v: {"social": {"twitterTitle": v}},
    "twitterDescription": lambda v: {"social": {"twitterDescription": v}},
    "robotsIndex": lambda v: {"robots": {"index": bool(v)}},
    "robotsFollow": lambda v: {"robots": {"follow": bool(v)}},
    "schemaBuilders": lambda v: {"schema": {"builders": _str_list(v)}},
}


def _str_list(value):
    if isinstance(value, str):
        value = [part.strip() for part in value.split(",")]
    return [str(v).strip() for v in (value or []) if str(v).strip()]


def normalize_seo(raw, path=""):
    """Reply with flat keys -> a PageSEO PATCH body (nested), plus any
    unknown keys. `breadcrumbName` becomes breadcrumbLabels[<page path>] (the
    key schema_builders.breadcrumb looks labels up by)."""
    parsed = strip_markdown_links(extract_json(raw))
    if not isinstance(parsed, dict):
        raise NormalizeError("Expected a JSON object of SEO fields.")
    patch, unknown = {}, []
    warnings = []
    for key, value in parsed.items():
        if key == "breadcrumbName":
            key = str(path or "").strip("/") or "home"
            patch = guarded_merge(patch, {"breadcrumbLabels": {key: value}}, warnings)
            continue
        builder = _SEO_FIELD_PATCH.get(key)
        if builder is None:
            unknown.append(key)
            continue
        patch = guarded_merge(patch, builder(value), warnings)
    if "searchIntent" in patch:
        from .prompts import SEARCH_INTENTS
        if patch["searchIntent"] not in SEARCH_INTENTS:
            unknown.append(f"searchIntent={patch.pop('searchIntent')}")
    return {"patch": patch, "unknown": unknown, "fields": len(parsed) - len(unknown)}


def normalize_page(raw):
    """A full page reply -> validated by the same parser paste-to-build uses."""
    from .dynamic_pages import DynamicPageParseError, parse_and_validate
    data = strip_markdown_links(extract_json(raw))
    try:
        return {"page": parse_and_validate(json.dumps(data))}
    except DynamicPageParseError as exc:
        raise NormalizeError(exc.errors) from exc
