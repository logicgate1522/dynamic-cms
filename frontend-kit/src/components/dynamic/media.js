import { mediaUrl } from "@/lib/api";

// Image for a SectionMedia slot ("image", "items[2].image"), falling back
// to a URL stored directly in the section content.
export function slotImage(media = [], slot, fallbackUrl = "", fallbackAlt = "") {
    const entry = media.find((m) => m.slot === slot);
    const url = entry?.image?.url || fallbackUrl;
    if (!url) return null;
    return {
        src: mediaUrl(url),
        alt: entry?.alt_override || entry?.image?.alt_text || fallbackAlt || "",
        width: entry?.image?.width || undefined,
        height: entry?.image?.height || undefined,
    };
}

export function itemImage(media, index, item = {}) {
    return slotImage(media, `items[${index}].image`, typeof item.image === "string" ? item.image : "", item.alt || item.title || item.name || "");
}

// Plain-text paragraphs split on blank lines — never HTML.
export function paragraphs(text) {
    if (!text) return [];
    return String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

export const VIDEO_URL = /^https:\/\/(www\.)?(youtube\.com\/embed\/|youtu\.be\/|player\.vimeo\.com\/video\/)/i;
export const MAP_URL = /^https:\/\/(www\.)?(google\.com\/maps\/embed|maps\.google\.com\/maps\?.*output=embed|openstreetmap\.org\/export\/embed\.html)/i;

export function safeHref(href) {
    if (!href || typeof href !== "string") return null;
    const value = href.trim();
    if (/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(value)) return value;
    return null;
}

// Which of `keys` actually holds the value — the path an inline edit writes to.
export function keyOf(item, ...keys) {
    for (const key of keys) {
        const v = item?.[key];
        if (v !== undefined && v !== null && v !== "") return key;
    }
    return keys[0];
}

export function pick(obj, ...keys) {
    for (const key of keys) {
        const v = obj?.[key];
        if (v !== undefined && v !== null && v !== "") return v;
    }
    return "";
}
