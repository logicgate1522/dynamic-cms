/* =========================================
   Tracking — the ONLY place the site fires analytics events (R25, R31).

   track(name, params) sends one event to every tool configured in Site tools
   → Settings → Tracking & analytics, in each tool's own vocabulary:
     - Google Tag Manager: dataLayer.push({ event: name, ...params }) and, per
       matched conversion, { event: "conversion", conversion_id, … }
     - GA4 (direct, no GTM): gtag("event", name) + gtag("event", "cv_<id>")
       per matched conversion (each can be a GA4 key event)
     - Meta / TikTok: ONE event per action (standard name where one exists),
       carrying every matched conversion id in `conversions` ("|a|b|") and the
       same event id the server copy uses (de-duplication)
     - Google Ads / LinkedIn: per matched primary conversion (ids from sync)
   Conversion-level events also go to the backend (POST events/, a beacon) for
   server-side copies, daily counts and contacts.

   The vocabulary, conversions and page → intent map come from the backend
   (GET tracking/config/), so the browser and server always agree.

   Event names (GA4 recommended names where they exist):
     page_view · cta_click · nav_click · section_view · scroll_depth ·
     service_engaged · faq_open · form_start · form_error · form_abandon ·
     generate_lead · contact_click · outbound_click · file_download · search

   Never call gtag/fbq/ttq/lintrk/dataLayer.push directly from components —
   check-inline.mjs fails on it. Signed-in admins are not tracked when
   "Don't track signed-in admins" is on. Consent (lib/consent.js) gates every
   non-Google tool and every stored identifier.
========================================= */

import { API } from "@/lib/api";
import { getConsent } from "@/lib/consent";
import { primary, recordEvent } from "@/lib/intentProfile";

let config = { events: {}, excludeAdmins: true };
let plan = { conversions: [], intents: [], segments: [], stages: [], pageTypes: {}, pageIntents: {}, formPages: [], vocab: null, currency: "USD" };
const queue = [];
let flushTimer = null;
let verifyToken = "";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
// Events with an on/off switch in Settings → Tracking → Automatic events.
const SWITCH = { page_view: "pageView", generate_lead: "lead", contact_click: "contactClicks" };
const ENGAGEMENT = new Set(["cta_click", "nav_click", "section_view", "scroll_depth", "service_engaged", "faq_open",
    "form_start", "form_error", "form_abandon", "outbound_click", "file_download", "search"]);
const FALLBACK_META = { page_view: "PageView", generate_lead: "Lead", contact_click: "Contact", service_engaged: "ViewContent",
    file_download: "Download", search: "Search" };
const FALLBACK_TIKTOK = { generate_lead: "SubmitForm", contact_click: "Contact", service_engaged: "ViewContent", cta_click: "ClickButton",
    file_download: "Download", search: "Search" };
const SERVER_EVENTS = new Set(["service_engaged", "generate_lead"]);

/** Called once by <AnalyticsEvents> with SiteSettings.analytics and GET tracking/config/. */
export function configureTracking(analytics = {}, tracking = null) {
    config = {
        events: { pageView: true, lead: true, contactClicks: true, engagement: true, ...(analytics.events || {}) },
        excludeAdmins: analytics.excludeAdmins !== false,
        googleAdsId: analytics.googleAdsId || "",
        googleAdsLeadLabel: analytics.googleAdsLeadLabel || "",
        linkedinLeadConversionId: analytics.linkedinLeadConversionId || "",
        hasGa4: Boolean(analytics.ga4Id),
    };
    if (tracking && typeof tracking === "object") plan = { ...plan, ...tracking };
}

export function trackingPlan() {
    return plan;
}

export function setVerifyToken(token) {
    verifyToken = token || "";
}

export function newEventId() {
    try {
        return crypto.randomUUID();
    } catch {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }
}

