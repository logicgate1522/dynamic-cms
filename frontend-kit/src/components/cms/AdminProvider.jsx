"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { apiRequest, getSession, login as apiLogin, logout as apiLogout } from "@/lib/api";

/* =========================================
   Admin state for the whole site.
   - isAdmin comes from the server (GET auth/session/),
     never from anything stored in the browser.
   - Editable blocks register here so the admin bar,
     the whole-page AI assist and the editors can see
     every block on the current page.
   - Drafts: inline edits autosave as drafts; the admin
     bar publishes or discards them. `publishEpoch` /
     `discardEpoch` tell every block to refresh.
   - Panels (section editor, SEO, AI assist, page
     builder, site tools) are opened through here, so
     no component reaches into another's state.
========================================= */

const AdminContext = createContext(null);

const EDIT_MODE_KEY = "cmsEditMode";

export function AdminProvider({ children }) {
    const [isAdmin, setIsAdmin] = useState(false);
    const [user, setUser] = useState(null);
    const [checked, setChecked] = useState(false);
    const [editMode, setEditModeState] = useState(true);
    const [editables, setEditables] = useState({});
    const editablesRef = useRef({});
    // Pending-save flushers (dynamic sections) — run before publish/discard so
    // a just-typed edit is neither left out nor re-created after a discard.
    const flushersRef = useRef(new Set());
    const [drafts, setDrafts] = useState({ components: [], hosts: [], total: 0 });
    const [publishEpoch, setPublishEpoch] = useState(0);
    const [discardEpoch, setDiscardEpoch] = useState(0);
    const [panel, setPanel] = useState(null); // {type, ...props}
    const [seoPath, setSeoPath] = useState(null);
    const [dynamicHost, setDynamicHost] = useState(null);
    // The collection this route belongs to ({collection, role: "index"|"entry", entry?}),
    // so "+ New <item>" and entry settings appear only where they make sense.
    const pathname = usePathname();
    const [collection, setCollection] = useState({ collection: null, role: null });

    const refreshSession = useCallback(async () => {
        const session = await getSession();
        setIsAdmin(Boolean(session.authenticated));
        setUser(session.user || null);
        setChecked(true);
    }, []);

    useEffect(() => {
        refreshSession();
        try {
            setEditModeState(localStorage.getItem(EDIT_MODE_KEY) !== "0");
        } catch {
            // storage unavailable: editing starts on
        }
        const onFocus = () => refreshSession();
        window.addEventListener("focus", onFocus);
        return () => window.removeEventListener("focus", onFocus);
    }, [refreshSession]);

    const refreshDrafts = useCallback(async () => {
        try {
            setDrafts(await apiRequest("drafts/"));
        } catch {
            // not an admin (any more) — leave as is
        }
    }, []);

    useEffect(() => {
        if (isAdmin) refreshDrafts();
    }, [isAdmin, refreshDrafts]);

    // lib/track.js skips events for signed-in admins ("Don't track signed-in admins").
    useEffect(() => {
        window.__cmsAdmin = isAdmin;
    }, [isAdmin]);

    const refreshCollection = useCallback(async () => {
        if (!isAdmin || !pathname || pathname.startsWith("/admin")) {
            setCollection({ collection: null, role: null });
            return;
        }
        try {
            setCollection(await apiRequest(`collections/for-path/?path=${encodeURIComponent(pathname)}`));
        } catch {
            setCollection({ collection: null, role: null });
        }
    }, [isAdmin, pathname]);

    useEffect(() => {
        refreshCollection();
    }, [refreshCollection]);

    // Panels belong to the page they were opened on.
    useEffect(() => {
        setPanel(null);
    }, [pathname]);

    const setEditMode = useCallback((value) => {
        setEditModeState(value);
        try {
            localStorage.setItem(EDIT_MODE_KEY, value ? "1" : "0");
        } catch {
            // ignore
        }
    }, []);

    const signIn = useCallback(async (identifier, password) => {
        const signedIn = await apiLogin(identifier, password);
        setUser(signedIn);
        setIsAdmin(true);
        setEditMode(true);
        return signedIn;
    }, [setEditMode]);

    const signOut = useCallback(async () => {
        await apiLogout().catch(() => {});
        setIsAdmin(false);
        setUser(null);
        setPanel(null);
    }, []);

    const register = useCallback((name, entry) => {
        editablesRef.current = { ...editablesRef.current, [name]: entry };
        setEditables(editablesRef.current);
        return () => {
            const { [name]: _removed, ...rest } = editablesRef.current;
            editablesRef.current = rest;
            setEditables(rest);
        };
    }, []);

    const addFlusher = useCallback((fn) => {
        flushersRef.current.add(fn);
        return () => flushersRef.current.delete(fn);
    }, []);
    const flushAll = useCallback(() => Promise.all([
        ...Object.values(editablesRef.current).map((e) => e.flush?.()),
        ...[...flushersRef.current].map((fn) => fn()),
    ]), []);

    // Publish / discard: everything pending, or a scope
    // ({components: [...], hosts: [{kind, key}]}).
    const publish = useCallback(async (scope = {}) => {
        await flushAll();
        const result = await apiRequest("drafts/publish/", { method: "POST", body: scope });
        setPublishEpoch((n) => n + 1);
        await refreshDrafts();
        // Re-render this page on the server now so the next visitor gets
        // fresh HTML (the backend webhook already dropped the cache).
        fetch(window.location.pathname, { cache: "no-store" }).catch(() => {});
        return result;
    }, [refreshDrafts, flushAll]);

    const discard = useCallback(async (scope = {}) => {
        await flushAll();
        const result = await apiRequest("drafts/discard/", { method: "POST", body: scope });
        setDiscardEpoch((n) => n + 1);
        await refreshDrafts();
        return result;
    }, [refreshDrafts, flushAll]);

    const value = useMemo(() => ({
        isAdmin,
        checked,
        user,
        editMode: isAdmin && editMode,
        setEditMode,
        signIn,
        signOut,
        refreshSession,
        editables,
        editablesRef,
        register,
        addFlusher,
        drafts,
        refreshDrafts,
        publish,
        discard,
        publishEpoch,
        discardEpoch,
        panel,
        openPanel: (type, props = {}) => setPanel({ type, ...props }),
        closePanel: () => setPanel(null),
        seoPath,
        setSeoPath,
        dynamicHost,
        setDynamicHost,
        collection,
        refreshCollection,
    }), [isAdmin, checked, user, editMode, setEditMode, signIn, signOut, refreshSession, editables, register, addFlusher,
        drafts, refreshDrafts, publish, discard, publishEpoch, discardEpoch, panel, seoPath, dynamicHost, collection, refreshCollection]);

    return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

const NOOP = () => {};
const OUTSIDE = {
    isAdmin: false,
    checked: true,
    user: null,
    editMode: false,
    setEditMode: NOOP,
    signIn: async () => null,
    signOut: async () => {},
    refreshSession: async () => {},
    editables: {},
    editablesRef: { current: {} },
    register: () => NOOP,
    addFlusher: () => NOOP,
    drafts: { components: [], hosts: [], total: 0 },
    refreshDrafts: async () => {},
    publish: async () => ({}),
    discard: async () => ({}),
    publishEpoch: 0,
    discardEpoch: 0,
    panel: null,
    openPanel: NOOP,
    closePanel: NOOP,
    seoPath: null,
    setSeoPath: NOOP,
    dynamicHost: null,
    setDynamicHost: NOOP,
    collection: { collection: null, role: null },
    refreshCollection: NOOP,
};

export function useAdmin() {
    return useContext(AdminContext) || OUTSIDE;
}
