"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { INTENT_OPTIONS, Notice, PasteBox, PromptBox, Segmented, pageTextExcerpt } from "@/components/cms/ai";
import Drawer, { buttonStyles } from "@/components/cms/Drawer";
import { SEO_SAVED_EVENT, useKeywordCoverage } from "@/components/cms/PageAssist";
import { apiRequest, mediaUrl, uploadImage } from "@/lib/api";
import { SITE_NAME } from "@/lib/brand";
import { seoChecks, seoScore } from "@/lib/seoChecks";

/* =========================================
   Per-page SEO (seo/<path>/). Saves go live
   immediately — this is metadata, not page copy.
   Mounted once per route via <PageSeo path>; the
   admin bar's "SEO" button opens it.

   The first thing an admin sees is ASK AI: the audit
   prompt is already built (every field, the failing
   checks with their fixes, the visible page text) —
   copy, paste the reply, done. The score bar and the
   full check list (lib/seoChecks.js, mirrored by the
   backend) stay visible on every tab.
========================================= */

const SCHEMA_BUILDERS = ["Service", "FAQPage", "HowTo", "Product", "Event", "Person", "VideoObject"];
const CHANGEFREQ = ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"];
const TAB_LABELS = { essentials: "Essentials", sharing: "Sharing & indexing", advanced: "Advanced" };

const EMPTY = {
    seoTitle: "",
    metaDescription: "",
    canonicalUrl: "",
    canonicalSelf: true,
    keywords: { primary: "", secondary: [], variations: [] },
    searchIntent: "",
    social: { ogTitle: "", ogDescription: "", ogImage: "", ogImageAlt: "", twitterTitle: "", twitterDescription: "", twitterImage: "", twitterCard: "summary_large_image" },
    robots: { index: true, follow: true, noarchive: false, nosnippet: false, noimageindex: false },
    sitemap: { include: true, priority: 0.5, changefreq: "monthly" },
    schema: { enabled: true, builders: [] },
    breadcrumbLabels: {},
    notes: "",
};

function withDefaults(data) {
    const d = data || {};
    return {
        ...EMPTY,
        ...d,
        keywords: { ...EMPTY.keywords, ...(d.keywords || {}) },
        social: { ...EMPTY.social, ...(d.social || {}) },
        robots: { ...EMPTY.robots, ...(d.robots || {}) },
        sitemap: { ...EMPTY.sitemap, ...(d.sitemap || {}) },
        schema: { ...EMPTY.schema, ...(d.schema || {}) },
        breadcrumbLabels: { ...(d.breadcrumbLabels || {}) },
    };
}

function deepMergePatch(base, patch) {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch || {})) {
        out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMergePatch(base?.[k] || {}, v) : v;
    }
    return out;
}

const titleCase = (text) => String(text).replace(/\b\w/g, (c) => c.toUpperCase());

// Mechanical suggestions for EMPTY fields only (never overwrites what an
// admin wrote). Real judgment is Ask AI's job.
function autoFill(form, path) {
    const h1 = (typeof document !== "undefined" && document.querySelector("main h1, h1")?.innerText) || "";
    const keyword = form.keywords.primary || h1.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
    const firstSentence = pageTextExcerpt(1200).replace(h1, "").split(/(?<=[.!?])\s+/).find((t) => t.length > 60) || "";
    const patch = {};
    if (!form.keywords.primary && keyword) patch.keywords = { primary: keyword };
    if (!form.seoTitle && keyword) patch.seoTitle = `${titleCase(keyword)} | ${SITE_NAME}`.slice(0, 60);
    if (!form.metaDescription && firstSentence) patch.metaDescription = firstSentence.length > 160 ? `${firstSentence.slice(0, 156).trimEnd()}…` : firstSentence;
    if (!form.searchIntent) patch.searchIntent = /^(blog|resources|guides)\b/.test(path) ? "informational" : "commercial";
    if (!form.breadcrumbLabels[path] && h1) patch.breadcrumbLabels = { [path]: h1.trim().slice(0, 60) };
    return patch;
}

export default function SeoEditPanel({ path }) {
    const { isAdmin, setSeoPath, panel, closePanel, seoPath } = useAdmin();

    useEffect(() => {
        setSeoPath(path);
        return () => setSeoPath(null);
    }, [path, setSeoPath]);

    if (!isAdmin || panel?.type !== "seo" || seoPath !== path) return null;
    return <SeoDrawer path={path} initialTab={panel.tab} onClose={closePanel} />;
}

