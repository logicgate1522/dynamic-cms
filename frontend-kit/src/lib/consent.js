/* =========================================
   Consent (R32) — the ONLY place consent state lives.

   Categories: necessary (always), analytics, marketing.
   Region modes (Site tools → Tracking → plan region):
     uk_eu  opt-in: analytics + marketing denied until the visitor chooses
     us     opt-out: granted unless refused or Global Privacy Control is on
     other  follows Settings → Tracking → Consent default ("granted"/"denied")
   The choice is a first-party cookie (cms_consent, necessary) with the banner
   version: changing the banner's categories asks again.

   getConsent()            { analytics, marketing, ad_user_data, ad_personalization, decided, known }
   setConsent({analytics, marketing})   stores, updates Google Consent Mode, notifies
   onConsent(fn)           subscribe (returns unsubscribe)
   openConsentSettings()   re-opens the banner (footer "Cookie settings")
========================================= */

const COOKIE = "cms_consent";
const MAX_AGE = 60 * 60 * 24 * 180;
let state = null;
let cfg = { region: "uk_eu", fallback: "denied", version: "1", hasTags: false };
const listeners = new Set();

function readCookie() {
    if (typeof document === "undefined") return null;
    const match = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`));
    if (!match) return null;
    try {
        const value = JSON.parse(decodeURIComponent(match.slice(COOKIE.length + 1)));
        return value && typeof value === "object" ? value : null;
    } catch {
        return null;
    }
}

function writeCookie(value) {
    try {
        const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(value))}; Max-Age=${MAX_AGE}; Path=/; SameSite=Lax${secure}`;
    } catch {
        /* blocked cookies: the choice lasts for this page only */
    }
}

function gpc() {
    return typeof navigator !== "undefined" && navigator.globalPrivacyControl === true;
}

function defaults() {
    if (cfg.region === "us") return { analytics: true, marketing: !gpc() };
    if (cfg.region === "other") return cfg.fallback === "granted" ? { analytics: true, marketing: !gpc() } : { analytics: false, marketing: false };
    return { analytics: false, marketing: false };
}

function compute() {
    const saved = readCookie();
    if (saved && saved.v === cfg.version) {
        const marketing = Boolean(saved.marketing) && !(cfg.region === "us" && gpc());
        return finish({ analytics: Boolean(saved.analytics), marketing, decided: true });
    }
    return finish({ ...defaults(), decided: false });
}

function finish(s) {
    return { ...s, ad_user_data: s.marketing, ad_personalization: s.marketing, known: s.decided || cfg.region !== "uk_eu" };
}

export function configureConsent({ region, consentDefault, version, hasTags } = {}) {
    cfg = {
        region: ["uk_eu", "us", "other"].includes(region) ? region : consentDefault === "granted" ? "other" : "uk_eu",
        fallback: consentDefault === "granted" ? "granted" : "denied",
        version: String(version || "1"),
        hasTags: Boolean(hasTags),
    };
    const prev = state;
    state = compute();
    googleUpdate(state);
    // Components that read consent before this ran (e.g. tags loading
    // while tracking was still suspended) catch up now.
    if (prev && (prev.analytics !== state.analytics || prev.marketing !== state.marketing)) {
        listeners.forEach((fn) => {
            try {
                fn(state, prev);
            } catch {
                /* a listener must not break the others */
            }
        });
    }
    return state;
}

export function consentRegion() {
    return cfg.region;
}

export function getConsent() {
    if (!state) state = compute();
    return state;
}

// The banner is needed when tags are configured and the visitor hasn't
// chosen (uk_eu/other), or always reachable via "Cookie settings".
export function needsBanner() {
    const s = getConsent();
    return cfg.hasTags && !s.decided && cfg.region !== "us";
}

export function setConsent({ analytics, marketing }) {
    const prev = getConsent();
    const next = finish({ analytics: Boolean(analytics), marketing: Boolean(marketing), decided: true });
    writeCookie({ v: cfg.version, analytics: next.analytics, marketing: next.marketing, at: Date.now() });
    state = next;
    googleUpdate(next);
    if (prev.marketing && !next.marketing) revokeMarketing();
    listeners.forEach((fn) => {
        try {
            fn(next, prev);
        } catch {
            /* a listener must not break the others */
        }
    });
    return next;
}

export function onConsent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function openConsentSettings() {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("cms:consent-open"));
}

function googleUpdate(s) {
    if (typeof window === "undefined" || typeof window.gtag !== "function") return;
    const v = (on) => (on ? "granted" : "denied");
    window.gtag("consent", "update", {
        analytics_storage: v(s.analytics),
        ad_storage: v(s.marketing),
        ad_user_data: v(s.ad_user_data),
        ad_personalization: v(s.ad_personalization),
    });
}

function revokeMarketing() {
    if (typeof window === "undefined") return;
    try {
        if (typeof window.fbq === "function") window.fbq("consent", "revoke");
        if (window.ttq?.holdConsent) window.ttq.holdConsent();
        if (window.ttq?.revokeConsent) window.ttq.revokeConsent();
    } catch {
        /* vendors may not be loaded */
    }
}

// Verification runs force a consent state (granted, or denied for the
// "denied" run) without touching the visitor's cookie.
export function forceConsent(s) {
    state = finish({ analytics: Boolean(s.analytics), marketing: Boolean(s.marketing), decided: true });
    googleUpdate(state);
    listeners.forEach((fn) => fn(state, state));
}
