"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { formatDate, useApi } from "@/components/admin/useApi";
import { PasteBox, PromptBox, Step } from "@/components/cms/ai";
import { buttonStyles } from "@/components/cms/Drawer";
import ChecksTab from "@/components/admin/tracking/ChecksTab";
import { describeTrigger } from "@/components/admin/tracking/describe";
import PlanEditor, { startPick } from "@/components/admin/tracking/PlanEditor";
import ToolsTab from "@/components/admin/tracking/ToolsTab";
import { Empty, Pill, Section } from "@/components/admin/tracking/ui";
import { apiRequest } from "@/lib/api";
import { scanSite } from "@/lib/siteScan";

/* =========================================
   Site tools → Tracking (R31): the plan (what counts, for whom, why),
   the tools it reaches, and proof that it works.
   - Scan site → facts; Build from library / Ask AI → a proposal shown as a
     diff; Save draft; Approve (goes live in the browser, syncs to tools)
   - Tools: what each is for on THIS site; connect once; sync status
   - Checks: trigger → sent → received for every conversion
========================================= */

const TABS = [["overview", "Overview"], ["plan", "Plan"], ["tools", "Tools"], ["checks", "Checks"], ["ai", "Ask AI"]];

export default function TrackingPanel({ initialTab = "overview", inDrawer = false, onPickStart }) {
    const [tab, setTab] = useState(initialTab);
    const state = useApi("tracking/plan/");
    const facts = useApi("tracking/facts/");
    const overview = useApi("tracking/overview/");
    const settings = useApi("settings/site/");
    const [draft, setDraft] = useState(null);
    const [dirty, setDirtyState] = useState(false);
    // Read synchronously: a plan load must never replace unsaved edits made
    // in the same render (e.g. "Pick on page" adding a conversion on mount).
    const dirtyRef = useRef(false);
    const setDirty = (value) => {
        dirtyRef.current = value;
        setDirtyState(value);
    };
    const [proposal, setProposal] = useState(null);
    const [busy, setBusy] = useState("");
    const [message, setMessage] = useState({ error: "", success: "" });
    const [scanProgress, setScanProgress] = useState("");

    useEffect(() => {
        if (state.data?.plan && !dirtyRef.current) setDraft(state.data.plan);
    }, [state.data]);

    const reloadAll = useCallback(() => {
        state.reload();
        facts.reload();
        overview.reload();
    }, [state, facts, overview]);

    const act = async (label, fn) => {
        setBusy(label);
        setMessage({ error: "", success: "" });
        try {
            const success = await fn();
            setMessage({ error: "", success: success || "" });
        } catch (err) {
            const report = err.body?.report;
            const lines = report ? [...(report.errors || []), ...(report.dangling || [])].slice(0, 6) : [];
            setMessage({ error: [err.message, ...lines].join(" · "), success: "" });
        } finally {
            setBusy("");
        }
    };

    const scan = () => act("scan", async () => {
        const result = await scanSite({ onProgress: (d, t) => setScanProgress(`${d}/${t} pages`) });
        setScanProgress("");
        const res = await apiRequest("tracking/scan/?source=browser", { method: "POST", body: result });
        reloadAll();
        if (res.warning) throw new Error(res.warning);
        return `Scanned ${result.pages.length} pages: ${res.facts.blocks} sections, ${res.facts.ctas} calls-to-action, ${res.facts.faqs} questions, forms: ${res.facts.forms.join(", ") || "none"}.${res.stale ? " The site changed since the plan was approved — review it." : ""}`;
    });

    const build = () => act("build", async () => {
        const res = await apiRequest("tracking/plan/build/", { method: "POST" });
        setProposal({ ...res, source: "library" });
        return "";
    });

    const save = () => act("save", async () => {
        const res = await apiRequest("tracking/plan/", { method: "PUT", body: { plan: draft } });
        setDraft(res.plan);
        setDirty(false);
        state.reload();
        return `Saved as a draft${res.report.dangling.length ? ` — ${res.report.dangling.length} trigger(s) don't match the site yet` : ""}. Approve to put it live.`;
    });

    const approve = () => act("approve", async () => {
        if (dirty) {
            const saved = await apiRequest("tracking/plan/", { method: "PUT", body: { plan: draft } });
            setDraft(saved.plan);
            setDirty(false);
        }
        const res = await apiRequest("tracking/plan/approve/", { method: "POST" });
        setDraft(res.plan);
        reloadAll();
        return `Approved (version ${res.plan.version}). Conversions are live on the site; connected tools are syncing. Next: run the checks.`;
    });

    const useProposal = () => {
        setDraft(proposal.plan);
        setDirty(true);
        setProposal(null);
        setTab("plan");
        setMessage({ error: "", success: "Proposal loaded. Review it, then Save draft or Approve." });
    };

    const pick = () => {
        if (dirty) {
            setMessage({ error: "Save the draft first: picking reloads the panel.", success: "" });
            return;
        }
        onPickStart?.();
        startPick(() => window.dispatchEvent(new CustomEvent("cms:open-tracking", { detail: { tab: "plan" } })));
    };

    const s = state.data;
    const plan = draft || s?.plan;
    return (
        <div data-cms-tracking-panel>
            <div className="mb-4 flex flex-wrap items-center gap-2">
                {plan ? <Pill status={plan.status}>{plan.status === "approved" ? `approved · v${plan.version}` : "draft"}</Pill> : null}
                {s?.stale ? <Pill status="warn">site changed since approval</Pill> : null}
                {dirty ? <Pill status="pending">unsaved changes</Pill> : null}
                {s?.pack ? <span className="text-[12px] text-[#64748B]">Business type: {s.pack.replace(/_/g, " ")}</span> : null}
                <span className="ml-auto flex flex-wrap gap-2">
                    <button type="button" className={buttonStyles.secondary} disabled={Boolean(busy)} onClick={scan} title="Read every page as a visitor sees it">{busy === "scan" ? `Scanning ${scanProgress}…` : "Scan site"}</button>
                    <button type="button" className={buttonStyles.secondary} disabled={Boolean(busy)} onClick={build}>{busy === "build" ? "Building…" : "Build from library"}</button>
                    <button type="button" className={buttonStyles.secondary} disabled={!dirty || Boolean(busy)} onClick={save}>Save draft</button>
                    <button type="button" className={buttonStyles.primary} disabled={!plan || Boolean(busy)} onClick={approve} data-cms-action="approve-plan">{busy === "approve" ? "Approving…" : "Approve"}</button>
                </span>
            </div>
            {message.error ? <p className="mb-3 rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{message.error}</p> : null}
            {message.success ? <p className="mb-3 rounded-lg bg-[#ECFDF3] px-3 py-2 text-[13px] text-[#067647]">{message.success}</p> : null}
            {s?.report?.dangling?.length ? (
                <p className="mb-3 rounded-lg bg-[#FFFAEB] px-3 py-2 text-[12px] text-[#B54708]">Doesn't match the site: {s.report.dangling.slice(0, 5).join(" · ")}</p>
            ) : null}
            {s?.report?.gaps?.length ? (
                <p className="mb-3 rounded-lg bg-[#FFFAEB] px-3 py-2 text-[12px] text-[#B54708]" data-cms-plan-gaps>Not covered yet ({s.report.gaps.length}): {s.report.gaps.slice(0, 5).join(" · ")}{s.report.gaps.length > 5 ? " …" : ""}. “Build from library” fills these in.</p>
            ) : null}
            {!s?.facts?.scanned ? <p className="mb-3 rounded-lg bg-[#EFF8FF] px-3 py-2 text-[12px] text-[#175CD3]">Tip: click “Scan site” first so the plan can see your sections, buttons, FAQs and forms.</p> : null}

            {proposal ? <ProposalView proposal={proposal} plan={plan} onUse={useProposal} onCancel={() => setProposal(null)} /> : null}

            <div className="mb-4 flex flex-wrap gap-1 border-b border-[#E2E8F0]">
                {TABS.map(([key, label]) => (
                    <button key={key} type="button" onClick={() => setTab(key)} className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold ${tab === key ? "border-[var(--cms-accent)] text-[#0F172A]" : "border-transparent text-[#64748B] hover:text-[#0F172A]"}`}>
                        {label}
                    </button>
                ))}
            </div>

            {tab === "overview" ? <Overview data={overview.data} plan={plan} /> : null}
            {tab === "plan" && plan ? (
                <PlanEditor plan={plan} facts={facts.data} onChange={(next) => { setDraft(next); setDirty(true); }} onPick={inDrawer ? pick : undefined} />
            ) : null}
            {tab === "tools" ? <ToolsTab explain={s?.tools} settings={settings.data} onChanged={reloadAll} /> : null}
            {tab === "checks" ? <ChecksTab plan={plan} settings={settings.data} onDone={reloadAll} /> : null}
            {tab === "ai" ? <AiTab onProposal={(p) => setProposal({ ...p, source: "ai" })} /> : null}
        </div>
    );
}

function Overview({ data, plan }) {
    if (!data) return <p className="text-[13px] text-[#64748B]">Loading…</p>;
    return (
        <div>
            {(data.alerts || []).length ? (
                <Section title="Needs attention">
                    <ul className="space-y-1">
                        {data.alerts.map((a, i) => <li key={i} className="rounded-lg bg-[#FFFAEB] px-3 py-2 text-[12px] text-[#B54708]">{a.message}</li>)}
                    </ul>
                </Section>
            ) : null}
            <Section title="Conversions (last 7 days)" description={data.checks ? `Last check: ${formatDate(data.checks.finished_at)} — ${data.checks.status}` : "Not checked yet: open Checks → Run checks."}>
                {(data.conversions || []).length ? (
                    <div className="overflow-x-auto rounded-xl border border-[#E2E8F0]">
                        <table className="w-full text-left text-[12px]">
                            <thead className="bg-[#F8FAFC] text-[#64748B]"><tr><th className="p-2">Conversion</th><th className="p-2">When</th><th className="p-2 text-right">7 days</th><th className="p-2">Last seen</th></tr></thead>
                            <tbody>
                                {data.conversions.map((c, i) => {
                                    const full = (plan?.conversions || []).find((x) => x.id === c.id);
                                    return (
                                        <tr key={i} className="border-t border-[#E2E8F0]">
                                            <td className="p-2"><strong>{c.label}</strong> {c.tier === "primary" ? <Pill status="in_sync">primary</Pill> : null}</td>
                                            <td className="p-2 text-[#64748B]">{full ? describeTrigger(full.trigger, plan) : ""}</td>
                                            <td className="p-2 text-right font-semibold">{c.total7}</td>
                                            <td className="p-2 text-[#64748B]">{c.lastSeen ? formatDate(c.lastSeen) : "never"}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                ) : <Empty>No plan yet. Scan the site, then “Build from library” or “Ask AI”.</Empty>}
            </Section>
            {(data.anomalies || []).length ? (
                <Section title="Gone quiet">
                    {data.anomalies.map((a, i) => <p key={i} className="text-[12px]">{a.conversion}: nothing for {a.quietDays} days (usually {a.avgPerDay}/day)</p>)}
                </Section>
            ) : null}
        </div>
    );
}

function ProposalView({ proposal, plan, onUse, onCancel }) {
    const d = proposal.diff || {};
    const kinds = ["conversions", "intents", "segments", "stages", "audiences"];
    return (
        <div className="mb-4 rounded-xl border-2 border-[var(--cms-accent)] bg-white p-3" data-cms-tracking-proposal>
            <div className="flex flex-wrap items-center gap-2">
                <strong className="text-[13px]">{proposal.source === "ai" ? "AI proposal" : "Library proposal"}: {d.total || 0} change(s)</strong>
                <span className="ml-auto flex gap-2">
                    <button type="button" className={buttonStyles.secondary} onClick={onCancel}>Discard</button>
                    <button type="button" className={buttonStyles.primary} onClick={onUse}>Use this</button>
                </span>
            </div>
            {proposal.dropped?.length ? <p className="mt-1 text-[12px] text-[#B54708]">Left out (not on the site): {proposal.dropped.join(", ")}</p> : null}
            <div className="mt-2 grid gap-2 text-[12px] sm:grid-cols-2">
                {kinds.map((k) => d[k] && (d[k].added.length + d[k].removed.length + d[k].changed.length) ? (
                    <div key={k}>
                        <p className="font-semibold capitalize">{k}</p>
                        {d[k].added.map((x, i) => <p key={`a${i}`} className="text-[#067647]">+ {x.label}{x.rationale ? ` — ${x.rationale}` : ""}</p>)}
                        {d[k].changed.map((x, i) => <p key={`c${i}`} className="text-[#175CD3]">~ {x.after.label}</p>)}
                        {d[k].removed.map((x, i) => <p key={`r${i}`} className="text-[#B42318]">− {x.label}</p>)}
                    </div>
                ) : null)}
            </div>
            {!d.total ? <p className="mt-1 text-[12px] text-[#64748B]">Same as the current plan{plan?.status === "approved" ? "." : " — you can approve it as is."}</p> : null}
        </div>
    );
}

function AiTab({ onProposal }) {
    const [prompt, setPrompt] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [replace, setReplace] = useState(false);
    useEffect(() => {
        apiRequest("ai/tracking-plan/prompt/", { method: "POST" }).then((r) => setPrompt(r.prompt)).catch((e) => setError(e.message));
    }, []);
    return (
        <div className="space-y-4">
            <Step number={1} title="Copy this prompt into any AI chat (ChatGPT, Claude, Gemini…)"><PromptBox prompt={prompt} rows={10} /></Step>
            <Step number={2} title="Paste its whole reply here">
                {error ? <p className="text-[12px] text-[#B42318]">{error}</p> : null}
                <label className="mb-2 flex items-center gap-2 text-[12px]"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace plan (allow the reply to remove most items)</label>
                <PasteBox busy={busy} applyLabel="Review changes" onApply={async (raw) => {
                    setBusy(true);
                    setError("");
                    try {
                        onProposal(await apiRequest("ai/tracking-plan/apply/", { method: "POST", body: { raw, replace } }));
                    } catch (e) {
                        setError(e.message);
                        return false;
                    } finally {
                        setBusy(false);
                    }
                    return true;
                }} />
            </Step>
            <p className="text-[12px] text-[#64748B]">Anything that refers to a page, form, option or section that isn't on the site is left out automatically. Locked items never change.</p>
        </div>
    );
}
