"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { currentSeoPath } from "@/components/cms/ai";
import CollectionPanel from "@/components/cms/CollectionPanel";
import PageAssist, { CoverageBadge, useKeywordCoverage } from "@/components/cms/PageAssist";
import SectionEditor from "@/components/cms/SectionEditor";
import SiteTools from "@/components/cms/SiteTools";

/* =========================================
   The admin bar (bottom centre, admins only):
   editing on/off · unpublished changes + Publish ·
   whole-page AI (live keyword %) · SEO · the page's
   collection ("＋ New article" on a collection's index
   page, "Article settings" on an entry — nothing on
   one-off pages) · site tools · dashboard.
   It can be minimised to a small pill so it never
   covers the page. It also mounts every admin panel,
   so a page only needs <AdminProvider> + <AdminBar />.
========================================= */

const MINIMISED_KEY = "cmsBarMinimised";

const pill = "rounded-full px-3 py-1.5 text-[12px] font-semibold transition whitespace-nowrap";

export default function AdminBar() {
    const admin = useAdmin();
    const pathname = usePathname();
    const onDashboard = pathname?.startsWith("/admin");

    if (!admin.isAdmin) return null;

    return (
        <>
            {onDashboard ? null : <Bar admin={admin} pathname={pathname} />}
            <SectionEditor />
            <PageAssist />
            <CollectionPanel />
            <SiteTools />
        </>
    );
}

