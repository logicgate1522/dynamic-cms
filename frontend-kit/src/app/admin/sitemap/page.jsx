"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Card, Notice, PageTitle } from "@/components/admin/AdminShell";
import { buttonStyles } from "@/components/cms/Drawer";
import { apiRequest } from "@/lib/api";

const CHANGEFREQ = ["", "always", "hourly", "daily", "weekly", "monthly", "yearly", "never"];

// Sitemap organizer: every URL the backend sitemap knows about (CMS pages,
// blog, code routes listed in extraPaths), with per-URL overrides.
export default function SitemapPage() {
    const [report, setReport] = useState(null);
    const [overrides, setOverrides] = useState({});
    const [extraPaths, setExtraPaths] = useState([]);
    const [saved, setSaved] = useState("");
    const [newPath, setNewPath] = useState("");
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [search, setSearch] = useState("");

    const load = useCallback(async () => {
        try {
            const [rep, settings] = await Promise.all([apiRequest("sitemap/report/"), apiRequest("settings/site/")]);
            const cfg = settings.sitemap || {};
            setReport(rep);
            setOverrides(cfg.overrides || {});
            setExtraPaths(cfg.extraPaths || []);
            setSaved(JSON.stringify([cfg.overrides || {}, cfg.extraPaths || []]));
        } catch (err) {
            setError(err.message);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const dirty = JSON.stringify([overrides, extraPaths]) !== saved;
    const keyOf = (path) => path || "home";
    const setOverride = (path, patch) => setOverrides((o) => ({ ...o, [keyOf(path)]: { ...(o[keyOf(path)] || {}), ...patch } }));

    async function save() {
        setError("");
        setSuccess("");
        try {
            await apiRequest("settings/site/", { method: "PATCH", body: { sitemap: { overrides, extraPaths } } });
            setSuccess("Sitemap saved.");
            await load();
        } catch (err) {
            setError(err.message);
        }
    }

    const entries = useMemo(
        () => (report?.entries || []).filter((e) => !search || `/${e.path}`.includes(search.toLowerCase())),
        [report, search]
    );

    return (
        <>
            <PageTitle
                title="Sitemap"
                description="Every URL search engines are told about. Exclude pages that shouldn't be found, raise the priority of key pages, and add routes that exist only in the site's code."
                actions={<button type="button" className={buttonStyles.primary} disabled={!dirty} onClick={save}>Save sitemap</button>}
            />
            <Notice error={error} success={success} />
            <Card className="mb-4">
                <p className="text-[13px] font-semibold">Code routes</p>
                <p className="mt-1 text-[12px] text-[#64748B]">Pages built in code (not in the CMS) appear in the sitemap only when listed here.</p>
                <div className="mt-3 flex flex-wrap gap-1">
                    {extraPaths.map((p) => (
                        <span key={p} className="inline-flex items-center gap-1 rounded-full bg-[#F1F5F9] px-2.5 py-1 text-[12px]">
                            /{p}
                            <button type="button" aria-label={`Remove ${p}`} onClick={() => setExtraPaths(extraPaths.filter((x) => x !== p))} className="text-[#94A3B8] hover:text-[#B42318]">×</button>
                        </span>
                    ))}
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            const clean = newPath.trim().replace(/^\/+|\/+$/g, "");
                            if (clean && !extraPaths.includes(clean)) setExtraPaths([...extraPaths, clean]);
                            setNewPath("");
                        }}
                    >
                        <input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="/about + Enter" className="rounded-full border border-[#CBD5E1] px-3 py-1 text-[12px]" />
                    </form>
                </div>
            </Card>
            <Card className="overflow-x-auto p-0">
                <div className="flex items-center justify-between px-5 pt-4">
                    <p className="text-[13px] text-[#64748B]">{report ? `${report.included} of ${report.entries.length} URLs included` : "Loading…"}</p>
                    <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter by path" className="rounded-lg border border-[#CBD5E1] px-3 py-1.5 text-[12px]" />
                </div>
                <table className="mt-3 w-full min-w-[720px] text-left text-[13px]">
                    <thead className="border-y border-[#E2E8F0] bg-[#F8FAFC] text-[11px] uppercase tracking-[0.08em] text-[#64748B]">
                        <tr>
                            <th scope="col" className="px-5 py-2">URL</th>
                            <th scope="col" className="px-3 py-2">Source</th>
                            <th scope="col" className="px-3 py-2">Include</th>
                            <th scope="col" className="px-3 py-2">Priority</th>
                            <th scope="col" className="px-3 py-2">Change frequency</th>
                        </tr>
                    </thead>
                    <tbody>
                        {entries.map((e) => {
                            const o = overrides[keyOf(e.path)] || {};
                            const included = o.include === undefined ? e.included : o.include !== false;
                            return (
                                <tr key={e.path} className={`border-b border-[#F1F5F9] ${included ? "" : "opacity-50"}`}>
                                    <td className="px-5 py-2 font-mono text-[12px]">/{e.path}</td>
                                    <td className="px-3 py-2 text-[#64748B]">{e.source}</td>
                                    <td className="px-3 py-2"><input type="checkbox" checked={included} onChange={(ev) => setOverride(e.path, { include: ev.target.checked })} /></td>
                                    <td className="px-3 py-2">
                                        <input type="number" min="0" max="1" step="0.1" value={o.priority ?? e.priority ?? ""} onChange={(ev) => setOverride(e.path, { priority: ev.target.value === "" ? undefined : Number(ev.target.value) })} className="w-20 rounded-md border border-[#CBD5E1] px-2 py-1" />
                                    </td>
                                    <td className="px-3 py-2">
                                        <select value={o.changefreq ?? e.changefreq ?? ""} onChange={(ev) => setOverride(e.path, { changefreq: ev.target.value || undefined })} className="rounded-md border border-[#CBD5E1] px-2 py-1">
                                            {CHANGEFREQ.map((c) => <option key={c} value={c}>{c || "—"}</option>)}
                                        </select>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </Card>
        </>
    );
}
