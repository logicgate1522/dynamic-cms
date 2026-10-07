"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Card, PageTitle } from "@/components/admin/AdminShell";
import { fetchAll } from "@/components/admin/useApi";
import { apiRequest } from "@/lib/api";

export default function AdminOverview() {
    const [stats, setStats] = useState(null);

    useEffect(() => {
        Promise.allSettled([
            fetchAll("blog/"),
            apiRequest("content/pages/"),
            apiRequest("forms/quote/submissions/?is_read=0&is_spam=0"),
            apiRequest("seo/analyze/"),
        ]).then(([posts, pages, submissions, seo]) => {
            const value = (r) => (r.status === "fulfilled" ? r.value : null);
            const list = (r) => (Array.isArray(value(r)) ? value(r) : value(r)?.results || []);
            const seoData = value(seo);
            setStats({
                posts: list(posts).length,
                drafts: list(posts).filter((p) => p.status !== "published").length,
                pages: list(pages).length,
                unread: value(submissions)?.count ?? list(submissions).length,
                seoScore: seoData?.average_score ?? seoData?.average ?? null,
            });
        });
    }, []);

    const tiles = [
        { href: "/admin/submissions", label: "Unread quote requests", value: stats?.unread },
        { href: "/admin/blog", label: "Blog posts", value: stats?.posts, sub: stats ? `${stats.drafts} draft(s)` : "" },
        { href: "/admin/pages", label: "CMS pages", value: stats?.pages },
        { href: "/admin/seo", label: "Average SEO score", value: stats?.seoScore ?? "—" },
    ];

    return (
        <>
            <PageTitle title="Overview" description="Manage site content, articles, pages, enquiries and SEO." />

            <LaunchReadiness />

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {tiles.map((tile) => (
                    <Link key={tile.href} href={tile.href}>
                        <Card className="h-full transition hover:border-[var(--cms-accent)]">
                            <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">{tile.label}</p>
                            <p className="mt-2 text-[30px] font-bold text-[#0F172A]">{tile.value ?? "…"}</p>
                            {tile.sub ? <p className="text-[12px] text-[#64748B]">{tile.sub}</p> : null}
                        </Card>
                    </Link>
                ))}
            </div>

            <Card className="mt-6">
                <h2 className="text-[15px] font-bold">Editing page content</h2>
                <p className="mt-2 text-[13px] leading-6 text-[#475569]">
                    Open any page of the site while signed in and <strong>click any outlined text to type</strong>.
                    Hovering a block shows its tools (all fields, AI, history); hovering a list item shows ↑ ↓ ⧉ ✕.
                    Edits save as <strong>drafts</strong> — visitors see them after <strong>Publish</strong> in the bar
                    at the bottom. The bar also has <strong>✦ AI assist</strong> for the whole page, <strong>SEO</strong>
                    (opens on Ask AI) and, on the articles and services pages, <strong>＋ New</strong>.
                </p>
                <Link href="/" className="mt-4 inline-block rounded-lg bg-[var(--cms-accent)] px-4 py-2 text-[13px] font-semibold text-white">Open the site →</Link>
            </Card>
        </>
    );
}

// Blockers and warnings before going live (GET launch-check/).
function LaunchReadiness() {
    const [data, setData] = useState(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        apiRequest("launch-check/").then(setData).catch(() => setData(null));
    }, []);
    if (!data) return null;
    const blockers = data.items.filter((i) => i.level === "blocker");
    const warnings = data.items.filter((i) => i.level === "warning");
    return (
        <Card className={`mb-6 border-2 ${data.ready ? "border-[#86EFAC]" : "border-[#FCA5A5]"}`} data-cms-launch={data.ready ? "ready" : "blocked"}>
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-[15px] font-bold">{data.ready ? "Ready to launch" : `Not ready to launch — ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`}</h2>
                    <p className="text-[13px] text-[#475569]">
                        {data.ready ? "Nothing would embarrass the live site." : "Fix these before the site goes live."}
                        {warnings.length ? ` ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.` : ""}
                    </p>
                </div>
                {data.items.length ? (
                    <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-lg border border-[#CBD5E1] px-3 py-1.5 text-[13px] font-semibold">
                        {open ? "Hide details" : "Show details"}
                    </button>
                ) : null}
            </div>
            {open || !data.ready ? (
                <ul className="mt-4 space-y-2">
                    {[...blockers, ...(open ? warnings : [])].map((item) => (
                        <li key={item.id} className={`rounded-lg px-3 py-2 text-[13px] ${item.level === "blocker" ? "bg-[#FEF2F2]" : "bg-[#FFFBEB]"}`}>
                            <p className={`font-semibold ${item.level === "blocker" ? "text-[#991B1B]" : "text-[#92400E]"}`}>{item.level === "blocker" ? "✕" : "!"} {item.label}</p>
                            {item.detail ? <p className="mt-0.5 text-[#475569]">{item.detail}</p> : null}
                            {item.fix ? <p className="mt-0.5 text-[#0F172A]">→ {item.fix}</p> : null}
                        </li>
                    ))}
                </ul>
            ) : null}
        </Card>
    );
}