function SeoDrawer({ path, initialTab = "ai", onClose }) {
    const [stored, setStored] = useState(null);
    const [form, setForm] = useState(null);
    const [tab, setTab] = useState(initialTab);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [flash, setFlash] = useState("");
    const bodyRef = useRef(null);
    const coverage = useKeywordCoverage(path);

    const load = useCallback(async () => {
        try {
            const data = withDefaults(await apiRequest(`seo/${path}/`));
            setStored(data);
            setForm(data);
        } catch (err) {
            setError(err.message);
            setStored(withDefaults({}));
            setForm(withDefaults({}));
        }
    }, [path]);

    useEffect(() => {
        load();
    }, [load]);

    const dirty = form && stored && JSON.stringify(form) !== JSON.stringify(stored);
    const set = (patch) => setForm((f) => deepMergePatch(f, patch));

    async function save(next = form) {
        setSaving(true);
        setError("");
        setNotice("");
        try {
            const clean = structuredClone(next);
            clean.keywords.secondary = clean.keywords.secondary.filter((k) => k.trim());
            clean.keywords.variations = clean.keywords.variations.filter((k) => k.trim());
            const data = withDefaults(await apiRequest(`seo/${path}/`, { method: "PATCH", body: clean }));
            setStored(data);
            setForm(data);
            setNotice("SEO saved and live.");
            window.dispatchEvent(new Event(SEO_SAVED_EVENT));
            return true;
        } catch (err) {
            setError(err.message);
            return false;
        } finally {
            setSaving(false);
        }
    }

    const checks = useMemo(() => (form ? seoChecks(form) : []), [form]);
    const failing = checks.filter((c) => !c.pass && !c.skip);
    const score = seoScore(checks);

    const goTo = (check) => {
        setTab(check.tab);
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                const el = bodyRef.current?.querySelector(`[data-field="${check.field}"]`);
                el?.scrollIntoView({ behavior: "smooth", block: "center" });
                setFlash(check.field);
                setTimeout(() => setFlash(""), 1600);
            })
        );
    };

    if (!form) {
        return (
            <Drawer open title="Page SEO" subtitle={`/${path === "home" ? "" : path}`} onClose={onClose}>
                <p className="text-[13px] text-[#64748B]">Loading…</p>
            </Drawer>
        );
    }

    const issuesOn = (t) => failing.filter((c) => c.tab === t).length;
    const tabs = [
        ["ai", "✦ Ask AI"],
        ["essentials", `Essentials${issuesOn("essentials") ? ` · ${issuesOn("essentials")}` : ""}`],
        ["sharing", `Sharing & indexing${issuesOn("sharing") ? ` · ${issuesOn("sharing")}` : ""}`],
        ["advanced", `Advanced${issuesOn("advanced") ? ` · ${issuesOn("advanced")}` : ""}`],
        ["checks", `Checks${failing.length ? ` · ${failing.length}` : ""}`],
        ["history", "History"],
    ];
    const segment = path.split("/").pop() || "home";
    const fieldProps = (field) => ({ field, flash: flash === field });
    const fill = autoFill(form, path);
    const canFill = Object.keys(fill).length > 0;

    return (
        <Drawer
            open
            width={620}
            title="Page SEO"
            subtitle={`/${path === "home" ? "" : path}`}
            onClose={() => {
                if (dirty && !window.confirm("Discard unsaved SEO changes?")) return;
                onClose();
            }}
            footer={
                ["essentials", "sharing", "advanced"].includes(tab) ? (
                    <div className="flex items-center justify-end gap-2">
                        <button type="button" className={buttonStyles.secondary} disabled={!dirty || saving} onClick={() => setForm(stored)}>Undo</button>
                        <button type="button" className={buttonStyles.primary} disabled={!dirty || saving} onClick={() => save()}>{saving ? "Saving…" : "Save SEO"}</button>
                    </div>
                ) : null
            }
        >
            <div ref={bodyRef} className="space-y-4" data-cms-panel="seo">
                <ScoreBar score={score} passing={checks.filter((c) => c.pass && !c.skip).length} total={checks.filter((c) => !c.skip).length} coverage={coverage} onChecks={() => setTab("checks")} />

                <div className="flex gap-1 overflow-x-auto rounded-xl bg-[#F1F5F9] p-1">
                    {tabs.map(([key, label]) => (
                        <button key={key} type="button" data-cms-tab={key} onClick={() => setTab(key)} className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] font-semibold ${tab === key ? (key === "ai" ? "bg-[var(--cms-accent)] text-white shadow-sm" : "bg-white text-[#0F172A] shadow-sm") : key === "ai" ? "text-[var(--cms-accent-strong)]" : "text-[#475569] hover:bg-white/60"}`}>
                            {label}
                        </button>
                    ))}
                </div>
                <Notice tone="error">{error}</Notice>
                <Notice tone="success">{notice}</Notice>

                {["essentials", "sharing", "advanced"].includes(tab) && canFill ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-[#CBD5E1] px-3 py-2">
                        <p className="text-[12px] text-[#475569]">Some fields are empty. Auto-fill suggests them from the page (mechanical — review before saving).</p>
                        <button type="button" className={buttonStyles.secondary} onClick={() => setForm((f) => deepMergePatch(f, fill))}>Auto-fill</button>
                    </div>
                ) : null}

                {tab === "ai" ? <SeoAi path={path} form={form} failing={failing} onApplied={async (patch) => save(deepMergePatch(form, patch))} /> : null}

                {tab === "essentials" ? (
                    <>
                        <SnippetPreview form={form} path={path} />
                        <TextField label="SEO title" help="50–60 characters, keyword first." count={form.seoTitle.length} value={form.seoTitle} onChange={(v) => set({ seoTitle: v })} {...fieldProps("seoTitle")} />
                        <TextField label="Meta description" help="120–160 characters, specific, with a reason to click." multiline count={form.metaDescription.length} value={form.metaDescription} onChange={(v) => set({ metaDescription: v })} {...fieldProps("metaDescription")} />
                        <TextField label="Primary keyword" help="The one phrase this page should rank for." value={form.keywords.primary} onChange={(v) => set({ keywords: { primary: v } })} {...fieldProps("keywords.primary")} />
                        <ChipsField label="Secondary keywords" value={form.keywords.secondary} onChange={(v) => set({ keywords: { secondary: v } })} {...fieldProps("keywords.secondary")} />
                        <ChipsField label="Keyword variations" value={form.keywords.variations} onChange={(v) => set({ keywords: { variations: v } })} {...fieldProps("keywords.variations")} />
                        <SelectField label="Search intent" value={form.searchIntent} options={INTENT_OPTIONS.map((o) => [o, o || "Choose…"])} onChange={(v) => set({ searchIntent: v })} {...fieldProps("searchIntent")} />
                        <TextField label="Canonical URL override" help="Leave empty to use this page's own URL." value={form.canonicalUrl} onChange={(v) => set({ canonicalUrl: v })} {...fieldProps("canonicalUrl")} />
                    </>
                ) : null}

                {tab === "sharing" ? (
                    <>
                        <ImageField label="Social share image (1200×630)" value={form.social.ogImage} onChange={(v) => set({ social: { ogImage: v } })} {...fieldProps("social.ogImage")} />
                        <TextField label="Social image alt text" value={form.social.ogImageAlt} onChange={(v) => set({ social: { ogImageAlt: v } })} {...fieldProps("social.ogImageAlt")} />
                        <TextField label="Social title" help="Defaults to the SEO title." value={form.social.ogTitle} onChange={(v) => set({ social: { ogTitle: v } })} {...fieldProps("social.ogTitle")} />
                        <TextField label="Social description" multiline value={form.social.ogDescription} onChange={(v) => set({ social: { ogDescription: v } })} {...fieldProps("social.ogDescription")} />
                        <SelectField label="X/Twitter card" value={form.social.twitterCard} options={[["summary_large_image", "Large image"], ["summary", "Small image"]]} onChange={(v) => set({ social: { twitterCard: v } })} {...fieldProps("social.twitterCard")} />
                        <fieldset className="space-y-2 rounded-xl border border-[#E2E8F0] p-3">
                            <legend className="px-1 text-[11px] font-bold uppercase tracking-[0.08em] text-[#475569]">Search engines</legend>
                            <Toggle label="Allow indexing" checked={form.robots.index} onChange={(v) => set({ robots: { index: v } })} {...fieldProps("robots.index")} />
                            <Toggle label="Follow links" checked={form.robots.follow} onChange={(v) => set({ robots: { follow: v } })} {...fieldProps("robots.follow")} />
                            <Toggle label="No cached copy (noarchive)" checked={form.robots.noarchive} onChange={(v) => set({ robots: { noarchive: v } })} field="robots.noarchive" />
                            <Toggle label="No text snippet (nosnippet)" checked={form.robots.nosnippet} onChange={(v) => set({ robots: { nosnippet: v } })} field="robots.nosnippet" />
                            <Toggle label="Don't index images (noimageindex)" checked={form.robots.noimageindex} onChange={(v) => set({ robots: { noimageindex: v } })} field="robots.noimageindex" />
                        </fieldset>
                        <fieldset className="space-y-2 rounded-xl border border-[#E2E8F0] p-3">
                            <legend className="px-1 text-[11px] font-bold uppercase tracking-[0.08em] text-[#475569]">Sitemap</legend>
                            <Toggle label="Include in sitemap" checked={form.sitemap.include} onChange={(v) => set({ sitemap: { include: v } })} {...fieldProps("sitemap.include")} />
                            <SelectField label="Change frequency" value={form.sitemap.changefreq} options={CHANGEFREQ.map((c) => [c, c])} onChange={(v) => set({ sitemap: { changefreq: v } })} field="sitemap.changefreq" />
                            <TextField label="Priority (0.0–1.0)" value={String(form.sitemap.priority)} onChange={(v) => set({ sitemap: { priority: Math.max(0, Math.min(1, Number(v) || 0)) } })} field="sitemap.priority" />
                        </fieldset>
                    </>
                ) : null}

                {tab === "advanced" ? (
                    <>
                        <fieldset className="space-y-2 rounded-xl border border-[#E2E8F0] p-3" data-field="schema.enabled">
                            <legend className="px-1 text-[11px] font-bold uppercase tracking-[0.08em] text-[#475569]">Structured data on this page</legend>
                            <Toggle label="Structured data (schema) enabled" checked={form.schema.enabled} onChange={(v) => set({ schema: { enabled: v } })} {...fieldProps("schema.enabled")} />
                            <p className="text-[12px] text-[#64748B]">Organization, WebSite and breadcrumbs are always included. Add only types the visible content supports.</p>
                            <div className="grid grid-cols-2 gap-1.5" data-field="schema.builders">
                                {SCHEMA_BUILDERS.map((b) => (
                                    <label key={b} className="flex items-center gap-2 text-[13px]">
                                        <input
                                            type="checkbox"
                                            checked={form.schema.builders.includes(b)}
                                            onChange={(e) => set({ schema: { builders: e.target.checked ? [...form.schema.builders, b] : form.schema.builders.filter((x) => x !== b) } })}
                                        />
                                        {b}
                                    </label>
                                ))}
                            </div>
                        </fieldset>
                        <TextField label="Breadcrumb label" help="How this page is named in the breadcrumb trail." value={form.breadcrumbLabels[path] || form.breadcrumbLabels[segment] || ""} onChange={(v) => set({ breadcrumbLabels: { [path]: v } })} field="breadcrumb" />
                        <TextField label="Internal notes" multiline help="Only visible here." value={form.notes} onChange={(v) => set({ notes: v })} field="notes" />
                    </>
                ) : null}

                {tab === "checks" ? <ChecksTab checks={checks} onGo={goTo} path={path} /> : null}
                {tab === "history" ? <SeoHistory path={path} onRestored={load} /> : null}
            </div>
        </Drawer>
    );
}

function ScoreBar({ score, passing, total, coverage, onChecks }) {
    const tone = score >= 80 ? "bg-[#16A34A]" : score >= 50 ? "bg-[#F59E0B]" : "bg-[#DC2626]";
    return (
        <button type="button" onClick={onChecks} className="block w-full rounded-xl border border-[#E2E8F0] p-3 text-left hover:border-[#CBD5E1]" data-cms-seo-score={score}>
            <div className="flex items-center justify-between text-[12px]">
                <span className="font-bold text-[#0F172A]">{score}% SEO score</span>
                <span className="text-[#64748B]">
                    {passing}/{total} checks pass
                    {coverage.percent !== null ? ` · keyword in ${coverage.percent}% of sections` : ""}
                </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#E2E8F0]">
                <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${score}%` }} />
            </div>
        </button>
    );
}

