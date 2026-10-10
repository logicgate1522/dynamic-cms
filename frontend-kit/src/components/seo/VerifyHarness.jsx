"use client";

import { useEffect } from "react";

import { API } from "@/lib/api";
import { forceConsent } from "@/lib/consent";
import { abandonNow, blockOf } from "@/lib/trackCapture";

/* =========================================
   Verification harness (R31, §11). Inert unless the page is opened with
   ?cms-verify=<signed run token>&cms-test=<test>, by the Tracking panel
   (hidden iframe) or the headless runner (acceptance/verify-tracking.mjs).

   For one conversion it:
     1. forces the consent state the test needs (granted, or denied for
        the consent check) — the visitor's own choice is never touched
     2. records every call: dataLayer, gtag, Meta/TikTok/LinkedIn (stubs:
        nothing reaches the real accounts), beacons to events/, the form
        response
     3. performs the action a visitor would (submit, click, scroll, open…)
     4. checks: trigger found and performed; each configured tool got the
        right event; browser and server event ids match; no personal data
        in any payload; nothing sent to marketing tools without consent
     5. reports to the backend (run token) and to the opener (postMessage);
        window.__cmsVerifyDone holds the results for the headless runner.
========================================= */

const TEST_EMAIL_DOMAIN = "example.org";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeTest(raw) {
    try {
        return JSON.parse(decodeURIComponent(escape(atob(raw.replace(/-/g, "+").replace(/_/g, "/")))));
    } catch {
        return null;
    }
}

function installRecorder() {
    const rec = { track: [], layer: [], gtag: [], beacons: [], forms: [] };
    window.__cmsVerify = { record: (e) => rec.track.push(e) };
    window.dataLayer = window.dataLayer || [];
    const push = window.dataLayer.push.bind(window.dataLayer);
    window.dataLayer.push = (...args) => {
        rec.layer.push(...args);
        return push(...args);
    };
    if (typeof window.gtag === "function") {
        const g = window.gtag;
        window.gtag = (...args) => {
            rec.gtag.push(args);
            return g(...args);
        };
    }
    const beacon = navigator.sendBeacon?.bind(navigator);
    if (beacon) {
        navigator.sendBeacon = (url, data) => {
            if (String(url).includes("/events/")) {
                (data instanceof Blob ? data.text() : Promise.resolve(String(data))).then((t) => {
                    try {
                        rec.beacons.push(JSON.parse(t));
                    } catch {
                        /* not JSON */
                    }
                });
            }
            return beacon(url, data);
        };
    }
    window.addEventListener("cms:form-result", (e) => {
        window.__cmsVerifyFormSeen = true;
        rec.forms.push(e.detail || {});
    });
    return rec;
}

function setValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
}

function visible(el) {
    if (el.type === "hidden" || el.closest("[aria-hidden='true']") || el.tabIndex === -1) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

async function fillForm(form, args, runId) {
    const filled = [];
    const groups = new Set();
    for (const el of form.querySelectorAll("input, select, textarea")) {
        if (!visible(el) || el.disabled) continue;
        const name = el.name || "";
        // Some pickers render as text until focused (then become date/time
        // after the framework re-renders): focus, wait a frame, then read.
        el.focus();
        await sleep(60);
        const type = (el.type || "").toLowerCase();
        if (/website|honeypot|url_hp/i.test(name)) continue;
        if (el.dataset.cmsField === "consent_marketing" || /consent_marketing/.test(el.dataset.type || "")) continue;
        if (type === "checkbox" || type === "radio") {
            if (args.field && name === args.field) {
                const label = (el.closest("label")?.textContent || "").replace(/\s+/g, " ").trim();
                const want = String(args.option);
                if ((String(el.value) === want || label === want || (el.value === "on" && label.includes(want))) && !el.checked) el.click();
                continue;
            }
            if (type === "checkbox" && name && !el.required && form.querySelectorAll(`input[name="${CSS.escape(name)}"]`).length > 1) {
                // A required checkbox group (e.g. "services") with no option asked for: tick the first.
                if (!form.querySelector(`input[name="${CSS.escape(name)}"]:checked`) && !groups.has(name)) {
                    groups.add(name);
                    el.click();
                }
                continue;
            }
            if (type === "radio" && !groups.has(name)) {
                groups.add(name);
                if (!form.querySelector(`input[name="${CSS.escape(name)}"]:checked`)) el.click();
            } else if (type === "checkbox" && el.required && !el.checked) {
                el.click();
            }
            continue;
        }
        if (el.tagName === "SELECT") {
            const options = [...el.options].filter((o) => o.value);
            const want = args.field === name ? options.find((o) => o.value === String(args.option)) : null;
            const opt = want || options[0];
            if (opt) setValue(el, opt.value);
            filled.push(name);
            continue;
        }
        const values = {
            // One address per test: the backend ignores a second enquiry from the same email within 60s.
            email: `verify+${runId}-${String(args.conversion || "x").replace(/[^a-z0-9_]/gi, "").slice(0, 30)}@${TEST_EMAIL_DOMAIN}`, tel: "07700900000", number: "1", url: "https://example.org",
            date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), time: "10:00",
            "datetime-local": `${new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)}T10:00`,
        };
        const value = values[type] ?? (el.tagName === "TEXTAREA" ? "Automatic tracking check - please ignore." : "Tracking Check");
        setValue(el, value);
        el.blur();
        filled.push(name);
    }
    return filled;
}

