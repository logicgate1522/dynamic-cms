"use client";

import { useCallback, useEffect, useState } from "react";

import { Card, Notice, PageTitle } from "@/components/admin/AdminShell";
import { fetchAll, formatDate } from "@/components/admin/useApi";
import { buttonStyles } from "@/components/cms/Drawer";
import { apiFetch, apiRequest } from "@/lib/api";

const EMPTY = { source: "", destination: "", status_code: 301, notes: "" };

export default function RedirectsPage() {
    const [items, setItems] = useState(null);
    const [draft, setDraft] = useState(EMPTY);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    const load = useCallback(async () => {
        try {
            setItems(await fetchAll("redirects/"));
        } catch (err) {
            setError(err.message);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    async function act(fn, message) {
        setError("");
        setSuccess("");
        try {
            await fn();
            await load();
            setSuccess(message);
        } catch (err) {
            setError(err.message);
        }
    }

    const normalise = (p) => (/^https?:\/\//.test(p) ? p.trim() : `/${p.trim().replace(/^\/+/, "")}`);

    const add = (event) => {
        event.preventDefault();
        act(async () => {
            const status = Number(draft.status_code);
            await apiRequest("redirects/", {
                method: "POST",
                body: { ...draft, source: normalise(draft.source), destination: normalise(draft.destination), status_code: status, permanent: status === 301 || status === 308 },
            });
            setDraft(EMPTY);
        }, "Redirect added. It takes effect within a minute.");
    };

    async function importCsv(file) {
        setError("");
        setSuccess("");
        try {
            const result = await apiRequest("redirects/io/", { method: "POST", body: { csv: await file.text() } });
            await load();
            const problems = result.errors?.length ? ` ${result.errors.length} row(s) skipped.` : "";
            setSuccess(`Imported: ${result.created} created, ${result.updated} updated.${problems}`);
        } catch (err) {
            setError(err.message);
        }
    }

    async function exportCsv() {
        const res = await apiFetch("redirects/io/?format=csv");
        const url = URL.createObjectURL(await res.blob());
        Object.assign(document.createElement("a"), { href: url, download: "redirects.csv" }).click();
        URL.revokeObjectURL(url);
    }

    const input = "h-10 w-full rounded-lg border border-[#D6DEE8] px-3 text-[13px] outline-none focus:border-[#0F9E86]";

    return (
        <>
            <PageTitle
                title="Redirects"
                description="Send old URLs to new ones. Add a redirect whenever a page's URL changes so links and search rankings carry over."
                actions={
                    <>
                        <button type="button" className={buttonStyles.secondary} onClick={exportCsv}>Export CSV</button>
                        <label className={`${buttonStyles.secondary} cursor-pointer`}>
                            Import CSV
                            <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} />
                        </label>
                    </>
                }
            />
            <Notice error={error} success={success} />

            <Card>
                <form onSubmit={add} className="grid gap-3 md:grid-cols-[1fr_1fr_140px_auto] md:items-end">
                    <label className="text-[12px] font-semibold text-[#475569]">From<input required value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="/old-page" className={`mt-1 ${input}`} /></label>
                    <label className="text-[12px] font-semibold text-[#475569]">To<input required value={draft.destination} onChange={(e) => setDraft({ ...draft, destination: e.target.value })} placeholder="/new-page" className={`mt-1 ${input}`} /></label>
                    <label className="text-[12px] font-semibold text-[#475569]">
                        Type
                        <select value={draft.status_code} onChange={(e) => setDraft({ ...draft, status_code: e.target.value })} className={`mt-1 ${input}`}>
                            <option value={301}>301 permanent</option>
                            <option value={302}>302 temporary</option>
                            <option value={307}>307 temporary</option>
                            <option value={308}>308 permanent</option>
                        </select>
                    </label>
                    <button type="submit" className={`${buttonStyles.primary} h-10`}>Add redirect</button>
                </form>
            </Card>

            <Card className="mt-6 overflow-x-auto p-0">
                <table className="w-full min-w-[720px] text-left text-[13px]">
                    <thead className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] uppercase tracking-[0.08em] text-[#64748B]">
                        <tr>
                            <th scope="col" className="px-5 py-3">From</th>
                            <th scope="col" className="px-3 py-3">To</th>
                            <th scope="col" className="px-3 py-3">Code</th>
                            <th scope="col" className="px-3 py-3">Hits</th>
                            <th scope="col" className="px-3 py-3">Last hit</th>
                            <th scope="col" className="px-5 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {items === null ? (
                            <tr><td colSpan={6} className="px-5 py-6 text-[#64748B]">Loading…</td></tr>
                        ) : items.length === 0 ? (
                            <tr><td colSpan={6} className="px-5 py-6 text-[#64748B]">No redirects yet.</td></tr>
                        ) : (
                            items.map((r) => (
                                <tr key={r.id} className={`border-b border-[#F1F5F9] last:border-0 ${r.is_active ? "" : "opacity-50"}`}>
                                    <td className="px-5 py-3 font-mono text-[12px]">{r.source}</td>
                                    <td className="px-3 py-3 font-mono text-[12px]">{r.destination}</td>
                                    <td className="px-3 py-3">{r.effective_status}</td>
                                    <td className="px-3 py-3">{r.hit_count}</td>
                                    <td className="px-3 py-3 text-[#475569]">{formatDate(r.last_hit_at)}</td>
                                    <td className="px-5 py-3 text-right">
                                        <div className="flex justify-end gap-3">
                                            <button type="button" className={buttonStyles.link} onClick={() => act(() => apiRequest(`redirects/${r.id}/`, { method: "PATCH", body: { is_active: !r.is_active } }), r.is_active ? "Redirect paused." : "Redirect enabled.")}>
                                                {r.is_active ? "Pause" : "Enable"}
                                            </button>
                                            <button type="button" className={`${buttonStyles.link} text-[#B42318]`} onClick={() => window.confirm(`Delete redirect ${r.source}?`) && act(() => apiRequest(`redirects/${r.id}/`, { method: "DELETE" }), "Redirect deleted.")}>
                                                Delete
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </Card>
        </>
    );
}
