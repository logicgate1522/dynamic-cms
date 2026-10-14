"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Card, Notice, PageTitle } from "@/components/admin/AdminShell";
import { formatDate, rows } from "@/components/admin/useApi";
import Drawer, { buttonStyles } from "@/components/cms/Drawer";
import { humanize } from "@/components/cms/FieldEditor";
import { apiFetch, apiRequest } from "@/lib/api";

/* Form submissions: an inbox. A list of people on the left (who, what they want, where from, when) and the
   selected enquiry on the right: contact buttons first, then what they want, their message, who they are and
   how they found you. Phones open the enquiry in a panel. Works for any form: labels and field types come
   from the form's definition, and every answer is shown, nothing is dropped. */

const FILTERS = [
    { key: "inbox", label: "All", query: "is_spam=0" },
    { key: "unread", label: "Unread", query: "is_read=0&is_spam=0" },
    { key: "spam", label: "Spam", query: "is_spam=1" },
];

// Fields that get a place of their own; everything else lands in "More details".
const NAME_KEYS = ["name", "fullName", "full_name", "firstName", "first_name"];
const EMAIL_KEYS = ["email", "emailAddress"];
const PHONE_KEYS = ["phone", "mobile", "tel", "telephone", "whatsapp_number"];
const COMPANY_KEYS = ["company", "organisation", "organization", "business", "businessName"];
const SITE_KEYS = ["currentWebsite", "website_url", "websiteUrl", "site", "portfolio", "linkedin", "github"];
const MESSAGE_KEYS = ["message", "notes", "note", "comments", "details", "projects", "description"];
const GOAL_KEYS = ["goal", "service", "interest", "subject", "role", "topic", "enquiry"];
const PLAN_KEYS = ["plan", "services", "interests", "needs"];
const BUDGET_KEYS = ["budget", "salary", "timeline", "availability"];
const WHERE_KEYS = ["heardFrom", "heardFromOther", "source", "sourceService"];
const HIDDEN_KEYS = ["budgetChosen", "consent", "consent_marketing"];

const PALETTE = [
    ["#DBEAFE", "#1E3A8A"], ["#DCFCE7", "#14532D"], ["#FEF3C7", "#78350F"],
    ["#FCE7F3", "#831843"], ["#EDE9FE", "#4C1D95"], ["#CFFAFE", "#134E4A"],
];

const pick = (fields, keys) => {
    for (const key of keys) {
        const value = fields[key];
        if (value !== undefined && value !== null && String(value).trim() !== "") return { key, value };
    }
    return null;
};

const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?";
const colourFor = (name) => PALETTE[[...String(name || "?")].reduce((n, c) => n + c.charCodeAt(0), 0) % PALETTE.length];

