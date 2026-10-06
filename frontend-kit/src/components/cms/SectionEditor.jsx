"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { Notice, PasteBox, PromptBox, Segmented, Step, STRATEGY_OPTIONS, currentSeoPath } from "@/components/cms/ai";
import Drawer, { buttonStyles } from "@/components/cms/Drawer";
import { ObjectFields } from "@/components/cms/FieldEditor";
import { apiRequest, mergeDefaults } from "@/lib/api";

function formatDate(value) {
    try {
        return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    } catch {
        return value;
    }
}

// Panel for one registered block: every field, AI for just this block,
// raw JSON, and revision history. All changes land in the block's DRAFT.
export default function SectionEditor() {
    const { panel, editables, closePanel } = useAdmin();
    const entry = panel?.type === "section" ? editables[panel.name] : null;
    if (!entry) return null;
    return <SectionEditorDrawer key={entry.name} entry={entry} initialTab={panel.tab} onClose={closePanel} />;
}

function SectionEditorDrawer({ entry, initialTab = "fields", onClose }) {
    const [tab, setTab] = useState(initialTab);
    const [draft, setDraft] = useState(() => structuredClone(entry.data));
    const dirty = JSON.stringify(draft) !== JSON.stringify(entry.data);

    // Inline edits made while the panel is open flow back in.
    useEffect(() => {
        if (!dirty) setDraft(structuredClone(entry.data));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entry.data]);

    function close() {
        if (dirty && !window.confirm("Discard the changes in this panel?")) return;
        onClose();
    }

    const tabs = [
        ["fields", "All fields"],
        ["ai", "AI assist"],
        ["json", "JSON"],
        ["history", "History"],
    ];

    return (
        <Drawer
            open
            title={entry.label}
            subtitle={`Block “${entry.name}” · ${entry.saveState === "saving" ? "saving draft…" : entry.saveState === "error" ? "draft not saved" : "changes save as a draft"}`}
            onClose={close}
            footer={
                tab === "fields" ? (
                    <div className="flex items-center justify-between gap-3">
                        <button
                            type="button"
                            className={buttonStyles.danger}
                            onClick={() => {
                                if (window.confirm("Replace this block's draft with the built-in content? You can still discard drafts before publishing.")) {
                                    entry.replace(structuredClone(entry.defaults));
                                    setDraft(structuredClone(entry.defaults));
                                }
                            }}
                        >
                            Reset to built-in
                        </button>
                        <div className="flex gap-2">
                            <button type="button" className={buttonStyles.secondary} disabled={!dirty} onClick={() => setDraft(structuredClone(entry.data))}>
                                Undo panel edits
                            </button>
                            <button type="button" className={buttonStyles.primary} disabled={!dirty} onClick={() => entry.replace(structuredClone(draft))}>
                                Save draft
                            </button>
                        </div>
                    </div>
                ) : null
            }
        >
            <div className="mb-4 flex flex-wrap gap-1">
                {tabs.map(([key, label]) => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setTab(key)}
                        className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${tab === key ? "bg-[#123A5C] text-white" : "text-[#475569] hover:bg-[#F1F5F9]"}`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            <Notice tone="error">{entry.saveError}</Notice>

            {tab === "fields" ? (
                <div className="space-y-4">
                    <p className="text-[12px] text-[#64748B]">
                        Tip: most text can be edited by clicking it on the page. Use this panel for links, icons, image alt text and anything not shown inline.
                    </p>
                    <ObjectFields value={draft} template={entry.defaults} hints={entry.fields} onChange={setDraft} />
                </div>
            ) : null}

            {tab === "ai" ? <SectionAi entry={entry} /> : null}
            {tab === "json" ? <SectionJson entry={entry} /> : null}
            {tab === "history" ? <SectionHistory entry={entry} /> : null}
        </Drawer>
    );
}

function SectionAi({ entry }) {
    const pathname = usePathname();
    const [strategy, setStrategy] = useState("expand");
    const [keyword, setKeyword] = useState("");
    const [instruction, setInstruction] = useState("");
    const [prompt, setPrompt] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState("");

    async function build() {
        setBusy(true);
        setError("");
        try {
            const data = await apiRequest("ai/section-prompt/", {
                method: "POST",
                body: {
                    content: entry.data,
                    label: entry.label,
                    path: currentSeoPath(pathname),
                    keyword: keyword.trim() || undefined,
                    strategy,
                    instruction: instruction.trim(),
                },
            });
            setPrompt(data.prompt);
            if (!keyword && data.keyword) setKeyword(data.keyword);
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function apply(raw) {
        setError("");
        setResult("");
        try {
            const data = await apiRequest("ai/normalize/", { method: "POST", body: { kind: "section", raw, current: entry.data } });
            entry.replace(mergeDefaults(entry.defaults, data.content));
            setResult(
                "Applied to the draft — review it on the page, then Publish from the admin bar." +
                    (data.warnings.length ? `\n\n⚠ ${data.warnings.join("\n⚠ ")}` : "")
            );
            return true;
        } catch (err) {
            setError(err.message);
            return false;
        }
    }

    return (
        <div className="space-y-5">
            <Step number={1} title="Describe what you want">
                <Segmented value={strategy} onChange={setStrategy} options={STRATEGY_OPTIONS} />
                <input
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    placeholder="Keyword to work in (defaults to the page's SEO keyword)"
                    className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 text-[13px] outline-none focus:border-[#0F9E86]"
                />
                <textarea
                    rows={2}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="Optional: what to change (e.g. “make it more specific to landlords”)"
                    className="w-full rounded-lg border border-[#CBD5E1] px-3 py-2 text-[13px] outline-none focus:border-[#0F9E86]"
                />
                <button type="button" className={buttonStyles.primary} onClick={build} disabled={busy}>
                    {busy ? "Building…" : prompt ? "Rebuild prompt" : "Build prompt"}
                </button>
            </Step>
            {prompt ? (
                <>
                    <Step number={2} title="Copy the prompt">
                        <PromptBox prompt={prompt} />
                    </Step>
                    <Step number={3} title="Paste the AI's reply">
                        <PasteBox onApply={apply} />
                    </Step>
                </>
            ) : null}
            <Notice tone="error">{error}</Notice>
            <Notice tone="success">{result}</Notice>
        </div>
    );
}

function SectionJson({ entry }) {
    const [error, setError] = useState("");
    const [ok, setOk] = useState("");
    const json = JSON.stringify(entry.data, null, 2);
    return (
        <div className="space-y-4">
            <Step number={1} title="Current content (copy to edit elsewhere)">
                <PromptBox prompt={json} rows={10} />
            </Step>
            <Step number={2} title="Paste edited JSON">
                <PasteBox
                    applyLabel="Replace draft with this JSON"
                    onApply={async (raw) => {
                        setError("");
                        setOk("");
                        try {
                            const data = await apiRequest("ai/normalize/", { method: "POST", body: { kind: "section", raw, current: entry.data } });
                            entry.replace(mergeDefaults(entry.defaults, data.content));
                            setOk("Draft updated." + (data.warnings.length ? `\n⚠ ${data.warnings.join("\n⚠ ")}` : ""));
                            return true;
                        } catch (err) {
                            setError(err.message);
                            return false;
                        }
                    }}
                />
            </Step>
            <Notice tone="error">{error}</Notice>
            <Notice tone="success">{ok}</Notice>
        </div>
    );
}

function SectionHistory({ entry }) {
    const [rows, setRows] = useState(null);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        try {
            setRows(await apiRequest(`home/${entry.name}/history/`));
        } catch (err) {
            setRows([]);
            if (err.status !== 404) setError(err.message);
        }
    }, [entry.name]);

    useEffect(() => {
        load();
    }, [load]);

    return (
        <div className="space-y-2">
            <p className="text-[12px] text-[#64748B]">Restoring copies a version into the draft — publish to make it live.</p>
            <Notice tone="error">{error}</Notice>
            {rows === null ? <p className="text-[13px] text-[#64748B]">Loading…</p> : null}
            {rows?.length === 0 ? <p className="text-[13px] text-[#64748B]">No saved versions yet.</p> : null}
            {rows?.map((rev) => (
                <div key={rev.id} className="flex items-center justify-between rounded-lg border border-[#E2E8F0] px-3 py-2">
                    <div>
                        <p className="text-[13px] font-medium text-[#1E293B]">{rev.note || "edit"}</p>
                        <p className="text-[11px] text-[#64748B]">{formatDate(rev.created_at)}{rev.saved_by ? ` · ${rev.saved_by}` : ""}</p>
                    </div>
                    <button type="button" className={buttonStyles.link} onClick={() => entry.replace(mergeDefaults(entry.defaults, rev.data))}>
                        Restore to draft
                    </button>
                </div>
            ))}
        </div>
    );
}
