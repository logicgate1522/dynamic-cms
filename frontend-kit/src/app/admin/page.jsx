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

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {tiles.map((tile) => (
                    <Link key={tile.href} href={tile.href}>
                        <Card className="h-full transition hover:border-[#0F9E86]">
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
                    Open any page of the site while signed in. The CMS bar at the bottom of the screen turns on
                    <strong> editing mode</strong>: every editable section shows an <em>Edit</em> button, and the
                    <strong> Sections</strong> menu lists them all. Use <strong>SEO</strong> in the same bar to edit that
                    page&apos;s title, description, social image and indexing, or to run an SEO audit.
                </p>
                <Link href="/" className="mt-4 inline-block rounded-lg bg-[#0F9E86] px-4 py-2 text-[13px] font-semibold text-white">Open the site →</Link>
            </Card>
        </>
    );
}
