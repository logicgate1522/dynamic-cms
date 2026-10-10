/* =========================================
   Intent profile (R31/R32) — what this visit (and, with analytics consent,
   earlier visits) suggests the visitor wants. Sent with a form submission
   only (submitForm → `_cms.profile`), so the enquiry arrives with
   "Interest: Website redesign · Small business · Switching · via Google Ads".

   Storage: without analytics consent NOTHING is written to the device (UK
   PECR / ePrivacy): the profile lives in page memory only, for this visit.
   With consent: localStorage (90 days) + a random visitor id. Withdrawing
   consent deletes the stored copy and the id.

   Scores (TRACKING_IMPLEMENTATION_PLAN.md §5.2):
     page view of an intent page +1 · service_engaged +3 · CTA with intent +2
     FAQ matching intent/segment/stage +2 · intent-tagged block seen +0.5
     form option chosen +10. Earlier visits decay ×0.8.
========================================= */

const KEY = "cms_profile";
const MAX_BYTES = 8000;
const UTM = ["source", "medium", "campaign", "term", "content"];
const CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "li_fat_id", "msclkid"];
const WEIGHTS = { page_view: 1, service_engaged: 3, cta_click: 2, faq_open: 2, section_view: 0.5 };

let profile = null;
let persistent = false;