function timeAgo(value) {
    const then = new Date(value).getTime();
    if (!then) return "";
    const minutes = Math.round((Date.now() - then) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days === 1) return "yesterday";
    if (days < 7) return `${days}d ago`;
    return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const SOURCE_NAMES = { google: "Google", bing: "Bing", facebook: "Facebook", fb: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", youtube: "YouTube", twitter: "X", x: "X", tiktok: "TikTok", direct: "Direct" };

// Where the visit came from, as one short label (what the visitor said wins over what we measured).
function sourceOf(sub) {
    const said = String((sub.data || {}).heardFrom || "").trim();
    if (said) return { label: said, said: true };
    const first = (sub.profile || {}).first || {};
    const source = String(first.source || "").toLowerCase();
    const medium = String(first.medium || "").toLowerCase();
    if (!source) return null;
    const name = SOURCE_NAMES[source] || humanize(source);
    if (/cpc|ppc|paid/.test(medium)) return { label: `${name} Ads`, said: false };
    if (source === "direct") return { label: "Direct", said: false };
    if (medium === "organic") return { label: `${name} search`, said: false };
    if (medium && medium !== "referral" && medium !== "(none)") return { label: `${name} · ${medium}`, said: false };
    return { label: name, said: false };
}

function deviceOf(ua) {
    const text = String(ua || "");
    const os = /iPhone|iPad/.test(text) ? "iOS" : /Android/.test(text) ? "Android" : /Mac OS X/.test(text) ? "macOS" : /Windows/.test(text) ? "Windows" : /Linux/.test(text) ? "Linux" : "";
    const browser = /Edg\//.test(text) ? "Edge" : /Chrome\//.test(text) ? "Chrome" : /Firefox\//.test(text) ? "Firefox" : /Safari\//.test(text) ? "Safari" : "";
    return [browser, os].filter(Boolean).join(" on ");
}

const asText = (value) => (Array.isArray(value) ? value.join(", ") : typeof value === "object" && value !== null ? JSON.stringify(value) : String(value));
const isUrl = (value) => /^https?:\/\/\S+$/i.test(String(value).trim());
const webHref = (value) => (isUrl(value) ? String(value).trim() : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(String(value).trim()) ? `https://${String(value).trim()}` : "");
const digits = (value) => String(value || "").replace(/[^\d+]/g, "");

function copy(text) {
    try {
        navigator.clipboard?.writeText(text);
    } catch {
        /* clipboard unavailable: nothing to do */
    }
}

/* ------------------------------------------------------------------ pieces */

function Avatar({ name, size = 40 }) {
    const [bg, fg] = colourFor(name);
    return (
        <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center rounded-full font-bold" style={{ width: size, height: size, background: bg, color: fg, fontSize: size * 0.36 }}>
            {initials(name)}
        </span>
    );
}

function Chip({ children, tone = "slate" }) {
    const tones = {
        slate: "bg-[#F1F5F9] text-[#334155]",
        blue: "bg-[#DBEAFE] text-[#1E3A8A]",
        green: "bg-[#DCFCE7] text-[#14532D]",
        amber: "bg-[#FEF3C7] text-[#78350F]",
        red: "bg-[#FEE2E2] text-[#7F1D1D]",
    };
    return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>{children}</span>;
}

function Section({ title, children }) {
    return (
        <section className="rounded-xl border border-[#E2E8F0] bg-white p-4">
            <h3 className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-[#475569]">{title}</h3>
            {children}
        </section>
    );
}

function Fact({ label, children }) {
    return (
        <div className="min-w-0">
            <dt className="text-[11px] font-semibold text-[#475569]">{label}</dt>
            <dd className="mt-0.5 break-words text-[13px] text-[#0F172A]">{children}</dd>
        </div>
    );
}

function ActionLink({ href, label, tone, onCopy, copyLabel }) {
    const tones = {
        green: "bg-[#15803D] text-white hover:brightness-110",
        blue: "bg-[var(--cms-accent)] text-white hover:brightness-110",
        slate: "border border-[#CBD5E1] bg-white text-[#334155] hover:bg-[#F1F5F9]",
    };
    return (
        <span className="inline-flex overflow-hidden rounded-lg shadow-sm">
            <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" className={`px-3.5 py-2 text-[13px] font-semibold ${tones[tone]}`}>{label}</a>
            {onCopy ? (
                <button type="button" onClick={onCopy} title={copyLabel} aria-label={copyLabel} className="border-l border-black/10 bg-white px-2.5 text-[12px] font-semibold text-[#475569] hover:bg-[#F1F5F9]">Copy</button>
            ) : null}
        </span>
    );
}

/* ------------------------------------------------------------------ the enquiry */

function Enquiry({ sub, spec, onToggle }) {
    const fields = sub.data || {};
    const profile = sub.profile || {};
    const [copied, setCopied] = useState("");
    const used = new Set(HIDDEN_KEYS);
    const take = (keys) => {
        const hit = pick(fields, keys);
        if (hit) keys.forEach((k) => used.add(k));
        return hit?.value ?? null;
    };
    const name = take(NAME_KEYS);
    const email = take(EMAIL_KEYS);
    const phone = take(PHONE_KEYS);
    const company = take(COMPANY_KEYS);
    const site = take(SITE_KEYS);
    const goal = take(GOAL_KEYS);
    const plan = take(PLAN_KEYS);
    const budget = take(BUDGET_KEYS);
    const message = take(MESSAGE_KEYS);
    const country = fields.country;
    const timeZone = fields.timeZone;
    ["country", "timeZone", "whatsapp"].forEach((k) => used.add(k));
    const heard = fields.heardFrom ? [fields.heardFrom, fields.heardFromOther].filter(Boolean).join(" · ") : "";
    WHERE_KEYS.forEach((k) => used.add(k));
    const whatsappOk = String(fields.whatsapp || "").toLowerCase() === "yes" && phone;
    const source = sourceOf(sub);
    const first = profile.first || {};
    const pages = (profile.path || []).map((p) => p.p).filter(Boolean);
    const campaign = (first.utm || {}).campaign;
    const device = deviceOf(sub.user_agent);
    const place = [sub.city, sub.region, sub.country].filter(Boolean).join(", ");
    const planItems = plan ? String(Array.isArray(plan) ? plan.join(", ") : plan).split(/\s*,\s*/).filter(Boolean) : [];
    const rest = Object.entries(fields).filter(([key, value]) => !used.has(key) && String(value ?? "").trim() !== "");
    const label = (key) => spec[key]?.label || humanize(key || "");

    const doCopy = (text, id) => {
        copy(text);
        setCopied(id);
        setTimeout(() => setCopied(""), 1500);
    };
    const asPlainText = () => [
        `${name || "Enquiry"} · ${formatDate(sub.created_at)}`,
        ...Object.entries(fields).map(([k, v]) => `${label(k)}: ${asText(v)}`),
        source ? `Found us via: ${source.label}` : "",
    ].filter(Boolean).join("\n");

    return (
        <div className="space-y-3" data-cms-enquiry={sub.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                    <Avatar name={name || email} size={52} />
                    <div className="min-w-0">
                        <h2 className="truncate text-[18px] font-bold text-[#0F172A]">{name || email || `Enquiry #${sub.id}`}</h2>
                        <p className="text-[12px] text-[#475569]">
                            {[company, country].filter(Boolean).join(" · ")}{company || country ? " · " : ""}{formatDate(sub.created_at)} ({timeAgo(sub.created_at)})
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                    {sub.is_test ? <Chip tone="amber">Test</Chip> : null}
                    {sub.is_spam ? <Chip tone="red">Spam</Chip> : !sub.is_read ? <Chip tone="blue">New</Chip> : <Chip>Read</Chip>}
                </div>
            </div>

            <div className="flex flex-wrap gap-2">
                {whatsappOk ? <ActionLink href={`https://wa.me/${digits(phone).replace(/^\+/, "")}`} label="WhatsApp" tone="green" /> : null}
                {phone ? <ActionLink href={`tel:${digits(phone)}`} label={`Call ${phone}`} tone={whatsappOk ? "slate" : "blue"} onCopy={() => doCopy(String(phone), "phone")} copyLabel="Copy phone number" /> : null}
                {email ? <ActionLink href={`mailto:${email}`} label="Email" tone="slate" onCopy={() => doCopy(String(email), "email")} copyLabel="Copy email address" /> : null}
                {copied ? <span className="self-center text-[12px] font-semibold text-[#15803D]" aria-live="polite">Copied</span> : null}
            </div>

            {goal || planItems.length || budget ? (
                <Section title="What they want">
                    {goal ? <p className="text-[15px] font-semibold text-[#0F172A]">{asText(goal)}</p> : null}
                    {planItems.length ? <div className="mt-2 flex flex-wrap gap-1.5">{planItems.map((item) => <Chip key={item} tone="blue">{item}</Chip>)}</div> : null}
                    {budget ? <p className="mt-2 text-[13px] text-[#334155]"><span className="font-semibold">{label(pick(fields, BUDGET_KEYS)?.key)}:</span> {asText(budget)}</p> : null}
                </Section>
            ) : null}

            {message ? (
                <Section title={label(pick(fields, MESSAGE_KEYS)?.key)}>
                    <p className="whitespace-pre-wrap border-l-4 border-[#CBD5E1] pl-3 text-[14px] leading-6 text-[#0F172A]">{asText(message)}</p>
                </Section>
            ) : null}

            {company || site || country || timeZone ? (
                <Section title="About them">
                    <dl className="grid gap-3 sm:grid-cols-2">
                        {company ? <Fact label="Company">{asText(company)}</Fact> : null}
                        {site ? (
                            <Fact label="Current website">
                                {webHref(site) ? <a href={webHref(site)} target="_blank" rel="noopener noreferrer" className="font-semibold text-[var(--cms-accent)] hover:underline">{asText(site)}</a> : asText(site)}
                            </Fact>
                        ) : null}
                        {country ? <Fact label="Country">{asText(country)}</Fact> : null}
                        {timeZone ? <Fact label="Time zone">{asText(timeZone)}</Fact> : null}
                    </dl>
                </Section>
            ) : null}

            <Section title="How they found you">
                <div className="flex flex-wrap items-center gap-2">
                    {heard ? <Chip tone="green">They said: {heard}</Chip> : <span className="text-[12px] text-[#475569]">They didn&apos;t say.</span>}
                    {source && !source.said ? <Chip>Measured: {source.label}</Chip> : null}
                </div>
                <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                    {first.landing ? <Fact label="First page">{first.landing}</Fact> : null}
                    {profile.visits ? <Fact label="Visits">{profile.visits}</Fact> : null}
                    {campaign ? <Fact label="Campaign">{campaign}</Fact> : null}
                    {pages.length ? <Fact label="Pages viewed">{[...new Set(pages)].slice(0, 6).join("  ›  ")}</Fact> : null}
                    {place ? <Fact label="Location">{place}</Fact> : null}
                    {device ? <Fact label="Device">{device}</Fact> : null}
                </dl>
            </Section>

            {rest.length ? (
                <Section title="More details">
                    <dl className="grid gap-3 sm:grid-cols-2">
                        {rest.map(([key, value]) => (
                            <div key={key} className={String(asText(value)).length > 60 ? "sm:col-span-2" : ""}>
                                <Fact label={label(key)}>
                                    {isUrl(value) ? <a href={String(value)} target="_blank" rel="noopener noreferrer" className="font-semibold text-[var(--cms-accent)] hover:underline">{String(value)}</a> : <span className="whitespace-pre-wrap">{asText(value)}</span>}
                                </Fact>
                            </div>
                        ))}
                    </dl>
                </Section>
            ) : null}

            <div className="flex flex-wrap items-center gap-3 pt-1">
                <button type="button" className={buttonStyles.link} onClick={() => onToggle(sub, "is_read")}>{sub.is_read ? "Mark unread" : "Mark read"}</button>
                <button type="button" className={buttonStyles.link} onClick={() => onToggle(sub, "is_spam")}>{sub.is_spam ? "Not spam" : "Mark as spam"}</button>
                <button type="button" className={buttonStyles.link} onClick={() => doCopy(asPlainText(), "all")}>Copy all as text</button>
                <span className="ml-auto text-[11px] text-[#475569]">#{sub.id}</span>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------ the list row */

function Row({ sub, active, onOpen }) {
    const fields = sub.data || {};
    const name = pick(fields, NAME_KEYS)?.value || pick(fields, EMAIL_KEYS)?.value || `Enquiry #${sub.id}`;
    const company = pick(fields, COMPANY_KEYS)?.value;
    const what = pick(fields, GOAL_KEYS)?.value || pick(fields, PLAN_KEYS)?.value || pick(fields, MESSAGE_KEYS)?.value || pick(fields, EMAIL_KEYS)?.value || "";
    const source = sourceOf(sub);
    return (
        <li>
            <button
                type="button"
                onClick={onOpen}
                aria-current={active ? "true" : undefined}
                className={`flex w-full items-center gap-3 border-b border-[#F1F5F9] px-3.5 py-3 text-left transition ${active ? "bg-[#EFF6FF]" : "bg-white hover:bg-[#F8FAFC]"}`}
            >
                <span className="relative">
                    <Avatar name={name} />
                    {!sub.is_read && !sub.is_spam ? <span title="Unread" className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-white bg-[var(--cms-accent)]" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                        <span className={`truncate text-[14px] ${sub.is_read ? "font-medium text-[#334155]" : "font-bold text-[#0F172A]"}`}>{asText(name)}</span>
                        <span className="shrink-0 text-[11px] text-[#475569]">{timeAgo(sub.created_at)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-[#475569]">{[company, asText(what)].filter(Boolean).join(" · ")}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                        {sub.is_test ? <Chip tone="amber">Test</Chip> : null}
                        {source ? <Chip tone={source.said ? "green" : "slate"}>{source.label}</Chip> : null}
                    </span>
                </span>
            </button>
        </li>
    );
}

/* ------------------------------------------------------------------ the page */

export default function SubmissionsPage() {
    const [forms, setForms] = useState(null);
    const [form, setForm] = useState("");
    const [filter, setFilter] = useState("inbox");
    const [page, setPage] = useState(1);
    const [data, setData] = useState(null);
    const [spec, setSpec] = useState({});
    const [error, setError] = useState("");
    const [openId, setOpenId] = useState(null);
    const [search, setSearch] = useState("");
    const [country, setCountry] = useState("");
    const [wide, setWide] = useState(true);

    useEffect(() => {
        const query = window.matchMedia("(min-width: 1024px)");
        const apply = () => setWide(query.matches);
        apply();
        query.addEventListener("change", apply);
        return () => query.removeEventListener("change", apply);
    }, []);

    const loadForms = useCallback(async () => {
        try {
            const list = await apiRequest("forms/");
            setForms(list);
            setForm((current) => current || (list.find((f) => f.unread > 0) || list[0] || {}).name || "quote");
        } catch (err) {
            setForms([]);
            setForm((current) => current || "quote");
            setError(err.message);
        }
    }, []);

    useEffect(() => {
        loadForms();
    }, [loadForms]);

    const query = FILTERS.find((f) => f.key === filter).query;

    const load = useCallback(async () => {
        if (!form) return;
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

    // Field labels and types from the form's definition (public).
    useEffect(() => {
        if (!form) return;
        apiRequest(`home/form-${form}/`)
            .then((definition) => setSpec(Object.fromEntries((definition?.fields || []).filter((f) => f?.name).map((f) => [f.name, f]))))
            .catch(() => setSpec({}));
    }, [form]);

    // Where the leads come from: the country they chose with their phone code (no extra question asked).
    const countryOf = (sub) => String(sub.data?.country || sub.country || "").trim();
    const countries = useMemo(() => {
        const counts = new Map();
        for (const sub of rows(data)) {
            const c = countryOf(sub);
            if (c) counts.set(c, (counts.get(c) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }, [data]);

    const list = useMemo(() => {
        const all = rows(data).filter((sub) => !country || countryOf(sub) === country);
        const needle = search.trim().toLowerCase();
        if (!needle) return all;
        return all.filter((sub) => JSON.stringify(sub.data || {}).toLowerCase().includes(needle));
    }, [data, search, country]);

    const selected = list.find((sub) => sub.id === openId) || (wide ? list[0] : null);

    async function toggle(sub, field) {
        try {
            await apiRequest(`forms/${form}/submissions/${sub.id}/`, { method: "PATCH", body: { [field]: !sub[field] } });
            await Promise.all([load(), loadForms()]);
        } catch (err) {
            setError(err.message);
        }
    }

    function open(sub) {
        setOpenId(sub.id);
        if (!sub.is_read) toggle(sub, "is_read");
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

    const total = data?.count ?? list.length;
    const current = (forms || []).find((f) => f.name === form);

    return (
        <>
            <PageTitle
                title="Form submissions"
                description="Enquiries from the site's forms, newest first. Unread ones have a blue dot. Set a notification email on the server to also get them by email."
                actions={<button type="button" className={buttonStyles.secondary} onClick={exportCsv} disabled={!form}>Export CSV</button>}
            />
            <Notice error={error} />

            {forms && forms.length > 1 ? (
                <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Forms">
                    {forms.map((f) => (
                        <button
                            key={f.name}
                            type="button"
                            role="tab"
                            aria-selected={f.name === form}
                            onClick={() => { setForm(f.name); setPage(1); setOpenId(null); }}
                            className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] font-semibold ${f.name === form ? "border-[var(--cms-primary)] bg-[var(--cms-primary)] text-white" : "border-[#D6DEE8] bg-white text-[#334155] hover:bg-[#F8FAFC]"}`}
                        >
                            {f.label}
                            <span className={`rounded-full px-1.5 text-[11px] ${f.name === form ? "bg-white/20" : "bg-[#F1F5F9]"}`}>{f.total}</span>
                            {f.unread ? <span title={`${f.unread} unread`} className="h-2 w-2 rounded-full bg-[var(--cms-accent)]" /> : null}
                        </button>
                    ))}
                </div>
            ) : null}

            <div className="mb-3 flex flex-wrap items-center gap-3">
                <div className="flex gap-1 rounded-lg bg-[#E2E8F0] p-1" role="group" aria-label="Show">
                    {FILTERS.map((f) => (
                        <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => { setFilter(f.key); setPage(1); setOpenId(null); }} className={`rounded-md px-3 py-1 text-[12px] font-semibold ${filter === f.key ? "bg-white text-[#0F172A] shadow-sm" : "text-[#475569]"}`}>
                            {f.label}{f.key === "unread" && current?.unread ? ` (${current.unread})` : ""}
                        </button>
                    ))}
                </div>
                <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search name, email, company…"
                    aria-label="Search these enquiries"
                    className="h-9 min-w-[200px] flex-1 rounded-lg border border-[#D6DEE8] bg-white px-3 text-[13px] sm:max-w-xs"
                />
                <span className="text-[12px] text-[#475569]">{total} {total === 1 ? "enquiry" : "enquiries"}</span>
            </div>

            {countries.length > 1 ? (
                <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by country" data-cms-country-filter>
                    <span className="mr-1 text-[12px] font-semibold text-[#475569]">Country</span>
                    <button type="button" aria-pressed={!country} onClick={() => { setCountry(""); setOpenId(null); }} className={`rounded-full border px-3 py-1 text-[12px] font-semibold ${!country ? "border-[#0F172A] bg-[#0F172A] text-white" : "border-[#D6DEE8] bg-white text-[#334155]"}`}>All</button>
                    {countries.map(([name, count]) => (
                        <button key={name} type="button" aria-pressed={country === name} onClick={() => { setCountry(country === name ? "" : name); setOpenId(null); }} className={`rounded-full border px-3 py-1 text-[12px] font-semibold ${country === name ? "border-[#0F172A] bg-[#0F172A] text-white" : "border-[#D6DEE8] bg-white text-[#334155]"}`}>{name} · {count}</button>
                    ))}
                </div>
            ) : null}

            {data === null ? <p className="text-[13px] text-[#475569]">Loading…</p> : null}
            {data && rows(data).length === 0 ? (
                <Card><p className="text-[13px] text-[#475569]">{filter === "unread" ? "Nothing unread. You're all caught up." : filter === "spam" ? "No spam." : "No enquiries yet. They appear here as soon as someone submits the form."}</p></Card>
            ) : null}

            {data && rows(data).length ? (
                <div className="lg:grid lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] lg:items-start lg:gap-4">
                    <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white lg:sticky lg:top-4 lg:max-h-[calc(100vh-8rem)] lg:overflow-y-auto">
                        <ul>
                            {list.map((sub) => <Row key={sub.id} sub={sub} active={selected?.id === sub.id} onOpen={() => open(sub)} />)}
                        </ul>
                        {list.length === 0 ? <p className="px-4 py-6 text-[13px] text-[#475569]">No enquiry here matches “{search}”.</p> : null}
                        {data.next || data.previous ? (
                            <div className="flex justify-between border-t border-[#F1F5F9] p-2">
                                <button type="button" className={buttonStyles.secondary} disabled={!data.previous} onClick={() => setPage((p) => p - 1)}>← Newer</button>
                                <button type="button" className={buttonStyles.secondary} disabled={!data.next} onClick={() => setPage((p) => p + 1)}>Older →</button>
                            </div>
                        ) : null}
                    </div>

                    {wide && selected ? <div className="min-w-0"><Enquiry sub={selected} spec={spec} onToggle={toggle} /></div> : null}
                </div>
            ) : null}

            {!wide && selected && openId ? (
                <Drawer open title="Enquiry" onClose={() => setOpenId(null)} width={560}>
                    <Enquiry sub={selected} spec={spec} onToggle={toggle} />
                </Drawer>
            ) : null}
        </>
    );
}
