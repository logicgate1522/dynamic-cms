"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import { useCmsInitial } from "@/components/cms/CmsDataProvider";
import { FloatingTools, PLACE, useFloating } from "@/components/cms/floating";
import { createInline } from "@/components/cms/inline";
import { API, apiRequest, isEmpty, mergeDefaults, setPath } from "@/lib/api";
import { HIDDEN_KEY, isHidden, stripHidden } from "@/lib/visibility";

/* =========================================
   useCms(name, defaults, options) — binds one
   block of the page to GET/PATCH home/<name>/.

   const { data, E, editButton } = useCms("home-hero", defaults, { label: "Home hero" });
   <h1><E.Text path="title" /></h1>

   Visitors: published content (server-rendered via
   <CmsSection names>), merged over `defaults`, so
   fields added in code later still render.

   Admins: the latest draft. Every edit — inline,
   in the "All fields" panel, or applied from an AI
   reply — autosaves as a DRAFT (PATCH ?mode=draft,
   ~0.7s after the last change). Nothing is public
   until the admin bar's Publish.

   `defaults` must be a module-level constant.
   options.label      name shown to admins
   options.fields     per-field hints for the All fields panel
                      ("items[].icon": { type: "select", options: [...] })
   options.afterSave(data)  runs after this block is published
   options.excludeFromKeywordAudit  shared copy (footer, site-wide CTA)
                      that should not count toward a page's keyword score
   options.buttonPosition   classes placing the "All fields" pill
   options.hideable         false for blocks that hold shared labels rather
                            than a visible section (no "Hide" toggle)

   Returns { data, hidden, E, editButton, … }. Render {editButton} as the
   FIRST child of the block's root element: admins get the block's tools,
   visitors a hidden marker that tells tracking which block this is (R31).
   A block an admin hid renders
   nothing for visitors — every component MUST end with:
       if (hidden) return null;
       return ( …the block… );
   (hidden list items are already removed from `data` for visitors).
========================================= */

const AUTOSAVE_MS = 700;