function norm(path) {
    try {
        const u = new URL(path, window.location.href);
        return u.origin === window.location.origin ? u.pathname.replace(/\/+$/, "") || "/" : null;
    } catch {
        return null;
    }
}

function guardNavigation() {
    // tel:/mailto:/downloads/outbound must not leave the test page.
    const stop = (e) => {
        const a = e.target?.closest?.("a[href]");
        if (a && (!norm(a.getAttribute("href")) || /^(tel:|mailto:)/.test(a.getAttribute("href")))) e.preventDefault();
    };
    window.addEventListener("click", stop);
    return () => window.removeEventListener("click", stop);
}

async function scrollToPercent(pct) {
    const main = document.querySelector("[data-track-content]") || document.querySelector("main") || document.body;
    const rect = main.getBoundingClientRect();
    const top = window.scrollY + rect.top;
    const target = top + rect.height * (pct / 100) - window.innerHeight;
    for (let y = window.scrollY; y < target; y += Math.max(200, window.innerHeight / 2)) {
        window.scrollTo(0, y);
        await sleep(120);
    }
    window.scrollTo(0, Math.max(0, target + 10));
    await sleep(400);
}

async function perform(test, runId) {
    const a = test.args || {};
    switch (test.action) {
        case "submit": {
            const form = document.querySelector(`form[data-cms-form="${CSS.escape(a.form || "")}"]`) || document.querySelector("form[data-cms-form]");
            if (!form) return `no form “${a.form}” on ${test.page}`;
            form.scrollIntoView({ block: "center" });
            await fillForm(form, { ...a, conversion: test.conversion }, runId);
            await sleep(300);
            if (form.requestSubmit) form.requestSubmit();
            else form.querySelector("[type=submit]")?.click();
            await sleep(1500);
            const invalid = [...form.querySelectorAll("[aria-invalid='true'], :invalid")].map((x) => x.name).filter(Boolean);
            if (invalid.length && !window.__cmsVerifyFormSeen) return `the form refused the test values (${[...new Set(invalid)].join(", ")}) — check its required fields`;
            return null;
        }
        case "abandon": {
            const form = document.querySelector(`form[data-cms-form="${CSS.escape(a.form || "")}"]`) || document.querySelector("form[data-cms-form]");
            const input = form?.querySelector("input:not([type=hidden]), textarea");
            if (!input) return "no form field to start";
            input.focus();
            setValue(input, "Tracking Check");
            await sleep(300);
            abandonNow();
            return null;
        }
        case "click_cta": {
            const links = [...document.querySelectorAll("a[href], [data-track-cta]")].filter((el) => norm(el.getAttribute("href") || "") === a.target || el.hasAttribute("data-track-cta"));
            const inBlock = links.filter((el) => !a.block || blockOf(el).name === a.block);
            const el = inBlock.find((x) => (x.textContent || "").trim().includes(a.label || "")) || inBlock[0] || links[0];
            if (!el) return `no link to ${a.target} found${a.block ? ` in ${a.block}` : ""}`;
            el.scrollIntoView({ block: "center" });
            await sleep(200);
            el.click();
            return null;
        }
        case "engage":
            await scrollToPercent(60);
            return null;
        case "view_block": {
            const marker = document.querySelector(`span[data-track-block="${CSS.escape(a.block || "")}"]`);
            const root = marker?.parentElement || document.querySelector(`[data-track-block="${CSS.escape(a.block || "")}"]`);
            if (!root) return `block “${a.block}” isn't on ${test.page} (hidden or removed?)`;
            root.scrollIntoView({ block: "center" });
            await sleep(2800);
            return null;
        }
        case "open_faq": {
            const want = String(a.question || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40);
            const find = () => [...document.querySelectorAll("[aria-expanded], summary")]
                .filter((c) => !c.closest("header, nav, footer") && c.getBoundingClientRect().width > 0)
                .find((c) => (c.textContent || "").toLowerCase().replace(/\s+/g, " ").includes(want));
            let el = find();
            // Tabbed FAQs: the question may sit under another category tab.
            if (!el) {
                const tabs = [...document.querySelectorAll("main button:not([aria-expanded]), main [role=tab]")]
                    .filter((b) => b.getBoundingClientRect().width > 0 && (b.textContent || "").trim().length <= 40).slice(0, 15);
                for (const tab of tabs) {
                    tab.click();
                    await sleep(400);
                    el = find();
                    if (el) break;
                }
            }
            if (!el) return `FAQ “${a.question}” not found on ${test.page}`;
            el.scrollIntoView({ block: "center" });
            if (el.getAttribute("aria-expanded") === "true") el.click();
            await sleep(100);
            el.click();
            return null;
        }
        case "scroll":
            await scrollToPercent(Math.min(100, (a.percent || 75) + 5));
            return null;
        case "click_contact": {
            const sel = a.method === "email" ? "a[href^='mailto:']" : a.method === "whatsapp" ? "a[href*='wa.me'], a[href*='whatsapp']" : "a[href^='tel:']";
            const el = document.querySelector(sel);
            if (!el) return `no ${a.method} link on ${test.page}`;
            el.click();
            return null;
        }
        case "click_download":
        case "click_outbound": {
            const el = [...document.querySelectorAll("a[href]")].find((x) => (test.action === "click_download"
                ? /\.(pdf|docx?|xlsx?|csv|zip|pptx?)(\?|#|$)/i.test(x.getAttribute("href")) || x.hasAttribute("download")
                : !norm(x.getAttribute("href")) && /^https?:/.test(x.getAttribute("href"))));
            if (!el) return `no ${test.action === "click_download" ? "download" : "outbound"} link on ${test.page}`;
            el.click();
            return null;
        }
        case "visit":
            return null;
        default:
            return `no automatic action for “${test.action}”`;
    }
}

function containsPii(obj, runId) {
    const text = JSON.stringify(obj);
    return text.includes(`verify+${runId}`) || text.includes("07700900000") || /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text.replace(/@example\.org/g, ""));
}

