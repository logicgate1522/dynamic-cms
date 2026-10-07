"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { INTENT_OPTIONS, Notice, PasteBox, PromptBox, Segmented, Step } from "@/components/cms/ai";
import { buttonStyles } from "@/components/cms/Drawer";
import { humanize } from "@/components/cms/FieldEditor";
import { apiRequest } from "@/lib/api";

/* =========================================
   One-off page from an SEO brief — Dashboard → Pages
   only (power users). On the site itself admins create
   pages through collections (CollectionPanel), so new
   entries always follow their collection's template.
   brief -> ai/new-page-prompt/ -> copy -> paste
   -> content/paste-to-build/ (a DRAFT page with its
   SEO filled in) -> open it to review and publish.
========================================= */

const field = "w-full rounded-lg border border-[#CBD5E1] px-3 py-2 text-[13px] outline-none focus:border-[var(--cms-accent)]";

export function CreatePageForm({ onDone, defaultKind = "content" }) {
    const router = useRouter();
    const [kind, setKind] = useState(defaultKind);
    const [title, setTitle] = useState("");
    const [path, setPath] = useState("");
    const [topic, setTopic] = useState("");
    const [pageType, setPageType] = useState("service");
    const [brief, setBrief] = useState({ keyword: "", intent: "", location: "", audience: "", supporting: "", cta: "" });
    const [types, setTypes] = useState([]);
    const [selected, setSelected] = useState([]);
    const [prompt, setPrompt] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [mode, setMode] = useState("brief"); // brief | copy

    useEffect(() => {
        apiRequest("ai/section-schema/").then((d) => setTypes(Object.keys(d.section_schema))).catch(() => {});
    }, []);

    const slug = (text) => text.toLowerCase().trim().replace(/[^a-z0-9/]+/g, "-").replace(/^-+|-+$/g, "");

    async function build() {
        setBusy(true);
        setError("");
        try {
            if (mode === "copy") {
                setPrompt((await apiRequest("ai/copy-structure-prompt/")).prompt);
            } else {
                const q = new URLSearchParams({
                    host_kind: kind === "blog" ? "blog" : "content",
                    page_type: kind === "blog" ? "article" : pageType,
                    title,
                    topic,
                    path: kind === "blog" ? `blog/${slug(title)}` : path,
                    ...Object.fromEntries(Object.entries(brief).filter(([, v]) => v.trim())),
                    ...(selected.length ? { sections: selected.join(",") } : {}),
                });
                setPrompt((await apiRequest(`ai/new-page-prompt/?${q}`)).prompt);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function create(raw) {
        setError("");
        try {
            const body = { raw };
            if (kind === "blog") body.page_type = "article";
            else {
                if (path.trim()) body.path = path.trim().replace(/^\/+|\/+$/g, "");
                body.page_type = pageType;
            }
            const data = await apiRequest("content/paste-to-build/", { method: "POST", body });
            const href = data.host.kind === "blog" ? `/blog/${data.host.key}` : `/${data.host.key}`;
            onDone?.();
            router.push(href);
            return true;
        } catch (err) {
            setError(err.message);
            return false;
        }
    }

    return (
        <div className="space-y-5">
            <Segmented value={mode} onChange={(v) => { setMode(v); setPrompt(""); }} options={[["brief", "Write from a brief"], ["copy", "Copy an existing page"]]} />

            {mode === "brief" ? (
                <Step number={1} title="Brief">
                    <Segmented value={kind} onChange={setKind} options={[["content", "Page"], ["blog", "Blog article"]]} />
                    <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title / H1 (e.g. VAT Returns for Small Businesses)" />
                    {kind === "content" ? (
                        <div className="grid grid-cols-2 gap-2">
                            <input className={field} value={path} onChange={(e) => setPath(e.target.value)} placeholder={`URL path, e.g. services/${slug(title) || "vat-returns"}`} />
                            <select className={field} value={pageType} onChange={(e) => setPageType(e.target.value)}>
                                {["service", "landing", "local-service", "generic"].map((t) => <option key={t} value={t}>{humanize(t)} page</option>)}
                            </select>
                        </div>
                    ) : null}
                    <textarea rows={2} className={field} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What should it cover? Key facts, offers, prices, deadlines…" />
                    <div className="grid grid-cols-2 gap-2">
                        <input className={field} value={brief.keyword} onChange={(e) => setBrief({ ...brief, keyword: e.target.value })} placeholder="Primary keyword" />
                        <select className={field} value={brief.intent} onChange={(e) => setBrief({ ...brief, intent: e.target.value })}>
                            {INTENT_OPTIONS.map((o) => <option key={o} value={o}>{o ? humanize(o) : "Search intent…"}</option>)}
                        </select>
                        <input className={field} value={brief.location} onChange={(e) => setBrief({ ...brief, location: e.target.value })} placeholder="Location / service area" />
                        <input className={field} value={brief.audience} onChange={(e) => setBrief({ ...brief, audience: e.target.value })} placeholder="Audience" />
                        <input className={field} value={brief.supporting} onChange={(e) => setBrief({ ...brief, supporting: e.target.value })} placeholder="Supporting keywords (comma-separated)" />
                        <input className={field} value={brief.cta} onChange={(e) => setBrief({ ...brief, cta: e.target.value })} placeholder="Call to action (e.g. Get a free quote)" />
                    </div>
                    <details className="text-[12px] text-[#475569]">
                        <summary className="cursor-pointer font-semibold">Limit section types ({selected.length ? selected.length : "any"})</summary>
                        <div className="mt-2 flex flex-wrap gap-1">
                            {types.map((t) => {
                                const on = selected.includes(t);
                                return (
                                    <button key={t} type="button" onClick={() => setSelected(on ? selected.filter((x) => x !== t) : [...selected, t])} className={`rounded-full border px-2.5 py-0.5 text-[11px] ${on ? "border-[var(--cms-accent)] bg-[var(--cms-accent-soft)] text-[var(--cms-accent-strong)]" : "border-[#E2E8F0]"}`}>
                                        {humanize(t)}
                                    </button>
                                );
                            })}
                        </div>
                    </details>
                </Step>
            ) : (
                <Step number={1} title="Copy an existing page">
                    <p className="text-[12px] text-[#475569]">The prompt asks the AI to reproduce a page you paste in (HTML, text, or a screenshot description) section by section, keeping the copy verbatim.</p>
                    <Segmented value={kind} onChange={setKind} options={[["content", "Page"], ["blog", "Blog article"]]} />
                    {kind === "content" ? <input className={field} value={path} onChange={(e) => setPath(e.target.value)} placeholder="URL path for the new page" /> : null}
                </Step>
            )}

            <button type="button" className={buttonStyles.primary} onClick={build} disabled={busy || (mode === "brief" && !title.trim() && !topic.trim())}>
                {busy ? "Building…" : prompt ? "Rebuild prompt" : "Build prompt"}
            </button>

            {prompt ? (
                <>
                    <Step number={2} title="Copy it into your AI chat"><PromptBox prompt={prompt} /></Step>
                    <Step number={3} title="Paste the reply — a draft page is created">
                        <PasteBox onApply={create} applyLabel={kind === "blog" ? "Create draft article" : "Create draft page"} />
                    </Step>
                </>
            ) : null}
            <Notice tone="error">{error}</Notice>
        </div>
    );
}
