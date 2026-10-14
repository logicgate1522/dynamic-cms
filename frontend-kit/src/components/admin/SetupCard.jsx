"use client";

import { useState } from "react";

import { Card } from "@/components/admin/AdminShell";
import { useApi } from "@/components/admin/useApi";
import { Notice, PasteBox, PromptBox, Step } from "@/components/cms/ai";
import { buttonStyles } from "@/components/cms/Drawer";
import { apiRequest } from "@/lib/api";

/* Settings → Setup: how complete the always-needed settings are, what is missing (grouped, each
   with a jump link), and the one-go AI fill-in: copy ONE prompt that carries all the context and
   tells the AI to ask the owner questions when it can't answer, paste the reply back, done.
   Optional things (extra pixels, custom code…) are never listed here. */
export default function SetupCard({ onJump, onApplied, refreshKey = 0 }) {
    const setup = useApi(`settings/setup/?r=${refreshKey}`);
    const [open, setOpen] = useState(false);
    const [notes, setNotes] = useState("");
    const [prompt, setPrompt] = useState("");
    const [busy, setBusy] = useState("");
    const [result, setResult] = useState(null);
    const [error, setError] = useState("");
    const report = setup.data;

    if (!report) return null;
    const percent = report.percent;
    const askable = report.missing.filter((i) => i.ai).length;

    const buildPrompt = async () => {
        setBusy("prompt");
        setError("");
        try {
            const res = await apiRequest("ai/settings-prompt/", { method: "POST", body: { notes } });
            setPrompt(res.prompt);
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy("");
        }
    };

    const apply = async (reply) => {
        setBusy("apply");
        setError("");
        try {
            const res = await apiRequest("settings/setup/", { method: "POST", body: { reply } });
            setResult(res);
            setup.reload?.();
            onApplied?.(res);
            return true;
        } catch (err) {
            setError(err.message);
            return false;
        } finally {
            setBusy("");
        }
    };

    const byGroup = report.groups.map((g) => ({ ...g, items: report.items.filter((i) => i.group === g.id) })).filter((g) => g.items.length);

    return (
        <Card data-cms-settings="setup" className="mb-6">
            <div className="flex flex-wrap items-center gap-4">
                <div className="relative h-14 w-14 shrink-0">
                    <svg viewBox="0 0 36 36" className="h-14 w-14 -rotate-90">
                        <circle cx="18" cy="18" r="15.5" fill="none" stroke="#E2E8F0" strokeWidth="3.5" />
                        <circle cx="18" cy="18" r="15.5" fill="none" stroke={percent === 100 ? "#12B76A" : "var(--cms-accent)"} strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${(percent / 100) * 97.4} 97.4`} />
                    </svg>
                    <span className="absolute inset-0 flex items-center justify-center text-[13px] font-bold text-[#0F172A]" data-cms-setup-percent>{percent}%</span>
                </div>
                <div className="min-w-0 flex-1">
                    <h2 className="text-[15px] font-bold">{percent === 100 ? "Everything the site needs is set" : "Finish setting up your site"}</h2>
                    <p className="text-[13px] text-[#475569]">
                        {report.done} of {report.total} essentials set.{" "}
                        {report.missing.length ? "Only things every site should have are counted — extras stay in their own tabs." : ""}
                    </p>
                </div>
                {askable ? (
                    <button type="button" className={buttonStyles.primary} onClick={() => setOpen(!open)} data-cms-action="setup-ai">
                        {open ? "Close" : `Fill ${askable} with AI`}
                    </button>
                ) : null}
            </div>

            {open ? (
                <div className="mt-5 space-y-4 rounded-xl bg-[#F8FAFC] p-4">
                    <Step number={1} title="Tell the AI about the business (optional)">
                        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. We are a two-person accounting firm in Leeds serving contractors and small limited companies…" className="w-full rounded-lg border border-[#CBD5E1] p-2.5 text-[12px] outline-none focus:border-[var(--cms-accent)]" />
                        <button type="button" className={buttonStyles.secondary} onClick={buildPrompt} disabled={busy === "prompt"}>{busy === "prompt" ? "Building…" : prompt ? "Rebuild prompt" : "Build the prompt"}</button>
                    </Step>
                    {prompt ? (
                        <Step number={2} title="Copy it into any AI chat — it asks you questions if it needs more">
                            <PromptBox prompt={prompt} rows={7} />
                        </Step>
                    ) : null}
                    {prompt ? (
                        <Step number={3} title="Paste the JSON reply (not its questions)">
                            <PasteBox onApply={apply} busy={busy === "apply"} applyLabel="Fill my settings" />
                        </Step>
                    ) : null}
                    <Notice tone="error">{error}</Notice>
                    {result ? (
                        <Notice tone={result.applied.length ? "success" : "warning"}>
                            {result.applied.length ? `Filled ${result.applied.length}: ${result.applied.join(", ")}.` : "Nothing was filled."}
                            {result.skipped.length ? `\nSkipped: ${result.skipped.map((s) => `${s.key} (${s.reason})`).join("; ")}.` : ""}
                        </Notice>
                    ) : null}
                </div>
            ) : null}

            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {byGroup.map((g) => {
                    const left = g.items.filter((i) => !i.filled).length;
                    return (
                        <div key={g.id} className="rounded-xl border border-[#E2E8F0] p-3">
                            <button type="button" onClick={() => onJump?.(g.id)} className="flex w-full items-center justify-between text-left">
                                <span className="text-[13px] font-semibold text-[#0F172A]">{g.label}</span>
                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${left ? "bg-[#FFFAEB] text-[#B54708]" : "bg-[#ECFDF3] text-[#067647]"}`}>{left ? `${left} to do` : "done"}</span>
                            </button>
                            <ul className="mt-2 space-y-1">
                                {g.items.map((i) => (
                                    <li key={i.key} className={`flex items-start gap-2 text-[12px] ${i.filled ? "text-[#64748B]" : "text-[#0F172A]"}`}>
                                        <span aria-hidden="true" className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[9px] ${i.filled ? "bg-[#12B76A] text-white" : "border border-[#CBD5E1]"}`}>{i.filled ? "✓" : ""}</span>
                                        {i.label}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    );
                })}
            </div>
        </Card>
    );
}
