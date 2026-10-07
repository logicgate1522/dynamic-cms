/* =========================================
   Hide / show — for blocks, sections and list items.

   Anything can be hidden by giving it `_hidden: true` in its content:
     - a whole useCms block      → data._hidden
     - a CMS-page section        → section content._hidden
     - one item in any list      → items[i]._hidden
   It is an ordinary edit: it saves as a draft and goes live on Publish.

   Visitors (and admins with editing off) get stripHidden(data): hidden list
   items are removed and hidden blocks/sections are not rendered at all — the
   content is not in the HTML. Admins with editing on see everything, with
   hidden things dimmed (cms.css: [data-cms-hidden]).
========================================= */

export const HIDDEN_KEY = "_hidden";

export function isHidden(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value) && value[HIDDEN_KEY]);
}

// Remove hidden items from every array, at any depth (objects are copied,
// never mutated). The `_hidden` flag itself is dropped from what remains.
export function stripHidden(value) {
    if (Array.isArray(value)) return value.filter((item) => !isHidden(item)).map(stripHidden);
    if (value && typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (key !== HIDDEN_KEY) out[key] = stripHidden(item);
        }
        return out;
    }
    return value;
}