function evaluate(test, rec, tools, consent) {
    const cid = test.conversion;
    const out = [];
    const add = (step, tool, status, detail = "", evidence = {}) => out.push({ conversion: cid, step, tool, status, detail, evidence });
    const lead = test.event === "generate_lead";
    const form = rec.forms.at(-1);
    const fired = lead ? Boolean(form?.ok && (form.conversions || []).some((c) => c.id === cid))
        : rec.track.some((e) => e.name === test.event && e.matched.includes(cid));
    if (!fired) {
        const seen = [...new Set(rec.track.map((e) => e.name))].join(", ") || "nothing";
        add("sent", "site", "fail", lead ? (form ? (form.ok ? "the server didn't match this conversion" : `submission failed: ${form.message || form.status}`) : "no form response")
            : `the ${test.event} event didn't match this conversion (events seen: ${seen})`);
        return out;
    }
    add("sent", "site", "ok", `${test.event} → ${cid}`);
    const eventIds = rec.track.filter((e) => e.name === test.event).map((e) => e.eventId);
    const marketingOk = consent === "granted";
    if (tools.gtm) {
        const ok = rec.layer.some((x) => x && x.event === "conversion" && x.conversion_id === cid);
        add("sent", "gtm", ok ? "ok" : "fail", ok ? "dataLayer conversion event" : "no dataLayer conversion event");
    }
    if (tools.ga4 && !tools.gtm) {
        const ok = rec.gtag.some((args) => args[0] === "event" && args[1] === `cv_${cid}`.slice(0, 40));
        add("sent", "ga4", ok ? "ok" : "fail", ok ? `gtag cv_${cid}` : `no gtag cv_${cid} event`);
    }
    const vendor = window.__cmsVendorCalls || [];
    if (tools.meta) {
        const calls = vendor.filter((c) => c.tool === "meta");
        if (!marketingOk) add("sent", "meta", calls.length ? "fail" : "ok", calls.length ? "Meta was called without marketing consent" : "nothing sent without consent");
        else {
            const call = calls.find((c) => String(c.args?.[2]?.conversions || "").includes(`|${cid}|`));
            const ok = Boolean(call) && eventIds.includes(call.args?.[3]?.eventID);
            add("sent", "meta", ok ? "ok" : (call ? "warn" : "fail"), ok ? `${call.args[1]} with event id` : call ? "sent, but the event id differs from the server copy" : "no Meta event carried this conversion",
                call ? { name: call.args[1] } : {});
        }
    }
    if (tools.tiktok) {
        const calls = vendor.filter((c) => c.tool === "tiktok");
        if (!marketingOk) add("sent", "tiktok", calls.length ? "fail" : "ok", calls.length ? "TikTok was called without marketing consent" : "nothing sent without consent");
        else if (test.tier === "primary" || calls.length) add("sent", "tiktok", calls.length ? "ok" : "fail", calls.length ? calls[0].args[0] : "no TikTok event");
    }
    if (!lead) {
        const server = rec.beacons.some((b) => (b.events || []).some((e) => (e.conversions || []).includes(cid)));
        add("sent", "server", server ? "ok" : "fail", server ? "beacon to events/ (server copies, counts)" : "the conversion never reached the backend");
        const bc = rec.beacons.find((b) => (b.events || []).some((e) => (e.conversions || []).includes(cid)));
        if (bc && !marketingOk && bc.consent?.marketing) add("sent", "server", "fail", "the beacon claimed marketing consent in a denied run");
    }
    const payloads = { layer: rec.layer, gtag: rec.gtag, vendor, beacons: rec.beacons };
    add("sent", "privacy", containsPii(payloads, test.run) ? "fail" : "ok", containsPii(payloads, test.run) ? "personal data (email/phone) found in an event" : "no personal data in any event");
    return out;
}

