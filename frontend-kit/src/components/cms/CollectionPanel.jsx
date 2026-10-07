"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { Notice, PasteBox, PromptBox, Segmented, Step, STRATEGY_OPTIONS } from "@/components/cms/ai";
import Drawer, { buttonStyles } from "@/components/cms/Drawer";
import { apiRequest, mediaUrl, uploadImage } from "@/lib/api";

/* =========================================
   Collections (configured per site in Settings →
   collections; see dynamic-cms api/site_collections.py).

   Only pages that share ONE reusable structure are
   buildable from the site, and only where it makes
   sense:
   - on the collection's index page (e.g. /resources
     for articles): "＋ New article" — type a title and
     either create a blank draft or write it with AI —
     plus every entry with publish / unpublish / delete
   - on an entry page: its settings (title, URL, fields,
     publish), an AI rewrite (applied as drafts, fitted
     to the template) and quick links to its siblings.
   Every entry uses the collection's template, so it
   looks exactly like the others.
========================================= */

const input = "w-full rounded-lg border border-[#CBD5E1] bg-white px-3 py-2 text-[13px] outline-none focus:border-[var(--cms-accent)] focus:ring-2 focus:ring-[var(--cms-accent)]/20";

export default function CollectionPanel() {
    const { panel, closePanel, collection } = useAdmin();
    if (panel?.type !== "collection" || !collection.collection) return null;
    return <CollectionDrawer cfg={collection.collection} role={collection.role} entry={collection.entry} onClose={closePanel} />;
}

function CollectionDrawer({ cfg, role, entry, onClose }) {
    const [tab, setTab] = useState(role === "entry" && entry ? "entry" : "new");
    const tabs = [
        ...(role === "entry" && entry ? [["entry", `This ${cfg.label.toLowerCase()}`]] : []),
        ["new", `＋ New ${cfg.label.toLowerCase()}`],
        ["all", `All ${cfg.plural.toLowerCase()}`],
    ];
    return (
        <Drawer open width={600} title={cfg.plural} subtitle={`Every ${cfg.label.toLowerCase()} uses the same layout: ${cfg.sections.join(" → ")}`} onClose={onClose}>
            <div className="space-y-4" data-cms-panel="collection">
                <Segmented value={tab} onChange={setTab} options={tabs} />
                {tab === "entry" ? <EntrySettings cfg={cfg} entry={entry} /> : null}
                {tab === "new" ? <NewEntry cfg={cfg} /> : null}
                {tab === "all" ? <EntryList cfg={cfg} /> : null}
            </div>
        </Drawer>
    );
}

/* ---------------- new entry ---------------- */

function NewEntry({ cfg }) {
    const router = useRouter();
    const { closePanel, refreshCollection } = useAdmin();
    const [title, setTitle] = useState("");
    const [keyword, setKeyword] = useState("");
    const [topic, setTopic] = useState("");
    const [mode, setMode] = useState("blank");
    const [prompt, setPrompt] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const label = cfg.label.toLowerCase();

    const open = async (data) => {
        closePanel();
        await refreshCollection();
        router.push(data.entry.href);
    };

    async function createBlank() {
        setBusy(true);
        setError("");
        try {
            await open(await apiRequest(`collections/${cfg.key}/entries/`, { method: "POST", body: { title } }));
        } catch (err) {
            setError(err.message);
            setBusy(false);
        }
    }

    async function buildPrompt() {
        setBusy(true);
        setError("");
        try {
            const q = new URLSearchParams({ title, topic, ...(keyword.trim() ? { keyword } : {}) });
            setPrompt((await apiRequest(`collections/${cfg.key}/prompt/?${q}`)).prompt);
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function createFromReply(raw) {
        setError("");
        try {
            await open(await apiRequest(`collections/${cfg.key}/entries/`, { method: "POST", body: { title, raw } }));
            return true;
        } catch (err) {
            setError(err.message);
            return false;
        }
    }

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <label className="block text-[11px] font-bold uppercase tracking-[0.08em] text-[#475569]" htmlFor="cms-new-title">{cfg.label} title</label>
                <input id="cms-new-title" autoFocus className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`e.g. a clear, searchable ${label} title`} onKeyDown={(e) => e.key === "Enter" && title.trim() && mode === "blank" && createBlank()} />
            </div>
            <Segmented value={mode} onChange={(m) => { setMode(m); setPrompt(""); }} options={[["blank", "Start from the template"], ["ai", "Write it with AI"]]} />

            {mode === "blank" ? (
                <>
                    <p className="text-[12px] text-[#64748B]">Creates a private draft laid out exactly like the other {cfg.plural.toLowerCase()}, with placeholder text you replace by clicking it on the page.</p>
                    <button type="button" className={`${buttonStyles.primary} w-full`} disabled={busy || !title.trim()} onClick={createBlank} data-cms-action="create-blank">
                        {busy ? "Creating…" : `Create draft ${label} →`}
                    </button>
                </>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-2">
                        <input className={input} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="Primary keyword (optional)" />
                        <input className={input} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Key facts to include (optional)" />
                    </div>
                    <Step number={1} title="Build the prompt">
                        <button type="button" className={buttonStyles.primary} disabled={busy || !title.trim()} onClick={buildPrompt} data-cms-action="build-entry-prompt">
                            {busy ? "Building…" : prompt ? "Rebuild prompt" : "Build prompt"}
                        </button>
                    </Step>
                    {prompt ? (
                        <>
                            <Step number={2} title="Copy it into your AI chat"><PromptBox prompt={prompt} /></Step>
                            <Step number={3} title={`Paste the reply — a draft ${label} is created`}>
                                <PasteBox onApply={createFromReply} applyLabel={`Create draft ${label} →`} />
                            </Step>
                        </>
                    ) : null}
                </>
            )}
            <Notice tone="error">{error}</Notice>
            {cfg.listingNote ? <Notice tone="info">{cfg.listingNote}</Notice> : null}
        </div>
    );
}

