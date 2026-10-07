"use client";

import { useEffect, useState } from "react";

import { Card, Notice, PageTitle } from "@/components/admin/AdminShell";
import { useApi } from "@/components/admin/useApi";
import { buttonStyles } from "@/components/cms/Drawer";
import { ObjectFields } from "@/components/cms/FieldEditor";
import { apiRequest, mergeDefaults } from "@/lib/api";
import { sendFormEmail } from "@/lib/forms";
import { SITE_NAME } from "@/lib/brand";

// Canonical SiteSettings.data shape (FRONTEND_INTEGRATION_PROMPT.md §13.6).
const TEMPLATE = {
    organization: { name: "", legalName: "", logo: "", logoAlt: "", foundingDate: "", description: "", sameAs: [""] },
    contact: { email: "", phone: "", contactType: "customer service", availableLanguages: ["English"] },
    locations: [
        {
            name: "",
            streetAddress: "",
            addressLocality: "",
            addressRegion: "",
            postalCode: "",
            addressCountry: "GB",
            telephone: "",
            priceRange: "",
            openingHours: [{ days: ["Monday"], opens: "09:00", closes: "17:30" }],
        },
    ],
    seoDefaults: {
        siteUrl: "",
        titleTemplate: `%s | ${SITE_NAME}`,
        defaultTitle: "",
        defaultDescription: "",
        defaultOgImage: "",
        defaultOgImageAlt: "",
        twitterHandle: "",
        twitterCard: "summary_large_image",
        robots: { index: true, follow: true },
        themeColor: "#071224",
        locale: "en_GB",
        searchUrl: "",
    },
    verification: { google: "", bing: "", yandex: "", pinterest: "", facebookDomain: "" },
    schema: { organizationType: "AccountingService", enabled: true },
    robotsTxt: { disallow: ["/api/"], allow: [""] },
};

const HINTS = {
    "organization.logo": { type: "image", category: "brand" },
    "organization.sameAs": { label: "Social profile URLs" },
    "organization.description": { type: "textarea" },
    "seoDefaults.siteUrl": { label: "Public site URL", help: "e.g. https://www.accountedge.co.uk — used for canonical URLs and the sitemap." },
    "seoDefaults.titleTemplate": { help: "%s is replaced by each page's title." },
    "seoDefaults.defaultDescription": { type: "textarea" },
    "seoDefaults.defaultOgImage": { label: "Default social share image (1200×630)", type: "image", category: "seo" },
    "seoDefaults.twitterCard": { type: "select", options: ["summary_large_image", "summary"] },
    "seoDefaults.robots.index": { label: "Allow search engines to index the site (turn off on staging)" },
    "seoDefaults.searchUrl": { help: "Optional. e.g. https://site/search?q={query}" },
    "schema.organizationType": { type: "select", options: ["Organization", "LocalBusiness", "AccountingService", "ProfessionalService"] },
    "locations[].openingHours[].days": { label: "Days" },
};

// Shown in their own cards at the top (not in the generic form below).
const FORMS_DEFAULTS = { notifyEmail: "", subjectPrefix: "New website enquiry" };
const ANALYTICS_DEFAULTS = {
    gtmId: "", ga4Id: "", googleAdsId: "", googleAdsLeadLabel: "", metaPixelId: "", tiktokPixelId: "",
    linkedinPartnerId: "", linkedinLeadConversionId: "", clarityId: "", hotjarId: "",
    dataLayer: [], consentDefault: "", excludeAdmins: true,
    events: { pageView: true, lead: true, contactClicks: true },
    customHead: [], customBodyStart: [], customBodyEnd: [],
};
const TRACKING_FIELDS = [
    ["gtmId", "Google Tag Manager container", "GTM-ABC1234", /^GTM-[A-Z0-9]{4,12}$/, "Recommended: manage every other tag inside GTM, using the data layer events below."],
    ["ga4Id", "Google Analytics 4 measurement ID", "G-ABC123XYZ", /^G-[A-Z0-9]{4,16}$/, "Only if you don't load GA4 through GTM."],
    ["googleAdsId", "Google Ads tag ID", "AW-123456789", /^AW-\d{6,14}$/, ""],
    ["googleAdsLeadLabel", "Google Ads lead conversion label", "AbC-D_efG-h12", /^[A-Za-z0-9_-]{4,40}$/, "Fires on every stored form submission."],
    ["metaPixelId", "Meta (Facebook) Pixel ID", "123456789012345", /^\d{10,20}$/, "Sends PageView, Lead and Contact."],
    ["tiktokPixelId", "TikTok Pixel ID", "C4ABCDEFGH1234567890", /^[A-Z0-9]{15,30}$/, ""],
    ["linkedinPartnerId", "LinkedIn Insight partner ID", "1234567", /^\d{4,12}$/, ""],
    ["linkedinLeadConversionId", "LinkedIn lead conversion ID", "12345678", /^\d{4,12}$/, ""],
    ["clarityId", "Microsoft Clarity project ID", "abcd1234ef", /^[a-z0-9]{8,16}$/, ""],
    ["hotjarId", "Hotjar site ID", "1234567", /^\d{5,12}$/, ""],
];

