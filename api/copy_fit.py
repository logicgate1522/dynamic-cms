"""Copy that fits: length limits for AI-written text.

An AI that is asked to "improve" a block happily writes three paragraphs where
the design has one line. This module gives every prompt the same two tools:

  limits_for(content)    a mirror of `content` where each editable string is
                         replaced by the most characters it may have — derived
                         from the text that is there now (the design was made
                         for that length) and capped by the field's role.
  fit_to_limits(new, old, warnings)
                         the same check on the way back in: a string that
                         does not fit keeps its previous text and a warning
                         says why. Nothing oversized ever reaches the page.

LENGTH_GUIDE is the human-readable version, repeated in every prompt that
writes copy.
"""

import re

LENGTH_GUIDE = """LENGTH — write to fit the design, not to fill space:
- Match the length of the current text of every field. A field may be at most about 25% (or 16 characters, for short labels) longer than it is now; shorter is always fine. The "LIMITS" object below gives the maximum characters per field (same keys and nesting as the content) — never exceed it.
- Typical sizes when a field is new or empty: eyebrow / badge / label 1–3 words (≤ 30 characters); button or link text 1–4 words (≤ 28); page or hero headline 4–10 words (≤ 80); section heading 3–9 words (≤ 70); card / list-item title ≤ 60; subheading or hero sub-text 1–2 sentences (≤ 170); card / list-item body 1–2 sentences (≤ 150); FAQ question ≤ 110, answer 2–4 sentences (≤ 500); paragraph of body copy 40–90 words; navigation and footer link labels 1–3 words.
- One idea per field. Do not add paragraphs, lists or sentences to a field that holds a single line. Do not pack several sentences into a headline.
- A field that is a short label stays a short label."""

# Keys whose value is not copy: never limited, never rewritten for length.
_SKIP_KEY = re.compile(r"(href|src|url|image|icon|slug|id|alt|color|colour|variant|type|position|target|rel|path|link)$", re.I)
_CAPS = [  # (key pattern, max characters)
    (re.compile(r"(eyebrow|kicker|badge|tag|label|pill|step|number|year)$", re.I), 40),
    (re.compile(r"(button|cta|buttonText|linkText|btn)", re.I), 30),
    (re.compile(r"(title|heading|headline|name|question)$", re.I), 110),
]
MIN_LIMIT = 24


def _is_copy(key, value):
    if not isinstance(value, str) or not value.strip():
        return False
    if key and _SKIP_KEY.search(str(key)):
        return False
    if re.match(r"^(https?://|/|#|mailto:|tel:)", value.strip()):
        return False
    return True


def _limit_for(key, text):
    current = len(text)
    limit = max(round(current * 1.25), current + 16, MIN_LIMIT)
    for pattern, cap in _CAPS:
        if key and pattern.search(str(key)):
            limit = min(limit, max(cap, current))
            break
    return limit


def limits_for(value, key=None):
    """Mirror of `value`: copy strings become their character limit; everything
    else (links, images, ids, numbers) is dropped. Empty containers are dropped."""
    if isinstance(value, str):
        return _limit_for(key, value) if _is_copy(key, value) else None
    if isinstance(value, list):
        mirror = [limits_for(v, key) for v in value]
        return mirror if any(m is not None for m in mirror) else None
    if isinstance(value, dict):
        mirror = {k: m for k, v in value.items() if (m := limits_for(v, k)) is not None}
        return mirror or None
    return None


def fit_to_limits(new, old, warnings, path="", key=None):
    """Return `new` with every copy string that outgrew its limit replaced by
    the previous text (appending a warning). A new list item is checked
    against the first existing item (items of a list share a template)."""
    if isinstance(new, str):
        if old is not None and isinstance(old, str) and _is_copy(key, old):
            limit = _limit_for(key, old)
            if len(new) > limit:
                warnings.append(
                    f"{path or 'a field'}: kept the existing text — the AI wrote {len(new)} characters and this field fits {limit}."
                )
                return old
        return new
    if isinstance(new, list):
        out = []
        for i, item in enumerate(new):
            counterpart = old[i] if isinstance(old, list) and i < len(old) else (old[0] if isinstance(old, list) and old else None)
            out.append(fit_to_limits(item, counterpart, warnings, f"{path}[{i + 1}]", key))
        return out
    if isinstance(new, dict):
        return {k: fit_to_limits(v, old.get(k) if isinstance(old, dict) else None, warnings, f"{path}.{k}" if path else k, k)
                for k, v in new.items()}
    return new