/* ---------------- all entries ---------------- */

function EntryList({ cfg }) {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState("");
    const load = useCallback(() => apiRequest(`collections/${cfg.key}/entries/`).then(setRows).catch((err) => setError(err.message)), [cfg.key]);
    useEffect(() => {
        load();
    }, [load]);

    const act = async (fn) => {
        setError("");
        try {
            await fn();
            await load();
        } catch (err) {
            setError(err.message);
        }
    };

    return (
        <div className="space-y-2">
            <Notice tone="error">{error}</Notice>
            {rows === null ? <p className="text-[13px] text-[#64748B]">Loading…</p> : null}
            {rows?.length === 0 ? <p className="rounded-lg border border-dashed border-[#CBD5E1] px-3 py-6 text-center text-[13px] text-[#64748B]">No {cfg.plural.toLowerCase()} yet.</p> : null}
            {(rows || []).map((row) => (
                <div key={row.slug} data-cms-entry={row.slug} className="flex items-center gap-2 rounded-lg border border-[#E2E8F0] px-3 py-2">
                    <Link href={row.href} className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#0F172A] hover:underline">{row.title}</Link>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${row.status === "published" ? "bg-[#DCFCE7] text-[#15803D]" : "bg-[#FEF3C7] text-[#92400E]"}`}>{row.status}</span>
                    <button
                        type="button"
                        className={buttonStyles.link}
                        onClick={() => act(() => apiRequest(`collections/${cfg.key}/entries/${row.slug}/`, { method: "PATCH", body: { status: row.status === "published" ? "draft" : "published" } }))}
                    >
                        {row.status === "published" ? "Unpublish" : "Publish"}
                    </button>
                    <button
                        type="button"
                        className="text-[12px] font-semibold text-[#B42318] hover:underline"
                        onClick={() => window.confirm(`Delete “${row.title}” for good?`) && act(() => apiRequest(`collections/${cfg.key}/entries/${row.slug}/`, { method: "DELETE" }))}
                    >
                        Delete
                    </button>
                </div>
            ))}
        </div>
    );
}

/* ---------------- this entry ---------------- */

