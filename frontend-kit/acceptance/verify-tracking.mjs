#!/usr/bin/env node
/* =========================================================================
   Headless tracking checks (R31, §11) — the scheduled twin of the Tracking
   panel's "Run checks". Runs every conversion's test in a real browser,
   records the real network requests to each tool, and reports to the CMS.

     cd frontend-kit/acceptance && npm run setup          # once
     SITE_URL=https://www.example.com API_URL=https://api.example.com \
     RUNNER_SECRET=<the backend's REVALIDATE_SECRET> \
     node verify-tracking.mjs [--schedule]

   --schedule   start a new run if none is queued (cron / GitHub Action);
                without it, only runs queued from the panel ("Queue for
                runner") are executed.
   Exit code 1 when the run fails (so CI shows red); 0 when it passes or
   there was nothing to run.

   Test leads are stored as tests: no email, no contact, deleted after a
   day. Meta/TikTok/LinkedIn are stubbed in the page (nothing reaches the
   real accounts); GA4 hits carry debug_mode + traffic_type=internal.
========================================================================= */

import { chromium } from "playwright";

const SITE = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
const API = `${(process.env.API_URL || "http://localhost:8000").replace(/\/+$/, "")}/api`;
const SECRET = process.env.RUNNER_SECRET || process.env.REVALIDATE_SECRET || "";
const SCHEDULE = process.argv.includes("--schedule");
const COLLECTORS = [
    ["ga4", /google-analytics\.com\/(g\/)?collect|analytics\.google\.com\/g\/collect/],
    ["gtm", /googletagmanager\.com\/gtm\.js/],
    ["googleAds", /googleadservices\.com|google\.com\/pagead|doubleclick\.net/],
];

if (!SECRET) {
    console.error("Set RUNNER_SECRET (the backend's REVALIDATE_SECRET).");
    process.exit(2);
}

const encode = (test) => Buffer.from(JSON.stringify(test)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const pending = await fetch(`${API}/tracking/verify/pending/${SCHEDULE ? "?schedule=1&trigger=schedule" : ""}`, { headers: { "X-CMS-Runner": SECRET } });
if (!pending.ok) {
    console.error(`tracking/verify/pending/ → HTTP ${pending.status}`);
    process.exit(2);
}
const { run } = await pending.json();
if (!run) {
    console.log("Nothing to check (no queued run, or the plan isn't approved).");
    process.exit(0);
}

const settings = await (await fetch(`${API}/settings/site/`)).json().catch(() => ({}));
const a = settings.analytics || {};
const on = (k) => Boolean(String(a[k] || "").trim());
const tools = { gtm: on("gtmId"), ga4: on("ga4Id"), meta: on("metaPixelId"), tiktok: on("tiktokPixelId"), linkedin: on("linkedinPartnerId"), googleAds: on("googleAdsId") };

const browser = await chromium.launch();
const tests = run.tests.filter((t) => !t.error && t.page).map((t) => ({ ...t, run: run.id, tools, consent: "granted" }));
const consentTest = tests.find((t) => t.event !== "generate_lead" && t.action !== "engage");
if (consentTest && (tools.meta || tools.tiktok || tools.linkedin)) tests.push({ ...consentTest, conversion: `_consent:${consentTest.conversion}`, consent: "denied" });

const extra = [];
for (const test of tests) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const hits = [];
    page.on("request", (req) => {
        for (const [tool, re] of COLLECTORS) if (re.test(req.url())) hits.push({ tool, url: req.url().slice(0, 200) });
    });
    const failed = [];
    page.on("requestfailed", (req) => {
        for (const [tool, re] of COLLECTORS) if (re.test(req.url())) failed.push({ tool, error: req.failure()?.errorText });
    });
    const sep = test.page.includes("?") ? "&" : "?";
    process.stdout.write(`… ${test.label || test.conversion} `);
    try {
        await page.goto(`${SITE}${test.page}${sep}cms-verify=${encodeURIComponent(run.token)}&cms-test=${encode(test)}`, { waitUntil: "load", timeout: 45000 });
        const results = await page.waitForFunction(() => window.__cmsVerifyDone, null, { timeout: 70000 }).then((h) => h.jsonValue());
        const bad = results.filter((r) => r.status === "fail").length;
        console.log(bad ? `FAIL (${bad})` : "ok");
        // Network-level evidence the harness can't see from inside the page.
        if (test.consent === "granted" && (tools.ga4 || tools.gtm)) {
            const ga = hits.some((h) => h.tool === "ga4");
            const blocked = failed.some((f) => f.tool === "ga4" || f.tool === "gtm");
            extra.push({ conversion: test.conversion, step: "received", tool: "ga4", status: ga ? "ok" : blocked ? "blocked" : "fail",
                         detail: ga ? "GA4 collect request sent from the page" : blocked ? "GA4/GTM request blocked" : "no GA4 collect request left the page" });
        }
    } catch (err) {
        console.log("ERROR");
        extra.push({ conversion: test.conversion, step: "trigger", status: "fail", detail: `runner: ${err.message.split("\n")[0]}` });
    }
    await context.close();
}
await browser.close();

const res = await fetch(`${API}/tracking/verify/runs/${run.id}/results/`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-CMS-Verify": run.token },
    body: JSON.stringify({ results: extra, done: true }),
});
const body = await res.json().catch(() => ({}));
const summary = body.run?.summary || {};
console.log(`\nRun #${run.id}: ${body.status || res.status} — ${summary.passed ?? "?"}/${summary.conversions ?? "?"} passed`);
if (summary.failing?.length) console.log(`Failing: ${summary.failing.join(", ")}`);
if (summary.unplaced?.length) console.log(`Couldn't place: ${summary.unplaced.join(", ")}`);
if (summary.missing?.length) console.log(`Not proven: ${summary.missing.join("; ")}`);
process.exit(body.status === "passed" ? 0 : 1);
