"use client";

import Link from "next/link";
import { useContext } from "react";

import { SectionEditContext } from "@/components/dynamic/edit-context";
import { paragraphs } from "@/components/dynamic/media";

// Internal links in body copy (R34): "[anchor words](/path)". Mirrors
// INTERNAL_LINK in the backend's api/ai_normalize.py; only site paths.
const INTERNAL_LINK = /\[([^\]\n]+)\]\((\/(?!\/)[^)\s]*)\)/g;

export function withLinks(line) {
    const out = [];
    let last = 0;
    for (const m of line.matchAll(INTERNAL_LINK)) {
        if (m.index > last) out.push(line.slice(last, m.index));
        out.push(<Link key={m.index} href={m[2]} className="font-semibold underline underline-offset-4 hover:opacity-80">{m[1]}</Link>);
        last = m.index + m[0].length;
    }
    if (!out.length) return line;
    if (last < line.length) out.push(line.slice(last));
    return out;
}

// Plain paragraphs (split on blank lines) for visitors; for an admin in
// edit mode, one multi-line editable block — blank lines become paragraphs
// (an internal link shows as its "[anchor](/path)" source there).
// Lines starting with "- " render as a ticked list.
export default function EditableParagraphs({ path = "content", text, className = "" }) {
    const ctx = useContext(SectionEditContext);
    if (ctx?.editMode) {
        return (
            <p className={className} style={{ whiteSpace: "pre-line" }}>
                <ctx.E.Text path={path} multiline placeholder="Write paragraphs here — a blank line starts a new one." />
            </p>
        );
    }
    // A paragraph may mix text lines and "- " list lines (e.g. "We help:" then
    // a list): text lines stay paragraphs, runs of "- " lines become a ticked list.
    return paragraphs(text).map((p, i) => {
        const blocks = [];
        for (const raw of p.split("\n")) {
            const line = raw.trim();
            if (!line) continue;
            const bullet = /^[-•]\s+/.test(line);
            const last = blocks[blocks.length - 1];
            if (bullet && last?.list) last.items.push(line.replace(/^[-•]\s+/, ""));
            else if (bullet) blocks.push({ list: true, items: [line.replace(/^[-•]\s+/, "")] });
            else if (last && !last.list) last.text += ` ${line}`;
            else blocks.push({ list: false, text: line });
        }
        return (
            <div key={i} className={i ? "mt-4" : ""}>
                {blocks.map((block, j) =>
                    block.list ? (
                        <ul key={j} className={`${j ? "mt-3" : ""} space-y-3`}>
                            {block.items.map((item, k) => (
                                <li key={k} className={`${className} flex gap-3`}>
                                    <span className="mt-[3px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[#0F9E86]/10 text-[12px] font-bold text-[#0F9E86]" aria-hidden="true">✓</span>
                                    <span>{withLinks(item)}</span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p key={j} className={`${className} ${j ? "mt-3" : ""}`}>{withLinks(block.text)}</p>
                    )
                )}
            </div>
        );
    });
}
