"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { Notice, PasteBox, PromptBox, Segmented, Step, STRATEGY_OPTIONS } from "@/components/cms/ai";
import Drawer, { buttonStyles } from "@/components/cms/Drawer";
import { ObjectFields, humanize } from "@/components/cms/FieldEditor";
import { createInline } from "@/components/cms/inline";
import { SectionEditContext } from "@/components/dynamic/edit-context";
import { SECTION_REGISTRY } from "@/components/dynamic/registry";
import { Fallback } from "@/components/dynamic/sections";
import { apiRequest, setPath } from "@/lib/api";

/* =========================================
   One dynamic section, as an admin sees it:
   - text is click-to-edit in place (adapters use <T>)
   - hover toolbar: ↑ ↓ · + add below · AI · Fields ·
     Copy JSON · delete
   - edits autosave to the section's DRAFT
     (PATCH …/sections/<id>/?mode=draft)
========================================= */

const AUTOSAVE_MS = 700;
const chip = "pointer-events-auto rounded-md bg-white px-2 py-1 text-[11px] font-bold text-[#0F172A] shadow ring-1 ring-black/10 hover:bg-[#ECFDF5] disabled:opacity-30";

export default function SectionSlot({ base, host, section, index, total, siblingIds, onChanged }) {
    const { editMode, refreshDrafts, addFlusher } = useAdmin();
    const [content, setContent] = useState(section.draft_content ?? section.content ?? {});
    const [saveState, setSaveState] = useState("idle");
    const [error, setError] = useState("");
    const [panel, setPanel] = useState(null);
    const [adding, setAdding] = useState(false);
    const [copied, setCopied] = useState(false);
    const pending = useRef(null);

    useEffect(() => {
        if (pending.current) return; // an unsaved local edit wins until it saves
        setContent(section.draft_content ?? section.content ?? {});
        setSaveState("idle");
    }, [section]);

    /* ---------- autosave draft ---------- */
    const timer = useRef(null);
    const persist = useCallback(async () => {
        clearTimeout(timer.current);
        const body = pending.current;
        if (!body) return;
        pending.current = null;
        setSaveState("saving");
        try {
            await apiRequest(`${base}/sections/${section.id}/?mode=draft`, { method: "PATCH", body: { content: body } });
            setSaveState("saved");
            setError("");
            refreshDrafts();
        } catch (err) {
            setSaveState("error");
            setError(err.message);
        }
    }, [base, section.id, refreshDrafts]);

    useEffect(() => () => {
        if (pending.current) persist();
    }, [persist]);
    useEffect(() => addFlusher(persist), [addFlusher, persist]);

    const stateRef = useRef({});
    const replace = useCallback((next) => {
        stateRef.current.data = next;
        setContent(next);
        pending.current = next;
        setSaveState("dirty");
        clearTimeout(timer.current);
        timer.current = setTimeout(persist, AUTOSAVE_MS);
    }, [persist]);
    const update = useCallback((path, value) => replace(setPath(stateRef.current.data, path, value)), [replace]);

    stateRef.current = { data: content, editMode, update, defaults: {}, label: humanize(section.section_type), block: `section:${section.id}` };
    const [E] = useState(() => createInline(stateRef));

    /* ---------- structure ---------- */
    async function act(fn) {
        setError("");
        try {
            await fn();
            await onChanged();
        } catch (err) {
            setError(err.message);
        }
    }
    const move = (dir) => act(() => {
        const ids = [...siblingIds];
        const to = index + dir;
        [ids[index], ids[to]] = [ids[to], ids[index]];
        return apiRequest(`${base}/sections/reorder/`, { method: "POST", body: { order: ids } });
    });
    const remove = () => window.confirm(`Delete this ${humanize(section.section_type)} section?`) &&
        act(() => apiRequest(`${base}/sections/${section.id}/`, { method: "DELETE" }));
    const addBelow = (type) => act(async () => {
        setAdding(false);
        await apiRequest(`${base}/sections/add/`, { method: "POST", body: { section_type: type, content: starterContent(type), position: index + 1 } });
    });

    const uploadSlot = (slot, file) => act(() => {
        const fd = new FormData();
        fd.append("image", file);
        return apiRequest(`${base}/sections/${section.id}/media/${encodeURIComponent(slot)}/`, { method: "POST", body: fd });
    });

    const Component = SECTION_REGISTRY[section.section_type];
    const missing = (section.media || []).filter((m) => m.required && !m.image);

    return (
        <SectionEditContext.Provider value={{ E, editMode, uploadSlot }}>
            <div className={`group/slot relative ${editMode ? "outline-dashed outline-1 outline-transparent hover:outline-[#0F9E86]/60" : ""}`}>
                {editMode ? (
                    <>
                        <span className="cms-ui pointer-events-none absolute left-3 top-3 z-[56] rounded bg-[#0F172A] px-1.5 py-0.5 text-[10px] font-bold uppercase text-white opacity-0 transition group-hover/slot:opacity-100">
                            {index + 1}. {humanize(section.section_type)}
                            {saveState === "saving" || saveState === "dirty" ? " · saving…" : section.draft_content || saveState === "saved" ? " · draft" : ""}
                        </span>
                        <div className="cms-ui pointer-events-none absolute right-3 top-3 z-[56] flex gap-1 opacity-0 transition group-hover/slot:opacity-100">
                            <button type="button" className={chip} disabled={index === 0} onClick={() => move(-1)} title="Move up">↑</button>
                            <button type="button" className={chip} disabled={index === total - 1} onClick={() => move(1)} title="Move down">↓</button>
                            <button type="button" className={chip} onClick={() => setAdding((v) => !v)} title="Add a section below">＋</button>
                            <button type="button" className={chip} onClick={() => setPanel("ai")}>✦ AI</button>
                            <button type="button" className={chip} onClick={() => setPanel("fields")}>Fields</button>
                            <button
                                type="button"
                                className={chip}
                                onClick={async () => {
                                    await navigator.clipboard.writeText(JSON.stringify(content, null, 2)).catch(() => {});
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 1200);
                                }}
                            >
                                {copied ? "Copied" : "JSON"}
                            </button>
                            <button type="button" className={`${chip} text-[#B42318]`} onClick={remove} title="Delete section">✕</button>
                        </div>
                    </>
                ) : null}

                {missing.length && editMode ? (
                    <div className="cms-ui relative z-[56] bg-[#FFFAEB] px-4 py-2 text-[12px] text-[#B54708]">
                        Needs {missing.length} image{missing.length === 1 ? "" : "s"} before the page can be published: {missing.map((m) => m.image_prompt || m.slot).join(" · ")}
                    </div>
                ) : null}
                {error && editMode ? <div className="cms-ui relative z-[56] bg-[#FEF3F2] px-4 py-2 text-[12px] text-[#B42318]">{error}</div> : null}

                {Component ? <Component {...content} media={section.media || []} /> : <Fallback type={section.section_type} />}

                {adding && editMode ? <TypePicker onPick={addBelow} onCancel={() => setAdding(false)} /> : null}
            </div>

            {panel === "fields" ? (
                <Drawer open title={`${humanize(section.section_type)} section`} subtitle="Changes save as a draft" onClose={() => setPanel(null)}>
                    <FieldsPanel content={content} onApply={(next) => { replace(next); setPanel(null); }} />
                </Drawer>
            ) : null}
            {panel === "ai" ? (
                <Drawer open title={`AI: ${humanize(section.section_type)} section`} subtitle="Prompt for just this section" onClose={() => setPanel(null)}>
                    <SlotAi host={host} section={section} content={content} onApply={replace} />
                </Drawer>
            ) : null}
        </SectionEditContext.Provider>
    );
}