/* ---------------- tabs ---------------- */

function ChecksTab({ checks, onGo, path }) {
    const [audit, setAudit] = useState(null);
    const [error, setError] = useState("");
    const failing = checks.filter((c) => !c.pass && !c.skip);
    const passing = checks.filter((c) => c.pass || c.skip);
    const run = async () => {
        setError("");
        setAudit(null);
        try {
            setAudit(await apiRequest(`seo/analyze/${path}/`, { method: "POST", body: { html: document.documentElement.outerHTML, url: window.location.href } }));
        } catch (err) {
            setError(err.message);
        }
    };
    return (
        <div className="space-y-3">
            {failing.length ? (
                <div className="space-y-1.5">
                    {failing.map((c) => (
                        <button key={c.id} type="button" data-cms-check={c.id} onClick={() => onGo(c)} className="flex w-full items-start gap-2.5 rounded-lg border border-[#FCD34D] bg-[#FFFBEB] px-3 py-2 text-left hover:border-[#F59E0B]">
                            <span className="mt-0.5 text-[#B45309]">✕</span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-[13px] font-semibold text-[#92400E]">{c.label}</span>
                                <span className="block text-[12px] text-[#B45309]">→ {c.fix}</span>
                            </span>
                            <span className="shrink-0 rounded border border-[#FCD34D] bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase text-[#B45309]">{TAB_LABELS[c.tab]}</span>
                        </button>
                    ))}
                </div>
            ) : (
                <Notice tone="success">Every check passes.</Notice>
            )}
            <details>
                <summary className="cursor-pointer text-[12px] font-semibold text-[#64748B]">{passing.length} check{passing.length === 1 ? "" : "s"} passing</summary>
                <ul className="mt-2 space-y-1">
                    {passing.map((c) => (
                        <li key={c.id} data-cms-check={c.id} className="flex gap-2 text-[12px] text-[#15803D]"><span>{c.skip ? "—" : "✓"}</span>{c.label}</li>
                    ))}
                </ul>
            </details>
            <button type="button" className={buttonStyles.secondary} onClick={run}>Run the full audit on the live page</button>
            <Notice tone="error">{error}</Notice>
            {audit ? (
                <div className="space-y-2">
                    <p className="text-[13px] font-semibold">Score {audit.overall}/100 · {audit.issues.length} issue(s)</p>
                    {audit.issues.map((i) => (
                        <div key={i.id} className="rounded-lg border border-[#E2E8F0] px-3 py-2 text-[12px]">
                            <p className="font-medium">{i.label}</p>
                            {i.message ? <p className="text-[#475569]">{i.message}</p> : null}
                            {i.fix ? <p className="text-[var(--cms-accent-strong)]">Fix: {i.fix}</p> : null}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function SeoAi({ path, form, failing, onApplied }) {
    const [mode, setMode] = useState("audit");
    const [prompt, setPrompt] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState("");
    const [brief, setBrief] = useState({ location: "", audience: "" });
    const { openPanel } = useAdmin();

    const build = useCallback(async (which = mode) => {
        setBusy(true);
        setError("");
        try {
            const body = { path, page_text: pageTextExcerpt() };
            const data = which === "audit"
                ? await apiRequest("ai/seo-prompt/", { method: "POST", body: { ...body, html: document.documentElement.outerHTML, url: window.location.href } })
                : await apiRequest("ai/keyword-prompt/", { method: "POST", body: { ...body, ...brief } });
            setPrompt(data.prompt);
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }, [mode, path, brief]);

    // Ask AI is the first action: the prompt is ready the moment the tab opens.
    const first = useRef(true);
    useEffect(() => {
        if (!first.current) return;
        first.current = false;
        build("audit");
    }, [build]);

    async function apply(raw) {
        setError("");
        setResult("");
        try {
            const data = await apiRequest("ai/normalize/", { method: "POST", body: { kind: mode === "audit" ? "seo" : "keywords", raw, path } });
            if (!data.fields) {
                setResult("The AI found nothing to change — every field is already good.");
                return true;
            }
            const ok = await onApplied(data.patch);
            if (ok) setResult(`Applied and saved ${data.fields} field${data.fields === 1 ? "" : "s"}.` + (data.unknown.length ? ` Ignored: ${data.unknown.join(", ")}.` : ""));
            return ok;
        } catch (err) {
            setError(err.message);
            return false;
        }
    }

    return (
        <div className="space-y-4" data-cms-seo-ai>
            <div className="rounded-xl bg-[var(--cms-bar)] p-4 text-white">
                <p className="text-[13px] font-bold">Ask AI to review this page</p>
                <p className="mt-1 text-[12px] leading-5 text-white/70">
                    {mode === "audit"
                        ? `One prompt with every SEO field, ${failing.length ? `the ${failing.length} failing check${failing.length === 1 ? "" : "s"} and how to fix them, ` : ""}and the visible page text. The AI audits like an expert editor and returns only the fields worth changing — paste its reply below to apply and save.`
                        : `Keyword research for this page${form.keywords.primary ? ` (current: “${form.keywords.primary}”)` : ""}: one primary keyword, secondary keywords, variations and search intent.`}
                </p>
                <div className="mt-3">
                    <Segmented value={mode} onChange={(m) => { setMode(m); setPrompt(""); setResult(""); build(m); }} options={[["audit", "Audit & improve"], ["keywords", "Find keywords"]]} />
                </div>
            </div>
            {mode === "keywords" ? (
                <div className="grid grid-cols-2 gap-2">
                    <input value={brief.location} onChange={(e) => setBrief({ ...brief, location: e.target.value })} placeholder="Location (optional)" className="rounded-lg border border-[#CBD5E1] px-3 py-2 text-[13px]" />
                    <input value={brief.audience} onChange={(e) => setBrief({ ...brief, audience: e.target.value })} placeholder="Audience (optional)" className="rounded-lg border border-[#CBD5E1] px-3 py-2 text-[13px]" />
                    <button type="button" className={`${buttonStyles.link} col-span-2 text-left`} onClick={() => build("keywords")}>↻ Rebuild with location / audience</button>
                </div>
            ) : null}
            {busy && !prompt ? <p className="text-[12px] text-[#64748B]">Building the prompt…</p> : null}
            {prompt ? (
                <>
                    <PromptBox prompt={prompt} />
                    <PasteBox onApply={apply} applyLabel="Apply & save these fields" placeholder="Paste the AI's whole reply — the ```json block is picked out automatically…" />
                </>
            ) : null}
            <Notice tone="error">{error}</Notice>
            <Notice tone="success">{result}</Notice>
            <button type="button" className={`${buttonStyles.secondary} w-full`} onClick={() => openPanel("assist")}>
                If the AI says the content needs work → Open whole-page AI assist
            </button>
        </div>
    );
}

function SeoHistory({ path, onRestored }) {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState("");
    useEffect(() => {
        apiRequest(`seo/${path}/history/`).then(setRows).catch((err) => {
            setRows([]);
            if (err.status !== 404) setError(err.message);
        });
    }, [path]);
    return (
        <div className="space-y-2">
            <Notice tone="error">{error}</Notice>
            {rows === null ? <p className="text-[13px] text-[#64748B]">Loading…</p> : null}
            {rows?.length === 0 ? <p className="text-[13px] text-[#64748B]">No SEO changes saved yet.</p> : null}
            {(rows || []).map((row) => (
                <div key={row.id} className="flex items-center justify-between rounded-lg border border-[#E2E8F0] px-3 py-2">
                    <div>
                        <p className="text-[13px] font-medium">{row.new_data?.seoTitle || "SEO change"}</p>
                        <p className="text-[11px] text-[#64748B]">{new Date(row.created_at).toLocaleString()}{row.changed_by ? ` · ${row.changed_by}` : ""}</p>
                    </div>
                    <button
                        type="button"
                        className={buttonStyles.link}
                        onClick={async () => {
                            await apiRequest(`seo/${path}/revert/${row.id}/`, { method: "POST" });
                            window.dispatchEvent(new Event(SEO_SAVED_EVENT));
                            await onRestored();
                        }}
                    >
                        Restore
                    </button>
                </div>
            ))}
        </div>
    );
}

/* ---------------- fields ---------------- */

const inputClass = "w-full rounded-lg border border-[#D6DEE8] bg-white px-3 py-2 text-[13px] text-[#1E293B] outline-none focus:border-[var(--cms-accent)] focus:ring-2 focus:ring-[var(--cms-accent)]/20";

function Wrap({ label, help, count, field, flash, children }) {
    return (
        <div data-field={field} className={`rounded-lg transition ${flash ? "bg-[var(--cms-accent-soft)] ring-2 ring-[var(--cms-accent)] ring-offset-2" : ""}`}>
            <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#475569]">{label}</span>
                {count !== undefined ? <span className="text-[11px] text-[#94A3B8]">{count}</span> : null}
            </div>
            {children}
            {help ? <p className="mt-1 text-[11px] text-[#64748B]">{help}</p> : null}
        </div>
    );
}

function TextField({ label, help, count, value, onChange, multiline, field, flash }) {
    return (
        <Wrap label={label} help={help} count={count} field={field} flash={flash}>
            {multiline ? (
                <textarea rows={3} className={`${inputClass} resize-y`} value={value} onChange={(e) => onChange(e.target.value)} />
            ) : (
                <input className={inputClass} value={value} onChange={(e) => onChange(e.target.value)} />
            )}
        </Wrap>
    );
}

function SelectField({ label, value, options, onChange, field, flash }) {
    return (
        <Wrap label={label} field={field} flash={flash}>
            <select className={inputClass} value={value} onChange={(e) => onChange(e.target.value)}>
                {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
        </Wrap>
    );
}

function Toggle({ label, checked, onChange, field, flash }) {
    return (
        <label data-field={field} className={`flex items-center gap-2 rounded-md text-[13px] ${flash ? "bg-[var(--cms-accent-soft)] ring-2 ring-[var(--cms-accent)]" : ""}`}>
            <input type="checkbox" checked={checked !== false} onChange={(e) => onChange(e.target.checked)} />
            {label}
        </label>
    );
}

function ChipsField({ label, value, onChange, field, flash }) {
    const [text, setText] = useState("");
    const add = () => {
        const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
        setText("");
    };
    return (
        <Wrap label={label} field={field} flash={flash} help="Press Enter or comma to add.">
            <div className="flex flex-wrap gap-1 rounded-lg border border-[#D6DEE8] p-1.5">
                {value.map((v) => (
                    <span key={v} className="inline-flex items-center gap-1 rounded-full bg-[#F1F5F9] px-2 py-0.5 text-[12px]">
                        {v}
                        <button type="button" aria-label={`Remove ${v}`} className="text-[#94A3B8] hover:text-[#B42318]" onClick={() => onChange(value.filter((x) => x !== v))}>×</button>
                    </span>
                ))}
                <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === ",") {
                            e.preventDefault();
                            add();
                        }
                    }}
                    onBlur={add}
                    className="min-w-[8rem] flex-1 px-1 text-[13px] outline-none"
                />
            </div>
        </Wrap>
    );
}

function ImageField({ label, value, onChange, field, flash }) {
    const [busy, setBusy] = useState(false);
    return (
        <Wrap label={label} field={field} flash={flash}>
            <div className="flex items-center gap-3">
                <div className="flex h-16 w-28 items-center justify-center overflow-hidden rounded-lg border border-[#D6DEE8] bg-[#F1F5F9]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {value ? <img src={mediaUrl(value)} alt="" className="h-full w-full object-cover" /> : <span className="text-[11px] text-[#94A3B8]">None</span>}
                </div>
                <label className="cursor-pointer rounded-lg bg-[var(--cms-primary)] px-3 py-1.5 text-[12px] font-semibold text-white">
                    {busy ? "Uploading…" : value ? "Replace" : "Upload"}
                    <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        setBusy(true);
                        try {
                            onChange(await uploadImage(file, "seo"));
                        } finally {
                            setBusy(false);
                        }
                    }} />
                </label>
                {value ? <button type="button" className={buttonStyles.danger} onClick={() => onChange("")}>Remove</button> : null}
            </div>
        </Wrap>
    );
}

function SnippetPreview({ form, path }) {
    const url = `${typeof window !== "undefined" ? window.location.host : ""}/${path === "home" ? "" : path}`;
    return (
        <div className="rounded-xl border border-[#E2E8F0] p-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#94A3B8]">Search result preview</p>
            <p className="mt-1 truncate text-[12px] text-[#4D5156]">{url}</p>
            <p className="truncate text-[18px] leading-6 text-[#1A0DAB]">{form.seoTitle || "No SEO title — the site default is used"}</p>
            <p className="line-clamp-2 text-[13px] leading-5 text-[#4D5156]">{form.metaDescription || "No meta description — search engines will pick text from the page."}</p>
        </div>
    );
}
