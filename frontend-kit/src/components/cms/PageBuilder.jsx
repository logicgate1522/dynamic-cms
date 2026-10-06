"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { INTENT_OPTIONS, Notice, PasteBox, PromptBox, Segmented, Step, STRATEGY_OPTIONS } from "@/components/cms/ai";
import Drawer, { buttonStyles } from "@/components/cms/Drawer";
import { humanize } from "@/components/cms/FieldEditor";
import { apiRequest, mediaUrl } from "@/lib/api";

/* =========================================
   Page builder for the CMS page being viewed
   (admin bar → "Page builder"):
   - AI: improve / rewrite the whole page from a
     brief (edit prompt includes the live sections);
     the reply is previewed, then applied with
     paste-to-edit as DRAFTS (images kept).
   - Images: fill required image slots.
   - Page: title, publish / unpublish, delete.
========================================= */

export default function PageBuilder() {
    const { panel, closePanel, dynamicHost } = useAdmin();
    if (panel?.type !== "builder" || !dynamicHost) return null;
    return <BuilderDrawer host={dynamicHost} initialTab={panel.tab} onClose={closePanel} />;
}

const field = "w-full rounded-lg border border-[#CBD5E1] px-3 py-2 text-[13px] outline-none focus:border-[#0F9E86]";

