"use client";

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { Notice, PasteBox, PromptBox, Step, currentSeoPath } from "@/components/cms/ai";
import Drawer, { buttonStyles } from "@/components/cms/Drawer";
import { apiRequest, mergeDefaults } from "@/lib/api";
import { containsKeyword, flattenText } from "@/lib/keywords";

/* =========================================
   Whole-page AI assist.
   Every block registered by useCms() on this page
   goes into ONE prompt (built by the backend, with
   a mechanical keyword pre-check). The AI's reply is
   cleaned by ai/normalize/ (lists can't silently
   shrink, URLs unwrapped) and fanned out to each
   block's draft. Nothing is public until Publish.
========================================= */

export function useKeywordCoverage(path) {
    const { editables, isAdmin } = useAdmin();
    const [keyword, setKeyword] = useState(null);

    useEffect(() => {
        if (!isAdmin) return;
        apiRequest(`seo/${path}/`)
            .then((seo) => setKeyword(seo?.keywords?.primary || ""))
            .catch(() => setKeyword(""));
    }, [isAdmin, path]);

    return useMemo(() => {
        const counted = Object.values(editables).filter((e) => !e.excludeFromKeywordAudit);
        if (!keyword || !counted.length) return { keyword: keyword || "", percent: null, rows: [] };
        const rows = Object.values(editables).map((e) => ({
            name: e.name,
            label: e.label,
            excluded: e.excludeFromKeywordAudit,
            hasKeyword: containsKeyword(flattenText(e.data).join(" \n "), keyword),
        }));
        const withKeyword = rows.filter((r) => !r.excluded && r.hasKeyword).length;
        return { keyword, rows, withKeyword, total: counted.length, percent: Math.round((withKeyword / counted.length) * 100) };
    }, [editables, keyword]);
}

export default function PageAssist() {
    const { panel, closePanel } = useAdmin();
    if (panel?.type !== "assist") return null;
    return <PageAssistDrawer onClose={closePanel} />;
}

