"use client";

import { Fragment, createContext, useContext, useState } from "react";

/* =========================================
   Inline editing inside dynamic section adapters.
   Adapters render text through <T>, list tools
   through <ItemTools>/<AddItem> and image swaps
   through <SlotUpload>. Outside an admin
   <SectionSlot> they render exactly what a plain
   adapter would (or nothing), so the public page
   is unchanged.
========================================= */

export const SectionEditContext = createContext(null);

function lines(text) {
    return String(text)
        .split("\n")
        .map((line, index) => (
            <Fragment key={index}>
                {index > 0 ? <br /> : null}
                {line}
            </Fragment>
        ));
}

export function T({ path, value, multiline = false, placeholder }) {
    const ctx = useContext(SectionEditContext);
    if (!ctx?.editMode) {
        const text = value === undefined || value === null ? "" : String(value);
        return multiline && text.includes("\n") ? lines(text) : text;
    }
    return <ctx.E.Text path={path} multiline={multiline} placeholder={placeholder} />;
}

export function ItemTools({ path = "items", index, className }) {
    const ctx = useContext(SectionEditContext);
    return ctx?.editMode ? <ctx.E.Item path={path} index={index} className={className} /> : null;
}

export function AddItem({ path = "items", label = "Add item", className = "mt-6" }) {
    const ctx = useContext(SectionEditContext);
    return ctx?.editMode ? <ctx.E.Add path={path} label={label} className={className} /> : null;
}

export function SlotUpload({ slot = "image", className = "left-3 top-3" }) {
    const ctx = useContext(SectionEditContext);
    const [busy, setBusy] = useState(false);
    if (!ctx?.editMode) return null;
    return (
        <label className={`cms-ui ${busy ? "" : "cms-hover-tools"} absolute z-[55] inline-flex cursor-pointer items-center rounded-full bg-[#0F172A]/85 px-3 py-1.5 text-[11px] font-semibold text-white shadow-lg ring-1 ring-white/30 hover:bg-[var(--cms-accent)] ${className}`}>
            {busy ? "Uploading…" : "Replace image"}
            <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={busy}
                onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    setBusy(true);
                    try {
                        await ctx.uploadSlot(slot, file);
                    } finally {
                        setBusy(false);
                    }
                }}
            />
        </label>
    );
}

// The key an adapter actually reads (items may use "title" or "name"…), so
// inline edits write back to the same field.

