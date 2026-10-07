"use client";

import Link from "next/link";

import { Card, Notice, PageTitle } from "@/components/admin/AdminShell";
import { useApi } from "@/components/admin/useApi";
import { buttonStyles } from "@/components/cms/Drawer";

function tone(score) {
    if (score >= 80) return "bg-[#ECFDF3] text-[#067647]";
    if (score >= 50) return "bg-[#FFFAEB] text-[#B54708]";
    return "bg-[#FEF3F2] text-[#B42318]";
}

const publicPath = (path) => (path === "home" ? "/" : `/${path}`);

export default function SeoAuditPage() {
    const { data, error, loading, reload } = useApi("seo/analyze/");
    const pages = data?.pages || [];

    return (
        <>
            <PageTitle
                title="SEO audit"
                description="Every page with saved SEO settings, worst first. Open a page and use SEO in the CMS bar to fix issues and re-run its audit against the live page."
                actions={<button type="button" className={buttonStyles.secondary} onClick={reload} disabled={loading}>{loading ? "Running…" : "Re-run"}</button>}
            />
            <Notice error={error} />

            {data ? (
                <div className="mb-6 grid gap-4 sm:grid-cols-3">
                    <Card>
                        <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">Average score</p>
                        <p className="mt-2 text-[30px] font-bold">{data.average_score}</p>
                    </Card>
                    <Card className="sm:col-span-2">
                        <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">Pages by grade</p>
                        <div className="mt-3 flex gap-3">
                            {["A", "B", "C", "D", "F"].map((g) => (
                                <span key={g} className="rounded-lg bg-[#F1F5F9] px-3 py-2 text-[13px]"><strong>{g}</strong> {data.count_by_grade?.[g] || 0}</span>
                            ))}
                        </div>
                    </Card>
                </div>
            ) : null}

            <Card className="overflow-x-auto p-0">
                <table className="w-full min-w-[720px] text-left text-[13px]">
                    <thead className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] uppercase tracking-[0.08em] text-[#64748B]">
                        <tr>
                            <th scope="col" className="px-5 py-3">Page</th>
                            <th scope="col" className="px-3 py-3">Overall</th>
                            <th scope="col" className="px-3 py-3">Technical</th>
                            <th scope="col" className="px-3 py-3">Content</th>
                            <th scope="col" className="px-3 py-3">Metadata</th>
                            <th scope="col" className="px-3 py-3">Schema</th>
                            <th scope="col" className="px-3 py-3">Issues</th>
                        </tr>
                    </thead>
                    <tbody>
                        {!data && loading ? <tr><td colSpan={7} className="px-5 py-6 text-[#64748B]">Running audit…</td></tr> : null}
                        {data && pages.length === 0 ? (
                            <tr><td colSpan={7} className="px-5 py-6 text-[#64748B]">No pages have SEO settings yet. Run <code>npm run cms:seed</code> or save SEO on any page.</td></tr>
                        ) : null}
                        {pages.map((p) => (
                            <tr key={p.path} className="border-b border-[#F1F5F9] last:border-0">
                                <td className="px-5 py-3"><Link href={publicPath(p.path)} target="_blank" className="font-semibold text-[var(--cms-accent)] hover:underline">{publicPath(p.path)}</Link></td>
                                {["overall", "technical_score", "content_score", "metadata_score", "schema_score"].map((k) => (
                                    <td key={k} className="px-3 py-3"><span className={`rounded-md px-2 py-0.5 font-semibold ${tone(p[k])}`}>{p[k]}</span></td>
                                ))}
                                <td className="px-3 py-3">{p.issue_count}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </Card>
        </>
    );
}
