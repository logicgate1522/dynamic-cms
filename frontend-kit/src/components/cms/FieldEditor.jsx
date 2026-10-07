"use client";

import { useState } from "react";

import { mediaUrl, uploadImage } from "@/lib/api";

/* =========================================
   Auto-generated form for any JSON value.
   Field types are inferred from the default
   value and key name; `hints` can override
   by path ("items[].icon").
========================================= */

const IMAGE_KEY = /(image|img|photo|avatar|logo|cover|thumbnail|picture|src)s?$/i;
const LONG_TEXT_KEY = /(text|description|desc|body|bio|quote|content|answer|paragraph|summary|excerpt|intro|message|note|subtitle)s?$/i;
const SHORT_TEXT_KEY = /(button|cta|link|submit|nav|quote)Text$/i;

export function humanize(key) {
    return String(key)
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/^\w/, (c) => c.toUpperCase());
}

function hintFor(hints, path) {
    if (!hints) return null;
    return hints[path.replace(/\[\d+\]/g, "[]")] || null;
}

function inferType(key, value, hint) {
    if (hint?.type) return hint.type;
    if (Array.isArray(value)) return "list";
    if (value !== null && typeof value === "object") return "object";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    if (IMAGE_KEY.test(String(key))) return "image";
    if (typeof value === "string" && (value.length > 70 || value.includes("\n") || (LONG_TEXT_KEY.test(String(key)) && !SHORT_TEXT_KEY.test(String(key))))) {
        return "textarea";
    }
    return "text";
}

// An empty item shaped like an existing one, for "Add item".
export function blankLike(value) {
    if (Array.isArray(value)) return [];
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blankLike(v)]));
    }
    if (typeof value === "number") return 0;
    if (typeof value === "boolean") return false;
    return "";
}

const inputClass = `
    w-full rounded-lg border border-[#D6DEE8] bg-white px-3 py-2
    text-[13px] text-[#1E293B] outline-none
    focus:border-[var(--cms-accent)] focus:ring-2 focus:ring-[var(--cms-accent)]/20
`;

function Label({ children, hint }) {
    return (
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#475569]">
            {hint?.label || children}
        </span>
    );
}

function ImageField({ value, onChange, label, hint }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function onFile(event) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setBusy(true);
        setError("");
        try {
            onChange(await uploadImage(file, hint?.category || "content"));
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div>
            <Label hint={hint}>{label}</Label>
            <div className="flex items-center gap-3">
                <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#D6DEE8] bg-[#F1F5F9]">
                    {value ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={mediaUrl(value)} alt="" className="h-full w-full object-cover" />
                    ) : (
                        <span className="text-[11px] text-[#64748B]">No image</span>
                    )}
                </div>
                <div className="flex flex-col gap-1.5">
                    <label className="inline-flex cursor-pointer items-center justify-center rounded-lg bg-[var(--cms-primary)] px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110">
                        {busy ? "Uploading…" : value ? "Replace image" : "Upload image"}
                        <input type="file" accept="image/*" className="hidden" onChange={onFile} disabled={busy} />
                    </label>
                    {value ? (
                        <button type="button" onClick={() => onChange("")} className="text-left text-[11px] text-[#B42318] hover:underline">
                            Remove
                        </button>
                    ) : null}
                </div>
            </div>
            {error ? <p className="mt-1 text-[11px] text-[#B42318]">{error}</p> : null}
        </div>
    );
}

