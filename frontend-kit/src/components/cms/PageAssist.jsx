"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { Notice, PasteBox, PromptBox, currentSeoPath } from "@/components/cms/ai";
import Drawer, { buttonStyles } from "@/components/cms/Drawer";
import { apiRequest, mergeDefaults } from "@/lib/api";
import { containsKeyword, flattenText } from "@/lib/keywords";
import { PAGE_ASSIST_RULES, seoChecks } from "@/lib/seoChecks";

/* =========================================
   Whole-page AI assist.
   Every editable block on the page — useCms blocks AND
   CMS-page sections — goes into ONE prompt, built by the
   backend (ai/page-assist-prompt/) with a mechanical
   keyword pre-check. Opening the panel builds it; the
   coverage card is LIVE (recomputed from the blocks as
   they change, including right after Apply).
   The reply goes through ai/normalize/ (prose/fences
   stripped, lists can't silently shrink, URLs unwrapped)
   and fans out to each block's own draft.
========================================= */

export const SEO_SAVED_EVENT = "cms:seo-saved";

// The page's SEO row, refreshed whenever the SEO panel saves.
export function usePageSeo(path) {
    const { isAdmin } = useAdmin();
    const [seo, setSeo] = useState(null);
    useEffect(() => {
        if (!isAdmin) return undefined;
        let cancelled = false;
        const load = () =>
            apiRequest(`seo/${path}/`)
                .then((row) => !cancelled && setSeo(row || {}))
                .catch(() => !cancelled && setSeo({}));
        load();
        window.addEventListener(SEO_SAVED_EVENT, load);
        return () => {
            cancelled = true;
            window.removeEventListener(SEO_SAVED_EVENT, load);
        };
    }, [isAdmin, path]);
    return seo;
}

export function useKeywordCoverage(path) {
    const { editables } = useAdmin();
    const seo = usePageSeo(path);
    const keyword = String(seo?.keywords?.primary || "").trim();

    return useMemo(() => {
        const blocks = Object.values(editables);
        const rows = blocks.map((e) => ({
            id: e.name,
            label: e.label,
            excluded: Boolean(e.excludeFromKeywordAudit),
            hasKeyword: keyword ? containsKeyword(flattenText(e.data).join(" \n "), keyword) : null,
        }));
        const counted = rows.filter((r) => !r.excluded);
        const withKeyword = counted.filter((r) => r.hasKeyword).length;
        return {
            seo,
            keyword,
            rows,
            withKeyword,
            total: counted.length,
            percent: keyword && counted.length ? Math.round((withKeyword / counted.length) * 100) : null,
        };
    }, [editables, keyword, seo]);
}

export default function PageAssist() {
    const { panel, closePanel } = useAdmin();
    if (panel?.type !== "assist") return null;
    return <PageAssistDrawer onClose={closePanel} />;
}

function PageAssistDrawer({ onClose }) {
    const pathname = usePathname();
    const path = currentSeoPath(pathname);
    const { editables, openPanel, seoPath } = useAdmin();
    const coverage = useKeywordCoverage(path);
    const [prompt, setPrompt] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState("");
    const [warnings, setWarnings] = useState("");
    const blocks = Object.values(editables);
    const built = useRef(false);

    const rules = useMemo(() => {
        if (!coverage.seo) return [];
        const byId = Object.fromEntries(seoChecks(coverage.seo).map((c) => [c.id, c]));
        return PAGE_ASSIST_RULES.map((id) => byId[id]).filter(Boolean);
    }, [coverage.seo]);
    const failingRules = rules.filter((r) => !r.pass && !r.skip);

    const build = useCallback(async () => {
        if (!blocks.length) return;
        setBusy(true);
        setError("");
        try {
            const sections = Object.fromEntries(
                blocks.map((e) => [e.name, { label: e.label, content: e.data, excludeFromKeywordAudit: e.excludeFromKeywordAudit }])
            );
            const data = await apiRequest("ai/page-assist-prompt/", { method: "POST", body: { path, sections } });
            setPrompt(data.prompt);
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }, [blocks, path]);

    // Opening the panel IS the first step: build the prompt straight away.
    useEffect(() => {
        if (built.current || !blocks.length) return;
        built.current = true;
        build();
    }, [blocks.length, build]);

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
                entry?.replace(entry.defaults && Object.keys(entry.defaults).length ? mergeDefaults(entry.defaults, content) : content);
            });
            if (!applied.length) {
                if (data.unmatched.length) setError(`None of the ids in that reply match this page's sections (${data.unmatched.join(", ")}). Copy the prompt again — the ids must match exactly.`);
                else setResult("The AI found nothing to change.");
                return !data.unmatched.length;
            }
            setResult(
                `Applied to ${applied.length} section${applied.length === 1 ? "" : "s"} as drafts: ${applied.map(([n]) => editables[n]?.label || n).join(", ")}.\nReview them on the page, then Publish from the admin bar.` +
                    (data.unmatched.length ? `\nIgnored unknown ids: ${data.unmatched.join(", ")}.` : "")
            );
            setWarnings(data.warnings.join("\n"));
            return true;
        } catch (err) {
            setError(err.message);
            return false;
        }
    }

    return (
        <Drawer open title="◆ Whole-page AI assist" subtitle={`${blocks.length} editable section${blocks.length === 1 ? "" : "s"} on /${path === "home" ? "" : path}`} onClose={onClose} width={560}>
            <div className="space-y-4" data-cms-panel="page-assist">
                <p className="text-[13px] leading-5 text-[#475569]">
                    One prompt covers every editable section on this page. Paste the AI&apos;s reply back once and it fans out to each section&apos;s own draft automatically — no per-section copy/paste.
                </p>

                {!blocks.length ? (
                    <Notice tone="warning">This page has no editable sections yet.</Notice>
                ) : (
                    <CoverageCard coverage={coverage} rules={rules} failingRules={failingRules} onOpenSeo={seoPath ? () => openPanel("seo") : null} />
                )}

                <Notice tone="error">{error}</Notice>
                <Notice tone="success">{result}</Notice>
                <Notice tone="warning">{warnings ? `⚠ Blocked likely data loss:\n${warnings}` : ""}</Notice>

                {busy && !prompt ? <p className="text-[12px] text-[#64748B]">Building the prompt…</p> : null}
                {prompt ? (
                    <div className="space-y-3">
                        <PromptBox prompt={prompt} rows={9} />
                        <PasteBox onApply={apply} applyLabel="Apply to every section (as drafts)" placeholder="Paste the AI's whole reply for the page here…" />
                        <button type="button" className={buttonStyles.link} onClick={build} disabled={busy}>
                            {busy ? "Rebuilding…" : "↻ Rebuild the prompt with the latest content"}
                        </button>
                    </div>
                ) : null}
            </div>
        </Drawer>
    );
}