export function useCms(name, defaults, options = {}) {
    const initial = useCmsInitial(name);
    const [remote, setRemote] = useState(initial);
    const [draft, setDraft] = useState(null);
    const [saveState, setSaveState] = useState("idle"); // idle | dirty | saving | saved | error
    const [saveError, setSaveError] = useState("");
    const admin = useAdmin();
    const { isAdmin, editMode, register, openPanel, refreshDrafts, publishEpoch, discardEpoch } = admin;

    // Outside a <CmsSection>, nothing was fetched on the server.
    useEffect(() => {
        if (initial !== undefined) return undefined;
        let cancelled = false;
        fetch(`${API}/home/${name}/`)
            .then((res) => (res.ok ? res.json() : {}))
            .then((data) => !cancelled && setRemote(data))
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [initial, name]);

    const published = useMemo(
        () => mergeDefaults(defaults, isEmpty(remote) ? undefined : remote),
        [defaults, remote]
    );

    // Admins edit (and see) the latest draft.
    const loadDraft = useCallback(() => {
        apiRequest(`home/${name}/?mode=draft`)
            .then((data) => setDraft(mergeDefaults(defaults, isEmpty(data) ? undefined : data)))
            .catch(() => {});
    }, [name, defaults]);

    useEffect(() => {
        if (isAdmin) loadDraft();
        else setDraft(null);
    }, [isAdmin, loadDraft]);

    const data = isAdmin && draft ? draft : published;

    /* ---------- autosave ---------- */
    const pending = useRef(null);
    const timer = useRef(null);

    const persist = useCallback(async () => {
        clearTimeout(timer.current);
        const body = pending.current;
        if (!body) return;
        pending.current = null;
        setSaveState("saving");
        try {
            await apiRequest(`home/${name}/?mode=draft`, { method: "PATCH", body });
            setSaveState(pending.current ? "dirty" : "saved");
            setSaveError("");
            refreshDrafts();
        } catch (error) {
            pending.current = pending.current || body;
            setSaveState("error");
            setSaveError(error.message);
        }
    }, [name, refreshDrafts]);

    const stateRef = useRef({});

    const replace = useCallback((next) => {
        stateRef.current.data = next;
        setDraft(next);
        pending.current = next;
        setSaveState("dirty");
        clearTimeout(timer.current);
        timer.current = setTimeout(persist, AUTOSAVE_MS);
    }, [persist]);

    const update = useCallback((path, value) => {
        replace(setPath(stateRef.current.data, path, value));
    }, [replace]);

    // Never lose a pending edit on navigation.
    useEffect(() => () => {
        if (pending.current) persist();
    }, [persist]);

    /* ---------- publish / discard from the admin bar ---------- */
    const lastPublish = useRef(publishEpoch);
    useEffect(() => {
        if (publishEpoch === lastPublish.current) return;
        lastPublish.current = publishEpoch;
        if (draft) {
            setRemote(draft);
            options.afterSave?.(draft);
        }
        setSaveState("idle");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [publishEpoch]);

    const lastDiscard = useRef(discardEpoch);
    useEffect(() => {
        if (discardEpoch === lastDiscard.current) return;
        lastDiscard.current = discardEpoch;
        pending.current = null;
        clearTimeout(timer.current);
        setSaveState("idle");
        loadDraft();
    }, [discardEpoch, loadDraft]);

    /* ---------- visibility ---------- */
    // Visitors (and admins with editing off) see the published shape: hidden
    // list items removed, hidden block not rendered. Editing shows everything.
    const hideable = options.hideable !== false;
    const blockHidden = hideable && isHidden(data);
    const visible = useMemo(() => (editMode ? data : stripHidden(data)), [editMode, data]);
    const hidden = blockHidden && !editMode;
    const setHidden = useCallback((value) => update(HIDDEN_KEY, Boolean(value)), [update]);

    /* ---------- inline primitives ---------- */
    const label = options.label || name;
    stateRef.current = { data: visible, editMode, update, defaults, label, block: name };
    const [E] = useState(() => createInline(stateRef));

    /* ---------- registry (admin bar, AI assist, panels) ---------- */
    const fields = options.fields;
    const afterSave = options.afterSave;
    const excludeFromKeywordAudit = Boolean(options.excludeFromKeywordAudit);

    useEffect(() => {
        if (!isAdmin) return undefined;
        return register(name, {
            name,
            label,
            defaults,
            data,
            fields,
            afterSave,
            excludeFromKeywordAudit,
            hidden: blockHidden,
            saveState,
            saveError,
            update,
            replace,
            flush: persist,
        });
    }, [isAdmin, register, name, label, defaults, data, fields, afterSave, excludeFromKeywordAudit,
        blockHidden, saveState, saveError, update, replace, persist]);

    // Visitors get a hidden, zero-size marker instead: its parent is this
    // block, so tracking knows which block every click/view belongs to (R31).
    const editButton = editMode ? (
        <AllFieldsButton
            name={name}
            label={label}
            saveState={saveState}
            position={options.buttonPosition}
            hidden={blockHidden}
            onToggleHidden={hideable ? () => setHidden(!blockHidden) : null}
            onClick={() => openPanel("section", { name })}
        />
    ) : (
        <span hidden data-track-block={name} />
    );

    return { data: visible, hidden, setHidden, E, editButton, update, replace, saveState, editMode };
}

const STATE_DOT = {
    dirty: "bg-[#F59E0B]",
    saving: "bg-[#F59E0B] animate-pulse",
    saved: "bg-[var(--cms-accent)]",
    error: "bg-[#DC2626]",
    idle: "bg-white/70",
};

// The block's own tools (Hide · "Label ⋯"), floating at the block's top-right
// in the admin layer: never covered by a neighbouring section, never moving
// the layout (R30). The in-page anchor also carries the "hidden" marker that
// dims the block (cms.css). `position` is accepted for compatibility.
function AllFieldsButton({ name, label, saveState, onClick, hidden, onToggleHidden }) {
    const anchor = useRef(null);
    const pinned = hidden || ["dirty", "saving", "error"].includes(saveState);
    const tools = useFloating(anchor, { pinned });
    return (
        <>
            <span ref={anchor} className="cms-ui" hidden data-track-block={name}>
                {/* Dims the block (cms.css) while it is hidden from visitors. */}
                {hidden ? <span data-cms-hidden="block" hidden /> : null}
            </span>
            <FloatingTools tools={tools} place={PLACE.insideTopRight} data-cms-block-tools className="inline-flex items-center gap-1">
                {onToggleHidden ? <button
                    type="button"
                    onClick={onToggleHidden}
                    title={hidden ? "Hidden from visitors (after Publish) — click to show" : "Hide this block from visitors"}
                    aria-pressed={hidden}
                    data-cms-action="toggle-hidden"
                    className={`inline-flex h-[30px] items-center rounded-full border px-2.5 text-[11px] font-semibold shadow-[0_8px_24px_rgba(0,0,0,0.25)] backdrop-blur ${hidden ? "border-[#F59E0B] bg-[#FEF3C7] text-[#92400E]" : "border-white/40 bg-[#0F172A]/90 text-white hover:bg-[#334155]"}`}
                >
                    {hidden ? "Hidden · Show" : "Hide"}
                </button> : null}
                <button
                    type="button"
                    onClick={onClick}
                    title={`All fields, AI and history for “${label}”`}
                    className="inline-flex h-[30px] items-center gap-2 whitespace-nowrap rounded-full border border-white/40 bg-[#0F172A]/90 px-3 text-[11px] font-semibold text-white shadow-[0_8px_24px_rgba(0,0,0,0.25)] backdrop-blur transition hover:bg-[var(--cms-accent)]"
                >
                    <span className={`h-2 w-2 rounded-full ${STATE_DOT[saveState] || STATE_DOT.idle}`} aria-hidden="true" />
                    {label}
                    <span aria-hidden="true">⋯</span>
                </button>
            </FloatingTools>
        </>
    );
}