function ListField({ value, onChange, label, path, hints, template }) {
    const [open, setOpen] = useState(() => new Set());
    const items = Array.isArray(value) ? value : [];
    const sample = template ?? items[0];
    const isObjectList = sample !== null && typeof sample === "object" && !Array.isArray(sample);

    const update = (next) => onChange(next);
    const move = (index, delta) => {
        const target = index + delta;
        if (target < 0 || target >= items.length) return;
        const next = [...items];
        [next[index], next[target]] = [next[target], next[index]];
        update(next);
    };
    const remove = (index) => update(items.filter((_, i) => i !== index));
    const add = () => {
        update([...items, sample === undefined ? "" : blankLike(sample)]);
        setOpen((prev) => new Set(prev).add(items.length));
    };
    const toggle = (index) =>
        setOpen((prev) => {
            const next = new Set(prev);
            next.has(index) ? next.delete(index) : next.add(index);
            return next;
        });

    const itemTitle = (item, index) => {
        if (!isObjectList) return null;
        const first = Object.values(item || {}).find((v) => typeof v === "string" && v.trim() && !/^\/|^https?:/.test(v));
        return first ? first.slice(0, 60) : `Item ${index + 1}`;
    };

    const iconButton = "rounded-md px-1.5 py-1 text-[12px] text-[#475569] hover:bg-[#E2E8F0] disabled:opacity-30";

    return (
        <div>
            <Label hint={hintFor(hints, path)}>{label}</Label>
            <div className="space-y-2">
                {items.map((item, index) => (
                    <div key={index} className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC]">
                        <div className="flex items-center gap-1 px-2 py-1.5">
                            {isObjectList ? (
                                <button type="button" onClick={() => toggle(index)} className="flex-1 truncate text-left text-[13px] font-medium text-[#1E293B]">
                                    <span className="mr-1.5 inline-block w-3 text-[#64748B]">{open.has(index) ? "▾" : "▸"}</span>
                                    {itemTitle(item, index)}
                                </button>
                            ) : (
                                <div className="flex-1">
                                    <FieldInput
                                        fieldKey={label}
                                        value={item}
                                        path={`${path}[${index}]`}
                                        hints={hints}
                                        bare
                                        onChange={(v) => update(items.map((it, i) => (i === index ? v : it)))}
                                    />
                                </div>
                            )}
                            <button type="button" className={iconButton} onClick={() => move(index, -1)} disabled={index === 0} aria-label="Move up">↑</button>
                            <button type="button" className={iconButton} onClick={() => move(index, 1)} disabled={index === items.length - 1} aria-label="Move down">↓</button>
                            <button type="button" className={`${iconButton} text-[#B42318]`} onClick={() => remove(index)} aria-label="Remove">✕</button>
                        </div>
                        {isObjectList && open.has(index) ? (
                            <div className="space-y-3 border-t border-[#E2E8F0] px-3 py-3">
                                <ObjectFields
                                    value={item}
                                    template={sample}
                                    path={`${path}[${index}]`}
                                    hints={hints}
                                    onChange={(v) => update(items.map((it, i) => (i === index ? v : it)))}
                                />
                            </div>
                        ) : null}
                    </div>
                ))}
            </div>
            <button
                type="button"
                onClick={add}
                className="mt-2 rounded-lg border border-dashed border-[#94A3B8] px-3 py-1.5 text-[12px] font-semibold text-[#334155] hover:border-[var(--cms-accent)] hover:text-[var(--cms-accent)]"
            >
                + Add {isObjectList ? "item" : "entry"}
            </button>
        </div>
    );
}

function FieldInput({ fieldKey, value, onChange, path, hints, template, bare = false }) {
    const hint = hintFor(hints, path);
    const type = inferType(fieldKey, template !== undefined ? template : value, hint);
    const label = humanize(fieldKey);

    if (hint?.hidden) return null;

    if (type === "object") {
        return (
            <fieldset className="rounded-xl border border-[#E2E8F0] p-3">
                <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#475569]">{hint?.label || label}</legend>
                <div className="space-y-3">
                    <ObjectFields value={value || {}} template={template} path={path} hints={hints} onChange={onChange} />
                </div>
            </fieldset>
        );
    }

    if (type === "list") {
        const sample = Array.isArray(template) && template.length ? template[0] : undefined;
        return <ListField value={value} onChange={onChange} label={label} path={path} hints={hints} template={sample} />;
    }

    if (type === "image") {
        return <ImageField value={value} onChange={onChange} label={label} hint={hint} />;
    }

    let control;
    if (type === "boolean") {
        return (
            <label className="flex items-center gap-2 text-[13px] text-[#1E293B]">
                <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
                {hint?.label || label}
            </label>
        );
    } else if (type === "select") {
        control = (
            <select className={inputClass} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
                {(hint.options || []).map((opt) => {
                    const optValue = typeof opt === "object" ? opt.value : opt;
                    const optLabel = typeof opt === "object" ? opt.label : humanize(opt);
                    return <option key={optValue} value={optValue}>{optLabel}</option>;
                })}
            </select>
        );
    } else if (type === "number") {
        control = (
            <input type="number" className={inputClass} value={value ?? 0} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} />
        );
    } else if (type === "datetime") {
        control = <input type="datetime-local" className={inputClass} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    } else if (type === "textarea") {
        control = (
            <textarea className={`${inputClass} min-h-[84px] resize-y leading-relaxed`} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
        );
    } else {
        control = <input type="text" className={inputClass} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
    }

    if (bare) return control;

    return (
        <label className="block">
            <Label hint={hint}>{label}</Label>
            {control}
            {hint?.help ? <span className="mt-1 block text-[11px] text-[#64748B]">{hint.help}</span> : null}
        </label>
    );
}

export function ObjectFields({ value, onChange, path = "", hints, template }) {
    const shape = template && typeof template === "object" ? { ...template, ...value } : value || {};

    return Object.keys(shape).map((key) => (
        <FieldInput
            key={key}
            fieldKey={key}
            value={value?.[key]}
            template={template && typeof template === "object" ? template[key] : undefined}
            path={path ? `${path}.${key}` : key}
            hints={hints}
            onChange={(v) => onChange({ ...value, [key]: v })}
        />
    ));
}