function clean(value) {
    if (Array.isArray(value)) {
        return value.map(clean).filter((v) => v !== "" && v !== null && !(typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => x === "" || (Array.isArray(x) && !x.length))));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    }
    return value;
}

export default function SettingsPage() {
    const { data, error: loadError, setData } = useApi("settings/site/");
    const [draft, setDraft] = useState(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    useEffect(() => {
        if (data) {
            setDraft({
                ...mergeDefaults(TEMPLATE, data),
                forms: { ...FORMS_DEFAULTS, ...(data.forms || {}) },
                analytics: { ...ANALYTICS_DEFAULTS, ...(data.analytics || {}), events: { ...ANALYTICS_DEFAULTS.events, ...(data.analytics?.events || {}) } },
            });
        }
    }, [data]);

    async function save() {
        setSaving(true);
        setError("");
        setSuccess("");
        try {
            const saved = await apiRequest("settings/site/", { method: "PATCH", body: clean(draft) });
            setData(saved);
            setSuccess("Settings saved. Metadata, analytics and structured data update across the site.");
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            <PageTitle
                title="Site settings"
                description="Form notifications, tracking, organisation details, search defaults and verification codes."
                actions={<button type="button" className={buttonStyles.primary} onClick={save} disabled={!draft || saving}>{saving ? "Saving…" : "Save settings"}</button>}
            />
            <Notice error={error || loadError} success={success} />
            {draft ? (
                <div className="mb-6 space-y-6">
                    <FormNotificationsCard value={draft.forms} onChange={(forms) => setDraft({ ...draft, forms })} />
                    <TrackingCard value={draft.analytics} onChange={(analytics) => setDraft({ ...draft, analytics })} />
                </div>
            ) : null}
            {draft ? (
                <Card>
                    <div className="space-y-5">
                        <ObjectFields value={draft} template={TEMPLATE} hints={HINTS} onChange={setDraft} />
                    </div>
                </Card>
            ) : (
                <p className="text-[13px] text-[#64748B]">Loading…</p>
            )}
        </>
    );
}

const inputClass = "w-full rounded-lg border border-[#CBD5E1] bg-white px-3 py-2 text-[13px] outline-none focus:border-[var(--cms-accent)] focus:ring-2 focus:ring-[var(--cms-accent)]/20";

function Label({ children, help }) {
    return (
        <span className="mb-1 block text-[12px] font-semibold text-[#334155]">
            {children}
            {help ? <span className="mt-0.5 block text-[11px] font-normal text-[#64748B]">{help}</span> : null}
        </span>
    );
}

// Where form submissions are emailed (FormSubmit.co). Kept at the top: a site
// whose leads reach nobody is not ready to launch.
function FormNotificationsCard({ value, onChange }) {
    const [test, setTest] = useState({ busy: false, message: "", ok: null });
    const email = value.notifyEmail.trim();
    const valid = !email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || /^[A-Za-z0-9]{16,64}$/.test(email);
    return (
        <Card data-cms-settings="forms">
            <h2 className="text-[15px] font-bold">Form notifications</h2>
            <p className="mt-1 text-[13px] text-[#475569]">
                Every enquiry is saved in the Form inbox <strong>and</strong> emailed to this address (sent by FormSubmit.co).
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block">
                    <Label help="Your inbox, e.g. enquiries@yourfirm.co.uk — or the private alias FormSubmit emails you after activation.">Send enquiries to</Label>
                    <input className={inputClass} value={value.notifyEmail} onChange={(e) => onChange({ ...value, notifyEmail: e.target.value })} placeholder="enquiries@yourfirm.co.uk" data-cms-field="forms.notifyEmail" />
                    {!valid ? <span className="mt-1 block text-[12px] text-[#B42318]">Enter an email address (or the FormSubmit alias).</span> : null}
                </label>
                <label className="block">
                    <Label help="Starts the subject of every notification email.">Email subject</Label>
                    <input className={inputClass} value={value.subjectPrefix} onChange={(e) => onChange({ ...value, subjectPrefix: e.target.value })} />
                </label>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    className={buttonStyles.secondary}
                    disabled={!email || !valid || test.busy}
                    onClick={async () => {
                        setTest({ busy: true, message: "", ok: null });
                        const result = await sendFormEmail("test", { message: "This is a test from Site settings." }, { to: email, subjectPrefix: value.subjectPrefix, test: true });
                        setTest({ busy: false, ok: result.ok, message: result.ok ? "Sent. The FIRST time, FormSubmit emails an activation link — click it, then save the alias it gives you here." : result.message });
                    }}
                >
                    {test.busy ? "Sending…" : "Send a test email"}
                </button>
                {test.message ? <span className={`text-[12px] ${test.ok ? "text-[#067647]" : "text-[#B42318]"}`}>{test.message}</span> : null}
            </div>
            <p className="mt-3 text-[12px] text-[#64748B]">Save settings after changing the address. Spam caught by the form&apos;s trap is never emailed.</p>
        </Card>
    );
}

function TrackingCard({ value, onChange }) {
    const set = (patch) => onChange({ ...value, ...patch });
    const rows = value.dataLayer || [];
    return (
        <Card data-cms-settings="tracking">
            <h2 className="text-[15px] font-bold">Tracking &amp; analytics</h2>
            <p className="mt-1 text-[13px] text-[#475569]">
                Paste only the ID — the tags are added for you. Events sent automatically: <code>page_view</code> (navigation),
                {" "}<code>generate_lead</code> (form submitted), <code>contact_click</code> (phone / email links).
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {TRACKING_FIELDS.map(([key, label, example, pattern, help]) => {
                    const v = String(value[key] || "").trim();
                    return (
                        <label key={key} className="block">
                            <Label help={help}>{label}</Label>
                            <input className={inputClass} value={value[key] || ""} placeholder={example} onChange={(e) => set({ [key]: e.target.value.trim() })} data-cms-field={`analytics.${key}`} />
                            {v && !pattern.test(v) ? <span className="mt-1 block text-[12px] text-[#B42318]">Doesn&apos;t look right — expected e.g. {example}</span> : null}
                        </label>
                    );
                })}
            </div>

            <div className="mt-6">
                <Label help="Pushed to window.dataLayer before Google Tag Manager loads — use them as Data Layer Variables in GTM.">Data layer variables</Label>
                <div className="space-y-2">
                    {rows.map((row, index) => (
                        <div key={index} className="flex gap-2">
                            <input className={inputClass} value={row.key} placeholder="site_section" onChange={(e) => set({ dataLayer: rows.map((r, i) => (i === index ? { ...r, key: e.target.value.trim() } : r)) })} />
                            <input className={inputClass} value={String(row.value ?? "")} placeholder="accounting" onChange={(e) => set({ dataLayer: rows.map((r, i) => (i === index ? { ...r, value: e.target.value } : r)) })} />
                            <button type="button" className={buttonStyles.danger} onClick={() => set({ dataLayer: rows.filter((_, i) => i !== index) })} aria-label="Remove variable">✕</button>
                        </div>
                    ))}
                    <button type="button" className={buttonStyles.secondary} onClick={() => set({ dataLayer: [...rows, { key: "", value: "" }] })}>+ Add variable</button>
                </div>
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <fieldset>
                    <Label>Automatic events</Label>
                    {[["pageView", "Page views on in-site navigation"], ["lead", "Lead when a form is submitted"], ["contactClicks", "Phone and email link clicks"]].map(([k, l]) => (
                        <label key={k} className="flex items-center gap-2 text-[13px]">
                            <input type="checkbox" checked={value.events?.[k] !== false} onChange={(e) => set({ events: { ...value.events, [k]: e.target.checked } })} />
                            {l}
                        </label>
                    ))}
                    <label className="mt-2 flex items-center gap-2 text-[13px]">
                        <input type="checkbox" checked={value.excludeAdmins !== false} onChange={(e) => set({ excludeAdmins: e.target.checked })} />
                        Don&apos;t track signed-in admins
                    </label>
                </fieldset>
                <label className="block">
                    <Label help="Google Consent Mode v2 default before a visitor chooses. Use “denied” with a cookie banner (EU/UK).">Consent default</Label>
                    <select className={inputClass} value={value.consentDefault || ""} onChange={(e) => set({ consentDefault: e.target.value })}>
                        <option value="">Not set</option>
                        <option value="denied">Denied until the visitor agrees</option>
                        <option value="granted">Granted</option>
                    </select>
                </label>
            </div>

            <details className="mt-6">
                <summary className="cursor-pointer text-[13px] font-semibold text-[#334155]">Other tags (custom code)</summary>
                {[["customHead", "In <head>"], ["customBodyStart", "Start of <body>"], ["customBodyEnd", "End of <body>"]].map(([k, l]) => (
                    <label key={k} className="mt-3 block">
                        <Label help="Paste the vendor's snippet exactly; one snippet per box.">{l}</Label>
                        <textarea rows={3} className={`${inputClass} font-mono text-[12px]`} value={(value[k] || []).join("\n\n<!-- next -->\n\n")} onChange={(e) => set({ [k]: e.target.value.split("\n\n<!-- next -->\n\n").filter((x) => x.trim()) })} />
                    </label>
                ))}
            </details>
        </Card>
    );
}