function PageAssistDrawer({ onClose }) {
    const pathname = usePathname();
    const path = currentSeoPath(pathname);
    const { editables, openPanel } = useAdmin();
    const coverage = useKeywordCoverage(path);
    const [prompt, setPrompt] = useState("");
    const [audit, setAudit] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState("");
    const [warnings, setWarnings] = useState("");

    const blocks = Object.values(editables);

    async function build() {
        setBusy(true);
        setError("");
        try {
            const sections = Object.fromEntries(
                blocks.map((e) => [e.name, { label: e.label, content: e.data, excludeFromKeywordAudit: e.excludeFromKeywordAudit }])
            );
            const data = await apiRequest("ai/page-assist-prompt/", { method: "POST", body: { path, sections } });
            setPrompt(data.prompt);
            setAudit(data.audit);
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    async function apply(raw) {
        setError("");
        setResult("");
        setWarnings("");
        try {
            const current = Object.fromEntries(blocks.map((e) => [e.name, e.data]));
            const data = await apiRequest("ai/normalize/", { method: "POST", body: { kind: "page_assist", raw, current } });
            const applied = Object.entries(data.applied);
            applied.forEach(([name, content]) => {
                const entry = editables[name];
                entry?.replace(mergeDefaults(entry.defaults, content));
            });
            if (!applied.length) {
                setResult(data.unmatched.length ? "" : "The AI found nothing to change.");
                if (data.unmatched.length) setError(`None of the ids in that reply match this page's blocks (${data.unmatched.join(", ")}).`);
                return true;
            }
            setResult(
                `Applied to ${applied.length} block${applied.length === 1 ? "" : "s"} as drafts: ${applied.map(([n]) => editables[n]?.label || n).join(", ")}.\nReview them on the page, then Publish from the admin bar.` +
                    (data.unmatched.length ? `\nIgnored unknown ids: ${data.unmatched.join(", ")}.` : "")
            );
            setWarnings(data.warnings.join("\n"));
            return true;
        } catch (err) {
            setError(err.message);
            return false;
        }
    }

    const shown = audit || (coverage.percent !== null ? { keyword: coverage.keyword, percent: coverage.percent, withKeyword: coverage.withKeyword, total: coverage.total, sections: coverage.rows.map((r) => ({ id: r.name, label: r.label, hasKeyword: r.hasKeyword, excluded: r.excluded })) } : null);
    const failingRules = (audit?.rules || []).filter((r) => !r.pass && !r.skip);

    return (
        <Drawer open title="Whole-page AI assist" subtitle={`${blocks.length} editable block${blocks.length === 1 ? "" : "s"} on /${path === "home" ? "" : path}`} onClose={onClose} width={560}>
            <div className="space-y-5">
                <p className="text-[12px] leading-5 text-[#475569]">
                    One prompt audits every block on this page for the page&apos;s keyword and for thin or generic copy. Paste the reply back once — each block gets its own draft.
                </p>

                {shown ? (
                    <div className="space-y-2 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#0F172A]">Keyword coverage</span>
                            <CoverageBadge percent={shown.percent} />
                        </div>
                        {shown.keyword ? (
                            <p className="text-[12px] text-[#475569]">“{shown.keyword}” appears in {shown.withKeyword} of {shown.total} blocks.</p>
                        ) : null}
                        <div className="flex flex-wrap gap-1">
                            {(shown.sections || []).map((s) => (
                                <span
                                    key={s.id}
                                    className={`rounded-full border px-2 py-0.5 text-[11px] ${s.excluded ? "border-[#E2E8F0] text-[#94A3B8]" : s.hasKeyword ? "border-[#A7F3D0] bg-[#ECFDF5] text-[#047857]" : "border-[#FDE68A] bg-[#FFFBEB] text-[#B45309]"}`}
                                    title={s.excluded ? "Shared block — not counted" : s.hasKeyword ? "Contains the keyword" : "Missing the keyword"}
                                >
                                    {s.hasKeyword ? "✓ " : ""}{s.label}
                                </span>
                            ))}
                        </div>
                    </div>
                ) : (
                    <Notice tone="warning">No primary keyword is set for this page. Set one in SEO (or use “Find keywords” there) for a sharper audit — the AI will otherwise pick one.</Notice>
                )}

                {failingRules.length ? (
                    <Notice tone="warning">
                        {`SEO metadata needs attention (fix in the SEO panel — page content can't fix these):\n• ${failingRules.map((r) => r.label).join("\n• ")}`}
                        <div className="mt-2">
                            <button type="button" className={buttonStyles.link} onClick={() => openPanel("seo")}>Open SEO panel →</button>
                        </div>
                    </Notice>
                ) : null}

                <Step number={1} title="Build the prompt">
                    <button type="button" className={buttonStyles.primary} onClick={build} disabled={busy || !blocks.length}>
                        {busy ? "Building…" : prompt ? "Rebuild with latest content" : "Build prompt for this page"}
                    </button>
                </Step>
                {prompt ? (
                    <>
                        <Step number={2} title="Copy it into your AI chat">
                            <PromptBox prompt={prompt} />
                        </Step>
                        <Step number={3} title="Paste the reply — every block updates as a draft">
                            <PasteBox onApply={apply} applyLabel="Apply to every block (as drafts)" />
                        </Step>
                    </>
                ) : null}
                <Notice tone="error">{error}</Notice>
                <Notice tone="success">{result}</Notice>
                <Notice tone="warning">{warnings ? `Blocked likely data loss:\n${warnings}` : ""}</Notice>
            </div>
        </Drawer>
    );
}

export function CoverageBadge({ percent }) {
    if (percent === null || percent === undefined) {
        return <span className="rounded-full bg-[#E2E8F0] px-2 py-0.5 text-[11px] font-bold text-[#475569]">no keyword</span>;
    }
    const tone = percent >= 60 ? "bg-[#DCFCE7] text-[#166534]" : percent > 0 ? "bg-[#FEF3C7] text-[#92400E]" : "bg-[#FEE2E2] text-[#991B1B]";
    return <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${tone}`}>{percent}% keyword</span>;
}
