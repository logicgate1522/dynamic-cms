"use client";

import Link from "next/link";
import { useState } from "react";

import { Card, Notice } from "@/components/admin/AdminShell";
import { useApi } from "@/components/admin/useApi";
import { buttonStyles } from "@/components/cms/Drawer";
import { apiRequest } from "@/lib/api";
import { scanSite } from "@/lib/siteScan";

/* =========================================
   Internal links (R34): the site's link graph as visitors see it.
   "Scan site" reads every page in the sitemap (lib/siteScan.js, the same
   scan the Tracking panel uses) and stores it; the backend analyses it
   (api/link_audit.py — the same analyser the site-audit gate uses).
   Problems marked "Must fix" fail the gate. Suggestions are links the copy
   already mentions: add them inline as [anchor](/path) in a text block, or
   use Ask AI on that page (its prompt lists them).
========================================= */

const LEVEL = { fail: ["Must fix", "bg-[#FEF3F2] text-[#B42318]"], warn: ["Improve", "bg-[#FFFAEB] text-[#B54708]"] };

export default function InternalLinks() {
    const { data, error, loading, reload } = useApi("seo/links/");
    const [busy, setBusy] = useState("");
    const [scanError, setScanError] = useState("");

    async function scan() {
        setScanError("");
        try {
            const result = await scanSite({ onProgress: (d, t) => setBusy(`Scanning ${d}/${t}…`) });
            setBusy("Analysing…");
            await apiRequest("tracking/scan/", { method: "POST", body: result });
            await reload();
        } catch (err) {
            setScanError(err.message);
        } finally {
            setBusy("");
        }
    }

    const summary = data?.summary;
    const issues = [...(data?.issues || [])].sort((a, b) => (a.level === b.level ? 0 : a.level === "fail" ? -1 : 1));
    const suggestions = data?.suggestions || [];

    return (
        <section className="mt-10" data-cms-internal-links>
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h2 className="text-[18px] font-bold text-[#0F172A]">Internal links</h2>
                    <p className="mt-1 max-w-[720px] text-[13px] text-[#475569]">
                        Every page should be linked from the content of related pages (menus alone don&apos;t count), within {3} clicks of the home page, with link words that say what the page is about.
                        {data?.scannedAt ? ` Last scan: ${new Date(data.scannedAt).toLocaleString()}.` : ""}
                    </p>
                </div>
                <button type="button" className={buttonStyles.primary} onClick={scan} disabled={Boolean(busy) || loading} data-cms-action="scan-links">{busy || "Scan site"}</button>
            </div>
            <Notice error={error || scanError} />

            {data && !summary ? <Card><p className="text-[13px] text-[#475569]">Not scanned yet. Click “Scan site”.</p></Card> : null}

            {summary ? (
                <>
                    <div className="mb-4 grid gap-3 sm:grid-cols-4">
                        {[["Pages", summary.pages], ["Must fix", summary.fail], ["To improve", summary.warn], ["Avg. content links in", summary.avgContextualInbound]].map(([label, value], i) => (
                            <Card key={i}>
                                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">{label}</p>
                                <p className="mt-1 text-[24px] font-bold">{value}</p>
                            </Card>
                        ))}
                    </div>

                    <Card className="mb-4 overflow-x-auto p-0">
                        <table className="w-full min-w-[640px] text-left text-[13px]">
                            <thead className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] uppercase tracking-[0.08em] text-[#64748B]">
                                <tr><th scope="col" className="px-4 py-3">Problem</th><th scope="col" className="px-3 py-3">Page</th><th scope="col" className="px-3 py-3">What&apos;s wrong</th><th scope="col" className="px-3 py-3">How to fix</th></tr>
                            </thead>
                            <tbody>
                                {issues.length === 0 ? <tr><td colSpan={4} className="px-4 py-5 text-[#067647]">No internal-link problems.</td></tr> : null}
                                {issues.map((issue, i) => (
                                    <tr key={i} className="border-b border-[#F1F5F9] align-top last:border-0">
                                        <td className="px-4 py-3"><span className={`rounded-md px-2 py-0.5 text-[12px] font-semibold ${LEVEL[issue.level][1]}`}>{LEVEL[issue.level][0]}</span></td>
                                        <td className="px-3 py-3 font-medium">{issue.path.startsWith("/") && !issue.path.includes(",") ? <Link href={issue.path} target="_blank" className="text-[var(--cms-accent-strong)] hover:underline">{issue.path}</Link> : issue.path}</td>
                                        <td className="px-3 py-3">{issue.text}</td>
                                        <td className="px-3 py-3 text-[#475569]">{issue.fix}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </Card>

                    <Card className="overflow-x-auto p-0">
                        <p className="border-b border-[#E2E8F0] px-4 py-3 text-[13px] text-[#475569]">
                            <strong className="text-[#0F172A]">Suggested links ({suggestions.length}).</strong> The page on the left already mentions the topic of the page on the right. Link those words: in a text block write <code>[words](/path)</code>, or open the page and use Ask AI (its prompt lists these).
                        </p>
                        <table className="w-full min-w-[640px] text-left text-[13px]">
                            <thead className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] uppercase tracking-[0.08em] text-[#64748B]">
                                <tr><th scope="col" className="px-4 py-3">On page</th><th scope="col" className="px-3 py-3">Link the words</th><th scope="col" className="px-3 py-3">To</th></tr>
                            </thead>
                            <tbody>
                                {suggestions.slice(0, 60).map((s, i) => (
                                    <tr key={i} className="border-b border-[#F1F5F9] last:border-0">
                                        <td className="px-4 py-3"><Link href={s.from} target="_blank" className="text-[var(--cms-accent-strong)] hover:underline">{s.from}</Link></td>
                                        <td className="px-3 py-3"><code>[{s.anchor}]({s.to})</code></td>
                                        <td className="px-3 py-3">{s.to}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </Card>
                </>
            ) : null}
        </section>
    );
}
