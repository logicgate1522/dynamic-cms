"use client";

import { Fragment, useEffect, useState } from "react";

import { formatDate, useApi } from "@/components/admin/useApi";
import { buttonStyles } from "@/components/cms/Drawer";
import { Empty, input, Pill, Section } from "@/components/admin/tracking/ui";
import { apiFetch, apiRequest } from "@/lib/api";

/* =========================================
   Contacts (R33): everyone who got in touch, what they wanted, where they
   came from and where they are in your pipeline. Admin-only.
   Privacy: marketing lists only ever contain people who ticked the opt-in;
   contacts are erased automatically after the retention period (unless
   marked Client); "Erase" removes a person everywhere, "Export" gives them
   everything held (access requests).
========================================= */

const TABS = [["list", "Contacts"], ["groups", "Groups"], ["settings", "Settings"], ["audit", "Activity log"]];

async function download(path, filename) {
    const res = await apiFetch(path);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement("a"), { href: url, download: filename }).click();
    URL.revokeObjectURL(url);
}

export default function ContactsPanel() {
    const [tab, setTab] = useState("list");
    return (
        <div data-cms-contacts-panel>
            <div className="mb-4 flex flex-wrap gap-1 border-b border-[#E2E8F0]">
                {TABS.map(([key, label]) => (
                    <button key={key} type="button" onClick={() => setTab(key)} className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold ${tab === key ? "border-[var(--cms-accent)] text-[#0F172A]" : "border-transparent text-[#64748B] hover:text-[#0F172A]"}`}>
                        {label}
                    </button>
                ))}
            </div>
            {tab === "list" ? <ContactList /> : null}
            {tab === "groups" ? <Groups /> : null}
            {tab === "settings" ? <ContactSettings /> : null}
            {tab === "audit" ? <Audit /> : null}
        </div>
    );
}

/* ------------------------------------------------------------------ list */

function ContactList() {
    const [filters, setFilters] = useState({ q: "", status: "", group: "", opt_in: "" });
    const [page, setPage] = useState(1);
    const query = new URLSearchParams(Object.entries({ ...filters, page }).filter(([, v]) => v !== "" && v != null)).toString();
    const list = useApi(`contacts/?${query}`);
    const groups = useApi("contacts/groups/");
    const settings = useApi("contacts/settings/");
    const [openId, setOpenId] = useState(null);
    const [error, setError] = useState("");
    const set = (patch) => {
        setFilters({ ...filters, ...patch });
        setPage(1);
    };
    const data = list.data || { results: [], count: 0, pageSize: 50 };
    if (openId) return <ContactDetail id={openId} onBack={() => { setOpenId(null); list.reload(); }} />;
    return (
        <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <input className={`${input} max-w-[220px]`} placeholder="Search name, email, phone" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
                <select className={`${input} max-w-[180px]`} value={filters.status} onChange={(e) => set({ status: e.target.value })}>
                    <option value="">Any status</option>
                    {(settings.data?.statuses || []).map((s, i) => <option key={i} value={s}>{settings.data.statusLabels?.[s] || s}</option>)}
                </select>
                <select className={`${input} max-w-[240px]`} value={filters.group} onChange={(e) => set({ group: e.target.value })}>
                    <option value="">Everyone</option>
                    {(groups.data?.groups || []).map((g, i) => <option key={i} value={g.key}>{g.label} ({g.size})</option>)}
                </select>
                <select className={`${input} max-w-[160px]`} value={filters.opt_in} onChange={(e) => set({ opt_in: e.target.value })}>
                    <option value="">Any consent</option>
                    <option value="1">Opted in</option>
                    <option value="0">Not opted in</option>
                </select>
                <span className="ml-auto flex gap-2">
                    <button type="button" className={buttonStyles.secondary} onClick={() => download(`contacts/export/?${query}`, "contacts.csv").catch((e) => setError(e.message))}>Export CSV</button>
                </span>
            </div>
            {error ? <p className="mb-2 text-[12px] text-[#B42318]">{error}</p> : null}
            {list.error ? <p className="mb-2 text-[12px] text-[#B42318]">{list.error}</p> : null}
            {data.results.length ? (
                <div className="overflow-x-auto rounded-xl border border-[#E2E8F0]">
                    <table className="w-full text-left text-[12px]">
                        <thead className="bg-[#F8FAFC] text-[#64748B]">
                            <tr><th className="p-2">Name</th><th className="p-2">Wants</th><th className="p-2">Type</th><th className="p-2">Stage</th><th className="p-2">Area</th><th className="p-2">Source</th><th className="p-2">Status</th><th className="p-2">Last contact</th></tr>
                        </thead>
                        <tbody>
                            {data.results.map((c, i) => (
                                <tr key={i} className="cursor-pointer border-t border-[#E2E8F0] hover:bg-[#F8FAFC]" onClick={() => setOpenId(c.id)} data-cms-contact={c.id}>
                                    <td className="p-2"><strong>{c.name || "—"}</strong><span className="block text-[#64748B]">{c.email || c.phone}</span>
                                        {c.merge_suggestions?.length ? <Pill status="warn">possible duplicate</Pill> : null}</td>
                                    <td className="p-2">{c.intents.join(", ")}</td>
                                    <td className="p-2">{c.segment}</td>
                                    <td className="p-2">{(c.stages || []).join(", ")}</td>
                                    <td className="p-2">{[c.city, c.region, c.country].filter(Boolean).join(", ")}</td>
                                    <td className="p-2">{c.source}{c.campaign ? ` · ${c.campaign}` : ""}</td>
                                    <td className="p-2"><Pill status={c.status === "client" ? "in_sync" : c.status === "new" ? "pending" : "skipped"}>{c.status.replace(/_/g, " ")}</Pill>{c.opt_in ? <span className="ml-1 text-[#067647]" title="Opted in to marketing">✓</span> : null}</td>
                                    <td className="p-2 text-[#64748B]">{formatDate(c.last_seen)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : <Empty>{list.loading ? "Loading…" : "No contacts yet. Everyone who submits a form with an email or phone appears here."}</Empty>}
            {data.count > data.pageSize ? (
                <div className="mt-2 flex items-center gap-2 text-[12px]">
                    <button type="button" className={buttonStyles.secondary} disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                    <span>Page {page} of {Math.ceil(data.count / data.pageSize)} · {data.count} contacts</span>
                    <button type="button" className={buttonStyles.secondary} disabled={page * data.pageSize >= data.count} onClick={() => setPage(page + 1)}>Next</button>
                </div>
            ) : null}
        </div>
    );
}

/* ---------------------------------------------------------------- detail */

function ContactDetail({ id, onBack }) {
    const { data, error, reload } = useApi(`contacts/${id}/`);
    const [note, setNote] = useState("");
    const [message, setMessage] = useState("");
    const [confirm, setConfirm] = useState("");
    if (!data) return <p className="text-[13px] text-[#64748B]">{error || "Loading…"}</p>;
    const patch = async (body) => {
        setMessage("");
        try {
            await apiRequest(`contacts/${id}/`, { method: "PATCH", body });
            reload();
        } catch (e) {
            setMessage(e.message);
        }
    };
    const s = data.summary;
    return (
        <div>
            <button type="button" className={`${buttonStyles.link} mb-3`} onClick={onBack}>← All contacts</button>
            {message ? <p className="mb-2 text-[12px] text-[#B42318]">{message}</p> : null}
            <div className="mb-4 flex flex-wrap items-start gap-4">
                <div>
                    <h3 className="text-[18px] font-bold text-[#0F172A]">{data.name || "—"}</h3>
                    <p className="text-[13px] text-[#475569]">{data.email} {data.phone ? `· +${data.phone}` : ""}</p>
                    <p className="mt-1 text-[12px] text-[#64748B]">
                        {[data.location.city, data.location.region, data.location.country].filter(Boolean).join(", ") || "Location unknown"} ·
                        first contact {formatDate(data.first_seen)} · {data.visits} visit(s) ·
                        {data.marketing_opt_in ? " opted in to marketing" : " not opted in to marketing"}
                    </p>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                    <select className={`${input} w-auto`} value={data.status} onChange={(e) => patch({ status: e.target.value })} aria-label="Status">
                        {(data.statuses || []).map((st, i) => <option key={i} value={st}>{st.replace(/_/g, " ")}</option>)}
                    </select>
                    <button type="button" className={buttonStyles.secondary} onClick={() => download(`contacts/${id}/export/`, `contact-${id}.json`)}>Export data</button>
                </div>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
                <Section title="What they want">
                    <p className="text-[13px]"><strong>Interests:</strong> {s.intents.join(", ") || "—"}</p>
                    <p className="text-[13px]"><strong>Type:</strong> {data.segment || "—"} · <strong>Stage:</strong> {(data.stages || []).join(", ") || "—"}</p>
                    <p className="text-[13px]"><strong>Came from:</strong> {s.source || "—"}{s.campaign ? ` · campaign “${s.campaign}”` : ""}</p>
                    {Object.keys(data.answers || {}).length ? (
                        <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 text-[12px]">
                            {Object.entries(data.answers).map(([k, v], i) => <Fragment key={i}><dt className="text-[#64748B]">{k}</dt><dd>{Array.isArray(v) ? v.join(", ") : String(v)}</dd></Fragment>)}
                        </dl>
                    ) : null}
                </Section>
                <Section title="Notes">
                    <div className="space-y-1">
                        {(data.notes || []).map((n, i) => <p key={i} className="rounded bg-[#F8FAFC] px-2 py-1 text-[12px]"><span className="text-[#94A3B8]">{formatDate(n.at)} · {n.by}</span><br />{n.text}</p>)}
                    </div>
                    <div className="mt-2 flex gap-2">
                        <input className={input} value={note} placeholder="Add a note" onChange={(e) => setNote(e.target.value)} />
                        <button type="button" className={buttonStyles.secondary} disabled={!note.trim()} onClick={async () => { await patch({ note }); setNote(""); }}>Add</button>
                    </div>
                </Section>
            </div>
            {s.merge_suggestions?.length ? (
                <Section title="Possible duplicates" description="Same phone number, different email. Merge only if it's the same person.">
                    {s.merge_suggestions.map((other, i) => (
                        <div key={i} className="flex items-center gap-2 text-[12px]">
                            <span>Contact #{other}</span>
                            <button type="button" className={buttonStyles.link} onClick={async () => { await apiRequest(`contacts/${id}/merge/`, { method: "POST", body: { other } }); reload(); }}>Merge into this one</button>
                            <button type="button" className={buttonStyles.link} onClick={() => patch({ dismiss_merge: other })}>Not the same person</button>
                        </div>
                    ))}
                </Section>
            ) : null}
            <Section title="Enquiries">
                {(data.submissions || []).map((sub, i) => (
                    <div key={i} className="mb-2 rounded-lg border border-[#E2E8F0] p-2 text-[12px]">
                        <p className="text-[#64748B]">{formatDate(sub.at)} · {sub.form}</p>
                        {sub.summary ? <p className="font-semibold text-[#0F766E]">{sub.summary}</p> : null}
                        <p className="mt-1 whitespace-pre-wrap">{Object.entries(sub.data || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\n")}</p>
                    </div>
                ))}
            </Section>
            {(data.events || []).length ? (
                <Section title="Visits since (with their consent)">
                    {data.events.map((e, i) => <p key={i} className="text-[12px] text-[#475569]">{formatDate(e.at)} · {e.name.replace(/_/g, " ")} {e.params?.intent ? `· ${e.params.intent}` : ""} {e.params?.page_path || ""}</p>)}
                </Section>
            ) : null}
            <Section title="Erase this person" description="Removes the contact, their enquiries and history from the CMS and from synced ad audiences. Cannot be undone.">
                <div className="flex gap-2">
                    <input className={`${input} max-w-[200px]`} placeholder="Type ERASE" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                    <button type="button" className={buttonStyles.danger} disabled={confirm !== "ERASE"} onClick={async () => {
                        try {
                            await apiRequest(`contacts/${id}/erase/`, { method: "POST", body: { confirm: "ERASE" } });
                            onBack();
                        } catch (e) {
                            setMessage(e.message);
                        }
                    }}>Erase permanently</button>
                </div>
            </Section>
        </div>
    );
}

/* ---------------------------------------------------------------- groups */

const FIELD_LABELS = { intent: "Interested in", segment: "Customer type", stage: "Stage", status: "Status", country: "Country", region: "Region", city: "City",
    source: "Source", medium: "Medium", campaign: "Campaign", tag: "Tag", opt_in: "Opted in", is_client: "Is a client", value: "Value", visits: "Visits",
    created: "First contact", last_seen: "Last contact" };
const OP_LABELS = { eq: "is", neq: "is not", contains: "contains", in: "is one of", gte: "at least", lte: "at most", exists: "is set", before: "before", after: "after" };

function Groups() {
    const { data, reload, error } = useApi("contacts/groups/");
    const [form, setForm] = useState(null);
    const [message, setMessage] = useState("");
    const save = async () => {
        setMessage("");
        try {
            const body = { label: form.label, rule: { all: form.rows.map((r) => ({ ...r, value: r.op === "in" ? r.value.split(",").map((x) => x.trim()) : r.value })) }, sync_to: form.meta ? ["meta"] : [] };
            if (form.key) await apiRequest(`contacts/groups/${form.key}/`, { method: "PATCH", body });
            else await apiRequest("contacts/groups/", { method: "POST", body });
            setForm(null);
            reload();
        } catch (e) {
            setMessage(e.message);
        }
    };
    return (
        <div>
            <Section title="Groups" description="Automatic groups follow your tracking plan. Make your own with rules; a group can become a Meta audience (opted-in people only, hashed)."
                     actions={<button type="button" className={buttonStyles.primary} onClick={() => setForm({ label: "", rows: [{ field: "intent", op: "eq", value: "" }], meta: false })}>+ New group</button>}>
                {error ? <p className="text-[12px] text-[#B42318]">{error}</p> : null}
                {form ? (
                    <div className="mb-3 space-y-2 rounded-xl border-2 border-[var(--cms-accent)] p-3">
                        <input className={input} placeholder="Group name" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
                        {form.rows.map((row, i) => (
                            <div key={i} className="flex flex-wrap gap-2">
                                <select className={`${input} w-auto`} value={row.field} onChange={(e) => setForm({ ...form, rows: form.rows.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)) })}>
                                    {Object.entries(FIELD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </select>
                                <select className={`${input} w-auto`} value={row.op} onChange={(e) => setForm({ ...form, rows: form.rows.map((r, j) => (j === i ? { ...r, op: e.target.value } : r)) })}>
                                    {Object.entries(OP_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                                </select>
                                {row.op !== "exists" ? <input className={`${input} max-w-[220px]`} value={row.value} placeholder={row.op === "in" ? "a, b, c" : "value"} onChange={(e) => setForm({ ...form, rows: form.rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)) })} /> : null}
                                <button type="button" className={buttonStyles.danger} onClick={() => setForm({ ...form, rows: form.rows.filter((_, j) => j !== i) })} aria-label="Remove condition">✕</button>
                            </div>
                        ))}
                        <button type="button" className={buttonStyles.link} onClick={() => setForm({ ...form, rows: [...form.rows, { field: "status", op: "eq", value: "" }] })}>+ And…</button>
                        <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" checked={form.meta} onChange={(e) => setForm({ ...form, meta: e.target.checked })} /> Keep a Meta customer audience in sync (opted-in people only)</label>
                        {message ? <p className="text-[12px] text-[#B42318]">{message}</p> : null}
                        <div className="flex gap-2">
                            <button type="button" className={buttonStyles.primary} disabled={!form.label.trim() || !form.rows.length} onClick={save}>Save group</button>
                            <button type="button" className={buttonStyles.secondary} onClick={() => setForm(null)}>Cancel</button>
                        </div>
                    </div>
                ) : null}
                <div className="divide-y divide-[#E2E8F0] rounded-xl border border-[#E2E8F0]">
                    {(data?.groups || []).map((g, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2 p-2 text-[12px]">
                            <strong>{g.label}</strong>
                            <Pill status={g.kind === "auto" ? "skipped" : "in_sync"}>{g.kind}</Pill>
                            <span className="text-[#64748B]">{g.size} people{g.optedIn != null ? ` · ${g.optedIn} opted in` : ""}</span>
                            {g.remote?.meta ? <span className="text-[#64748B]">Meta: {g.remote.meta.error || `${g.remote.meta.size ?? 0} synced`}{g.remote.meta.warning ? ` (${g.remote.meta.warning})` : ""}</span> : null}
                            {g.kind === "custom" ? (
                                <span className="ml-auto flex gap-2">
                                    <button type="button" className={buttonStyles.link} onClick={() => setForm({ key: g.key, label: g.label, rows: g.rule.all.map((r) => ({ ...r, value: Array.isArray(r.value) ? r.value.join(", ") : r.value ?? "" })), meta: (g.sync_to || []).includes("meta") })}>Edit</button>
                                    <button type="button" className={buttonStyles.danger} onClick={async () => { await apiRequest(`contacts/groups/${g.key}/`, { method: "DELETE" }); reload(); }}>Delete</button>
                                </span>
                            ) : null}
                        </div>
                    ))}
                </div>
            </Section>
        </div>
    );
}

/* -------------------------------------------------------------- settings */

function ContactSettings() {
    const { data, error } = useApi("contacts/settings/");
    const [draft, setDraft] = useState(null);
    const [message, setMessage] = useState({ error: "", success: "" });
    useEffect(() => {
        if (data && !draft) setDraft(data);
    }, [data, draft]);
    if (!draft) return <p className="text-[13px] text-[#64748B]">{error || "Loading…"}</p>;
    const save = async () => {
        try {
            const res = await apiRequest("contacts/settings/", { method: "PUT", body: draft });
            setDraft({ ...draft, ...res });
            setMessage({ error: "", success: "Saved." });
        } catch (e) {
            setMessage({ error: e.message, success: "" });
        }
    };
    return (
        <div className="space-y-4">
            {message.error ? <p className="text-[12px] text-[#B42318]">{message.error}</p> : null}
            {message.success ? <p className="text-[12px] text-[#067647]">{message.success}</p> : null}
            <Section title="Privacy">
                <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> Keep a contact record for each enquiry</label>
                <label className="mt-2 block text-[13px]">Erase people who aren't clients after
                    <input type="number" min="1" max="120" className={`${input} mx-2 inline-block w-20`} value={draft.retentionMonths} onChange={(e) => setDraft({ ...draft, retentionMonths: Number(e.target.value) || 24 })} />
                    months without contact
                </label>
                <label className="mt-2 flex items-center gap-2 text-[13px]"><input type="checkbox" checked={draft.deleteSubmissionsOnErase} onChange={(e) => setDraft({ ...draft, deleteSubmissionsOnErase: e.target.checked })} /> Erasing a contact also deletes their enquiries</label>
                <p className="mt-2 text-[12px] text-[#64748B]">Say this in your privacy policy (what you keep, why, and for how long). If you have legal record-keeping duties, keep client records in your practice software too — this list is not a system of record.</p>
            </Section>
            <Section title="Pipeline stages" description="Lowercase ids, comma-separated. “new” is always first.">
                <input className={input} value={draft.statuses.join(", ")} onChange={(e) => setDraft({ ...draft, statuses: e.target.value.split(",").map((x) => x.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_")).filter(Boolean) })} />
            </Section>
            <Section title="Send contacts to another system" description="A signed JSON POST on every new or changed contact (HubSpot, Pipedrive, Zapier, Make…).">
                {draft.webhooks.map((h, i) => (
                    <div key={i} className="mb-2 flex flex-wrap gap-2">
                        <input className={`${input} min-w-[260px] flex-1`} placeholder="https://hooks.example.com/…" value={h.url} onChange={(e) => setDraft({ ...draft, webhooks: draft.webhooks.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                        <input className={`${input} max-w-[180px]`} type="password" placeholder="Signing secret" value={h.secret || ""} onChange={(e) => setDraft({ ...draft, webhooks: draft.webhooks.map((x, j) => (j === i ? { ...x, secret: e.target.value } : x)) })} />
                        <button type="button" className={buttonStyles.secondary} onClick={async () => { const r = await apiRequest("contacts/webhook-test/", { method: "POST", body: { url: h.url } }).catch((e) => ({ ok: false, detail: e.message })); setMessage({ error: r.ok ? "" : r.detail, success: r.ok ? `Test sent: ${r.detail}` : "" }); }}>Send test</button>
                        <button type="button" className={buttonStyles.danger} onClick={() => setDraft({ ...draft, webhooks: draft.webhooks.filter((_, j) => j !== i) })} aria-label="Remove webhook">✕</button>
                    </div>
                ))}
                <button type="button" className={buttonStyles.link} onClick={() => setDraft({ ...draft, webhooks: [...draft.webhooks, { url: "", secret: "", events: draft.webhookEvents }] })}>+ Add webhook</button>
            </Section>
            <button type="button" className={buttonStyles.primary} onClick={save}>Save settings</button>
        </div>
    );
}

function Audit() {
    const { data } = useApi("contacts/audit/");
    return (data || []).length ? (
        <div className="divide-y divide-[#E2E8F0] rounded-xl border border-[#E2E8F0] text-[12px]">
            {data.map((a, i) => <p key={i} className="p-2"><span className="text-[#64748B]">{formatDate(a.at)}</span> · {a.user} · {a.action.replace(/_/g, " ")} {a.target}</p>)}
        </div>
    ) : <Empty>Nothing yet.</Empty>;
}
