"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { SITE_NAME } from "@/lib/brand";

const NAV = [
    { href: "/admin", label: "Overview" },
    { href: "/admin/pages", label: "Pages & builder" },
    { href: "/admin/blog", label: "Blog posts" },
    { href: "/admin/submissions", label: "Form submissions" },
    { href: "/admin/contacts", label: "Contacts" },
    { href: "/admin/tracking", label: "Tracking" },
    { href: "/admin/images", label: "Images" },
    { href: "/admin/seo", label: "SEO audit" },
    { href: "/admin/sitemap", label: "Sitemap" },
    { href: "/admin/redirects", label: "Redirects" },
    { href: "/admin/settings", label: "Site settings" },
];

export default function AdminShell({ children }) {
    const pathname = usePathname();
    const router = useRouter();
    const { signOut, isAdmin, checked } = useAdmin();
    const isLogin = pathname === "/admin/login";
    const ready = isLogin || (checked && isAdmin);

    // The server decides who is an admin (GET auth/session/).
    useEffect(() => {
        if (!isLogin && checked && !isAdmin) router.replace(`/admin/login?next=${encodeURIComponent(pathname)}`);
    }, [isLogin, checked, isAdmin, pathname, router]);

    if (isLogin) return <div className="min-h-screen bg-[#F1F5F9] font-sans">{children}</div>;
    if (!ready) return <div className="min-h-screen bg-[#F1F5F9]" />;

    return (
        <div className="cms-ui flex min-h-screen bg-[#F1F5F9] font-sans text-[#1E293B]">
            <aside className="hidden w-60 shrink-0 flex-col bg-[var(--cms-bar)] text-white md:flex">
                <Link href="/" className="px-5 py-5 text-[18px] font-bold">
                    {SITE_NAME}
                    <span className="mt-0.5 block text-[11px] font-semibold uppercase tracking-[0.2em] text-white/50">CMS</span>
                </Link>
                <nav className="flex-1 space-y-0.5 px-3">
                    {NAV.map((item) => {
                        const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
                        return (
                            <Link key={item.href} href={item.href} className={`block rounded-lg px-3 py-2 text-[13px] font-medium ${active ? "bg-white/10 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"}`}>
                                {item.label}
                            </Link>
                        );
                    })}
                </nav>
                <div className="space-y-1 border-t border-white/10 p-3">
                    <Link href="/" className="block rounded-lg px-3 py-2 text-[13px] text-white/70 hover:bg-white/5 hover:text-white">← View site</Link>
                    <button
                        type="button"
                        onClick={async () => {
                            await signOut();
                            router.replace("/admin/login");
                        }}
                        className="block w-full rounded-lg px-3 py-2 text-left text-[13px] text-white/70 hover:bg-white/5 hover:text-white"
                    >
                        Sign out
                    </button>
                </div>
            </aside>

            <div className="min-w-0 flex-1">
                <div className="flex gap-2 overflow-x-auto bg-[var(--cms-bar)] px-3 py-2 md:hidden">
                    {NAV.map((item) => (
                        <Link key={item.href} href={item.href} className={`whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] ${pathname === item.href ? "bg-white/15 text-white" : "text-white/70"}`}>
                            {item.label}
                        </Link>
                    ))}
                </div>
                <main className="mx-auto max-w-[1200px] px-4 py-6 sm:px-8 sm:py-8">{children}</main>
            </div>
        </div>
    );
}

export function PageTitle({ title, description, actions }) {
    return (
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
                <h1 className="text-[24px] font-bold text-[#0F172A]">{title}</h1>
                {description ? <p className="mt-1 max-w-[680px] text-[13px] text-[#64748B]">{description}</p> : null}
            </div>
            {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
    );
}

export function Card({ children, className = "", ...rest }) {
    return <div {...rest} className={`rounded-2xl border border-[#E2E8F0] bg-white p-5 shadow-sm ${className}`}>{children}</div>;
}

export function Notice({ error, success }) {
    if (error) return <p className="mb-4 rounded-lg bg-[#FEF3F2] px-3 py-2 text-[13px] text-[#B42318]">{error}</p>;
    if (success) return <p className="mb-4 rounded-lg bg-[#ECFDF3] px-3 py-2 text-[13px] text-[#067647]">{success}</p>;
    return null;
}

export function StatusBadge({ status }) {
    const published = status === "published";
    return (
        <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${published ? "bg-[#ECFDF3] text-[#067647]" : "bg-[#FFFAEB] text-[#B54708]"}`}>
            {status}
        </span>
    );
}