function FieldsPanel({ content, onApply }) {
    const [draft, setDraft] = useState(() => structuredClone(content));
    return (
        <div className="space-y-4">
            <ObjectFields value={draft} template={content} onChange={setDraft} />
            <button type="button" className={buttonStyles.primary} onClick={() => onApply(draft)}>Save draft</button>
        </div>
    );
}

function SlotAi({ host, section, content, onApply }) {
    const [strategy, setStrategy] = useState("expand");
    const [keyword, setKeyword] = useState("");
    const [instruction, setInstruction] = useState("");
    const [prompt, setPrompt] = useState("");
    const [error, setError] = useState("");
    const [result, setResult] = useState("");

    const build = async () => {
        setError("");
        try {
            const media = (section.media || []).filter((m) => m.image).map((m) => `${m.slot}: ${m.alt_override || m.image?.alt_text || "image"}`);
            const data = await apiRequest("ai/section-prompt/", {
                method: "POST",
                body: {
                    content,
                    section_type: section.section_type,
                    path: host.kind === "blog" ? `blog/${host.key}` : host.key,
                    page_type: host.pageType,
                    host_kind: host.kind,
                    keyword: keyword.trim() || undefined,
                    strategy,
                    instruction,
                    existing_media: media,
                },
            });
            setPrompt(data.prompt);
            if (!keyword && data.keyword) setKeyword(data.keyword);
        } catch (err) {
            setError(err.message);
        }
    };

    return (
        <div className="space-y-5">
            <Step number={1} title="What should change?">
                <Segmented value={strategy} onChange={setStrategy} options={STRATEGY_OPTIONS} />
                <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="Keyword (defaults to the page's SEO keyword)" className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 text-[13px]" />
                <textarea rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Optional instruction" className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 text-[13px]" />
                <button type="button" className={buttonStyles.primary} onClick={build}>{prompt ? "Rebuild prompt" : "Build prompt"}</button>
            </Step>
            {prompt ? (
                <>
                    <Step number={2} title="Copy the prompt"><PromptBox prompt={prompt} /></Step>
                    <Step number={3} title="Paste the reply">
                        <PasteBox
                            onApply={async (raw) => {
                                setError("");
                                try {
                                    const data = await apiRequest("ai/normalize/", { method: "POST", body: { kind: "section", raw, current: content } });
                                    onApply(data.content);
                                    setResult("Applied to the draft." + (data.warnings.length ? `\n⚠ ${data.warnings.join("\n⚠ ")}` : ""));
                                    return true;
                                } catch (err) {
                                    setError(err.message);
                                    return false;
                                }
                            }}
                        />
                    </Step>
                </>
            ) : null}
            <Notice tone="error">{error}</Notice>
            <Notice tone="success">{result}</Notice>
        </div>
    );
}