function clean(value) {
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map(clean).join(", ").slice(0, 100);
    return String(value).replace(EMAIL_RE, "[email]").replace(PHONE_RE, "[number]").replace(/\?[^\s#]*/g, "").trim().slice(0, 100);
}

function pagePath() {
    return typeof window === "undefined" ? "" : window.location.pathname.replace(/\/+$/, "") || "/";
}

/** Context every event carries: page type, intent, profile segment/stage. */
function context(params) {
    const path = params.page_path || pagePath();
    const who = primary();
    return {
        page_path: path,
        page_type: plan.pageTypes?.[path] || params.page_type || "other",
        intent: params.intent || plan.pageIntents?.[path] || who.intent || undefined,
        segment: params.segment || who.segment || undefined,
        stage: params.stage || who.stage || undefined,
        cms_v: 2,
    };
}

function matches(where = {}, p) {
    const has = (list, v) => Array.isArray(list) && list.includes(v);
    if (where.form && where.form !== p.form_name) return false;
    if (where.intent && where.intent !== p.intent) return false;
    if (where.stage && !(p.stage === where.stage || has(p.stages, where.stage))) return false;
    if (where.segment && where.segment !== p.segment) return false;
    if (where.blocks?.length && !where.blocks.includes(p.block)) return false;
    if (where.ctaTargets?.length && !where.ctaTargets.includes(p.cta_target)) return false;
    if (where.ctaLabel && !String(p.cta_label || "").toLowerCase().includes(String(where.ctaLabel).toLowerCase())) return false;
    if (where.path && where.path !== p.page_path) return false;
    if (where.pathPrefix && !String(p.page_path || "").startsWith(`${where.pathPrefix.replace(/\/+$/, "")}/`)) return false;
    if (where.pageType && where.pageType !== p.page_type) return false;
    if (where.percent && Number(where.percent) !== Number(p.percent)) return false;
    if (where.method && where.method !== p.method) return false;
    if (where.field && where.option != null) {
        const chosen = p._values?.[where.field];
        const list = Array.isArray(chosen) ? chosen.map(String) : chosen != null ? [String(chosen)] : [];
        if (!list.includes(String(where.option))) return false;
    }
    return true;
}

/** Plan conversions this event satisfies (leads come from the server). */
export function matchConversions(name, params) {
    if (name === "generate_lead") {
        const byId = Object.fromEntries((plan.conversions || []).map((c) => [c.id, c]));
        return (params._conversions || []).map((c) => ({ ...c, currency: c.currency || plan.currency,
            adsSendTo: byId[c.id]?.adsSendTo, linkedinConversionId: byId[c.id]?.linkedinConversionId }));
    }
    return (plan.conversions || []).filter((c) => c.trigger?.event === name && matches(c.trigger.where, params))
        .map((c) => ({ id: c.id, tier: c.tier, value: c.value?.mode === "fixed" ? c.value.amount : null, currency: plan.currency,
                       meta: c.meta, tiktok: c.tiktok, adsSendTo: c.adsSendTo, linkedinConversionId: c.linkedinConversionId }));
}

/**
 * track(name, params, { initial }) — initial: the first page view, which the
 * tags record themselves (only matching, profile and beacon run).
 */
export function track(name, params = {}, { initial = false } = {}) {
    if (typeof window === "undefined") return null;
    if (config.excludeAdmins && window.__cmsAdmin && !verifyToken) return null;
    if (SWITCH[name] && config.events[SWITCH[name]] === false) return null;
    if (ENGAGEMENT.has(name) && config.events.engagement === false) return null;

    const eventId = params.event_id || newEventId();
    const ctx = context(params);
    const raw = { ...params, ...Object.fromEntries(Object.entries(ctx).filter(([k]) => params[k] == null)) };
    const matched = matchConversions(name, raw);
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith("_") || v == null || v === "") continue;
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) continue;
        out[k] = clean(v);
    }
    out.event_id = eventId;
    if (verifyToken) {
        out.debug_mode = true;
        out.traffic_type = "internal";
    }
    const conversions = matched.length ? `|${matched.map((c) => c.id).join("|")}|` : "";
    if (conversions) out.conversions = conversions;
    const primaryValue = matched.filter((c) => c.tier === "primary" && c.value != null).map((c) => c.value);
    if (primaryValue.length && out.value == null) {
        out.value = Math.max(...primaryValue);
        out.currency = plan.currency;
    }

    recordEvent(name, raw, { stages: raw.stages, segments: raw.segments, intents: raw.intents });
    const consent = getConsent();

    if (!initial) {
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({ event: name, ...out });
        for (const c of matched) {
            window.dataLayer.push({ event: "conversion", conversion_id: c.id, tier: c.tier, event_id: `${eventId}:${c.id}`,
                ...(c.value != null ? { value: c.value, currency: c.currency } : {}) });
        }
        // GA4 loaded directly (no GTM) listens through gtag; GTM users map the
        // dataLayer events above in their container instead.
        if (typeof window.gtag === "function" && !window.__cmsGtm && config.hasGa4) {
            window.gtag("event", name, out);
            for (const c of matched) window.gtag("event", `cv_${c.id}`.slice(0, 40), { ...out, conversion_id: c.id });
        }
        sendAds(name, matched, out, eventId);
        if (consent.marketing || verifyToken) {
            sendMeta(name, matched, out, eventId);
            sendTikTok(name, matched, out, eventId);
            sendLinkedIn(name, matched);
        }
    } else if (matched.length) {
        // First load: the tags sent page_view; conversions still need sending.
        window.dataLayer = window.dataLayer || [];
        for (const c of matched) window.dataLayer.push({ event: "conversion", conversion_id: c.id, tier: c.tier, event_id: `${eventId}:${c.id}` });
        if (typeof window.gtag === "function" && !window.__cmsGtm && config.hasGa4) {
            for (const c of matched) window.gtag("event", `cv_${c.id}`.slice(0, 40), { ...out, conversion_id: c.id });
        }
    }

    if (name !== "generate_lead" && (SERVER_EVENTS.has(name) || matched.length || name === "cta_click" || name === "faq_open" || name === "form_abandon")) {
        enqueue({ name, event_id: eventId, params: out, conversions: matched.map((c) => c.id) });
    }
    window.__cmsVerify?.record?.({ name, params: out, matched: matched.map((c) => c.id), eventId, initial });
    return { eventId, matched };
}

