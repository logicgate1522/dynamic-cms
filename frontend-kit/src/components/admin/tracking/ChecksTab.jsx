"use client";

import { useEffect, useRef, useState } from "react";

import { formatDate, useApi } from "@/components/admin/useApi";
import { buttonStyles } from "@/components/cms/Drawer";
import { Empty, Pill, Section } from "@/components/admin/tracking/ui";
import { API, apiRequest } from "@/lib/api";

/* Runs every conversion's test in a hidden, same-origin iframe (the page's
   <VerifyHarness> does the work), then asks the backend to finalise the run
   (server-side arrival checks). The visitor's own consent is never touched. */

const TEST_TIMEOUT = 60000;

function encode(test) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(test)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function runInFrame(url, conversion) {
    return new Promise((resolve) => {
        const frame = document.createElement("iframe");
        frame.className = "cms-ui";
        frame.setAttribute("aria-hidden", "true");
        frame.setAttribute("data-cms-verify-frame", conversion);
        // Rendered (so scroll / visibility observers work) but invisible and
        // unclickable: hidden or far off-screen frames skip rendering.
        frame.style.cssText = "position:fixed;left:0;top:0;width:1280px;height:900px;border:0;opacity:0.01;pointer-events:none;z-index:-1";
        let done = false;
        const finish = (results) => {
            if (done) return;
            done = true;
            window.removeEventListener("message", onMessage);
            clearTimeout(timer);
            frame.remove();
            resolve(results);
        };
        const onMessage = (e) => {
            if (e.origin === window.location.origin && e.data?.type === "cms-verify-result" && e.data.conversion === conversion) finish(e.data.results);
        };
        const timer = setTimeout(() => finish([{ conversion, step: "trigger", status: "fail", detail: "timed out (the page didn't finish the test in 60s)" }]), TEST_TIMEOUT);
        window.addEventListener("message", onMessage);
        frame.src = url;
        document.body.appendChild(frame);
    });
}

function toolsFrom(settings) {
    const a = settings?.analytics || {};
    const on = (k) => Boolean(String(a[k] || "").trim());
    return { gtm: on("gtmId"), ga4: on("ga4Id"), meta: on("metaPixelId"), tiktok: on("tiktokPixelId"), linkedin: on("linkedinPartnerId"), googleAds: on("googleAdsId") };
}

