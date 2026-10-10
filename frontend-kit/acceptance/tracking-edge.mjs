#!/usr/bin/env node
/* =========================================================================
   Tracking, consent and contacts — edge-to-edge browser checks (R31–R33).
   Complements acceptance.mjs (which proves the main paths). Run against the
   production build with the backend running and an APPROVED tracking plan:

     SITE_URL=http://localhost:3000 API_URL=http://localhost:8000 \
     CMS_USER=… CMS_PASSWORD=… [FORM_PAGE=/contact] node tracking-edge.mjs

   Covers: SPA/back-forward page views; section/scroll/engaged-time events
   firing once; header/footer nav, outbound, download and contact clicks
   (no phone number in events); FAQ open-not-close; form start/abandon;
   admins and the engagement switch; no personal data anywhere; consent in
   every region (opt-in, opt-out, Global Privacy Control, "Choose" per
   category, banner version bump, Consent Mode updates, phone layout,
   accessibility); the visitor profile (memory-only vs stored, UTM/click ids
   reaching the enquiry summary); every Tracking panel tab (plan editor,
   lock/delete, "Pick on page", AI paste, tools, GTM download, checks
   history) and Contacts screens (filters, detail, status, notes, export,
   erase, groups, settings, audit); admin screens on a phone.
   Settings, the plan and contacts settings are restored at the end; test
   traffic carries a verification token so it never counts as real.
========================================================================= */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { chromium } from "playwright";