function Bar({ admin, pathname }) {
    const { editMode, setEditMode, editables, drafts, publish, discard, openPanel, seoPath, dynamicHost, signOut, user, collection } = admin;
    const [minimised, setMinimisedState] = useState(false);
    useEffect(() => {
        try {
            setMinimisedState(localStorage.getItem(MINIMISED_KEY) === "1");
        } catch {
            // storage unavailable
        }
    }, []);
    const setMinimised = (value) => {
        setMinimisedState(value);
        try {
            localStorage.setItem(MINIMISED_KEY, value ? "1" : "0");
        } catch {
            // ignore
        }
    };
    const coverage = useKeywordCoverage(currentSeoPath(pathname));
    const [menu, setMenu] = useState(null);
    const [more, setMore] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const ref = useRef(null);

    useEffect(() => {
        if (!menu) return undefined;
        const onClick = (event) => {
            if (ref.current && !ref.current.contains(event.target)) setMenu(null);
        };
        document.addEventListener("mousedown", onClick);
        return () => document.removeEventListener("mousedown", onClick);
    }, [menu]);

    // Sections publish through their page (hosts); only useCms blocks are "components".
    const pageNames = Object.keys(editables).filter((name) => editables[name].kind !== "section");
    const pageScope = { components: pageNames, hosts: dynamicHost ? [dynamicHost] : [] };
    const pagePending =
        drafts.components.filter((c) => pageNames.includes(c.name)).length +
        (dynamicHost ? drafts.hosts.filter((h) => h.kind === dynamicHost.kind && h.key === dynamicHost.key).reduce((n, h) => n + h.sections, 0) : 0);
    const saving = Object.values(editables).some((e) => e.saveState === "saving" || e.saveState === "dirty");
    const failed = Object.values(editables).some((e) => e.saveState === "error");

    async function run(action, scope, label) {
        setBusy(true);
        setMessage("");
        try {
            await Promise.all(Object.values(editables).map((e) => e.flush?.()));
            const result = await action(scope);
            const count = (result.components?.length || 0) + (result.sections || 0);
            setMessage(`${label} ${count} change${count === 1 ? "" : "s"}.`);
            setTimeout(() => setMessage(""), 3000);
        } catch (err) {
            setMessage(err.message);
        } finally {
            setBusy(false);
            setMenu(null);
        }
    }

    const cfg = collection.collection;
    const entry = collection.entry;

    if (minimised) {
        return (
            <div data-cms-adminbar className="cms-ui fixed bottom-4 right-4 z-[1500] font-sans">
                <button
                    type="button"
                    onClick={() => setMinimised(false)}
                    aria-label="Show the admin bar"
                    className="flex items-center gap-2 rounded-full bg-[var(--cms-bar)] px-3.5 py-2 text-[12px] font-semibold text-white shadow-[0_12px_32px_rgba(2,6,23,0.4)] hover:brightness-110"
                >
                    <span className={`h-2 w-2 rounded-full ${drafts.total ? "bg-[#F59E0B]" : "bg-[var(--cms-accent)]"}`} />
                    CMS{drafts.total ? ` · ${drafts.total} unpublished` : ""}
                </button>
            </div>
        );
    }

    return (
        <div ref={ref} data-cms-adminbar className="cms-ui fixed bottom-4 left-1/2 z-[1500] max-w-[calc(100vw-1rem)] -translate-x-1/2 font-sans">
            {message ? (
                <div className="mb-2 rounded-xl bg-[#0F172A] px-4 py-2 text-center text-[12px] text-white shadow-lg">{message}</div>
            ) : null}
            <div className="relative flex flex-wrap items-center justify-center gap-1 rounded-[22px] border border-white/10 bg-[var(--cms-bar)]/95 p-1.5 text-white shadow-[0_18px_50px_rgba(2,6,23,0.45)] backdrop-blur">
                <button
                    type="button"
                    onClick={() => setEditMode(!editMode)}
                    aria-pressed={editMode}
                    title="Click any outlined text on the page to edit it"
                    className={`${pill} ${editMode ? "bg-[var(--cms-accent)]" : "bg-white/10 text-white/80 hover:bg-white/15"}`}
                >
                    {editMode ? "✎ Editing" : "Editing off"}
                </button>

                <div className="relative">
                    <button
                        type="button"
                        onClick={() => setMenu(menu === "publish" ? null : "publish")}
                        className={`${pill} ${drafts.total ? "bg-[#F59E0B] text-[#1F2937]" : "bg-white/10 text-white/70"}`}
                    >
                        {failed ? "⚠ Save failed" : saving ? "Saving draft…" : drafts.total ? `Publish (${drafts.total})` : "All published"}
                    </button>
                    {menu === "publish" ? (
                        <Menu>
                            <p className="px-3 pb-1 pt-2 text-[11px] text-[#64748B]">
                                Edits save as drafts. Visitors see them only after you publish.
                            </p>
                            <MenuButton disabled={busy || !pagePending} onClick={() => run(publish, pageScope, "Published")}>
                                Publish this page ({pagePending})
                            </MenuButton>
                            <MenuButton disabled={busy || !drafts.total} onClick={() => run(publish, {}, "Published")}>
                                Publish everything ({drafts.total})
                            </MenuButton>
                            <MenuButton disabled={busy || !pagePending} danger onClick={() => window.confirm("Throw away this page's unpublished changes?") && run(discard, pageScope, "Discarded")}>
                                Discard this page&apos;s drafts
                            </MenuButton>
                            {drafts.components.length || drafts.hosts.length ? (
                                <div className="mt-1 max-h-48 overflow-y-auto border-t border-[#E2E8F0] px-3 py-2 text-[11px] text-[#475569]">
                                    {drafts.components.map((c) => (
                                        <p key={c.name}>• {editables[c.name]?.label || c.name}</p>
                                    ))}
                                    {drafts.hosts.map((h) => (
                                        <p key={`${h.kind}:${h.key}`}>• {h.title || h.key} ({h.sections} section{h.sections === 1 ? "" : "s"})</p>
                                    ))}
                                </div>
                            ) : null}
                        </Menu>
                    ) : null}
                </div>

                <button
                    type="button"
                    onClick={() => setMore((v) => !v)}
                    aria-expanded={more}
                    className={`${pill} bg-white/10 hover:bg-white/15 sm:hidden`}
                >
                    {more ? "Less ▴" : "More ▾"}
                </button>

                {/* Secondary actions: always shown from sm up, behind "More" on phones. */}
                <div className={`${more ? "flex" : "hidden"} w-full flex-wrap items-center justify-center gap-1 sm:flex sm:w-auto`}>
                <button type="button" onClick={() => openPanel("assist")} className={`${pill} flex items-center gap-1.5 bg-white/10 hover:bg-white/15`} title="One AI prompt for every block on this page">
                    ✦ AI assist
                    {coverage.percent !== null ? <CoverageBadge percent={coverage.percent} /> : null}
                </button>

                {seoPath ? (
                    <button type="button" onClick={() => openPanel("seo")} className={`${pill} bg-white/10 hover:bg-white/15`}>SEO</button>
                ) : null}

                {cfg && collection.role === "index" ? (
                    <button type="button" data-cms-collection="index" onClick={() => openPanel("collection")} className={`${pill} bg-[var(--cms-accent)] hover:brightness-110`}>
                        ＋ New {cfg.label.toLowerCase()}
                    </button>
                ) : null}
                {cfg && collection.role === "entry" && entry ? (
                    <button type="button" data-cms-collection="entry" onClick={() => openPanel("collection")} className={`${pill} flex items-center gap-1.5 bg-white/10 hover:bg-white/15`}>
                        <span className={`h-2 w-2 rounded-full ${entry.status === "published" ? "bg-[#4ADE80]" : "bg-[#F59E0B]"}`} />
                        {cfg.label} settings
                    </button>
                ) : null}
                <button type="button" onClick={() => openPanel("tools")} className={`${pill} bg-white/10 hover:bg-white/15`}>Site tools</button>
                <Link href="/admin" className={`${pill} bg-white/10 hover:bg-white/15`}>Dashboard</Link>

                <div className="relative">
                    <button type="button" onClick={() => setMenu(menu === "user" ? null : "user")} className={`${pill} text-white/70 hover:bg-white/10 hover:text-white`}>
                        {user?.name || "Account"} ▾
                    </button>
                    {menu === "user" ? (
                        <Menu>
                            <MenuButton onClick={async () => { setMenu(null); await signOut(); }}>Sign out</MenuButton>
                        </Menu>
                    ) : null}
                </div>
                </div>
                <button type="button" onClick={() => setMinimised(true)} aria-label="Minimise the admin bar" title="Minimise" className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-white text-[14px] font-bold leading-none text-[#0F172A] shadow ring-1 ring-black/10 hover:bg-[#F1F5F9]">
                    –
                </button>
            </div>
        </div>
    );
}

function Menu({ children }) {
    return (
        <div className="absolute bottom-full left-1/2 z-10 mb-2 w-72 -translate-x-1/2 rounded-xl border border-[#E2E8F0] bg-white p-1.5 text-[#1E293B] shadow-2xl">
            {children}
        </div>
    );
}

function MenuButton({ children, onClick, disabled, danger }) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={`block w-full rounded-lg px-3 py-2 text-left text-[13px] hover:bg-[#F1F5F9] disabled:opacity-40 ${danger ? "text-[#B42318]" : ""}`}
        >
            {children}
        </button>
    );
}
