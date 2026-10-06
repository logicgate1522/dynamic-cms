"use client";

import { useEffect, useState } from "react";

import { Card, Notice, PageTitle } from "@/components/admin/AdminShell";
import { useApi } from "@/components/admin/useApi";
import { buttonStyles } from "@/components/cms/Drawer";
import { ObjectFields } from "@/components/cms/FieldEditor";
import { apiRequest, mergeDefaults } from "@/lib/api";
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
    analytics: {
        gtmId: "",
        ga4Id: "",
        metaPixelId: "",
        clarityId: "",
        hotjarId: "",
        linkedinPartnerId: "",
        customHead: [""],
        customBodyStart: [""],
        customBodyEnd: [""],
    },
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
    "analytics.customHead": { label: "Custom <head> code", help: "Raw HTML snippets, injected verbatim." },
    "analytics.customHead[]": { type: "textarea" },
    "analytics.customBodyStart[]": { type: "textarea" },
    "analytics.customBodyEnd[]": { type: "textarea" },
    "schema.organizationType": { type: "select", options: ["Organization", "LocalBusiness", "AccountingService", "ProfessionalService"] },
    "locations[].openingHours[].days": { label: "Days" },
};

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
        if (data) setDraft(mergeDefaults(TEMPLATE, data));
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
                description="Organisation details, search defaults, verification codes and analytics. These feed every page's metadata and structured data."
                actions={<button type="button" className={buttonStyles.primary} onClick={save} disabled={!draft || saving}>{saving ? "Saving…" : "Save settings"}</button>}
            />
            <Notice error={error || loadError} success={success} />
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
