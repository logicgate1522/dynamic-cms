"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { Layer, usePopoverPosition } from "@/components/cms/floating";
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
            {/* In the admin layer: one line, 1:1 scale, above everything (R30). */}
            {onDashboard ? null : <Layer><Bar admin={admin} pathname={pathname} /></Layer>}
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
    const [menu, setMenu] = useState(null); // "publish" | "more" | "user"
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const barRef = useRef(null);
    const popRef = useRef(null);
    const publishBtn = useRef(null);
    const moreBtn = useRef(null);
    const userBtn = useRef(null);

    useEffect(() => {
        if (!menu) return undefined;
        const onDown = (event) => {
            if (barRef.current?.contains(event.target) || popRef.current?.contains(event.target)) return;
            setMenu(null);
        };
        const onKey = (event) => event.key === "Escape" && setMenu(null);
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
        };
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
    const accountName = user?.name || "Account";

    // Secondary actions, in priority order. Each renders as a pill in the bar
    // when it fits and as a row in "More" when it doesn't — never dropped (R30).
    const actions = [
        {
            key: "assist",
            run: () => openPanel("assist"),
            label: (
                <>
                    ✦ AI assist
                    {coverage.percent !== null ? <CoverageBadge percent={coverage.percent} /> : null}
                </>
            ),
            title: "One AI prompt for every block on this page",
        },
        seoPath ? { key: "seo", run: () => openPanel("seo"), label: "SEO" } : null,
        cfg && collection.role === "index"
            ? { key: "collection", run: () => openPanel("collection"), label: `＋ New ${cfg.label.toLowerCase()}`, accent: true, attrs: { "data-cms-collection": "index" } }
            : null,
        cfg && collection.role === "entry" && entry
            ? {
                  key: "collection",
                  run: () => openPanel("collection"),
                  attrs: { "data-cms-collection": "entry" },
                  label: (
                      <>
                          <span className={`h-2 w-2 rounded-full ${entry.status === "published" ? "bg-[#4ADE80]" : "bg-[#F59E0B]"}`} />
                          {cfg.label} settings
                      </>
                  ),
              }
            : null,
        { key: "tools", run: () => openPanel("tools"), label: "Site tools" },
        { key: "dashboard", href: "/admin", label: "Dashboard" },
        { key: "account", account: true, label: `${accountName} ▾` },
    ].filter(Boolean);

    // Priority+ layout: measure every pill, keep as many inline as fit on one
    // line, put the rest in "More". Re-measured on resize and content change.
    const measureRef = useRef(null);
    const fixedRef = useRef(null);
    const [fit, setFit] = useState(actions.length);
    const signature = actions.map((a) => a.key).join("|") + `|${coverage.percent}|${drafts.total}|${saving}|${failed}|${editMode}`;
    useLayoutEffect(() => {
        const compute = () => {
            const pills = measureRef.current ? [...measureRef.current.children] : [];
            if (!pills.length || !fixedRef.current) return;
            const widths = pills.map((el) => el.getBoundingClientRect().width);
            const gap = 4;
            const chrome = 12 + 8; // bar padding + the minimise button's overhang
            const available = Math.min(window.innerWidth - 16, 1100) - chrome - fixedRef.current.getBoundingClientRect().width;
            const moreWidth = widths[widths.length - 1]; // last measured pill is "More ▾"
            const own = widths.slice(0, -1);
            const all = own.reduce((sum, w) => sum + w + gap, 0);
            if (all <= available) return setFit(own.length);
            let used = moreWidth + gap;
            let count = 0;
            for (const w of own) {
                if (used + w + gap > available) break;
                used += w + gap;
                count += 1;
            }
            setFit(count);
        };
        compute();
        window.addEventListener("resize", compute);
        return () => window.removeEventListener("resize", compute);
    }, [signature]);

    const inline = actions.slice(0, fit);
    const overflow = actions.slice(fit);

    const publishPos = usePopoverPosition(menu === "publish", publishBtn);
    const morePos = usePopoverPosition(menu === "more", moreBtn, { width: 260 });
    const userPos = usePopoverPosition(menu === "user", userBtn, { width: 220 });

    const pillFor = (action, measuring = false) => {
        const cls = `${pill} flex items-center gap-1.5 ${action.accent ? "bg-[var(--cms-accent)] hover:brightness-110" : action.account ? "text-white/70 hover:bg-white/10 hover:text-white" : "bg-white/10 hover:bg-white/15"}`;
        if (measuring) return <span key={action.key} className={cls}>{action.label}</span>;
        if (action.href) return <Link key={action.key} href={action.href} className={cls}>{action.label}</Link>;
        if (action.account) {
            return (
                <button key={action.key} ref={userBtn} type="button" className={cls} aria-expanded={menu === "user"} onClick={() => setMenu(menu === "user" ? null : "user")}>
                    {action.label}
                </button>
            );
        }
        return (
            <button key={action.key} type="button" onClick={action.run} title={action.title} className={cls} {...(action.attrs || {})}>
                {action.label}
            </button>
        );
    };

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
        <div ref={barRef} data-cms-adminbar className="cms-ui fixed bottom-4 left-1/2 z-[1500] max-w-[calc(100vw-1rem)] -translate-x-1/2 font-sans">
            {message ? (
                <div className="mb-2 rounded-xl bg-[#0F172A] px-4 py-2 text-center text-[12px] text-white shadow-lg">{message}</div>
            ) : null}

            {/* Off-screen copy of every pill, used only to measure widths. */}
            <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex flex-nowrap gap-1">
                {actions.map((action) => pillFor(action, true))}
                <span className={`${pill} bg-white/10`}>More ▾</span>
            </div>

            <div data-cms-bar-row className="relative flex flex-nowrap items-center justify-center gap-1 rounded-[22px] border border-white/10 bg-[var(--cms-bar)]/95 p-1.5 text-white shadow-[0_18px_50px_rgba(2,6,23,0.45)] backdrop-blur">
                <div ref={fixedRef} className="flex shrink-0 flex-nowrap items-center gap-1">
                    <button
                        type="button"
                        onClick={() => setEditMode(!editMode)}
                        aria-pressed={editMode}
                        title="Click any outlined text on the page to edit it"
                        className={`${pill} ${editMode ? "bg-[var(--cms-accent)]" : "bg-white/10 text-white/80 hover:bg-white/15"}`}
                    >
                        {editMode ? "✎ Editing" : "Editing off"}
                    </button>
                    <button
                        ref={publishBtn}
                        type="button"
                        aria-expanded={menu === "publish"}
                        onClick={() => setMenu(menu === "publish" ? null : "publish")}
                        className={`${pill} ${drafts.total ? "bg-[#F59E0B] text-[#1F2937]" : "bg-white/10 text-white/70"}`}
                    >
                        {failed ? "⚠ Save failed" : saving ? "Saving draft…" : drafts.total ? `Publish (${drafts.total})` : "All published"}
                    </button>
                </div>

                {inline.map((action) => pillFor(action))}

                {overflow.length ? (
                    <button ref={moreBtn} type="button" aria-expanded={menu === "more"} aria-haspopup="menu" onClick={() => setMenu(menu === "more" ? null : "more")} className={`${pill} bg-white/10 hover:bg-white/15`}>
                        More ▾
                    </button>
                ) : null}

                <button type="button" onClick={() => setMinimised(true)} aria-label="Minimise the admin bar" title="Minimise" className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-white text-[14px] font-bold leading-none text-[#0F172A] shadow ring-1 ring-black/10 hover:bg-[#F1F5F9]">
                    –
                </button>
            </div>

            {menu === "publish" && publishPos ? (
                <Menu pos={publishPos} menuRef={popRef}>
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
                        <div className="mt-1 border-t border-[#E2E8F0] px-3 py-2 text-[11px] text-[#475569]">
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

            {menu === "more" && morePos ? (
                <Menu pos={morePos} menuRef={popRef} role="menu" data-cms-more-menu>
                    {overflow.map((action) =>
                        action.account ? (
                            <div key={action.key} className="mt-1 border-t border-[#E2E8F0] pt-1">
                                <p className="px-3 py-1 text-[11px] text-[#64748B]">Signed in as {accountName}</p>
                                <MenuButton role="menuitem" onClick={async () => { setMenu(null); await signOut(); }}>Sign out</MenuButton>
                            </div>
                        ) : action.href ? (
                            <Link key={action.key} role="menuitem" href={action.href} className={menuItem} onClick={() => setMenu(null)}>{action.label}</Link>
                        ) : (
                            <MenuButton key={action.key} role="menuitem" attrs={action.attrs} onClick={() => { setMenu(null); action.run(); }}>
                                <span className="flex items-center gap-1.5">{action.label}</span>
                            </MenuButton>
                        )
                    )}
                </Menu>
            ) : null}

            {menu === "user" && userPos ? (
                <Menu pos={userPos} menuRef={popRef}>
                    <MenuButton onClick={async () => { setMenu(null); await signOut(); }}>Sign out</MenuButton>
                </Menu>
            ) : null}
        </div>
    );
}

const menuItem = "block w-full rounded-lg px-3 py-2 text-left text-[13px] text-[#1E293B] hover:bg-[#F1F5F9] disabled:opacity-40";

// A popover kept inside the viewport (usePopoverPosition): it opens above or
// below its button, never off-screen, and scrolls if it is taller than the room.
// Rendered straight into the admin layer: the bar is centred with a CSS
// transform, which would otherwise make `position: fixed` relative to the bar.
function Menu({ pos, menuRef, children, ...rest }) {
    return (
        <Layer>
        <div
            ref={menuRef}
            {...rest}
            style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }}
            className="z-[1600] overflow-y-auto rounded-xl border border-[#E2E8F0] bg-white p-1.5 text-[#1E293B] shadow-2xl"
        >
            {children}
        </div>
        </Layer>
    );
}

function MenuButton({ children, onClick, disabled, danger, role, attrs }) {
    return (
        <button type="button" role={role} disabled={disabled} onClick={onClick} className={`${menuItem} ${danger ? "text-[#B42318]" : ""}`} {...(attrs || {})}>
            {children}
        </button>
    );
}