const SITE = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
const API = `${(process.env.API_URL || "http://localhost:8000").replace(/\/+$/, "")}/api`;
const { CMS_USER, CMS_PASSWORD } = process.env;
const FORM_PAGE = process.env.FORM_PAGE || "/contact";
const STAMP = `edge${Date.now().toString(36)}`;
// EDGE_ONLY=A,D runs only those sections (A capture, B consent, C profile, D panel, E contacts, F phone).
const ONLY = (process.env.EDGE_ONLY || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
const want = (section) => !ONLY.length || ONLY.includes(section);
if (!CMS_USER || !CMS_PASSWORD) {
    console.error("Set CMS_USER and CMS_PASSWORD (a staff account).");
    process.exit(2);
}
let AXE = null;
try {
    AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
} catch {
    /* reported below */
}

const results = [];
const check = (name, pass, detail = "") => {
    results.push(Boolean(pass));
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${String(detail).slice(0, 200)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, { tries = 25, every = 400 } = {}) {
    for (let i = 0; i < tries; i++) {
        const v = await fn().catch(() => null);
        if (v) return v;
        await sleep(every);
    }
    return null;
}

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await adminCtx.newPage();
page.on("dialog", (d) => d.accept());
const pageErrors = [];
const admin = (path, init = {}) => page.evaluate(async ([url, init]) => {
    const res = await fetch(url, { credentials: "include", ...init });
    return { status: res.status, body: await res.json().catch(() => null) };
}, [`${API}/${path}`, init]);
async function adminWrite(path, method, body) {
    const csrf = (await admin("auth/csrf/")).body?.csrfToken;
    return admin(path, { method, headers: { "Content-Type": "application/json", "X-CSRFToken": csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function login() {
    await page.goto(`${SITE}/admin/login?next=/admin`);
    await page.fill("#email", CMS_USER);
    await page.fill("#password", CMS_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname === "/admin", { timeout: 20000 });
}
const layerEvents = (p, name) => p.evaluate((n) => (window.dataLayer || []).filter((e) => e && e.event === n), name);
async function waitForPage(p, needle) {
    // Settings changes reach cached pages through the revalidation webhook.
    return poll(async () => (await (await fetch(`${SITE}/`)).text()).includes(needle), { tries: 40, every: 750 });
}

let originalSettings = null;
let originalPlan = null;
let originalContacts = null;
let token = "";

/** A visitor context; `test` marks it as verification traffic (never counted as real). */
async function visitorContext({ test = true, gpc = false, cookies = [], viewport = { width: 1280, height: 900 } } = {}) {
    const ctx = await browser.newContext({ viewport });
    if (test && token) await ctx.addInitScript((t) => { try { sessionStorage.setItem("cms_verify", t); } catch {} }, token);
    if (gpc) await ctx.addInitScript(() => Object.defineProperty(navigator, "globalPrivacyControl", { get: () => true }));
    if (cookies.length) await ctx.addCookies(cookies);
    return ctx;
}

try {
    await login();
    originalSettings = (await admin("settings/site/")).body || {};
    originalPlan = (await admin("tracking/plan/")).body?.plan || null;
    originalContacts = (await admin("contacts/settings/")).body || null;
    const facts = (await admin("tracking/facts/")).body || {};
    const config = await (await fetch(`${API}/tracking/config/`)).json();
    if (originalPlan?.status !== "approved") throw new Error("approve the tracking plan first (Site tools → Tracking)");
    token = (await adminWrite("tracking/verify/runs/", "POST", { mode: "in_browser", trigger: "acceptance" })).body?.token || "";
    check("setup: an acceptance run token for test traffic", !!token);
    const pages = facts.pages || [];
    // The site's enquiry form: the one on FORM_PAGE (else the first with an email field).
    const leadForms = (facts.forms || []).filter((f) => (f.fields || []).some((x) => x.type === "email" || x.name === "email"));
    const leadForm = leadForms.find((f) => (f.pages || []).includes(FORM_PAGE)) || leadForms[0] || null;
    const formName = leadForm?.name || "contact";
    /** A valid submission for the site's own form definition (any fields). */
    const formPayload = (email) => {
        const body = {};
        for (const f of leadForm?.fields || []) {
            const opts = (f.options || []).map((o) => o.value);
            const value = {
                email, tel: "07700 900777", number: 1, url: "https://example.org", consent_marketing: false,
                date: new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10), time: "10:00", datetime: `${new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10)}T10:00`,
                select: opts[0], radio: opts[0], checkboxes: opts.slice(0, 1), multiselect: opts.slice(0, 1), checkbox: true,
            }[f.type];
            if (f.type === "hidden" || f.type === "file") continue;
            body[f.name] = value !== undefined ? value : f.name === "name" ? "Edge Contact" : `Edge ${STAMP}`;
        }
        if (!body.email) body.email = email;
        return body;
    };
    const servicePage = Object.keys(config.pageIntents || {})[0];
    const article = pages.find((p) => p.type === "article")?.path;
    const faqPage = pages.find((p) => p.type === "faq")?.path;

    /* ================================================== A. capture */
    if (want("A")) {
        const ctx = await visitorContext();
        const v = await ctx.newPage();
        v.on("pageerror", (e) => pageErrors.push(e.message));
        await v.goto(`${SITE}/`);
        await v.waitForLoadState("networkidle").catch(() => {});

        // A1. In-site navigation: one page_view per navigation, none on a hash change.
        const target = await v.evaluate(() => [...document.querySelectorAll("main a[href^='/']")].map((a) => a.getAttribute("href")).find((h) => h !== "/" && !h.includes("#")));
        if (target) {
            await v.locator(`main a[href="${target}"]`).first().click();
            await v.waitForURL((u) => u.pathname === target.split("?")[0], { timeout: 15000 }).catch(() => {});
            await sleep(800);
            const views = await layerEvents(v, "page_view");
            check("capture: in-site navigation fires exactly one page_view", views.length === 1, `${views.length} for ${target}`);
            await v.evaluate(() => { location.hash = "section-x"; });
            await sleep(600);
            check("capture: a hash change is not a page view", (await layerEvents(v, "page_view")).length === 1);
            await v.goBack(); // drops the hash: same page
            await sleep(500);
            check("capture: going back over a hash change isn't a page view", (await layerEvents(v, "page_view")).length === 1);
            await v.goBack(); // the previous page
            await sleep(1200);
            check("capture: going back to the previous page fires a page view", (await layerEvents(v, "page_view")).length === 2);
        }

        // A2. A section seen fires once, even when seen again.
        await v.goto(`${SITE}/`);
        // A block below the fold that is actually displayed (sites may render a
        // second, hidden copy of a block for phones).
        const pickBlock = () => v.evaluate(() => {
            const roots = [...document.querySelectorAll("span[data-track-block]")].map((m) => m.parentElement)
                .filter((r) => r && r.getClientRects().length && r.getBoundingClientRect().height > 0 && r.getBoundingClientRect().top > window.innerHeight * 1.2);
            if (!roots[0]) return null;
            roots[0].setAttribute("data-edge-target", "1");
            return roots[0].querySelector(":scope > span[data-track-block]").dataset.trackBlock;
        });
        const block = await pickBlock();
        if (block) {
            const scrollTo = async () => {
                if (!(await v.locator("[data-edge-target]").count())) await pickBlock();
                await v.evaluate(() => document.querySelector("[data-edge-target]").scrollIntoView({ block: "center", behavior: "instant" }));
            };
            await scrollTo();
            await sleep(2600);
            await v.evaluate(() => window.scrollTo(0, 0));
            await sleep(500);
            await scrollTo();
            await sleep(2600);
            const seen = (await layerEvents(v, "section_view")).filter((e) => e.block === block);
            check("capture: a section seen twice fires section_view once per page view", seen.length === 1, `${seen.length} × ${block}`);
            // Seen for less than 2 seconds: nothing.
            await v.goto(`${SITE}/`);
            await scrollTo();
            await sleep(900);
            await v.evaluate(() => window.scrollTo(0, 0));
            await sleep(1800);
            check("capture: a section glimpsed for under 2s fires nothing", !(await layerEvents(v, "section_view")).some((e) => e.block === block));
        }

        // A3. Scroll depth on an article: each threshold once.
        if (article) {
            await v.goto(`${SITE}${article}`);
            for (const pct of [30, 55, 80, 95, 40, 96]) {
                await v.evaluate((p) => {
                    const main = document.querySelector("[data-track-content]") || document.querySelector("main") || document.body;
                    const r = main.getBoundingClientRect();
                    window.scrollTo(0, window.scrollY + r.top + r.height * (p / 100) - window.innerHeight);
                }, pct);
                await sleep(350);
            }
            const depths = (await layerEvents(v, "scroll_depth")).map((e) => e.percent);
            check("capture: scroll depth fires 25/50/75/90 once each", JSON.stringify(depths) === "[25,50,75,90]", JSON.stringify(depths));
        }

        // A4. Engaged reading by time alone (30s visible, no scrolling).
        if (servicePage) {
            await v.goto(`${SITE}${servicePage}`);
            const intent = config.pageIntents[servicePage];
            for (let i = 0; i < 16; i++) {
                await v.mouse.move(100 + i, 100); // activity keeps the clock running
                await sleep(2000);
            }
            const engaged = (await layerEvents(v, "service_engaged")).filter((e) => e.intent === intent);
            check("capture: 30s on an offering's page fires service_engaged once, with its intent", engaged.length === 1, `${engaged.length} × ${intent}`);
        }

        // A5. Header and footer navigation.
        await v.goto(`${SITE}/`);
        const headerLink = v.locator("header a[href^='/']:visible").filter({ hasNotText: /^$/ }).nth(1);
        if (await headerLink.count()) {
            await headerLink.click();
            await sleep(700);
            check("capture: a header link fires nav_click (header)", (await layerEvents(v, "nav_click")).some((e) => e.nav_area === "header"));
        }
        await v.goto(`${SITE}/`);
        const footerLink = v.locator("footer a[href^='/']:visible").first();
        if (await footerLink.count()) {
            await footerLink.click();
            await sleep(700);
            check("capture: a footer link fires nav_click (footer)", (await layerEvents(v, "nav_click")).some((e) => e.nav_area === "footer"));
        }

        // A6. Outbound, download and contact links (added to the page for the test,
        // after hydration so the framework doesn't replace them).
        await v.goto(`${SITE}/`);
        await v.waitForLoadState("networkidle").catch(() => {});
        await sleep(800);
        await v.evaluate(() => {
            const host = document.querySelector("main") || document.body;
            for (const [id, href, text] of [["x-out", "https://example.com/page", "Partner"], ["x-dl", "/files/guide.pdf", "Guide"],
                                            ["x-tel", "tel:+447700900999", "Call"], ["x-mail", "mailto:someone@example.org", "Email"]]) {
                const a = Object.assign(document.createElement("a"), { id, href, textContent: text });
                host.prepend(a);
            }
            window.addEventListener("click", (e) => e.target.closest("#x-out, #x-dl, #x-tel, #x-mail") && e.preventDefault());
        });
        for (const id of ["x-out", "x-dl", "x-tel", "x-mail"]) await v.evaluate((i) => document.getElementById(i).click(), id);
        await sleep(400);
        check("capture: an outbound link fires outbound_click with its domain", (await layerEvents(v, "outbound_click")).some((e) => e.link_domain === "example.com"));
        check("capture: a PDF link fires file_download", (await layerEvents(v, "file_download")).some((e) => e.file_ext === "pdf"));
        const contacts = await layerEvents(v, "contact_click");
        check("capture: phone and email links fire contact_click by method", ["phone", "email"].every((m) => contacts.some((e) => e.method === m)));
        check("capture: the number and address never reach the event", !JSON.stringify(contacts).match(/7700900999|someone@/));

        // A7. FAQ: opening fires, closing doesn't.
        if (faqPage) {
            await v.goto(`${SITE}${faqPage}`);
            const toggle = v.locator("main [aria-expanded='false']:visible").first();
            if (await toggle.count()) {
                await toggle.click();
                await sleep(300);
                await v.locator("main [aria-expanded='true']:visible").first().click();
                await sleep(300);
                const opens = await layerEvents(v, "faq_open");
                check("capture: a FAQ fires faq_open on open only", opens.length === 1, `${opens.length}`);
                check("capture: faq_open names its block and topic or text", !!(opens[0]?.faq_id));
            }
        }

        // A8. Form started then left: form_abandon with the last field, no values.
        await v.goto(`${SITE}${FORM_PAGE}`);
        const form = v.locator("form[data-cms-form]:visible").first();
        const email = form.locator("input[type=email]").first();
        if (await email.count()) {
            await email.fill(`secret.${STAMP}@example.org`);
            const leave = await v.evaluate(() => [...document.querySelectorAll("header a[href^='/']")].map((a) => a.getAttribute("href")).find((h) => h !== location.pathname));
            await v.locator(`header a[href="${leave}"]`).first().click().catch(() => {});
            await sleep(1000);
            const ab = await layerEvents(v, "form_abandon");
            check("capture: leaving a started form fires form_abandon with the last field", ab.length === 1 && !!ab[0].last_field, JSON.stringify(ab[0] || {}));
            check("capture: no personal data in any event", !JSON.stringify(await v.evaluate(() => window.dataLayer)).includes(`secret.${STAMP}`));
        }
        await ctx.close();
    }

    // A9. Signed-in admins are not tracked.
    if (want("A")) {
        await page.goto(`${SITE}/`);
        await sleep(1500);
        const cta = page.locator("main a[href]").first();
        await cta.click({ trial: false }).catch(() => {});
        await sleep(600);
        const tracked = await page.evaluate(() => (window.dataLayer || []).filter((e) => e && /^(cta_click|nav_click|section_view)$/.test(e.event)).length);
        check("capture: signed-in admins are not tracked", tracked === 0, `${tracked} events`);
    }

    // A10. The engagement switch turns automatic engagement events off.
    if (want("A")) {
        await adminWrite("settings/site/", "PATCH", { analytics: { events: { pageView: true, lead: true, contactClicks: true, engagement: false } } });
        await waitForPage(page, '"engagement":false');
        const ctx = await visitorContext();
        const v = await ctx.newPage();
        await v.goto(`${SITE}${faqPage || "/"}`);
        await v.locator("main [aria-expanded='false']:visible").first().click().catch(() => {});
        await sleep(600);
        check("capture: Settings → engagement events off stops them", (await layerEvents(v, "faq_open")).length === 0);
        await ctx.close();
        await adminWrite("settings/site/", "PATCH", { analytics: { events: { ...(originalSettings.analytics?.events || {}), engagement: true } } });
    }

    /* ================================================== B. consent */
    if (want("B")) {
    await adminWrite("settings/site/", "PATCH", { analytics: { metaPixelId: "1234567890123456", clarityId: "abcd1234ef", ga4Id: "G-EDGE12345" } });
    await waitForPage(page, "abcd1234ef");
    const blocked = (ctx, list) => ctx.route(/connect\.facebook\.net|clarity\.ms|googletagmanager\.com\/gtag|google-analytics\.com/, (route) => {
        list.push(route.request().url());
        return route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
    });
    {
        // B1. "Choose": analytics only → Clarity loads, Meta doesn't.
        const ctx = await visitorContext({ test: false });
        const req = [];
        await blocked(ctx, req);
        const v = await ctx.newPage();
        await v.goto(`${SITE}/`);
        await v.locator("[data-cms-consent-banner]").waitFor({ timeout: 8000 }).catch(() => {});
        await v.locator("[data-cms-consent='choose']").click();
        const boxes = v.locator("[data-cms-consent-banner] input[type=checkbox]:not([disabled])");
        await boxes.nth(0).check();
        await v.locator("[data-cms-consent='save']").click();
        await sleep(1500);
        check("consent: “Choose” analytics only loads Clarity", req.some((u) => u.includes("clarity.ms")));
        check("consent: … and not Meta", !req.some((u) => u.includes("facebook")));
        const updates = await v.evaluate(() => (window.dataLayer || []).filter((a) => a && a[0] === "consent").map((a) => [a[1], a[2]?.analytics_storage, a[2]?.ad_storage]));
        check("consent: Consent Mode default is denied, then updated to the choice",
            updates[0]?.[0] === "default" && updates[0]?.[1] === "denied" && updates.some((u) => u[0] === "update" && u[1] === "granted" && u[2] === "denied"), JSON.stringify(updates));
        // B2. Memory-only without analytics consent was replaced by storage now.
        check("consent: with analytics consent the profile is stored", await v.evaluate(() => !!localStorage.getItem("cms_profile")));
        const visits1 = await v.evaluate(() => JSON.parse(localStorage.getItem("cms_profile")).visits);
        check("consent: a stored profile counts visits", visits1 >= 1);
        await ctx.close();
    }
    {
        const ctx = await visitorContext({ test: false });
        const v = await ctx.newPage();
        await v.goto(`${SITE}/`);
        await v.locator("[data-cms-consent-banner]").waitFor({ timeout: 8000 }).catch(() => {});
        await v.locator("[data-cms-consent='accept']").click();
        await sleep(500);
        await v.reload();
        await sleep(2000);
        check("consent: the choice is remembered on the next page load", (await v.locator("[data-cms-consent-banner]").count()) === 0);
        // B4. Changing the banner version asks again.
        await adminWrite("settings/site/", "PATCH", { analytics: { consentVersion: "2" } });
        await waitForPage(page, '"version":"2"').catch(() => {});
        await poll(async () => {
            await v.reload();
            return v.locator("[data-cms-consent-banner]").first().waitFor({ timeout: 3000 }).then(() => true).catch(() => false);
        }, { tries: 15, every: 1000 });
        check("consent: a new banner version asks returning visitors again", (await v.locator("[data-cms-consent-banner]").count()) === 1);
        await adminWrite("settings/site/", "PATCH", { analytics: { consentVersion: originalSettings.analytics?.consentVersion || "1" } });
        // B5. Without consent the profile lives in memory only.
        await v.locator("[data-cms-consent='reject']").click();
        await v.reload();
        await sleep(1200);
        check("consent: after “Reject all” nothing is stored but the choice", await v.evaluate(() => !localStorage.getItem("cms_profile") && !sessionStorage.getItem("cms_profile")));
        await ctx.close();
    }
    {
        // B6. Phone layout and accessibility of the banner.
        const ctx = await visitorContext({ test: false, viewport: { width: 390, height: 844 } });
        const v = await ctx.newPage();
        await v.goto(`${SITE}/`);
        const banner = v.locator("[data-cms-consent-banner]");
        await banner.waitFor({ timeout: 8000 }).catch(() => {});
        const box = await banner.boundingBox();
        check("consent: the banner takes at most ~42% of a phone screen", !!box && box.height <= 844 * 0.43, box ? `${Math.round(box.height)}px` : "no banner");
        const sizes = await v.locator("[data-cms-consent-banner] button").evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().height));
        check("consent: banner buttons are at least 44px tall", sizes.length >= 3 && sizes.every((h) => h >= 43.5), JSON.stringify(sizes));
        check("consent: no sideways scrolling with the banner open", await v.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
        if (AXE) {
            await v.addScriptTag({ content: AXE });
            const bad = await v.evaluate(async () => (await window.axe.run("[data-cms-consent-banner]", { runOnly: ["wcag2a", "wcag2aa"] })).violations.map((x) => `${x.id}(${x.impact})`));
            check("consent: the banner passes WCAG A/AA checks", bad.length === 0, bad.join(", "));
        } else check("consent: axe-core installed (npm run setup)", false);
        await ctx.close();
    }
    {
        // B7. Opt-out region: no banner, tags load; Global Privacy Control blocks marketing.
        const plan = (await admin("tracking/plan/")).body.plan;
        await adminWrite("tracking/plan/", "PUT", { plan: { ...plan, region: "us" } });
        await adminWrite("tracking/plan/approve/", "POST");
        await poll(async () => (await (await fetch(`${API}/tracking/config/`)).json()).region === "us", { tries: 20, every: 500 });
        await waitForPage(page, '"region":"us"');
        for (const gpc of [false, true]) {
            const ctx = await visitorContext({ test: false, gpc });
            const req = [];
            await blocked(ctx, req);
            const v = await ctx.newPage();
            await v.goto(`${SITE}/`);
            await sleep(3000);
            if (!gpc) {
                check("consent (us): no banner by default", (await v.locator("[data-cms-consent-banner]").count()) === 0);
                check("consent (us): marketing tags load without a banner", req.some((u) => u.includes("facebook")));
            } else {
                check("consent (us): Global Privacy Control keeps marketing tags off", !req.some((u) => u.includes("facebook")));
                check("consent (us): … while analytics still loads", req.some((u) => u.includes("clarity.ms")));
            }
            check(`consent (us): “Cookie settings” is still offered${gpc ? " (GPC)" : ""}`, (await v.locator("[data-cms-consent-open]").count()) > 0);
            await ctx.close();
        }
        await adminWrite("tracking/plan/", "PUT", { plan: originalPlan });
        await adminWrite("tracking/plan/approve/", "POST");
    }
    await adminWrite("settings/site/", "PATCH", { analytics: { metaPixelId: originalSettings.analytics?.metaPixelId || "", clarityId: originalSettings.analytics?.clarityId || "", ga4Id: originalSettings.analytics?.ga4Id || "" } });
    }

    /* ================================================== C. profile → enquiry */
    if (want("C")) {
        const ctx = await visitorContext();
        const v = await ctx.newPage();
        // Without consent the profile lives in page memory, so the visit moves
        // between pages the way people do: by clicking links (no full reload).
        await v.goto(`${SITE}/?utm_source=google&utm_medium=cpc&utm_campaign=${STAMP}&gclid=G-${STAMP}`);
        await v.waitForLoadState("networkidle").catch(() => {});
        if (servicePage) {
            await v.locator(`a[href="${servicePage}"]`).first().click({ force: true });
            await v.waitForURL((u) => u.pathname === servicePage, { timeout: 15000 }).catch(() => {});
            await v.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6));
            await sleep(800);
        }
        let response = null;
        v.on("response", async (r) => {
            if (r.request().method() === "POST" && /\/forms\/[^/]+\/submit\//.test(r.url())) response = await r.json().catch(() => null);
        });
        await v.locator(`a[href="${FORM_PAGE}"]`).first().click({ force: true });
        await v.waitForURL((u) => u.pathname === FORM_PAGE, { timeout: 15000 }).catch(() => {});
        await sleep(1000);
        const form = v.locator("form[data-cms-form]:visible").first();
        for (const el of await form.locator("input:visible, textarea:visible, select:visible").all()) {
            await el.focus().catch(() => {});
            const type = (await el.getAttribute("type")) || (await el.evaluate((n) => n.tagName.toLowerCase()));
            const name = (await el.getAttribute("name")) || "";
            if (["hidden", "submit", "file"].includes(type) || (await el.evaluate((n) => n.tabIndex < 0))) continue;
            if (await el.evaluate((n) => n.dataset.cmsField === "consent_marketing")) continue;
            if (type === "checkbox" || type === "radio") {
                if (!(await form.locator(`input[name="${name}"]:checked`).count())) await el.check().catch(() => {});
            } else if (type === "select") await el.selectOption({ index: 1 }).catch(() => {});
            else if (type === "email") await el.fill(`profile+${STAMP}@example.org`);
            else if (type === "tel") await el.fill("07700 900555");
            else if (type === "date") await el.fill("2030-01-01");
            else await el.fill(`Edge ${STAMP}`);
        }
        await form.locator("button[type=submit]").first().click();
        await poll(async () => response, { tries: 30, every: 300 });
        check("profile: the enquiry carries the visit's source", (response?.summary || "").includes("via google / cpc"), response?.summary);
        const subs = (await admin(`forms/${formName}/submissions/?is_read=0`)).body;
        const sub = (subs?.results || subs || []).find((s) => JSON.stringify(s.data).includes(`profile+${STAMP}`));
        check("profile: the stored enquiry has the click id and first source", sub?.profile?.click?.gclid === `G-${STAMP}` && sub?.profile?.first?.utm?.campaign === STAMP);
        check("profile: verification traffic is stored as a test (no email, no contact)", sub?.is_test === true);
        if (sub) await adminWrite(`forms/${formName}/submissions/${sub.id}/`, "DELETE");
        await ctx.close();
    }

    /* ================================================== D. tracking panel */
    if (want("D")) {
        await page.goto(`${SITE}/admin/tracking`);
        await page.locator("[data-cms-tracking-panel]").waitFor();
        const tab = (name) => page.getByRole("button", { name, exact: true }).click();
        // D1. Plan editor: add, edit, lock, delete; save draft; approve.
        await tab("Plan");
        const before = (await admin("tracking/plan/")).body.plan.conversions.length;
        await page.getByRole("button", { name: "+ Add conversion" }).click();
        const newRow = page.locator("[data-cms-conversion^='new_conversion']").last();
        await newRow.locator("input").first().fill(`Edge ${STAMP}`);
        await newRow.locator("select").nth(1).selectOption("page_view");
        await newRow.locator("select").nth(2).selectOption({ index: 1 });
        await newRow.getByText("Lock (AI and rebuilds never change it)").click();
        await page.getByRole("button", { name: "Save draft" }).click();
        const saved = await poll(async () => (await admin("tracking/plan/")).body.plan.conversions.find((c) => c.label === `Edge ${STAMP}`));
        check("panel: a new conversion saves as a draft", !!saved && (await admin("tracking/plan/")).body.plan.status === "draft");
        check("panel: the lock is kept", saved?.locked === true);
        await page.reload();
        await tab("Plan");
        await page.locator(`[data-cms-conversion="${saved?.id}"] button[aria-label^="Remove"]`).click();
        await page.getByRole("button", { name: "Save draft" }).click();
        await sleep(1200);
        const afterDelete = (await admin("tracking/plan/")).body.plan.conversions;
        check("panel: removing the locked conversion in the editor still keeps it (locked)", afterDelete.some((c) => c.id === saved?.id));
        await adminWrite("tracking/plan/?unlock=1", "PUT", { plan: originalPlan });
        check("panel: unlock + save restores the plan", (await admin("tracking/plan/")).body.plan.conversions.length === before);
        // D2. Approve with a dangling trigger is refused with the reason.
        const dangling = { ...originalPlan, conversions: [...originalPlan.conversions, { id: "edge_ghost", label: "Ghost", tier: "secondary", trigger: { event: "page_view", where: { path: "/ghost-page" } } }] };
        await adminWrite("tracking/plan/", "PUT", { plan: dangling });
        await page.reload();
        await page.locator("[data-cms-action='approve-plan']").click();
        check("panel: approving with a broken trigger is refused and says why", !!(await poll(async () => /ghost-page/.test(await page.locator("body").innerText()))));
        await adminWrite("tracking/plan/?unlock=1", "PUT", { plan: originalPlan });
        await adminWrite("tracking/plan/approve/", "POST");
        // D3. Ask AI: prompt, paste, proposal, use.
        await page.reload();
        await tab("Ask AI");
        const prompt = await poll(async () => page.locator("textarea[readonly]").first().inputValue());
        check("panel: the AI prompt loads and ends with its final check", !!prompt && prompt.includes("FINAL CHECK"));
        const reply = { ...Object.fromEntries(["intents", "segments", "stages", "audiences"].map((k) => [k, originalPlan[k]])),
            conversions: [...originalPlan.conversions, { id: "ai_edge", label: "AI edge", tier: "secondary", trigger: { event: "page_view", where: { path: "/ghost" } } }] };
        await page.locator("textarea:not([readonly])").first().fill("```json\n" + JSON.stringify(reply) + "\n```");
        await page.getByRole("button", { name: "Review changes" }).click();
        const proposal = page.locator("[data-cms-tracking-proposal]");
        await proposal.waitFor({ timeout: 15000 }).catch(() => {});
        check("panel: an AI reply becomes a reviewable proposal", (await proposal.count()) === 1);
        check("panel: things that aren't on the site are left out and listed", /Left out[^]*ai_edge/.test(await proposal.innerText().catch(() => "")));
        await proposal.getByRole("button", { name: "Discard" }).click();
        // D4. Tools: connect errors are shown plainly; GTM container downloads.
        await tab("Tools");
        const meta = page.locator("[data-cms-connection='meta']");
        await meta.getByRole("button", { name: /Connect|Update/ }).click();
        await meta.locator("input").nth(0).fill("1234567890123456");
        await meta.locator("input[type=password]").fill("not-a-real-token");
        await meta.getByRole("button", { name: /Check & save/ }).click();
        const err = await poll(async () => {
            const t = await page.locator("body").innerText();
            return /meta said|TRACKING_SECRET_KEY|network|Invalid|OAuth/i.test(t) ? t.match(/(meta said[^\n]*|[^\n]*TRACKING_SECRET_KEY[^\n]*|[^\n]*OAuth[^\n]*)/i)?.[0] : null;
        }, { tries: 40, every: 500 });
        check("panel: a bad Meta token is refused with the tool's message", !!err, err);
        check("panel: nothing is saved for a refused connection", !((await admin("tracking/connections/")).body?.connections || {}).meta);
        const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }).catch(() => null),
                                              page.getByRole("button", { name: /Download container/ }).click()]);
        let gtm = null;
        try {
            gtm = download ? JSON.parse(readFileSync(await download.path(), "utf8")) : null;
        } catch {
            gtm = null;
        }
        check("panel: the GTM container downloads as valid JSON", gtm?.exportFormatVersion === 2);
        // D5. Checks history renders.
        await tab("Checks");
        check("panel: the checks tab lists previous runs", !!(await poll(async () => /History/.test(await page.locator("body").innerText()))));
        // D6. Pick on page (from Site tools on a live page).
        await page.goto(`${SITE}/`);
        await page.locator("[data-cms-adminbar]").waitFor({ timeout: 15000 });
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("cms:open-tracking", { detail: { tab: "plan" } })));
        const drawerPlan = page.locator("[role=dialog] [data-cms-tracking-panel]");
        await drawerPlan.waitFor({ timeout: 10000 }).catch(() => {});
        const pickBtn = page.getByRole("button", { name: "Pick on page" });
        await pickBtn.waitFor({ timeout: 15000 }).catch(() => {}); // the plan loads after the drawer opens
        if (await pickBtn.count()) {
            await pickBtn.click();
            await page.locator("[data-cms-pick-banner]").waitFor({ timeout: 5000 });
            const ctaHref = (facts.ctaPages || [])[0];
            const pickTarget = ctaHref ? page.locator(`main a[href="${ctaHref}"]:visible`).first() : page.locator("main a:visible").first();
            await pickTarget.click();
            const rows = page.locator("[role=dialog] [data-cms-conversion]");
            await poll(async () => (await rows.count()) > (originalPlan.conversions || []).length);
            const last = (await rows.last().innerText().catch(() => "")).replace(/\s+/g, " ");
            console.log(`      picked: ${last.slice(0, 160)}`);
            const picked = /Clicked “/.test(last) && /going to \//.test(last);
            if (!picked && process.env.EDGE_SHOTS) await page.screenshot({ path: `${process.env.EDGE_SHOTS}/pick-fail.png`, fullPage: false });
            check("panel: “Pick on page” turns a clicked button into a conversion draft", !!picked,
                picked ? "" : `url ${page.url()} · drawer ${await page.locator("[role=dialog]").count()} · ${(await page.locator("[role=dialog]").innerText().catch(() => "")).slice(0, 160)}`);
            await page.keyboard.press("Escape");
        } else check("panel: “Pick on page” is offered in Site tools", false);
    }

    /* ================================================== E. contacts */
    if (want("E")) {
        // A real (non-test) enquiry to work with.
        const leadEmail = `contact+${STAMP}@example.org`;
        const res = await page.evaluate(async ([api, form, body]) => (await fetch(`${api}/forms/${form}/submit/`, {
            method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", body: JSON.stringify(body),
        })).status, [API, formName, formPayload(leadEmail)]);
        check("contacts: a real enquiry is accepted", res === 201, res);
        await page.goto(`${SITE}/admin/contacts`);
        const panel = page.locator("[data-cms-contacts-panel]");
        await panel.waitFor();
        await panel.getByPlaceholder("Search name, email, phone").fill(leadEmail);
        const row = page.locator("[data-cms-contact]").first();
        check("contacts: search finds the new contact", !!(await poll(async () => (await row.count()) && /Edge Contact/.test(await row.innerText()))));
        await row.click();
        await page.getByRole("combobox", { name: "Status" }).selectOption("contacted");
        await page.getByPlaceholder("Add a note").fill(`Called ${STAMP}`);
        await page.getByRole("button", { name: "Add", exact: true }).click();
        const detail = await poll(async () => {
            const list = (await admin(`contacts/?q=${encodeURIComponent(leadEmail)}`)).body?.results || [];
            if (!list[0]) return null;
            const d = (await admin(`contacts/${list[0].id}/`)).body;
            return d.status === "contacted" && d.notes.some((n) => n.text.includes(STAMP)) ? d : null;
        });
        check("contacts: status and notes save", !!detail);
        const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }).catch(() => null), page.getByRole("button", { name: "Export data" }).click()]);
        check("contacts: “Export data” downloads everything held", !!dl && JSON.parse(readFileSync(await dl.path(), "utf8")).email === leadEmail);
        // Groups: create, see its size, delete.
        await page.getByRole("button", { name: /All contacts/ }).click();
        await page.getByRole("button", { name: "Groups", exact: true }).click();
        await page.getByRole("button", { name: "+ New group" }).click();
        await page.getByPlaceholder("Group name").fill(`Edge ${STAMP}`);
        const groupForm = page.locator("div.border-2").filter({ has: page.getByPlaceholder("Group name") });
        await groupForm.locator("select").nth(0).selectOption("status");
        await groupForm.locator("input[placeholder='value']").fill("contacted");
        await page.getByRole("button", { name: "Save group" }).click();
        const group = await poll(async () => ((await admin("contacts/groups/")).body?.groups || []).find((g) => g.label === `Edge ${STAMP}`));
        check("contacts: a custom group is created with its members", group?.size >= 1, group && `${group.size} people`);
        if (group) await adminWrite(`contacts/groups/${group.key}/`, "DELETE");
        // Settings: http webhooks are refused; retention saves.
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: "+ Add webhook" }).click();
        await page.getByPlaceholder("https://hooks.example.com/…").fill("http://insecure.example.org/hook");
        await page.getByRole("button", { name: "Save settings" }).click();
        check("contacts: an http:// webhook is refused", !!(await poll(async () => /must start with https/.test(await page.locator("body").innerText()))));
        await page.getByRole("button", { name: "Activity log", exact: true }).click();
        check("contacts: the activity log shows the export", !!(await poll(async () => /contact export/.test(await page.locator("body").innerText()))));
        // Erase from the UI.
        await page.getByRole("button", { name: "Contacts", exact: true }).click();
        await page.getByPlaceholder("Search name, email, phone").fill(leadEmail);
        await poll(async () => (await page.locator("[data-cms-contact]").count()) > 0);
        await page.locator("[data-cms-contact]").first().click();
        await page.getByPlaceholder("Type ERASE").fill("ERASE");
        await page.getByRole("button", { name: "Erase permanently" }).click();
        check("contacts: “Erase permanently” removes the person", !!(await poll(async () => !((await admin(`contacts/?q=${encodeURIComponent(leadEmail)}`)).body?.results || []).length)));
    }

    /* ================================================== F. admin on a phone */
    if (want("F")) {
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await adminCtx.storageState() });
        const p = await phone.newPage();
        for (const path of ["/admin/tracking", "/admin/contacts"]) {
            await p.goto(`${SITE}${path}`);
            await sleep(2000);
            check(`phone: ${path} fits the screen`, await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
                await p.evaluate(() => `${document.documentElement.scrollWidth}px`));
        }
        await phone.close();
    }
} catch (err) {
    check("unexpected error", false, err.message.split("\n")[0]);
    await page.screenshot({ path: "tracking-edge-failure.png" }).catch(() => {});
} finally {
    // Put everything back.
    try {
        if (originalSettings) {
            await adminWrite("settings/site/", "PATCH", { analytics: {
                ...(originalSettings.analytics || {}), plan: undefined,
                metaPixelId: originalSettings.analytics?.metaPixelId || "", clarityId: originalSettings.analytics?.clarityId || "",
                ga4Id: originalSettings.analytics?.ga4Id || "", consentVersion: originalSettings.analytics?.consentVersion || "1",
                events: { ...(originalSettings.analytics?.events || {}), engagement: originalSettings.analytics?.events?.engagement ?? true },
            } });
        }
        if (originalPlan) {
            await adminWrite("tracking/plan/?unlock=1", "PUT", { plan: originalPlan });
            await adminWrite("tracking/plan/approve/", "POST");
        }
        if (originalContacts) await adminWrite("contacts/settings/", "PUT", { ...originalContacts, webhooks: (originalContacts.webhooks || []).map((h) => ({ ...h, secret: "…" })) });
        const plan = (await admin("tracking/plan/")).body?.plan;
        check("cleanup: plan restored and approved", plan?.status === "approved" && plan.conversions.length === originalPlan?.conversions.length);
    } catch (err) {
        check("cleanup", false, err.message);
    }
    check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    await browser.close();
    process.exit(passed === results.length ? 0 : 1);
}
