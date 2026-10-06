"use client";

import { useContext } from "react";

import { SectionEditContext } from "@/components/dynamic/edit-context";
import { paragraphs } from "@/components/dynamic/media";

// Plain paragraphs (split on blank lines) for visitors; for an admin in
// edit mode, one multi-line editable block — blank lines become paragraphs.
export default function EditableParagraphs({ path = "content", text, className = "" }) {
    const ctx = useContext(SectionEditContext);
    if (ctx?.editMode) {
        return (
            <p className={className} style={{ whiteSpace: "pre-line" }}>
                <ctx.E.Text path={path} multiline placeholder="Write paragraphs here — a blank line starts a new one." />
            </p>
        );
    }
    return paragraphs(text).map((p, i) => (
        <p key={i} className={`${className} ${i ? "mt-4" : ""}`}>{p}</p>
    ));
}
