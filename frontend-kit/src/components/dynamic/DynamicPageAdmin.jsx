"use client";

import { useCallback, useEffect, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { HeaderSpacerClient } from "@/components/dynamic/HeaderSpacer";
import SectionSlot from "@/components/dynamic/SectionSlot";
import { apiRequest } from "@/lib/api";

/* =========================================
   Wraps a CMS page (content page or dynamic blog
   post). Visitors get `children` — the server-
   rendered published page, untouched. Admins get
   the same page rendered from the admin API: drafts
   included, every section inline-editable, and the
   admin bar's "Page builder" bound to this page.
========================================= */

export default function DynamicPageAdmin({ kind = "content", hostKey, children }) {
    const { isAdmin, setDynamicHost, publishEpoch, discardEpoch } = useAdmin();
    const [host, setHost] = useState(null);
    const [sections, setSections] = useState(null);
    const [error, setError] = useState("");

    const base = kind === "blog" ? `blog/${hostKey}` : `content/${hostKey}`;

    const load = useCallback(async () => {
        try {
            const [row, list] = await Promise.all([
                apiRequest(kind === "blog" ? `blog/${hostKey}/` : `content/pages/${hostKey}/`),
                apiRequest(`${base}/sections/`),
            ]);
            setHost(row);
            setSections((Array.isArray(list) ? list : list.results || []).sort((a, b) => a.order - b.order));
            setError("");
        } catch (err) {
            setError(err.message);
        }
    }, [kind, hostKey, base]);

    // Reload after the admin bar publishes or discards, so the page shows
    // exactly what the server now holds.
    useEffect(() => {
        if (isAdmin) load();
    }, [isAdmin, load, publishEpoch, discardEpoch]);

    useEffect(() => {
        if (!isAdmin || !host) return undefined;
        setDynamicHost({
            kind,
            key: hostKey,
            base,
            title: host.title,
            status: host.status,
            pageType: kind === "blog" ? "article" : host.page_type,
            sections,
            reload: load,
        });
        return () => setDynamicHost(null);
    }, [isAdmin, host, sections, kind, hostKey, base, load, setDynamicHost]);

    if (!isAdmin || !sections) {
        return error && isAdmin ? <>{children}<p className="cms-ui p-4 text-[13px] text-[#B42318]">{error}</p></> : children;
    }

    const ids = sections.map((s) => s.id);
    const hostInfo = { kind, key: hostKey, pageType: kind === "blog" ? "article" : host?.page_type };

    return (
        <>
            {kind === "content" ? <HeaderSpacerClient sections={sections} /> : null}
            {host?.status !== "published" ? (
                <div className="cms-ui sticky top-[70px] z-50 bg-[#FFFAEB] px-5 py-2 text-center text-[13px] font-medium text-[#B54708] lg:top-[76px]">
                    Draft page — only admins can see it. Publish it from Page builder → Page.
                </div>
            ) : null}
            {sections.map((section, index) => (
                <SectionSlot
                    key={section.id}
                    base={base}
                    host={hostInfo}
                    section={section}
                    index={index}
                    total={sections.length}
                    siblingIds={ids}
                    onChanged={load}
                />
            ))}
            {!sections.length ? (
                <p className="cms-ui px-5 py-24 text-center text-[14px] text-[#64748B]">This page has no sections yet — open Page builder to add some.</p>
            ) : null}
        </>
    );
}
