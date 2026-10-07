"use client";

import Link from "next/link";
import { useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import Drawer from "@/components/cms/Drawer";
import BlogAdminPage from "@/app/admin/blog/page";
import ImagesPage from "@/app/admin/images/page";
import RedirectsPage from "@/app/admin/redirects/page";
import SettingsPage from "@/app/admin/settings/page";
import SitemapPage from "@/app/admin/sitemap/page";
import SubmissionsPage from "@/app/admin/submissions/page";

/* =========================================
   Site-wide tools in a floating dock, so an
   admin never has to leave the page they're on.
   The same panels are full pages under /admin.
========================================= */

const TOOLS = [
    ["settings", "Site settings", SettingsPage, "/admin/settings"],
    ["images", "Images", ImagesPage, "/admin/images"],
    ["forms", "Form inbox", SubmissionsPage, "/admin/submissions"],
    ["blog", "Blog", BlogAdminPage, "/admin/blog"],
    ["redirects", "Redirects", RedirectsPage, "/admin/redirects"],
    ["sitemap", "Sitemap", SitemapPage, "/admin/sitemap"],
];

export default function SiteTools() {
    const { panel, closePanel } = useAdmin();
    const [tab, setTab] = useState(panel?.tab || "settings");
    if (panel?.type !== "tools") return null;
    const [, label, Body, href] = TOOLS.find(([key]) => key === tab) || TOOLS[0];
    return (
        <Drawer open width={900} title="Site tools" subtitle={label} onClose={closePanel}>
            <div className="mb-5 flex flex-wrap items-center gap-1">
                {TOOLS.map(([key, name]) => (
                    <button key={key} type="button" onClick={() => setTab(key)} className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${tab === key ? "bg-[var(--cms-primary)] text-white" : "text-[#475569] hover:bg-[#F1F5F9]"}`}>
                        {name}
                    </button>
                ))}
                <Link href={href} onClick={closePanel} className="ml-auto text-[12px] font-semibold text-[var(--cms-accent)] hover:underline">Open full page →</Link>
            </div>
            <Body />
        </Drawer>
    );
}
