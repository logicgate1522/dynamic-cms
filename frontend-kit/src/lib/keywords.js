// Keyword matching — a verbatim port of dynamic-cms api/keywords.py, so
// "does this text contain the keyword" means the same thing in the live
// badges here and in every backend audit/prompt.

const STOP_WORDS = new Set([
    "a", "an", "and", "at", "by", "for", "from", "in", "into", "of", "on",
    "or", "the", "to", "with", "near", "your",
]);

export function keywordTokens(value) {
    return String(value || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word && !STOP_WORDS.has(word));
}

// Every significant word, in order and contiguous, connector words ignored.
export function containsKeyword(haystack, keyword) {
    const needle = keywordTokens(keyword);
    if (!needle.length) return false;
    const hay = keywordTokens(haystack);
    for (let i = 0; i + needle.length <= hay.length; i += 1) {
        if (needle.every((word, j) => hay[i + j] === word)) return true;
    }
    return false;
}

export function flattenText(value, out = []) {
    if (typeof value === "string") {
        if (value.trim()) out.push(value);
    } else if (Array.isArray(value)) {
        value.forEach((item) => flattenText(item, out));
    } else if (value && typeof value === "object") {
        Object.values(value).forEach((item) => flattenText(item, out));
    }
    return out;
}