function storage(persist) {
    if (!persist) return null; // memory only without consent
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function blank() {
    return { v: 1, visits: 0, first: null, last: null, scores: { intent: {}, segment: {}, stage: {} }, path: [], signals: [], click: {} };
}

function read(persist) {
    try {
        const raw = storage(persist)?.getItem(KEY);
        const value = raw ? JSON.parse(raw) : null;
        return value && value.v === 1 ? value : null;
    } catch {
        return null;
    }
}

function save() {
    if (!profile) return;
    profile.lastAt = Date.now();
    let text = JSON.stringify(profile);
    if (text.length > MAX_BYTES) {
        profile.path = profile.path.slice(-5);
        profile.signals = profile.signals.slice(-5);
        text = JSON.stringify(profile);
    }
    try {
        storage(persistent)?.setItem(KEY, text);
    } catch {
        /* private mode / quota: keep it in memory */
    }
}

function randomId() {
    try {
        return crypto.randomUUID().replace(/-/g, "");
    } catch {
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    }
}

function source() {
    const url = new URL(window.location.href);
    const utm = Object.fromEntries(UTM.map((k) => [k, url.searchParams.get(`utm_${k}`)]).filter(([, v]) => v));
    let ref = "";
    try {
        const r = document.referrer ? new URL(document.referrer) : null;
        if (r && r.host !== window.location.host) ref = r.hostname.replace(/^www\./, "");
    } catch {
        /* no referrer */
    }
    const click = Object.fromEntries(CLICK_IDS.map((k) => [k, url.searchParams.get(k)]).filter(([, v]) => v));
    const medium = utm.medium || (click.gclid || click.msclkid ? "cpc" : click.fbclid || click.ttclid ? "paid_social" : ref ? (/google|bing|duckduckgo|yahoo|ecosia/.test(ref) ? "organic" : "referral") : "direct");
    return {
        at: new Date().toISOString(),
        source: utm.source || (click.gclid ? "google" : click.fbclid ? "facebook" : ref) || "direct",
        medium, landing: window.location.pathname, utm, click,
    };
}

/** Start (or resume) the profile for this page load. */
export function initProfile({ analytics = false } = {}) {
    if (typeof window === "undefined") return null;
    persistent = Boolean(analytics);
    const stored = persistent ? read(true) : profile;
    profile = stored || blank();
    if (!persistent) {
        try {
            window.localStorage.removeItem(KEY);
        } catch {
            /* nothing stored */
        }
        delete profile.vid;
    } else if (!profile.vid) {
        profile.vid = randomId();
    }
    // A new visit: no profile in memory yet (first page of this load) and,
    // with consent, more than 30 minutes since the last stored activity.
    const last = Number(profile.lastAt || 0);
    const newVisit = !stored || !profile.visits || Date.now() - last > 30 * 60 * 1000;
    profile.lastAt = Date.now();
    if (newVisit) {
        if (profile.visits) decay();
        profile.visits += 1;
        const src = source();
        profile.first = profile.first || src;
        profile.last = src;
        profile.click = { ...profile.click, ...src.click };
    }
    save();
    return profile;
}

function decay() {
    for (const kind of ["intent", "segment", "stage"]) {
        for (const k of Object.keys(profile.scores[kind])) profile.scores[kind][k] = Math.round(profile.scores[kind][k] * 0.8 * 100) / 100;
    }
}

/** Consent changed: move between session/local storage, or forget. */
export function setProfilePersistence(analytics) {
    if (!profile || typeof window === "undefined") return;
    if (analytics && !persistent) {
        persistent = true;
        profile.vid = profile.vid || randomId();
        save();
    } else if (!analytics && persistent) {
        const vid = profile.vid;
        forgetProfile();
        if (vid) return vid;
    }
    return null;
}

export function forgetProfile() {
    try {
        window.localStorage.removeItem(KEY);
    } catch {
        /* nothing stored */
    }
    persistent = false;
    if (profile) {
        delete profile.vid;
        save();
    }
}

function bump(kind, id, by) {
    if (!id || !profile) return;
    profile.scores[kind][id] = Math.round(((profile.scores[kind][id] || 0) + by) * 100) / 100;
}

/** Called by track() for every event (params already carry intent/stage). */
export function recordEvent(name, params = {}, matched = {}) {
    if (!profile) return;
    const w = WEIGHTS[name];
    if (name === "page_view") {
        profile.path.push({ p: params.page_path || window.location.pathname, t: 0 });
        profile.path = profile.path.slice(-15);
    }
    if (w) {
        if (params.intent && (name !== "section_view" || params.block_intent)) bump("intent", params.intent, w);
        for (const s of matched.stages || []) bump("stage", s, w);
        for (const s of matched.segments || []) bump("segment", s, w);
        for (const i of matched.intents || []) if (i !== params.intent) bump("intent", i, w);
    }
    if (name === "faq_open" && params.faq_topic) profile.signals.push(`faq:${String(params.faq_topic).slice(0, 40)}`);
    if (name === "section_view" && /pric/i.test(params.block || "")) profile.signals.push("pricing_seen");
    profile.signals = [...new Set(profile.signals)].slice(-20);
    save();
}

/** Time on the current page, for the path list. */
export function notePageTime(seconds) {
    if (!profile?.path.length) return;
    profile.path[profile.path.length - 1].t = Math.round(seconds);
    save();
}

export function recordFormOptions(formName, values, config) {
    if (!profile || !config) return;
    for (const kind of ["intents", "segments"]) {
        for (const item of config[kind] || []) {
            for (const fo of item.formOptions || []) {
                const chosen = values[fo.field];
                const list = Array.isArray(chosen) ? chosen : chosen != null ? [chosen] : [];
                if (fo.form === formName && list.map(String).includes(fo.option)) bump(kind === "intents" ? "intent" : "segment", item.id, 10);
            }
        }
    }
    save();
}

function top(kind) {
    const entries = Object.entries(profile?.scores?.[kind] || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return "";
    if (entries.length > 1 && entries[0][1] < entries[1][1] * 1.5) return "";
    return entries[0][0];
}

export function primary() {
    return { intent: top("intent"), segment: top("segment"),
             stage: Object.entries(profile?.scores?.stage || {}).filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1])[0]?.[0] || "" };
}

/** What a form submission carries (`_cms.profile`). */
export function profileSnapshot({ marketing = false } = {}) {
    if (!profile) return {};
    const snap = JSON.parse(JSON.stringify(profile));
    if (marketing && typeof document !== "undefined") {
        const cookie = (name) => document.cookie.split("; ").find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
        snap.fbp = cookie("_fbp");
        snap.fbc = cookie("_fbc");
        snap.ttp = cookie("_ttp");
    }
    const ga = typeof document !== "undefined" && document.cookie.split("; ").find((c) => c.startsWith("_ga="));
    if (ga && persistent) snap.ga_client_id = ga.split("=")[1].split(".").slice(-2).join(".");
    return snap;
}

export function visitorId() {
    return persistent ? profile?.vid || "" : "";
}