async function runTest(token, test, tools) {
    const runId = test.run;
    const rec = installRecorder();
    forceConsent(test.consent === "denied" ? { analytics: false, marketing: false } : { analytics: true, marketing: true });
    const unguard = guardNavigation();
    await sleep(test.settle || 1500);
    let results;
    if (test.error) {
        results = [{ conversion: test.conversion, step: "trigger", status: "fail", detail: test.error }];
    } else {
        const problem = await perform(test, runId).catch((e) => `the action failed: ${e.message}`);
        if (problem) {
            results = [{ conversion: test.conversion, step: "trigger", status: /hidden or removed/.test(problem) ? "inactive" : "fail", detail: problem }];
        } else {
            const deadline = Date.now() + (test.event === "service_engaged" ? 35000 : 9000);
            while (Date.now() < deadline) {
                const done = test.event === "generate_lead" ? rec.forms.length : rec.track.some((e) => e.name === test.event && e.matched.includes(test.conversion));
                if (done) break;
                await sleep(250);
            }
            await sleep(2500); // let beacons flush
            const { flush } = await import("@/lib/track");
            flush();
            await sleep(500);
            results = [{ conversion: test.conversion, step: "trigger", status: "ok", detail: `${test.action} on ${test.page}` }, ...evaluate(test, rec, tools, test.consent || "granted")];
        }
    }
    unguard();
    window.__cmsVerifyDone = results;
    try {
        await fetch(`${API}/tracking/verify/runs/${runId}/results/`, {
            method: "POST", headers: { "Content-Type": "application/json", "X-CMS-Verify": token },
            body: JSON.stringify({ results }), credentials: "omit",
        });
    } catch {
        /* the opener still gets the postMessage */
    }
    try {
        window.parent?.postMessage({ type: "cms-verify-result", conversion: test.conversion, results }, window.location.origin);
    } catch {
        /* no opener */
    }
}

export default function VerifyHarness() {
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const token = params.get("cms-verify");
        const raw = params.get("cms-test");
        if (!token || !raw || window.__cmsVerifyStarted) return;
        const test = decodeTest(raw);
        if (!test) return;
        window.__cmsVerifyStarted = true;
        runTest(token, test, test.tools || {});
    }, []);
    return null;
}