function CoverageCard({ coverage, rules, failingRules, onOpenSeo }) {
    const { keyword, percent, withKeyword, total, rows } = coverage;
    return (
        <div className="space-y-3 rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] p-4" data-cms-coverage>
            <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-black uppercase tracking-[0.1em] text-[#0F172A]">Keyword coverage</span>
                {percent === null ? (
                    <span className="rounded-full bg-[#E2E8F0] px-2.5 py-0.5 text-[12px] font-bold text-[#475569]">No keyword set</span>
                ) : (
                    <span data-cms-coverage-percent={percent} className={`rounded-full px-2.5 py-0.5 text-[12px] font-black ${percentTone(percent)}`}>{percent}%</span>
                )}
            </div>
            <p className="text-[12px] leading-5 text-[#475569]">
                {keyword
                    ? `“${keyword}” appears in ${withKeyword} of ${total} section${total === 1 ? "" : "s"} below.`
                    : "Set a primary keyword in this page's SEO (Ask AI → Find keywords can choose one) to see per-section coverage."}
            </p>
            <div className="flex flex-wrap gap-1.5">
                {rows.map((r) => (
                    <span
                        key={r.id}
                        data-cms-coverage-chip={r.hasKeyword ? "yes" : r.excluded ? "shared" : "no"}
                        title={r.excluded ? "Shared across pages — not counted" : r.hasKeyword ? `Contains “${keyword}”` : keyword ? `Does not contain “${keyword}”` : ""}
                        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.02em] ${
                            r.excluded
                                ? "border-dashed border-[#CBD5E1] text-[#94A3B8]"
                                : r.hasKeyword
                                  ? "border-[#86EFAC] bg-[#F0FDF4] text-[#15803D]"
                                  : "border-[#E2E8F0] bg-white text-[#94A3B8]"
                        }`}
                    >
                        {r.hasKeyword && !r.excluded ? <span aria-hidden="true">✓</span> : null}
                        {r.label}
                        {r.excluded ? " · shared" : ""}
                    </span>
                ))}
            </div>

            {rules.length ? (
                <div className="space-y-1.5 border-t border-[#E2E8F0] pt-3">
                    <span className="text-[12px] font-black uppercase tracking-[0.1em] text-[#0F172A]">Other SEO rules</span>
                    <ul className="space-y-1">
                        {rules.map((rule) => (
                            <li key={rule.id} data-cms-rule={rule.id} data-pass={rule.skip ? "skip" : String(rule.pass)} className={`flex items-start gap-2 text-[13px] leading-5 ${rule.skip ? "text-[#94A3B8]" : rule.pass ? "text-[#15803D]" : "text-[#B45309]"}`}>
                                <span aria-hidden="true" className="w-3 shrink-0">{rule.skip ? "—" : rule.pass ? "✓" : "✕"}</span>
                                {rule.label}
                            </li>
                        ))}
                    </ul>
                    {failingRules.length ? (
                        <div className="space-y-2 pt-1">
                            <p className="text-[11px] leading-4 text-[#94A3B8]">These are SEO fields (title, description, keyword, schema), not page copy — pasting section JSON can&apos;t fix them. Fix them in the SEO panel.</p>
                            {onOpenSeo ? <button type="button" onClick={onOpenSeo} className={`${buttonStyles.secondary} w-full`}>Open SEO panel</button> : null}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function percentTone(percent) {
    return percent >= 60 ? "bg-[#DCFCE7] text-[#15803D]" : percent > 0 ? "bg-[#FEF3C7] text-[#92400E]" : "bg-[#FEE2E2] text-[#991B1B]";
}

export function CoverageBadge({ percent }) {
    if (percent === null || percent === undefined) {
        return <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-bold text-white/80">no keyword</span>;
    }
    return <span data-cms-badge-percent={percent} className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${percentTone(percent)}`}>{percent}% kw</span>;
}