function EntrySettings({ cfg, entry }) {
    const router = useRouter();
    const { refreshCollection, dynamicHost, publishEpoch } = useAdmin();
    const [form, setForm] = useState({ title: entry.title, slug: entry.slug, fields: { ...entry.fields } });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [strategy, setStrategy] = useState("expand");
    const [instruction, setInstruction] = useState("");
    const [prompt, setPrompt] = useState("");
    const label = cfg.label.toLowerCase();

    async function save(extra = {}) {
        setSaving(true);
        setError("");
        setNotice("");
        try {
            const saved = await apiRequest(`collections/${cfg.key}/entries/${entry.slug}/`, { method: "PATCH", body: { ...form, ...extra } });
            await refreshCollection();
            setNotice(extra.status ? (extra.status === "published" ? `Published — visitors can now see this ${label}.` : `Unpublished — only admins can see it.`) : "Saved.");
            if (saved.href !== entry.href) router.push(saved.href);
            else router.refresh();
        } catch (err) {
            setError(err.data?.missing ? `${err.message}\n${err.data.missing.map((m) => `• ${m.section_type}: ${m.image_prompt || m.slot}`).join("\n")}` : err.message);
        } finally {
            setSaving(false);
        }
    }

    async function buildRewrite() {
        setError("");
        try {
            const q = new URLSearchParams({ strategy, instruction });
            setPrompt((await apiRequest(`collections/${cfg.key}/entries/${entry.slug}/prompt/?${q}`)).prompt);
        } catch (err) {
            setError(err.message);
        }
    }

    async function applyRewrite(raw) {
        setError("");
        setNotice("");
        try {
            const data = await apiRequest(`collections/${cfg.key}/entries/${entry.slug}/apply/`, { method: "POST", body: { raw } });
            await dynamicHost?.reload?.();
            setNotice(`Applied as drafts — review on the page, then Publish from the admin bar.${data.warnings.length ? `\n⚠ ${data.warnings.join("\n⚠ ")}` : ""}`);
            return true;
        } catch (err) {
            setError(err.message);
            return false;
        }
    }

    void publishEpoch;
    const published = entry.status === "published";

    return (
        <div className="space-y-5">
            <div className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2.5 ${published ? "bg-[#F0FDF4]" : "bg-[#FFFBEB]"}`}>
                <span className={`text-[13px] font-semibold ${published ? "text-[#15803D]" : "text-[#92400E]"}`}>
                    {published ? `Live — visitors can see this ${label}.` : `Draft — only admins can see this ${label}.`}
                </span>
                <button type="button" className={published ? buttonStyles.secondary : buttonStyles.primary} disabled={saving} onClick={() => save({ status: published ? "draft" : "published" })} data-cms-action="toggle-entry-status">
                    {published ? "Unpublish" : `Publish ${label}`}
                </button>
            </div>

            <Notice tone="error">{error}</Notice>
            <Notice tone="success">{notice}</Notice>

            <div className="space-y-3">
                <Field label="Title (H1 and listing title)"><input className={input} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
                <Field label="URL" help={published ? "Changing it on a live page adds a 301 redirect from the old URL." : ""}>
                    <div className="flex items-center gap-1 text-[13px] text-[#64748B]">/{cfg.pathPrefix}/<input className={input} value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} /></div>
                </Field>
                {Object.entries(cfg.fields || {}).map(([name, spec]) => (
                    <Field key={name} label={spec.label || name}>
                        <EntryField spec={spec} value={form.fields[name] ?? ""} onChange={(v) => setForm({ ...form, fields: { ...form.fields, [name]: v } })} />
                    </Field>
                ))}
                <button type="button" className={buttonStyles.primary} disabled={saving} onClick={() => save()}>{saving ? "Saving…" : "Save settings"}</button>
            </div>

            <div className="space-y-3 border-t border-[#E2E8F0] pt-4">
                <p className="text-[13px] font-bold text-[#0F172A]">Rewrite with AI</p>
                <p className="text-[12px] text-[#64748B]">The reply keeps this {label}&apos;s layout and lands as drafts — nothing goes live until you publish.</p>
                <Segmented value={strategy} onChange={setStrategy} options={STRATEGY_OPTIONS} />
                <input className={input} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="What should change? (optional)" />
                <button type="button" className={buttonStyles.secondary} onClick={buildRewrite}>{prompt ? "Rebuild prompt" : "Build prompt"}</button>
                {prompt ? (
                    <>
                        <PromptBox prompt={prompt} />
                        <PasteBox onApply={applyRewrite} applyLabel="Apply as drafts" />
                    </>
                ) : null}
            </div>

            <div className="flex items-center justify-between border-t border-[#E2E8F0] pt-4">
                <Link href={`/${cfg.indexPath}`} className={buttonStyles.link}>← All {cfg.plural.toLowerCase()}</Link>
                <button
                    type="button"
                    className={buttonStyles.danger}
                    onClick={async () => {
                        if (!window.confirm(`Delete this ${label} for good?`)) return;
                        await apiRequest(`collections/${cfg.key}/entries/${entry.slug}/`, { method: "DELETE" });
                        router.push(`/${cfg.indexPath}`);
                    }}
                >
                    Delete {label}
                </button>
            </div>
        </div>
    );
}

function Field({ label, help, children }) {
    return (
        <div>
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.08em] text-[#475569]">{label}</span>
            {children}
            {help ? <p className="mt-1 text-[11px] text-[#64748B]">{help}</p> : null}
        </div>
    );
}

function EntryField({ spec, value, onChange }) {
    const [busy, setBusy] = useState(false);
    if (Array.isArray(spec.options)) {
        return (
            <select className={input} value={value} onChange={(e) => onChange(e.target.value)}>
                <option value="">Choose…</option>
                {spec.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
        );
    }
    if (spec.type === "textarea") return <textarea rows={3} className={input} value={value} onChange={(e) => onChange(e.target.value)} />;
    if (spec.type === "image") {
        return (
            <div className="flex items-center gap-3">
                <div className="h-14 w-24 overflow-hidden rounded-lg border border-[#E2E8F0] bg-[#F1F5F9]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {value ? <img src={mediaUrl(value)} alt="" className="h-full w-full object-cover" /> : null}
                </div>
                <label className={`${buttonStyles.secondary} cursor-pointer`}>
                    {busy ? "Uploading…" : value ? "Replace" : "Upload"}
                    <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        setBusy(true);
                        try {
                            onChange(await uploadImage(file, spec.category || "content"));
                        } finally {
                            setBusy(false);
                        }
                    }} />
                </label>
            </div>
        );
    }
    return <input className={input} value={value} onChange={(e) => onChange(e.target.value)} />;
}
