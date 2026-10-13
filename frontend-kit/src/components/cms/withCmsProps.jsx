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
export function withCmsProps(Component, { label = "Section", props: copyProps = [], shared = false } = {}) {
    function CmsBlock({ cmsName, ...props }) {
        const copy = {};
        for (const key of copyProps) if (props[key] !== undefined) copy[key] = props[key];
        const defaults = useStable(copy);
        const { data, hidden, editButton } = useCms(cmsName || `unnamed-${label}`, defaults, { label, shared });
        if (hidden) return null;
        const merged = {};
        for (const key of copyProps) if (data[key] !== undefined) merged[key] = data[key];
        return (
            <div className="relative">
                {editButton}
                <Component {...props} {...merged} />
            </div>
        );
    }
    CmsBlock.displayName = `CmsBlock(${Component.displayName || Component.name || label})`;
    return CmsBlock;
}
