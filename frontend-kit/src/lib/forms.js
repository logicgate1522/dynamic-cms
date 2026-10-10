import { API } from "@/lib/api";
import { getConsent } from "@/lib/consent";
import { profileSnapshot, recordFormOptions } from "@/lib/intentProfile";
import { newEventId, track, trackingPlan } from "@/lib/track";

/* =========================================
   Form submissions — the ONLY way the site submits a form.

     const result = await submitForm("quote", payload, { honeypotField: "website" });
     // result: { ok, status, errors, message }

   1. POST forms/<name>/submit/ — the CMS validates against the form's
      definition (home/form-<name>/), drops bots (honeypot) and stores the
      submission in the inbox (Dashboard → Form inbox). Server errors come
      back as { errors: { field: message } } — always show them.
      The request also carries `_cms` (R31): an event id, the consent state
      and the visitor's intent profile; the backend matches the plan's
      conversions and answers with them plus a one-line summary.
   2. If it was stored as a real lead (honeypot empty, not a duplicate):
      - an email goes to the address in Site tools → Settings → Form
        notifications, through FormSubmit.co (sendFormEmail below), with the
        summary ("Interest: Website redesign · Small business · via Google Ads")
      - track("generate_lead") fires with the server's conversions and the
        same event id as the server-side copies (de-duplication)
      - window "cms:form-result" tells the capture layer it was sent
   The email and the event never block or fail the visitor's submission.
   Verification runs (?cms-verify) are stored as tests: no email, no contact.
   Give every <form> data-cms-form="<name>" so starts/abandons are tracked.

   Never fetch the forms submit endpoint or formsubmit.co from a component —
   check-inline.mjs fails on it.
========================================= */

const FORMSUBMIT = "https://formsubmit.co/ajax/";
let settingsPromise = null;

function formSettings() {
    settingsPromise ||= fetch(`${API}/settings/site/`, { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : {}))
        .then((data) => data.forms || {})
        .catch(() => ({}));
    return settingsPromise;
}

function readable(key) {
    return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Sends one submission as an email via FormSubmit.co. `to` defaults to the
// Settings address. Returns { ok, message } — used by the Settings test button.
export async function sendFormEmail(formName, fields, { to, subjectPrefix, test = false } = {}) {
    const settings = await formSettings();
    const recipient = (to ?? settings.notifyEmail ?? "").trim();
    if (!recipient) return { ok: false, message: "No notification email is set (Site tools → Settings → Form notifications)." };
    const prefix = subjectPrefix ?? settings.subjectPrefix ?? "New website enquiry";
    const body = {
        _subject: `${test ? "[Test] " : ""}${prefix} — ${readable(formName)}`,
        _template: "table",
        _captcha: "false",
        ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [readable(k), Array.isArray(v) ? v.join(", ") : String(v ?? "")])),
        Page: typeof window !== "undefined" ? window.location.href : "",
    };
    try {
        const res = await fetch(`${FORMSUBMIT}${encodeURIComponent(recipient)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(body),
            keepalive: true,
        });
        const data = await res.json().catch(() => ({}));
        const ok = res.ok && String(data.success) !== "false";
        return { ok, message: data.message || (ok ? "Sent." : `FormSubmit returned ${res.status}.`) };
    } catch (err) {
        return { ok: false, message: err.message };
    }
}

function verifyToken() {
    try {
        return window.sessionStorage.getItem("cms_verify") || "";
    } catch {
        return "";
    }
}

function result(detail) {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("cms:form-result", { detail }));
    return detail;
}

export async function submitForm(formName, payload, { honeypotField = "website" } = {}) {
    const consent = getConsent();
    const eventId = newEventId();
    const verify = typeof window !== "undefined" ? verifyToken() : "";
    const envelope = {
        event_id: eventId,
        consent: { analytics: consent.analytics, marketing: consent.marketing, ad_user_data: consent.ad_user_data, ad_personalization: consent.ad_personalization },
        profile: profileSnapshot({ marketing: consent.marketing }),
        page: typeof window !== "undefined" ? window.location.pathname : "",
        ga4_loaded: typeof window !== "undefined" && Boolean(window.google_tag_data || window.google_tag_manager),
        ...(verify ? { verify } : {}),
    };
    let res;
    try {
        res = await fetch(`${API}/forms/${formName}/submit/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, _cms: envelope }),
        });
    } catch {
        track("form_error", { form_name: formName, field: "network" });
        return result({ form: formName, ok: false, status: 0, errors: {}, message: "network" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const errors = body.errors && typeof body.errors === "object" ? body.errors : {};
        for (const field of Object.keys(errors).slice(0, 5)) track("form_error", { form_name: formName, field });
        return result({ form: formName, ok: false, status: res.status, errors, message: body.detail || "" });
    }

    const isBot = Boolean(String(payload[honeypotField] || "").trim());
    if (!isBot && !body.duplicate) {
        const { [honeypotField]: _trap, ...fields } = payload;
        if (!verify) sendFormEmail(formName, body.summary ? { ...fields, interest: body.summary } : fields).catch(() => {});
        recordFormOptions(formName, fields, trackingPlan());
        track("generate_lead", {
            form_name: formName, event_id: body.event_id || eventId, intent: body.intent || undefined, segment: body.segment || undefined,
            _conversions: Array.isArray(body.conversions) ? body.conversions : [],
        });
    }
    return result({ form: formName, ok: true, status: res.status, errors: {}, message: "", duplicate: Boolean(body.duplicate),
                    conversions: body.conversions || [], summary: body.summary || "" });
}
