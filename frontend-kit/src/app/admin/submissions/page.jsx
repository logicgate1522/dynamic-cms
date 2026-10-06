"use client";

import { useCallback, useEffect, useState } from "react";

import { Card, Notice, PageTitle } from "@/components/admin/AdminShell";
import { formatDate, rows } from "@/components/admin/useApi";
import { buttonStyles } from "@/components/cms/Drawer";
import { humanize } from "@/components/cms/FieldEditor";
import { apiFetch, apiRequest } from "@/lib/api";

const FILTERS = [
    { key: "inbox", label: "Inbox", query: "is_spam=0" },
    { key: "unread", label: "Unread", query: "is_read=0&is_spam=0" },
    { key: "spam", label: "Spam", query: "is_spam=1" },
];

export default function SubmissionsPage() {
    const [form, setForm] = useState("quote");
    const [filter, setFilter] = useState("inbox");
    const [page, setPage] = useState(1);
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [open, setOpen] = useState(null);

    const query = FILTERS.find((f) => f.key === filter).query;

    const load = useCallback(async () => {
        try {
            setData(await apiRequest(`forms/${form}/submissions/?${query}&page=${page}`));
            setError("");
        } catch (err) {
            setData({ results: [], count: 0 });
            setError(err.status === 404 ? "" : err.message);
        }
    }, [form, query, page]);

    useEffect(() => {
        load();
    }, [load]);

    async function toggle(sub, field) {
        try {
            await apiRequest(`forms/${form}/submissions/${sub.id}/`, { method: "PATCH", body: { [field]: !sub[field] } });
            load();
        } catch (err) {
            setError(err.message);
        }
    }

    async function exportCsv() {
        try {
            const res = await apiFetch(`forms/${form}/submissions/export/?format=csv`);
            if (!res.ok) throw new Error(`Export failed (${res.status})`);
            const url = URL.createObjectURL(await res.blob());
            const a = Object.assign(document.createElement("a"), { href: url, download: `${form}-submissions.csv` });
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            setError(err.message);
        }
    }

    const list = rows(data);
    const total = data?.count ?? list.length;

    return (
        <>
            <PageTitle
                title="Form submissions"
                description="Enquiries from the site's forms. Set a notification email on the server (FORM_NOTIFICATION_EMAIL) to also receive them by email."
                actions={<button type="button" className={buttonStyles.secondary} onClick={exportCsv}>Export CSV</button>}
            />
            <Notice error={error} />

            <div className="mb-4 flex flex-wrap items-center gap-3">
                <label className="text-[12px] font-semibold text-[#475569]">
                    Form{" "}
                    <input value={form} onChange={(e) => { setForm(e.target.value.replace(/[^\w-]/g, "")); setPage(1); }} className="ml-1 h-9 w-36 rounded-lg border border-[#D6DEE8] px-3 text-[13px] font-normal" />
                </label>
                <div className="flex gap-1">
                    {FILTERS.map((f) => (
                        <button key={f.key} type="button" onClick={() => { setFilter(f.key); setPage(1); }} className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${filter === f.key ? "bg-[#123A5C] text-white" : "bg-white text-[#475569]"}`}>
                            {f.label}
                        </button>
                    ))}
                </div>
                <span className="text-[12px] text-[#64748B]">{total} total</span>
            </div>

            <div className="space-y-2">
                {data === null ? <p className="text-[13px] text-[#64748B]">Loading…</p> : null}
                {data && list.length === 0 ? <Card><p className="text-[13px] text-[#64748B]">No submissions here.</p></Card> : null}
                {list.map((sub) => {
                    const fields = sub.data || {};
                    const isOpen = open === sub.id;
                    return (
                        <Card key={sub.id} className={`p-0 ${sub.is_read ? "" : "border-l-4 border-l-[#0F9E86]"}`}>
                            <button
                                type="button"
                                onClick={() => {
                                    setOpen(isOpen ? null : sub.id);
                                    if (!sub.is_read) toggle(sub, "is_read");
                                }}
                                className="flex w-full flex-wrap items-center justify-between gap-2 px-5 py-4 text-left"
                            >
                                <span>
                                    <span className="font-semibold text-[#0F172A]">{fields.name || fields.email || `Submission #${sub.id}`}</span>
                                    <span className="ml-2 text-[12px] text-[#64748B]">{fields.email}{fields.phone ? ` · ${fields.phone}` : ""}</span>
                                </span>
                                <span className="text-[12px] text-[#64748B]">{formatDate(sub.created_at)}</span>
                            </button>
                            {isOpen ? (
                                <div className="border-t border-[#F1F5F9] px-5 py-4">
                                    <dl className="grid gap-3 sm:grid-cols-2">
                                        {Object.entries(fields).map(([key, value]) => (
                                            <div key={key} className={String(value).length > 60 ? "sm:col-span-2" : ""}>
                                                <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#64748B]">{humanize(key)}</dt>
                                                <dd className="mt-0.5 whitespace-pre-wrap text-[13px] text-[#0F172A]">{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
                                            </div>
                                        ))}
                                    </dl>
                                    <div className="mt-4 flex gap-3">
                                        {fields.email ? <a href={`mailto:${fields.email}`} className={buttonStyles.link}>Reply by email</a> : null}
                                        <button type="button" className={buttonStyles.link} onClick={() => toggle(sub, "is_read")}>{sub.is_read ? "Mark unread" : "Mark read"}</button>
                                        <button type="button" className={buttonStyles.link} onClick={() => toggle(sub, "is_spam")}>{sub.is_spam ? "Not spam" : "Mark as spam"}</button>
                                    </div>
                                </div>
                            ) : null}
                        </Card>
                    );
                })}
            </div>

            {data?.next || data?.previous ? (
                <div className="mt-4 flex justify-between">
                    <button type="button" className={buttonStyles.secondary} disabled={!data.previous} onClick={() => setPage((p) => p - 1)}>← Newer</button>
                    <button type="button" className={buttonStyles.secondary} disabled={!data.next} onClick={() => setPage((p) => p + 1)}>Older →</button>
                </div>
            ) : null}
        </>
    );
}