function sendAds(name, matched, out, eventId) {
    if (typeof window.gtag !== "function" || verifyToken) return;
    for (const c of matched) {
        if (c.tier === "primary" && c.adsSendTo) {
            window.gtag("event", "conversion", { send_to: c.adsSendTo, transaction_id: `${eventId}:${c.id}`,
                ...(c.value != null ? { value: c.value, currency: c.currency } : {}) });
        }
    }
    if (name === "generate_lead" && config.googleAdsId && config.googleAdsLeadLabel && !matched.some((c) => c.adsSendTo)) {
        window.gtag("event", "conversion", { send_to: `${config.googleAdsId}/${config.googleAdsLeadLabel}`, transaction_id: eventId });
    }
}

function sendMeta(name, matched, out, eventId) {
    if (typeof window.fbq !== "function" || name === "page_view") return;
    const mapped = matched.find((c) => c.tier === "primary" && c.meta && c.meta !== "custom")?.meta;
    const standard = mapped || plan.vocab?.events?.[name]?.meta || FALLBACK_META[name];
    if (!standard && !matched.length) return;
    const eventName = standard || name.split("_").map((p) => p[0].toUpperCase() + p.slice(1)).join("");
    const isStandard = Boolean(standard) && !["CtaClick"].includes(standard);
    const data = { ...out };
    if (out.intent) data.content_category = out.intent;
    window.fbq(isStandard ? "track" : "trackCustom", eventName, data, { eventID: eventId });
}

function sendTikTok(name, matched, out, eventId) {
    if (!window.ttq?.track || name === "page_view") return;
    const mapped = matched.find((c) => c.tier === "primary" && c.tiktok)?.tiktok;
    const event = mapped || plan.vocab?.events?.[name]?.tiktok || FALLBACK_TIKTOK[name];
    if (!event) return;
    window.ttq.track(event, { content_category: out.intent, value: out.value, currency: out.currency, description: out.conversions }, { event_id: eventId });
}

function sendLinkedIn(name, matched) {
    if (typeof window.lintrk !== "function") return;
    const ids = matched.filter((c) => c.tier === "primary" && c.linkedinConversionId).map((c) => c.linkedinConversionId);
    if (!ids.length && name === "generate_lead" && config.linkedinLeadConversionId) ids.push(config.linkedinLeadConversionId);
    for (const id of ids) window.lintrk("track", { conversion_id: Number(id) });
}

/* ---------------------------------------------------------- beacon */

function enqueue(event) {
    queue.push(event);
    if (queue.length >= 10) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, 2000);
}

export function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!queue.length || typeof window === "undefined") return;
    const events = queue.splice(0, 20);
    const consent = getConsent();
    const body = JSON.stringify({
        events, consent: { analytics: consent.analytics, marketing: consent.marketing, ad_user_data: consent.ad_user_data },
        profile: consent.analytics ? { vid: window.__cmsVisitorId || undefined } : {}, page: pagePath(),
        ga4_loaded: Boolean(window.google_tag_data || window.google_tag_manager), verify: verifyToken || undefined,
        webdriver: navigator.webdriver && !verifyToken ? true : undefined,
    });
    const url = `${API}/events/`;
    try {
        if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: "text/plain" }))) return;
    } catch {
        /* fall through */
    }
    fetch(url, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" }, credentials: "omit" }).catch(() => {});
    if (queue.length) flush();
}

if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
}
