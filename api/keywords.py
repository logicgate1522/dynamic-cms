"""Keyword matching shared by every SEO check and AI prompt.

"Does this text contain the keyword?" must mean exactly the same thing in
the SEO audit, the whole-page keyword coverage, and the frontend badges —
the frontend kit ports these three functions verbatim (lib/keywords.js).

A keyword matches when every significant word appears, in order and
contiguously, once connector words ("in", "for", "near", ...) are ignored on
both sides: "accountant in leeds" matches "Leeds accountants"? No — order
matters — but it does match "Accountant for Leeds businesses".
"""

import re

STOP_WORDS = frozenset({
    "a", "an", "and", "at", "by", "for", "from", "in", "into", "of", "on",
    "or", "the", "to", "with", "near", "your",
})

_SPLIT = re.compile(r"[^a-z0-9]+")


def keyword_tokens(value):
    return [w for w in _SPLIT.split(str(value or "").lower()) if w and w not in STOP_WORDS]


def contains_keyword(haystack, keyword):
    needle = keyword_tokens(keyword)
    if not needle:
        return False
    hay = keyword_tokens(haystack)
    n = len(needle)
    return any(hay[i:i + n] == needle for i in range(len(hay) - n + 1))


def flatten_text(value, out=None):
    """Every non-empty string inside any JSON-ish value."""
    out = [] if out is None else out
    if isinstance(value, str):
        if value.strip():
            out.append(value)
    elif isinstance(value, dict):
        for v in value.values():
            flatten_text(v, out)
    elif isinstance(value, (list, tuple)):
        for v in value:
            flatten_text(v, out)
    return out


def section_coverage(keyword, sections):
    """sections: {id: {"label", "content", "excludeFromKeywordAudit"?}} ->
    per-section keyword presence + overall percentage (excluded sections are
    still listed but don't count toward the score)."""
    rows = []
    counted = with_keyword = 0
    for sid, entry in (sections or {}).items():
        entry = entry if isinstance(entry, dict) else {}
        excluded = bool(entry.get("excludeFromKeywordAudit"))
        has = contains_keyword(" \n ".join(flatten_text(entry.get("content"))), keyword) if keyword else None
        rows.append({"id": sid, "label": entry.get("label") or sid, "hasKeyword": has, "excluded": excluded})
        if not excluded:
            counted += 1
            with_keyword += 1 if has else 0
    percent = round(with_keyword / counted * 100) if keyword and counted else None
    return {"keyword": keyword or "", "sections": rows, "withKeyword": with_keyword,
            "total": counted, "percent": percent}