function BuilderDrawer({ host, initialTab = "ai", onClose }) {
    const [tab, setTab] = useState(initialTab);
    const missing = (host.sections || []).flatMap((s) => (s.media || []).filter((m) => m.required && !m.image));
    const tabs = [["ai", "AI"], ["images", `Images${missing.length ? ` (${missing.length})` : ""}`], ["page", "Page"]];
    return (
        <Drawer open width={600} title={`Page builder: ${host.title}`} subtitle={`${host.kind === "blog" ? "/blog/" : "/"}${host.key} · ${host.status}`} onClose={onClose}>
            <div className="mb-4 flex gap-1">
                {tabs.map(([key, label]) => (
                    <button key={key} type="button" onClick={() => setTab(key)} className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${tab === key ? "bg-[#123A5C] text-white" : "text-[#475569] hover:bg-[#F1F5F9]"}`}>
                        {label}
                    </button>
                ))}
            </div>
            {tab === "ai" ? <BuilderAi host={host} /> : null}
            {tab === "images" ? <BuilderImages host={host} /> : null}
            {tab === "page" ? <BuilderPage host={host} onClose={onClose} /> : null}
        </Drawer>
    );
}

function BuilderAi({ host }) {
    const [mode, setMode] = useState("edit");
    const [strategy, setStrategy] = useState("expand");
    const [topic, setTopic] = useState("");
    const [brief, setBrief] = useState({ keyword: "", intent: "", location: "", audience: "", supporting: "", cta: "" });
    const [prompt, setPrompt] = useState("");
    const [preview, setPreview] = useState(null);
    const [raw, setRaw] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState("");

    async function build() {
        setBusy(true);
        setError("");
        try {
            const q = new URLSearchParams({ mode, strategy, topic, ...Object.fromEntries(Object.entries(brief).filter(([, v]) => v.trim())) });
            setPrompt((await apiRequest(`${host.base}/build-prompt/?${q}`)).prompt);
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function check(text) {
        setError("");
        setResult("");
        try {
            const data = await apiRequest("ai/normalize/", { method: "POST", body: { kind: "page", raw: text } });
            setRaw(text);
            setPreview(data.page);
            return true;
        } catch (err) {
            setError(err.message);
            return false;
        }
    }

    async function apply() {
        setBusy(true);
        setError("");
        try {
            const data = await apiRequest(`${host.base}/paste-to-edit/`, { method: "POST", body: { raw, as_draft: true } });
            await host.reload();
            setPreview(null);
            setRaw("");
            setResult(
                `Applied. Kept sections now hold drafts; new or changed section types were added directly.` +
                    (data.pending_images?.length ? `\n${data.pending_images.length} image slot(s) need an upload (Images tab).` : "") +
                    "\nReview the page, then Publish from the admin bar."
            );
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    const current = host.sections || [];

    return (
        <div className="space-y-5">
            <Step number={1} title="What should happen to this page?">
                <Segmented value={mode} onChange={setMode} options={[["edit", "Improve this page"], ["create", "Start over"]]} />
                {mode === "edit" ? <Segmented value={strategy} onChange={setStrategy} options={STRATEGY_OPTIONS} /> : null}
                <textarea rows={2} className={field} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={mode === "edit" ? "Change requested (optional): e.g. add pricing and an FAQ about deadlines" : "What the page should cover"} />
                <div className="grid grid-cols-2 gap-2">
                    <input className={field} value={brief.keyword} onChange={(e) => setBrief({ ...brief, keyword: e.target.value })} placeholder="Keyword (defaults to the page's SEO keyword)" />
                    <select className={field} value={brief.intent} onChange={(e) => setBrief({ ...brief, intent: e.target.value })}>
                        {INTENT_OPTIONS.map((o) => <option key={o} value={o}>{o ? humanize(o) : "Search intent…"}</option>)}
                    </select>
                    <input className={field} value={brief.location} onChange={(e) => setBrief({ ...brief, location: e.target.value })} placeholder="Location" />
                    <input className={field} value={brief.audience} onChange={(e) => setBrief({ ...brief, audience: e.target.value })} placeholder="Audience" />
                    <input className={field} value={brief.supporting} onChange={(e) => setBrief({ ...brief, supporting: e.target.value })} placeholder="Supporting keywords" />
                    <input className={field} value={brief.cta} onChange={(e) => setBrief({ ...brief, cta: e.target.value })} placeholder="Call to action" />
                </div>
                <button type="button" className={buttonStyles.primary} onClick={build} disabled={busy}>{busy ? "Building…" : prompt ? "Rebuild prompt" : "Build prompt"}</button>
            </Step>

            {prompt ? (
                <>
                    <Step number={2} title="Copy it into your AI chat"><PromptBox prompt={prompt} /></Step>
                    <Step number={3} title="Paste the reply to preview it">
                        <PasteBox onApply={check} applyLabel="Preview changes" />
                    </Step>
                </>
            ) : null}

            {preview ? (
                <Step number={4} title="Review, then apply">
                    <div className="rounded-xl border border-[#E2E8F0]">
                        {preview.sections.map((s, i) => {
                            const before = current[i];
                            const status = !before ? "new" : before.section_type !== s.section_type ? "replaces " + humanize(before.section_type) : "updated";
                            return (
                                <div key={i} className="flex items-center justify-between border-b border-[#F1F5F9] px-3 py-2 text-[12px] last:border-0">
                                    <span><strong>{i + 1}. {humanize(s.section_type)}</strong> {s.content.heading || s.content.text || ""}</span>
                                    <span className={status === "updated" ? "text-[#0F9E86]" : "text-[#B54708]"}>{status}</span>
                                </div>
                            );
                        })}
                        {current.length > preview.sections.length ? (
                            <p className="px-3 py-2 text-[12px] text-[#B42318]">
                                Removes {current.length - preview.sections.length} section(s): {current.slice(preview.sections.length).map((s) => humanize(s.section_type)).join(", ")}
                            </p>
                        ) : null}
                    </div>
                    {preview.seo?.title ? <p className="text-[12px] text-[#475569]">Suggested SEO title: “{preview.seo.title}” — set it in the SEO panel if you want it.</p> : null}
                    <div className="flex gap-2">
                        <button type="button" className={buttonStyles.primary} disabled={busy} onClick={apply}>{busy ? "Applying…" : "Apply to the page (as drafts)"}</button>
                        <button type="button" className={buttonStyles.secondary} onClick={() => setPreview(null)}>Cancel</button>
                    </div>
                </Step>
            ) : null}

            <Notice tone="error">{error}</Notice>
            <Notice tone="success">{result}</Notice>
        </div>
    );
}

function BuilderImages({ host }) {
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const slots = (host.sections || []).flatMap((s) => (s.media || []).map((m) => ({ ...m, section: s })));
    if (!slots.length) return <p className="text-[13px] text-[#64748B]">This page has no image slots.</p>;
    return (
        <div className="space-y-3">
            <Notice tone="error">{error}</Notice>
            {slots.map((m) => (
                <div key={m.id} className={`flex gap-3 rounded-xl border p-3 ${m.image ? "border-[#E2E8F0]" : m.required ? "border-[#FEC84B] bg-[#FFFAEB]" : "border-[#E2E8F0]"}`}>
                    <div className="h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-[#F1F5F9]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {m.image ? <img src={mediaUrl(m.image.url)} alt="" className="h-full w-full object-cover" /> : null}
                    </div>
                    <div className="min-w-0 flex-1 text-[12px]">
                        <p className="font-semibold">{humanize(m.section.section_type)} · {m.slot}{m.required ? " (required)" : ""}</p>
                        <p className="line-clamp-2 text-[#64748B]">{m.image_prompt || "No description"}</p>
                        <label className={`${buttonStyles.link} mt-1 inline-block cursor-pointer`}>
                            {busy === `${m.section.id}:${m.slot}` ? "Uploading…" : m.image ? "Replace" : "Upload"}
                            <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (!file) return;
                                setBusy(`${m.section.id}:${m.slot}`);
                                setError("");
                                try {
                                    const fd = new FormData();
                                    fd.append("image", file);
                                    await apiRequest(`${host.base}/sections/${m.section.id}/media/${encodeURIComponent(m.slot)}/`, { method: "POST", body: fd });
                                    await host.reload();
                                } catch (err) {
                                    setError(err.message);
                                } finally {
                                    setBusy("");
                                }
                            }} />
                        </label>
                    </div>
                </div>
            ))}
        </div>
    );
}

function BuilderPage({ host, onClose }) {
    const router = useRouter();
    const [title, setTitle] = useState(host.title);
    const [error, setError] = useState("");
    const [missing, setMissing] = useState([]);
    const [busy, setBusy] = useState(false);
    const hostUrl = host.kind === "blog" ? `blog/${host.key}/` : `content/pages/${host.key}/`;

    async function patch(body, message) {
        setBusy(true);
        setError("");
        setMissing([]);
        try {
            await apiRequest(hostUrl, { method: "PATCH", body });
            await host.reload();
            if (message) setError("");
        } catch (err) {
            setError(err.message);
            if (Array.isArray(err.body?.missing)) setMissing(err.body.missing);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-4">
            <label className="block text-[12px] font-semibold text-[#475569]">
                Page title
                <div className="mt-1 flex gap-2">
                    <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} />
                    <button type="button" className={buttonStyles.secondary} disabled={busy || title === host.title} onClick={() => patch({ title })}>Save</button>
                </div>
            </label>
            <div className="rounded-xl border border-[#E2E8F0] p-3 text-[13px]">
                <p>Status: <strong>{host.status}</strong></p>
                <p className="mt-1 text-[12px] text-[#64748B]">Publishing the page makes it visible at its URL. Section edits are drafts until you also Publish them from the admin bar.</p>
                <div className="mt-3 flex gap-2">
                    {host.status === "published" ? (
                        <button type="button" className={buttonStyles.secondary} disabled={busy} onClick={() => patch({ status: "draft" })}>Unpublish page</button>
                    ) : (
                        <button type="button" className={buttonStyles.primary} disabled={busy} onClick={() => patch({ status: "published" })}>Publish page</button>
                    )}
                </div>
            </div>
            <Notice tone="error">{error}</Notice>
            {missing.length ? (
                <Notice tone="warning">{`Upload these images first (Images tab):\n• ${missing.map((m) => m.image_prompt || m.slot).join("\n• ")}`}</Notice>
            ) : null}
            <button
                type="button"
                className={buttonStyles.danger}
                onClick={async () => {
                    if (!window.confirm(`Delete “${host.title}” permanently?`)) return;
                    await apiRequest(hostUrl, { method: "DELETE" });
                    onClose();
                    router.push(host.kind === "blog" ? "/resources" : "/");
                }}
            >
                Delete this page
            </button>
        </div>
    );
}
