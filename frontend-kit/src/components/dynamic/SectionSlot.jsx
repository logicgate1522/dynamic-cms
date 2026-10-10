"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { Notice, PasteBox, PromptBox, Segmented, Step, STRATEGY_OPTIONS } from "@/components/cms/ai";
import Drawer, { buttonStyles } from "@/components/cms/Drawer";
import { FloatingTools, PLACE, useFloating } from "@/components/cms/floating";
import { ObjectFields, humanize } from "@/components/cms/FieldEditor";
import { createInline } from "@/components/cms/inline";
import { SectionEditContext } from "@/components/dynamic/edit-context";
import { SECTION_REGISTRY } from "@/components/dynamic/registry";
import { Fallback } from "@/components/dynamic/sections";
import { apiRequest, setPath } from "@/lib/api";
import { HIDDEN_KEY, isHidden, stripHidden } from "@/lib/visibility";

/* =========================================
   One dynamic section, as an admin sees it:
   - text is click-to-edit in place (adapters use <T>)
   - hover toolbar: AI · Fields · Copy JSON — plus
     ↑ ↓ ＋ ✕ ONLY when the page belongs to a collection
     whose template allows adding this section type
     (`allowAdd`). Standalone pages and fixed templates
     keep their structure; admins change copy, not layout.
   - edits autosave to the section's DRAFT
     (PATCH …/sections/<id>/?mode=draft)
   - registers with the page registry, so the
     whole-page AI assist covers CMS pages too
========================================= */

// Starter content comes from the backend (one source for every client).
let startersPromise = null;
function loadStarters() {
    startersPromise ||= apiRequest("ai/section-schema/").then((d) => d.starters || {}).catch(() => ({}));
    return startersPromise;
}

const AUTOSAVE_MS = 700;
const chip = "pointer-events-auto rounded-md bg-white px-2 py-1 text-[11px] font-bold text-[#0F172A] shadow ring-1 ring-black/10 hover:bg-[var(--cms-accent-soft)] disabled:opacity-30";