export default function ChecksTab({ plan, settings, onDone }) {
    const runs = useApi("tracking/verify/runs/");
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
    const [detail, setDetail] = useState(null);
    const [error, setError] = useState("");
    const cancelled = useRef(false);

    useEffect(() => () => {
        cancelled.current = true;
    }, []);

    const open = async (id) => setDetail(await apiRequest(`tracking/verify/runs/${id}/`));

    const run = async () => {
        setError("");
        setRunning(true);
        cancelled.current = false;
        try {
            const created = await apiRequest("tracking/verify/runs/", { method: "POST", body: { mode: "in_browser" } });
            const tools = toolsFrom(settings);
            const tests = created.tests.filter((t) => !t.error && t.page);
            const consentTest = tests.find((t) => t.event !== "generate_lead" && t.action !== "engage");
            const queue = [...tests.map((t) => ({ ...t, run: created.id, tools, consent: "granted" })),
                ...(consentTest && (tools.meta || tools.tiktok || tools.linkedin) ? [{ ...consentTest, conversion: `_consent:${consentTest.conversion}`, run: created.id, tools, consent: "denied" }] : [])];
            setProgress({ done: 0, total: queue.length, current: "" });
            const all = [];
            for (const [i, test] of queue.entries()) {
                if (cancelled.current) break;
                setProgress({ done: i, total: queue.length, current: test.label || test.conversion });
                const sep = test.page.includes("?") ? "&" : "?";
                const results = await runInFrame(`${test.page}${sep}cms-verify=${encodeURIComponent(created.token)}&cms-test=${encode(test)}`, test.conversion);
                all.push(...results);
            }
            const res = await fetch(`${API}/tracking/verify/runs/${created.id}/results/`, {
                method: "POST", headers: { "Content-Type": "application/json", "X-CMS-Verify": created.token },
                body: JSON.stringify({ results: [], done: true }), credentials: "omit",
            });
            const body = await res.json().catch(() => ({}));
            setDetail(body.run || (await apiRequest(`tracking/verify/runs/${created.id}/`)));
            runs.reload();
            onDone?.();
        } catch (err) {
            setError(err.message);
        } finally {
            setRunning(false);
            setProgress({ done: 0, total: 0, current: "" });
        }
    };

    const queueHeadless = async () => {
        setError("");
        try {
            await apiRequest("tracking/verify/runs/", { method: "POST", body: { mode: "headless" } });
            runs.reload();
        } catch (err) {
            setError(err.message);
        }
    };

    const approved = plan?.status === "approved";
    return (
        <div>
            {error ? <p className="mb-3 rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{error}</p> : null}
            <Section
                title="Check every conversion"
                description="Each conversion is triggered on the live site the way a visitor would (test bookings are marked as tests: no email, no contact, deleted after a day), then each tool is checked: right event, same event id as the server copy, no personal data, nothing sent to marketing tools without consent."
                actions={<>
                    <button type="button" className={buttonStyles.secondary} disabled={!approved || running} onClick={queueHeadless} title="For the scheduled runner (verify-tracking.mjs / GitHub Action)">Queue for runner</button>
                    <button type="button" className={buttonStyles.primary} disabled={!approved || running} onClick={run} data-cms-action="run-checks">{running ? `Checking ${progress.done + 1}/${progress.total}…` : "Run checks"}</button>
                </>}
            >
                {!approved ? <Empty>Approve the plan first: checks test the live plan.</Empty> : null}
                {running ? (
                    <div className="rounded-lg bg-[#F8FAFC] p-3 text-[12px] text-[#475569]">
                        <div className="h-1.5 overflow-hidden rounded bg-[#E2E8F0]"><div className="h-full bg-[var(--cms-accent)] transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div>
                        <p className="mt-2">Testing “{progress.current}”… keep this tab open (an ad blocker in this browser may block tags — that shows as “blocked”, not broken).</p>
                    </div>
                ) : null}
            </Section>

            {detail ? <RunDetail run={detail} /> : null}

            <Section title="History">
                {(runs.data || []).length ? (
                    <div className="divide-y divide-[#E2E8F0] rounded-xl border border-[#E2E8F0]">
                        {runs.data.map((r, i) => (
                            <button key={i} type="button" className="flex w-full items-center gap-3 p-2 text-left text-[12px] hover:bg-[#F8FAFC]" onClick={() => open(r.id)}>
                                <Pill status={r.status} />
                                <span>{formatDate(r.finished_at || r.created_at)}</span>
                                <span className="text-[#64748B]">{r.trigger} · {r.mode}</span>
                                {r.summary?.conversions ? <span className="ml-auto text-[#64748B]">{r.summary.passed}/{r.summary.conversions} passed</span> : null}
                            </button>
                        ))}
                    </div>
                ) : <Empty>No checks yet.</Empty>}
            </Section>
        </div>
    );
}

function RunDetail({ run }) {
    const by = {};
    for (const r of run.results || []) (by[r.conversion] = by[r.conversion] || []).push(r);
    const tests = Object.fromEntries((run.tests || []).map((t) => [t.conversion, t]));
    const ids = [...new Set([...Object.keys(tests), ...Object.keys(by)])];
    return (
        <Section title={`Run #${run.id}`} description={run.summary?.failing?.length ? `Failing: ${run.summary.failing.join(", ")}` : run.status === "passed" ? "Everything checked passed." : ""}>
            <div className="overflow-x-auto rounded-xl border border-[#E2E8F0]">
                <table className="w-full text-left text-[12px]">
                    <thead className="bg-[#F8FAFC] text-[#64748B]"><tr><th className="p-2">Conversion</th><th className="p-2">Step</th><th className="p-2">Tool</th><th className="p-2">Result</th></tr></thead>
                    <tbody>
                        {ids.map((id) => {
                            const rows = by[id] || [{ step: "trigger", tool: "", status: tests[id]?.error ? "fail" : "skipped", detail: tests[id]?.error || "not run" }];
                            return rows.map((r, j) => (
                                <tr key={`${id}-${j}`} className="border-t border-[#E2E8F0] align-top" data-cms-check={id}>
                                    <td className="p-2">{j === 0 ? <strong>{tests[id]?.label || id}</strong> : null}</td>
                                    <td className="p-2">{r.step}</td>
                                    <td className="p-2">{r.tool}</td>
                                    <td className="p-2"><Pill status={r.status} /> <span className="text-[#475569]">{r.detail}</span></td>
                                </tr>
                            ));
                        })}
                    </tbody>
                </table>
            </div>
        </Section>
    );
}
