"use client";

import { useCms } from "@/components/cms/useCms";
import { useStable } from "@/lib/useStable";

/* =========================================
   withCmsProps(Component, { label, props, shared })

   For a SECTION COMPONENT whose copy arrives as props (a page passes
   `title`, `sub`, `items`... taken from a data file). It becomes a CMS block:
   the props named in `props` are the block's defaults (the original wording,
   R9) and the saved content is passed back to the component.

   Editing is IN PLACE, like every other block (R2): the block's binder
   (components/cms/Binder.jsx) makes every string the component prints, every
   image and every image list editable on the page itself — there is no
   popup-only path. The "All fields" panel is an addition, for AI and history.
   Text the component builds itself (templates, truncation) cannot be bound:
   print it through useCms + <E.Text> instead, or the inline-coverage gate
   will list it.

     export const Faq = withCmsProps(FaqBase, { label: "FAQ", props: ["title", "sub", "items"] });
     <Faq cmsName={`software-${slug}-faq`} title="…" sub="…" items={faqs} startHref="/start" />
========================================= */
const isPlainObject = (value) => value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const SKIP_PROPS = new Set(["cmsName", "children", "className", "style", "ref", "key"]);

// The JSON-safe part of a prop: strings, numbers, booleans, plain arrays/objects. Functions, components and
// React elements (an `icon`, a `visual`) are left out of what is stored; they stay as the code passes them.
function toPlain(value, depth = 0) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
    if (depth > 8 || typeof value !== "object" || value.$$typeof) return undefined;
    if (Array.isArray(value)) return value.map((item) => toPlain(item, depth + 1));
    if (!isPlainObject(value)) return undefined; // a Date, a Map, a class instance: stays as the code passes it
    const out = {};
    for (const [key, child] of Object.entries(value)) {
        const plain = toPlain(child, depth + 1);
        if (plain !== undefined) out[key] = plain;
    }
    return out;
}

// The saved content wins; whatever was left out of it (icons, elements) comes back from the code's own props.
function mergeBack(original, stored) {
    if (stored === undefined) return original;
    if (Array.isArray(stored)) return stored.map((item, i) => mergeBack(Array.isArray(original) ? original[i] : undefined, item));
    if (stored !== null && typeof stored === "object") {
        const base = isPlainObject(original) ? original : {};
        return { ...base, ...Object.fromEntries(Object.entries(stored).map(([key, child]) => [key, mergeBack(base[key], child)])) };
    }
    return stored;
}

/* props: ["title", "items"]  — just these props are the block's content
   props: "auto"              — every JSON-safe prop is (what the page shows is what the editor can change) */
export function withCmsProps(Component, { label = "Section", props: copyProps = "auto", shared = false } = {}) {
    function Wired({ cmsName, ...props }) {
        const keys = copyProps === "auto" ? Object.keys(props).filter((key) => !SKIP_PROPS.has(key)) : copyProps;
        const copy = {};
        for (const key of keys) {
            const plain = props[key] === undefined ? undefined : toPlain(props[key]);
            if (plain !== undefined) copy[key] = plain;
        }
        const defaults = useStable(copy);
        const { data, hidden, editButton } = useCms(cmsName, defaults, { label, shared });
        if (hidden) return null;
        const merged = {};
        for (const key of keys) if (data[key] !== undefined) merged[key] = mergeBack(props[key], data[key]);
        return (
            <div className="relative">
                {editButton}
                <Component {...props} {...merged} />
            </div>
        );
    }
    function CmsBlock(props) {
        // A block needs its own unique name: without one, every page's copy would share a single stored block.
        if (!props.cmsName) {
            if (process.env.NODE_ENV !== "production") console.error(`withCmsProps(${label}): pass a unique cmsName — rendering it as plain, uneditable content.`);
            const { cmsName, ...rest } = props; // eslint-disable-line no-unused-vars
            return <Component {...rest} />;
        }
        return <Wired {...props} />;
    }
    CmsBlock.displayName = `CmsBlock(${Component.displayName || Component.name || label})`;
    return CmsBlock;
}
