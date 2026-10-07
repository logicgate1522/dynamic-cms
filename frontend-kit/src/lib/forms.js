import { API } from "@/lib/api";
import { track } from "@/lib/track";

/* =========================================
   Form submissions — the ONLY way the site submits a form.

     const result = await submitForm("quote", payload, { honeypotField: "website" });
     // result: { ok, status, errors, message }

   1. POST forms/<name>/submit/ — the CMS validates against the form's
      definition (home/form-<name>/), drops bots (honeypot) and stores the
      submission in the inbox (Dashboard → Form inbox). Server errors come
      back as { errors: { field: message } } — always show them.
   2. If it was stored as a real lead (honeypot empty):
      - an email goes to the address in Site tools → Settings → Form
        notifications, through FormSubmit.co (sendFormEmail below)
      - track("generate_lead", { form_name }) fires (GTM / GA4 / Meta / …).
   The email and the event never block or fail the visitor's submission.

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

export async function submitForm(formName, payload, { honeypotField = "website" } = {}) {
    let res;
    try {
        res = await fetch(`${API}/forms/${formName}/submit/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
    } catch {
        return { ok: false, status: 0, errors: {}, message: "network" };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        return { ok: false, status: res.status, errors: body.errors && typeof body.errors === "object" ? body.errors : {}, message: body.detail || "" };
    }

    const isBot = Boolean(String(payload[honeypotField] || "").trim());
    if (!isBot) {
        const { [honeypotField]: _trap, ...fields } = payload;
        sendFormEmail(formName, fields).catch(() => {});
        track("generate_lead", { form_name: formName });
    }
    return { ok: true, status: res.status, errors: {}, message: "" };
}