const STARTERS = {
    hero: { heading: "New heading", description: "Describe the offer in one or two sentences.", button_text: "Get started", button_href: "/contact" },
    rich_text: { heading: "New section", content: "Write the first paragraph here." },
    image_text: { heading: "New section", content: "Write the copy here.", image_position: "right" },
    cta: { heading: "Ready to get started?", description: "", button_text: "Contact us", button_href: "/contact" },
    banner: { text: "Announcement text", link_text: "", link_href: "" },
    video: { heading: "", video_url: "https://www.youtube.com/embed/" },
    contact_block: { heading: "Get in touch", email: "", phone: "", address: "" },
    map_block: { heading: "Find us", embed_url: "https://www.google.com/maps/embed?pb=" },
    newsletter: { heading: "Stay in the loop", description: "", form_name: "newsletter" },
};
const LIST_STARTER = {
    cards: { title: "Card title", description: "Card text", href: "" },
    features: { title: "Feature", description: "What it does" },
    statistics: { value: "100+", label: "Label" },
    testimonials: { quote: "Quote", author: "Name", role: "Role", rating: 5 },
    faq: { question: "Question?", answer: "Answer." },
    gallery: { caption: "" },
    team: { name: "Name", role: "Role", bio: "" },
    timeline: { date: "2026", title: "Milestone", description: "" },
    pricing: { name: "Plan", price: "£0", period: "month", features: ["Feature"], button_text: "Choose", button_href: "/contact" },
    logos: { name: "Partner" },
    steps: { title: "Step", description: "What happens" },
};

export function starterContent(type) {
    if (STARTERS[type]) return structuredClone(STARTERS[type]);
    if (LIST_STARTER[type]) return { heading: "New section", items: [structuredClone(LIST_STARTER[type])] };
    return {};
}

function TypePicker({ onPick, onCancel }) {
    const types = Object.keys(SECTION_REGISTRY);
    return (
        <div className="cms-ui relative z-[57] flex flex-wrap items-center gap-1 border-y border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
            <span className="mr-1 text-[12px] font-semibold text-[#475569]">Add below:</span>
            {types.map((t) => (
                <button key={t} type="button" onClick={() => onPick(t)} className="rounded-full border border-[#CBD5E1] bg-white px-2.5 py-1 text-[11px] font-semibold hover:border-[#0F9E86]">
                    {humanize(t)}
                </button>
            ))}
            <button type="button" onClick={onCancel} className="ml-auto text-[12px] text-[#64748B]">Cancel</button>
        </div>
    );
}
