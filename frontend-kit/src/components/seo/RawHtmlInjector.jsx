"use client";

import { useEffect } from "react";

// Injects admin-supplied HTML snippets (SiteSettings.analytics.custom*)
// verbatim. Scripts inserted via innerHTML never execute, so each <script>
// is re-created as a live element.
export default function RawHtmlInjector({ snippets = [], target = "head", position = "end" }) {
    const key = JSON.stringify(snippets);

    useEffect(() => {
        const list = JSON.parse(key).filter((s) => typeof s === "string" && s.trim());
        if (!list.length) return undefined;

        const parent = target === "head" ? document.head : document.body;
        const inserted = [];

        for (const snippet of list) {
            const template = document.createElement("template");
            template.innerHTML = snippet;

            for (const node of Array.from(template.content.childNodes)) {
                let el = node;
                if (node.nodeName === "SCRIPT") {
                    el = document.createElement("script");
                    for (const attr of node.attributes) el.setAttribute(attr.name, attr.value);
                    el.text = node.textContent;
                }
                el.dataset && (el.dataset.cmsInjected = "1");
                if (position === "start") parent.insertBefore(el, parent.firstChild);
                else parent.appendChild(el);
                inserted.push(el);
            }
        }

        return () => inserted.forEach((el) => el.remove());
    }, [key, target, position]);

    return null;
}
