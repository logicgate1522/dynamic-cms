/* =========================================
   Tracking — the ONLY place the site fires analytics events.

   track(name, params) sends one event to every tool configured in Site tools
   → Settings → Tracking & analytics:
     - Google Tag Manager: window.dataLayer.push({ event: name, ...params })
       (build your GTM triggers on these event names)
     - GA4 (direct, without GTM): gtag("event", name, params)
     - Meta Pixel / TikTok / Google Ads / LinkedIn: mapped standard events
       for leads and contacts (see STANDARD below)

   Event names used by the CMS (GA4 recommended names):
     page_view        every in-site navigation (the first load is tracked by the tags)
     generate_lead    a form submission stored as a real lead ({ form_name })
     contact_click    a tel:/mailto: link click ({ method: "phone"|"email", value })

   Never call gtag/fbq/dataLayer.push directly from components —
   check-inline.mjs fails on it. Signed-in admins are not tracked when
   "Don't track signed-in admins" is on.
========================================= */

let config = { events: {}, excludeAdmins: true };

// Called once by <AnalyticsEvents> with SiteSettings.analytics.
export function configureTracking(analytics = {}) {
    config = {
        events: { pageView: true, lead: true, contactClicks: true, ...(analytics.events || {}) },
        excludeAdmins: analytics.excludeAdmins !== false,
        googleAdsId: analytics.googleAdsId || "",
        googleAdsLeadLabel: analytics.googleAdsLeadLabel || "",
        linkedinLeadConversionId: analytics.linkedinLeadConversionId || "",
    };
}

const STANDARD = {
    generate_lead: { meta: "Lead", tiktok: "SubmitForm" },
    contact_click: { meta: "Contact", tiktok: "Contact" },
};

const SWITCH = { page_view: "pageView", generate_lead: "lead", contact_click: "contactClicks" };

export function track(name, params = {}) {
    if (typeof window === "undefined") return;
    if (config.excludeAdmins && window.__cmsAdmin) return;
    if (SWITCH[name] && config.events[SWITCH[name]] === false) return;

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: name, ...params });

    // GA4 loaded directly (no GTM) listens through gtag; GTM users map the
    // dataLayer event above in their container instead.
    if (typeof window.gtag === "function" && !window.__cmsGtm) {
        window.gtag("event", name, params);
    }

    const standard = STANDARD[name];
    if (standard && typeof window.fbq === "function") window.fbq("track", standard.meta, params);
    if (standard && window.ttq?.track) window.ttq.track(standard.tiktok, params);
    if (name === "page_view") {
        if (typeof window.fbq === "function") window.fbq("track", "PageView");
        if (window.ttq?.page) window.ttq.page();
    }
    if (name === "generate_lead") {
        if (typeof window.gtag === "function" && config.googleAdsId && config.googleAdsLeadLabel) {
            window.gtag("event", "conversion", { send_to: `${config.googleAdsId}/${config.googleAdsLeadLabel}` });
        }
        if (typeof window.lintrk === "function" && config.linkedinLeadConversionId) {
            window.lintrk("track", { conversion_id: Number(config.linkedinLeadConversionId) });
        }
    }
}