export default function SectionSlot({ base, host, section, index, total, siblingIds, onChanged, allowAdd = [] }) {
    const { editMode, refreshDrafts, register } = useAdmin();
    const canRestructure = allowAdd.includes(section.section_type);
    const [content, setContent] = useState(section.draft_content ?? section.content ?? {});
    const [saveState, setSaveState] = useState("idle");
    const [error, setError] = useState("");
    const [panel, setPanel] = useState(null);
    const [adding, setAdding] = useState(false);
    const [copied, setCopied] = useState(false);
    const toolsAnchor = useRef(null);
    const tools = useFloating(toolsAnchor, { enabled: editMode, pinned: adding || Boolean(panel) });
    const noticeAnchor = useRef(null);
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

    const label = `${index + 1}. ${humanize(section.section_type)}`;
    stateRef.current = { data: content, editMode, update, defaults: {}, label: humanize(section.section_type), block: `section:${section.id}` };
    const [E] = useState(() => createInline(stateRef));

    // Page registry: whole-page AI assist + keyword coverage + flush before publish.
    useEffect(() => register(`section:${section.id}`, {
        name: `section:${section.id}`,
        kind: "section",
        label,
        hidden: isHidden(content),
        defaults: {},
        data: content,
        saveState,
        update,
        replace,
        flush: persist,
    }), [register, section.id, label, content, saveState, update, replace, persist]);

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
        const starters = await loadStarters();
        await apiRequest(`${base}/sections/add/`, { method: "POST", body: { section_type: type, content: starters[type] || {}, position: index + 1 } });
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
            {!editMode && isHidden(content) ? null : <div data-cms-hidden={editMode && isHidden(content) ? "section" : undefined} data-track-block={`section-${section.id}`} data-track-type={section.section_type} className={`group/slot relative ${editMode ? "outline-dashed outline-1 outline-transparent hover:outline-[var(--cms-accent)]/60" : ""}`}>
                {editMode ? (
                    <>
                        <span ref={toolsAnchor} hidden />
                        {/* Section label (top-left) and toolbar (top-right), floating (R30). */}
                        <FloatingTools tools={tools} place={PLACE.insideTopLeft} data-cms-section-label className="pointer-events-none rounded bg-[#0F172A] px-1.5 py-0.5 text-[10px] font-bold uppercase text-white">
                            {index + 1}. {humanize(section.section_type)}
                            {saveState === "saving" || saveState === "dirty" ? " · saving…" : section.draft_content || saveState === "saved" ? " · draft" : ""}
                        </FloatingTools>
                        <FloatingTools tools={tools} place={PLACE.insideTopRight} data-cms-section-tools={section.id} className="flex gap-1">
                            {canRestructure ? (
                                <>
                                    <button type="button" className={chip} disabled={index === 0} onClick={() => move(-1)} title="Move up">↑</button>
                                    <button type="button" className={chip} disabled={index === total - 1} onClick={() => move(1)} title="Move down">↓</button>
                                </>
                            ) : null}
                            {allowAdd.length ? <button type="button" className={chip} onClick={() => setAdding((v) => !v)} title="Add a section below">＋</button> : null}
                            <button type="button" className={chip} data-cms-action="toggle-section-hidden" onClick={() => update(HIDDEN_KEY, !isHidden(content))} title={isHidden(content) ? "Hidden from visitors (after Publish) — click to show" : "Hide this section from visitors"}>{isHidden(content) ? "Show" : "Hide"}</button>
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
                            {canRestructure ? <button type="button" className={`${chip} text-[#B42318]`} onClick={remove} title="Delete section">✕</button> : null}
                        </FloatingTools>
                    </>
                ) : null}

                {/* Publish blockers and errors float over the section's top edge
                    (always shown while they apply) instead of pushing it down. */}
                {editMode && (missing.length || error) ? (
                    <>
                        <span ref={noticeAnchor} hidden />
                        <SectionNotice anchor={noticeAnchor}>
                            {missing.length ? (
                                <span className="block rounded-lg bg-[#FFFAEB] px-3 py-1.5 text-[12px] text-[#B54708] shadow ring-1 ring-[#FEC84B]">
                                    Needs {missing.length} image{missing.length === 1 ? "" : "s"} before the page can be published: {missing.map((m) => m.image_prompt || m.slot).join(" · ")}
                                </span>
                            ) : null}
                            {error ? <span className="mt-1 block rounded-lg bg-[#FEF3F2] px-3 py-1.5 text-[12px] text-[#B42318] shadow ring-1 ring-[#FDA29B]">{error}</span> : null}
                        </SectionNotice>
                    </>
                ) : null}

                {Component ? <Component {...(editMode ? content : stripHidden(content))} media={section.media || []} /> : <Fallback type={section.section_type} />}

                {adding && editMode ? <TypePicker types={allowAdd} onPick={addBelow} onCancel={() => setAdding(false)} /> : null}
            </div>}

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

function SectionNotice({ anchor, children }) {
    const tools = useFloating(anchor, { pinned: true });
    return (
        <FloatingTools tools={tools} place={(r, s) => ({ left: r.left + r.width / 2 - s.w / 2, top: r.top + 44 })} className="max-w-[min(640px,calc(100vw-16px))]">
            {children}
        </FloatingTools>
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

function TypePicker({ types, onPick, onCancel }) {
    return (
        <div className="cms-ui relative z-[57] flex flex-wrap items-center gap-1 border-y border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
            <span className="mr-1 text-[12px] font-semibold text-[#475569]">Add below:</span>
            {types.map((t, index) => (
                <button key={index} type="button" onClick={() => onPick(t)} className="rounded-full border border-[#CBD5E1] bg-white px-2.5 py-1 text-[11px] font-semibold hover:border-[var(--cms-accent)]">
                    {humanize(t)}
                </button>
            ))}
            <button type="button" onClick={onCancel} className="ml-auto text-[12px] text-[#64748B]">Cancel</button>
        </div>
    );
}
