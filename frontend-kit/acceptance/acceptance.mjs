#!/usr/bin/env node
/* =========================================================================
   Acceptance test for a frontend wired with the dynamic-cms frontend kit.
   An integration is DONE only when every check here passes.

   Setup (once, in any folder):
     npm i playwright axe-core && npx playwright install chromium

   Run (frontend production build + backend both running):
     SITE_URL=http://localhost:3000 API_URL=http://localhost:8000 \
     CMS_USER=<staff username or email> CMS_PASSWORD=<password> \
     [CMS_PAGE=/] [CMS_DYNAMIC_PAGE=/some-cms-page] \
     node acceptance.mjs

   The backend's FRONTEND_REVALIDATE_URL must point at SITE_URL/api/revalidate
   (and REVALIDATE_SECRET must match), or the "visitor sees the publish"
   check fails — that is a real integration failure.

   At least one collection must be configured (SiteSettings.collections);
   the test creates, publishes, rewrites and deletes one entry in it.

   Everything the test changes is put back at the end: the edited block and
   the page keyword are restored and the entry it creates is deleted.
========================================================================= */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { chromium } from "playwright";

// axe-core (accessibility rules) — admin UI contrast + critical issues for visitors.
let AXE = null;
try {
    AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
} catch {
    // reported as a failing check below
}
async function axeViolations(target, options) {
    await target.addScriptTag({ content: AXE });
    return target.evaluate(async (opts) => (await window.axe.run(opts.context || document, opts.run)).violations
        .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, example: v.nodes[0]?.html?.slice(0, 90) })), options);
}

const SITE = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
const API = `${(process.env.API_URL || "http://localhost:8000").replace(/\/+$/, "")}/api`;
const { CMS_USER, CMS_PASSWORD } = process.env;
const PAGE = process.env.CMS_PAGE || "/";
const DYNAMIC_PAGE = process.env.CMS_DYNAMIC_PAGE || "";
const STAMP = `ACC${Date.now().toString(36)}`;

if (!CMS_USER || !CMS_PASSWORD) {
    console.error("Set CMS_USER and CMS_PASSWORD (a staff account).");
    process.exit(2);
}

const results = [];
const check = (name, pass, detail = "") => {
    results.push(pass);
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const publicJson = async (path) => (await fetch(`${API}/${path}`)).json();
async function poll(fn, { tries = 25, every = 400 } = {}) {
    for (let i = 0; i < tries; i++) {
        const value = await fn();
        if (value) return value;
        await sleep(every);
    }
    return null;
}

const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
);
const visitor = await (await browser.newContext()).newPage();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("dialog", (d) => d.accept());

const admin = (path, init = {}) =>
    page.evaluate(async ([url, init]) => {
        const res = await fetch(url, { credentials: "include", ...init });
        return { status: res.status, body: await res.json().catch(() => null) };
    }, [`${API}/${path}`, init]);
async function adminWrite(path, method, body) {
    const csrf = (await admin("auth/csrf/")).body?.csrfToken;
    return admin(path, {
        method,
        headers: { "Content-Type": "application/json", "X-CSRFToken": csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}
const bar = () => page.locator("[data-cms-adminbar]");
async function login(next) {
    await page.goto(`${SITE}/admin/login?next=${encodeURIComponent(next)}`);
    await page.fill("#email", CMS_USER);
    await page.fill("#password", CMS_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => url.pathname === next, { timeout: 15000 });
}
async function ensureEditing() {
    const toggle = bar().locator("button[aria-pressed]").first();
    await toggle.waitFor({ timeout: 15000 });
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
}
async function typeInto(locator, text) {
    await locator.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.type(text);
    await page.locator("body").click({ position: { x: 2, y: 2 } });
}
// Wait for a publish/discard to finish. Never waits for "All published":
// a real site may have unrelated drafts on other pages.
async function settle() {
    await poll(async () => !(await bar().getByText(/Saving draft…/).count()), { tries: 20, every: 300 });
    await sleep(800);
}
async function publishMenu(item) {
    await bar().getByRole("button", { name: /^Publish \(\d+\)/ }).click();
    await bar().getByRole("button", { name: item }).click();
}
const closeDrawer = () => page.locator('[role="dialog"] [aria-label="Close"]').first().click();

let block = null;
let original = null;
let originalSeo = null;
let createdEntry = null;
let originalSettings = null;   // forms + analytics, restored at the end
const restoreSections = [];    // [{ hostPath, id, content }]
const FORM_PAGE = process.env.FORM_PAGE || "/contact";

try {
    /* ---------- 1. Visitors get zero CMS UI ---------- */
    await visitor.goto(`${SITE}${PAGE}`);
    check("visitor: no admin bar, no editable spans",
        (await visitor.locator("[data-cms-adminbar], [data-cms-block]").count()) === 0);

    /* ---------- 2. Session login (cookie + CSRF, no token in storage) ---------- */
    await login(PAGE);
    check("login redirects back to ?next", true);
    const cookies = await context.cookies(API);
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    check("session cookie is httpOnly; nothing token-like in web storage",
        cookies.some((c) => c.name === "sessionid" && c.httpOnly) && !/token|authToken/i.test(storage));
    await bar().waitFor({ timeout: 15000 });
    check("admin bar mounted for staff", true);

    /* ---------- 3. True inline editing -> draft autosave ---------- */
    await ensureEditing();
    const candidates = page.locator('[data-cms-block]:not([data-cms-block^="section:"])');
    await candidates.first().waitFor({ timeout: 10000 });
    let target = null;
    for (let i = 0; i < (await candidates.count()) && !target; i++) {
        const el = candidates.nth(i);
        const path = await el.getAttribute("data-cms-path");
        if (!path.includes(".") && (await el.isVisible()) && (await el.innerText()).trim()) target = el;
    }
    check("page has a visible top-level inline-editable text", !!target);
    block = await target.getAttribute("data-cms-block");
    const field = await target.getAttribute("data-cms-path");
    original = await publicJson(`home/${block}/`);
    await typeInto(target, `${STAMP} inline`);
    const saved = await poll(async () => (await admin(`home/${block}/?mode=draft`)).body?.[field] === `${STAMP} inline`);
    check(`click-and-type saved a draft (${block}.${field})`, !!saved);
    check("public data unchanged before publish", (await publicJson(`home/${block}/`))[field] !== `${STAMP} inline`);

    /* ---------- 4. Publish -> webhook -> visitors see it ---------- */
    await publishMenu(/Publish this page/);
    await settle();
    check("publish copies the draft live", !!(await poll(async () => (await publicJson(`home/${block}/`))[field] === `${STAMP} inline`)));
    const fresh = await poll(async () => (await (await fetch(`${SITE}${PAGE}`)).text()).includes(`${STAMP} inline`), { tries: 30, every: 700 });
    check("visitor HTML updated (revalidate webhook)", !!fresh);

    /* ---------- 5. Whole-page AI assist (Prometheus parity) ---------- */
    // A unique keyword so coverage starts at 0% and must rise after Apply.
    const seoKey = PAGE.replace(/^\/+|\/+$/g, "") || "home";
    originalSeo = (await admin(`seo/${seoKey}/`)).body || {};
    const KW = `kw${STAMP.toLowerCase()}`;
    await adminWrite(`seo/${seoKey}/`, "PATCH", { keywords: { primary: KW } });
    await page.reload();
    await bar().waitFor({ timeout: 15000 });
    await bar().getByRole("button", { name: /AI assist/ }).click();
    const dialog5 = page.getByRole("dialog");
    const prompt = dialog5.locator("textarea[readonly]").first();
    await prompt.waitFor({ timeout: 10000 });
    const promptText = await prompt.inputValue();
    check("opening AI assist builds the prompt (no extra click)", promptText.length > 500 && promptText.includes(block), `${promptText.length} chars`);
    check("prompt restates its rules at the end (FINAL CHECK)", promptText.slice(-2500).includes("FINAL CHECK"));
    check("keyword coverage card shows a percentage", (await dialog5.locator("[data-cms-coverage-percent]").getAttribute("data-cms-coverage-percent")) === "0");
    check("“Other SEO rules” list is always shown (6 rules)", (await dialog5.locator("[data-cms-rule]").count()) === 6);
    const reply = `Here you go!\n\n\`\`\`json\n${JSON.stringify({ [block]: { content: { [field]: `${STAMP} ai [link](https://example.com) ok ${KW}` } } })}\n\`\`\`\nAnything else?`;
    await dialog5.locator("textarea:not([readonly])").last().fill(reply);
    await dialog5.getByRole("button", { name: /Apply/ }).click();
    const aiValue = await poll(async () => {
        const v = (await admin(`home/${block}/?mode=draft`)).body?.[field];
        return v && v.startsWith(`${STAMP} ai`) ? v : null;
    });
    check("AI paste normalised (prose, fences, wrapper, markdown link)", aiValue === `${STAMP} ai link ok ${KW}`, aiValue || "no draft");
    const livePercent = await poll(async () => Number(await dialog5.locator("[data-cms-coverage-percent]").getAttribute("data-cms-coverage-percent")) > 0);
    check("coverage updates live after Apply (no rebuild)", !!livePercent);
    await closeDrawer();

    /* ---------- 6. Discard ---------- */
    await publishMenu(/Discard this page/);
    await settle();
    check("discard drops the draft", !!(await poll(async () => (await admin(`home/${block}/?mode=draft`)).body?.[field] === `${STAMP} inline`)));

    /* ---------- 6b. Typing never loses focus ---------- */
    // Type character by character — across an autosave round trip — into a
    // field inside a LIST (the classic failure: a list keyed by its own text
    // re-creates the element on every keystroke), then into a panel input.
    async function typesWithoutLosingFocus(locator, label) {
        await locator.click();
        // Caret to the end, and mark the element so a re-mount is detectable.
        const id = await locator.evaluate((el) => {
            el.dataset.cmsFocusProbe = "1";
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            return `${el.dataset.cmsBlock}::${el.dataset.cmsPath}`;
        });
        for (const ch of "focus") await page.keyboard.type(ch, { delay: 60 });
        await sleep(1500); // autosave fires and the block re-renders
        for (const ch of "kept") await page.keyboard.type(ch, { delay: 60 });
        const state = await page.evaluate(() => {
            const el = document.activeElement;
            return {
                id: el?.dataset?.cmsBlock ? `${el.dataset.cmsBlock}::${el.dataset.cmsPath}` : el?.tagName,
                text: el?.innerText || el?.value || "",
                sameElement: el?.dataset?.cmsFocusProbe === "1",
            };
        });
        check(`typing keeps focus: ${label}`, state.id === id && state.text.endsWith("focuskept"), `${state.id} “${state.text.slice(-20)}”`);
        check(`the field is never re-created while typing: ${label}`, state.sameElement, state.sameElement ? "" : "re-created mid-typing — is the list keyed by the item's text? use the index");
        await page.keyboard.press("Escape"); // reverts the field
    }
    const listCandidates = await page.locator('[data-cms-block]:not([data-cms-block^="section:"])').evaluateAll((els) =>
        els.map((el, i) => ({ i, path: el.dataset.cmsPath, visible: el.offsetParent !== null && el.innerText.trim().length > 0 }))
            .filter((c) => /\.\d+(\.|$)/.test(c.path) && c.visible).map((c) => c.i));
    if (listCandidates.length) {
        await typesWithoutLosingFocus(page.locator('[data-cms-block]:not([data-cms-block^="section:"])').nth(listCandidates[0]), "inline field inside a list");
    } else {
        check("page has an inline-editable list field to test focus on", false);
    }
    const plainField = page.locator(`[data-cms-block="${block}"][data-cms-path="${field}"]`).first();
    await typesWithoutLosingFocus(plainField, "inline field");
    // The "All fields" panel: a regular form input.
    await page.locator(`button[title^="All fields"]`).first().click({ force: true });
    const panelInput = page.getByRole("dialog").locator('input[type="text"], input:not([type]), textarea').first();
    await panelInput.click();
    await page.keyboard.press("End");
    for (const ch of "focuskept") await page.keyboard.type(ch, { delay: 40 });
    const panelOk = await panelInput.evaluate((el) => document.activeElement === el && el.value.endsWith("focuskept"));
    check("typing keeps focus: All fields panel input", panelOk);
    await closeDrawer();
    // Discard what the focus checks left on THIS page only.
    await bar().getByRole("button", { name: /^Publish \(\d+\)|All published/ }).first().click();
    const discardPage = bar().getByRole("button", { name: /Discard this page/ });
    if (await discardPage.isEnabled()) await discardPage.click();
    else await bar().getByRole("button", { name: /^Publish \(\d+\)|All published/ }).first().click();
    await settle();

    /* ---------- 7. SEO panel: Ask AI is the first action ---------- */
    const seoButton = bar().getByRole("button", { name: "SEO", exact: true });
    if (await seoButton.count()) {
        await seoButton.click();
        const dialog7 = page.getByRole("dialog");
        const seoPrompt = await poll(async () => (await dialog7.locator("[data-cms-seo-ai] textarea[readonly]").first().inputValue().catch(() => "")).length > 200);
        check("SEO panel opens on Ask AI with the prompt already built", !!seoPrompt);
        check("SEO score bar is visible", (await dialog7.locator("[data-cms-seo-score]").count()) === 1);
        await dialog7.locator('[data-cms-tab="checks"]').click();
        const checksShown = await dialog7.locator("[data-cms-check]").count();
        check("every SEO check is listed (18, mirrors the backend)", checksShown === 18, `${checksShown}`);
        await closeDrawer();
    } else {
        check("SEO button on the admin bar", false, "this route has no seoPath — wire PageSeo / setSeoPath");
    }

    /* ---------- 7a. Accessibility: admin panels readable, no critical issues ---------- */
    if (!AXE) {
        check("axe-core installed (npm i axe-core) for the accessibility checks", false);
    } else {
        const seoBtn = bar().getByRole("button", { name: "SEO", exact: true });
        if (await seoBtn.count()) {
            await seoBtn.click();
            await page.locator("[data-cms-seo-ai] textarea[readonly]").first().waitFor({ timeout: 10000 }).catch(() => {});
            const v = await axeViolations(page, { context: '[role="dialog"]', run: { runOnly: ["color-contrast"] } });
            check("admin panels meet WCAG AA contrast (set --cms-* to ≥4.5:1 shades)", v.length === 0, v.map((x) => `${x.nodes}× ${x.example}`).join(" | "));
            await closeDrawer();
        }
        const vv = await axeViolations(visitor, { run: { resultTypes: ["violations"] } });
        const critical = vv.filter((x) => x.impact === "critical");
        check("visitor page has no critical accessibility violations", critical.length === 0, critical.map((x) => `${x.id}: ${x.example}`).join(" | "));
    }

    /* ---------- 7b. Edit tools never cover the page ---------- */
    const pill = page.locator(".cms-hover-tools").first();
    if (await pill.count()) {
        await bar().hover();
        const hidden = await pill.evaluate((el) => getComputedStyle(el).opacity);
        check("edit tools are hidden until their block is hovered", hidden === "0", `opacity ${hidden}`);
    }
    await page.getByRole("button", { name: "Minimise the admin bar" }).click();
    check("admin bar minimises to a small pill", (await bar().locator("button[aria-pressed]").count()) === 0);
    await page.getByRole("button", { name: "Show the admin bar" }).click();
    await bar().locator("button[aria-pressed]").waitFor({ timeout: 5000 });
    check("admin bar restores", true);

    /* ---------- 8. Dynamic CMS page: inline section edit + discard ---------- */
    if (DYNAMIC_PAGE) {
        await page.goto(`${SITE}${DYNAMIC_PAGE}`);
        await ensureEditing();
        const sectionText = page.locator('[data-cms-block^="section:"]').first();
        await sectionText.waitFor({ timeout: 10000 });
        const before = (await sectionText.innerText()).trim();
        const sectionListIdx = await page.locator('[data-cms-block^="section:"]').evaluateAll((els) =>
            els.findIndex((el) => /\.\d+(\.|$)/.test(el.dataset.cmsPath) && el.offsetParent !== null && el.innerText.trim()));
        if (sectionListIdx >= 0) await typesWithoutLosingFocus(page.locator('[data-cms-block^="section:"]').nth(sectionListIdx), "CMS-page section list field");
        await typeInto(sectionText, `${STAMP} section`);
        const listed = await poll(async () => ((await admin("drafts/")).body?.hosts || []).length > 0);
        check("section edit saved as a host draft", !!listed);
        check("visitors still see the published section", !(await (await fetch(`${SITE}${DYNAMIC_PAGE}`)).text()).includes(`${STAMP} section`));
        await publishMenu(/Discard this page/);
        const restored = await poll(async () => (await page.locator('[data-cms-block^="section:"]').first().innerText()).trim() === before);
        check("discard restores the section on screen", !!restored);
        const role = (await admin(`collections/for-path/?path=${encodeURIComponent(DYNAMIC_PAGE)}`)).body?.role;
        if (!role) {
            check("one-off CMS page: structure is locked (no add/move/delete)", (await page.locator('[title="Delete section"], [title="Add a section below"]').count()) === 0);
        }
        await bar().getByRole("button", { name: /AI assist/ }).click();
        await page.getByRole("dialog").locator("textarea[readonly]").first().waitFor({ timeout: 10000 });
        const sectionChips = await page.getByRole("dialog").locator("[data-cms-coverage-chip]").count();
        const sectionsOnPage = await page.locator('[data-cms-block^="section:"]').evaluateAll((els) => new Set(els.map((e) => e.dataset.cmsBlock)).size);
        check("whole-page assist covers the CMS page's sections", sectionChips >= sectionsOnPage && sectionsOnPage > 0, `${sectionChips} chips / ${sectionsOnPage} sections`);
        await closeDrawer();
    }

    /* ---------- 9. Collections: build entries only where it makes sense ---------- */
    const collections = (await admin("collections/")).body || [];
    const cfg = collections.find((c) => c.hostKind === "content") || collections[0];
    if (!cfg) {
        check("at least one collection is configured (SiteSettings.collections)", false);
    } else {
        await page.goto(`${SITE}${PAGE}`);
        await bar().waitFor({ timeout: 15000 });
        const pageRole = (await admin(`collections/for-path/?path=${encodeURIComponent(PAGE)}`)).body?.role;
        if (!pageRole) check("no “＋ New …” on a page that is not a collection index", (await page.locator('[data-cms-collection]').count()) === 0);

        await page.goto(`${SITE}/${cfg.indexPath}`);
        const newButton = page.locator('[data-cms-collection="index"]');
        await newButton.waitFor({ timeout: 15000 });
        check(`“＋ New ${cfg.label.toLowerCase()}” offered on /${cfg.indexPath}`, true);
        await newButton.click();
        const title = `Acceptance ${STAMP}`;
        await page.locator("#cms-new-title").fill(title);
        await page.locator('[data-cms-action="create-blank"]').click();
        createdEntry = { key: cfg.key, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-") };
        await page.waitForURL((url) => url.pathname === `/${cfg.pathPrefix}/${createdEntry.slug}`, { timeout: 15000 });
        check("blank entry created and opened", true);
        const hostPath = cfg.hostKind === "blog" ? `blog/${createdEntry.slug}` : `content/${cfg.pathPrefix}/${createdEntry.slug}`;
        const rows = (await admin(`${hostPath}/sections/`)).body;
        const types = (Array.isArray(rows) ? rows : rows?.results || []).map((r) => r.section_type);
        check("new entry follows the collection template exactly", JSON.stringify(types.slice(0, cfg.sections.length)) === JSON.stringify(cfg.sections), types.join(","));
        check("new entry is hidden from visitors (draft)", (await fetch(`${SITE}/${cfg.pathPrefix}/${createdEntry.slug}`)).status === 404);
        const settings = page.locator('[data-cms-collection="entry"]');
        await settings.waitFor({ timeout: 15000 });
        await settings.click();
        await page.locator('[data-cms-action="toggle-entry-status"]').click();
        const live = await poll(async () => (await fetch(`${SITE}/${cfg.pathPrefix}/${createdEntry.slug}`)).status === 200, { tries: 30, every: 700 });
        check("publishing from entry settings makes it public", !!live);
        if (!cfg.allowAdd?.length) {
            check("fixed template: no add/move/delete on the entry's sections", (await page.locator('[title="Delete section"], [title="Move up"]').count()) === 0);
        }
        const entryPrompt = (await admin(`collections/${cfg.key}/entries/${createdEntry.slug}/prompt/`)).body?.prompt || "";
        check("entry rewrite prompt is template-strict and ends with FINAL CHECK", entryPrompt.includes("STRUCTURE") && entryPrompt.slice(-2500).includes("FINAL CHECK"));
        const first = cfg.sections[0];
        const rewrite = await adminWrite(`collections/${cfg.key}/entries/${createdEntry.slug}/apply/`, "POST", {
            raw: "```json\n" + JSON.stringify({ sections: [{ type: first, heading: `${STAMP} rewritten`, content: "x", description: "x", text: "x", items: [{ question: "Q?", answer: "A." }] }] }) + "\n```",
        });
        check("AI rewrite applied as drafts, fitted to the template", rewrite.status === 200 && JSON.stringify(rewrite.body.sections.map((r) => r.section_type).slice(0, cfg.sections.length)) === JSON.stringify(cfg.sections));
        check("visitors still see the published entry, not the rewrite draft", !(await (await fetch(`${SITE}/${cfg.pathPrefix}/${createdEntry.slug}`)).text()).includes(`${STAMP} rewritten`));
        await closeDrawer().catch(() => {});
    }

    /* ---------- 9b. Responsive on every screen (R20) ---------- */
    const pagesToCheck = [PAGE, ...(DYNAMIC_PAGE ? [DYNAMIC_PAGE] : [])];
    for (const width of [390, 1920]) {
        const viewer = await browser.newPage({ viewport: { width, height: 900 } });
        for (const path of pagesToCheck) {
            await viewer.goto(`${SITE}${path}`);
            await viewer.waitForLoadState("networkidle").catch(() => {});
            const overflow = await viewer.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            if (width === 1920) {
                const h1s = await viewer.locator("h1").count();
                check(`SEO: exactly one <h1> in the HTML of ${path}`, h1s === 1, h1s === 1 ? "" : `${h1s} <h1> elements — a hidden mobile/desktop twin? make one <div role="heading" aria-level={1}>`);
            }
            check(`responsive: no horizontal scroll at ${width}px on ${path}`, overflow <= 1, overflow > 1 ? `${overflow}px wider than the screen` : "");
        }
        await viewer.close();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${SITE}${PAGE}`);
    await bar().waitFor({ timeout: 15000 });
    const barBox = await bar().boundingBox();
    check("responsive: admin bar fits a phone screen", !!barBox && barBox.x >= 0 && barBox.x + barBox.width <= 391);
    const more = bar().getByRole("button", { name: /More/ });
    check("responsive: secondary admin actions collapse behind “More” on phones", (await more.count()) === 1);
    if (await more.count()) {
        await more.click();
        const seo = bar().getByRole("button", { name: "SEO", exact: true });
        if (await seo.count()) {
            await seo.click();
            const panel = await page.locator('[role="dialog"] > div').last().boundingBox();
            check("responsive: panels fit a phone screen", !!panel && panel.width <= 391, panel ? `${Math.round(panel.width)}px` : "no panel");
            await closeDrawer();
        }
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    /* ---------- 9c. Hide blocks, list items and sections (R23) ---------- */
    async function publishPage() {
        await bar().getByRole("button", { name: /^Publish \(\d+\)/ }).click();
        await bar().getByRole("button", { name: /Publish this page/ }).click();
        await settle();
    }
    const visitorHtml = async (path) => (await (await fetch(`${SITE}${path}`)).text());
    // Text can legitimately appear elsewhere too (a nav label in the footer),
    // so hiding is proven by the count going down, not by absence.
    const countIn = async (path, text) => (await visitorHtml(path)).split(text).length - 1;
    const longestString = (value) => {
        let best = "";
        JSON.stringify(value, (k, v) => { if (typeof v === "string" && k !== "_hidden" && !/href|image|icon|url/i.test(k) && v.length > best.length) best = v; return v; });
        return best;
    };
    await page.goto(`${SITE}${PAGE}`);
    await ensureEditing();
    // Block: the first block whose Hide toggle we click.
    const toggle = page.locator('[data-cms-action="toggle-hidden"]').first();
    await toggle.click({ force: true });
    const hiddenBlock = await poll(async () => {
        const d = (await admin("drafts/")).body?.components || [];
        for (const c of d) {
            const draftData = (await admin(`home/${c.name}/?mode=draft`)).body;
            if (draftData?._hidden) return { name: c.name, text: longestString(draftData) };
        }
        return null;
    });
    check("“Hide” on a block saves _hidden as a draft", !!hiddenBlock);
    if (hiddenBlock) {
        const needle = hiddenBlock.text.slice(0, 40);
        const before = await countIn(PAGE, needle);
        await publishPage();
        const gone = await poll(async () => (await countIn(PAGE, needle)) < before, { tries: 30, every: 700 });
        check("a hidden block is not in the visitor's HTML", !!gone, `${hiddenBlock.name}: “${needle}” ${before}→${await countIn(PAGE, needle)}`);
        await page.goto(`${SITE}${PAGE}`);
        await ensureEditing();
        await page.locator('[data-cms-action="toggle-hidden"][aria-pressed="true"]').first().click({ force: true });
        await poll(async () => !(await admin(`home/${hiddenBlock.name}/?mode=draft`)).body?._hidden);
        await publishPage();
        const back = await poll(async () => (await countIn(PAGE, needle)) >= before, { tries: 30, every: 700 });
        check("showing it again brings it back for visitors", !!back);
    }
    // List item: the first list field on the page that belongs to an object item.
    const itemField = page.locator('[data-cms-block]:not([data-cms-block^="section:"])').filter({ hasText: /\S/ });
    const itemIndex = await itemField.evaluateAll((els) => els.findIndex((el) => /\.\d+\.\w+$/.test(el.dataset.cmsPath) && el.offsetParent));
    if (itemIndex >= 0) {
        const el = itemField.nth(itemIndex);
        const [blockName, path] = [await el.getAttribute("data-cms-block"), await el.getAttribute("data-cms-path")];
        const itemText = (await el.innerText()).trim();
        await el.hover();
        await page.locator('[data-cms-item-tools] [data-cms-action="toggle-item-hidden"]').first().click();
        const listPath = path.replace(/\.\d+\.\w+$/, "");
        const idx = Number(path.match(/\.(\d+)\.\w+$/)[1]);
        const saved = await poll(async () => {
            const d = (await admin(`home/${blockName}/?mode=draft`)).body;
            return listPath.split(".").reduce((o, k) => o?.[k], d)?.[idx]?._hidden;
        });
        check("“Hide” on a list item saves _hidden on that item only", !!saved, `${blockName}.${listPath}[${idx}]`);
        const itemBefore = await countIn(PAGE, itemText);
        await publishPage();
        const itemGone = await poll(async () => (await countIn(PAGE, itemText)) < itemBefore, { tries: 30, every: 700 });
        check("a hidden list item is not shown to visitors", !!itemGone, `“${itemText.slice(0, 30)}” ${itemBefore}→${await countIn(PAGE, itemText)}`);
        await el.hover();
        await page.locator('[data-cms-item-tools] [data-cms-action="toggle-item-hidden"]').first().click();
        await poll(async () => {
            const d = (await admin(`home/${blockName}/?mode=draft`)).body;
            return !listPath.split(".").reduce((o, k) => o?.[k], d)?.[idx]?._hidden;
        });
        await publishPage();
    }
    // CMS-page section.
    if (DYNAMIC_PAGE) {
        await page.goto(`${SITE}${DYNAMIC_PAGE}`);
        await ensureEditing();
        const slot = page.locator('[data-cms-block^="section:"]').first();
        await slot.waitFor({ timeout: 10000 });
        const sectionId = (await slot.getAttribute("data-cms-block")).split(":")[1];
        const role = (await admin(`collections/for-path/?path=${encodeURIComponent(DYNAMIC_PAGE)}`)).body;
        const hostKind = DYNAMIC_PAGE.startsWith("/blog/") ? "blog" : "content";
        const hostPath = hostKind === "blog" ? `blog/${DYNAMIC_PAGE.split("/").pop()}` : `content/${DYNAMIC_PAGE.replace(/^\//, "")}`;
        void role;
        const rows = (await admin(`${hostPath}/sections/`)).body;
        const original = (Array.isArray(rows) ? rows : rows?.results || []).find((r) => String(r.id) === sectionId);
        restoreSections.push({ hostPath, id: sectionId, content: original?.content });
        const sectionText = longestString(original?.content || {});
        // The toggle sits in the section's hover toolbar (below a fixed header
        // on the first section) — hover the section, then click it like a person.
        await slot.hover();
        await page.locator('[data-cms-action="toggle-section-hidden"]').first().click();
        const savedSection = await poll(async () => {
            const r = (await admin(`${hostPath}/sections/`)).body;
            return (Array.isArray(r) ? r : r?.results || []).find((x) => String(x.id) === sectionId)?.draft_content?._hidden;
        });
        check("“Hide” on a CMS-page section saves a draft", !!savedSection);
        const sectionBefore = await countIn(DYNAMIC_PAGE, sectionText.slice(0, 40));
        await publishPage();
        const sectionGone = await poll(async () => (await countIn(DYNAMIC_PAGE, sectionText.slice(0, 40))) < sectionBefore, { tries: 30, every: 700 });
        check("a hidden section is not in the visitor's HTML", !!sectionGone);
    }

    /* ---------- 9d. Forms: stored, emailed via FormSubmit, lead event (R24) ---------- */
    originalSettings = (await admin("settings/site/")).body || {};
    await adminWrite("settings/site/", "PATCH", { forms: { notifyEmail: "acceptance-test@example.org", subjectPrefix: "Acceptance" } });
    {
        const ctx = await browser.newContext();
        const v = await ctx.newPage();
        const emails = [];
        let formName = null;
        ctx.on("request", (r) => {
            const m = r.method() === "POST" && r.url().match(/\/forms\/([^/]+)\/submit\//);
            if (m) formName = m[1];
        });
        await ctx.route("https://formsubmit.co/**", async (route) => {
            emails.push({ url: route.request().url(), body: route.request().postDataJSON?.() || {} });
            await route.fulfill({ status: 200, contentType: "application/json", body: '{"success":"true","message":"ok"}' });
        });
        await v.goto(`${SITE}${FORM_PAGE}`);
        const forms = v.locator("form").filter({ has: v.locator('input[type="email"]') });
        let form = null;
        for (let i = 0; i < (await forms.count()); i++) if (!form && (await forms.nth(i).isVisible())) form = forms.nth(i);
        if (!form) check(`a visible form on ${FORM_PAGE} (set FORM_PAGE)`, false);
        else {
            const tag = `Lead ${STAMP}`;
            const inputs = form.locator("input:visible, textarea:visible");
            for (let i = 0; i < (await inputs.count()); i++) {
                const el = inputs.nth(i);
                const type = (await el.getAttribute("type")) || "text";
                if (["submit", "button", "hidden", "file", "checkbox", "radio"].includes(type)) continue;
                if (await el.evaluate((n) => n.tabIndex < 0 || !!n.closest('[aria-hidden="true"]'))) continue;
                await el.fill(type === "email" ? "lead@example.org" : type === "tel" ? "07700 900123" : tag);
            }
            await form.locator('button[type="submit"], input[type="submit"]').first().click();
            const emailed = await poll(async () => emails.length > 0, { tries: 20, every: 400 });
            check("a stored submission is emailed via FormSubmit to the Settings address", !!emailed && emails[0].url.includes(encodeURIComponent("acceptance-test@example.org")), emails[0]?.url);
            check("the email carries the submitted fields", emailed && JSON.stringify(emails[0].body).includes(tag));
            const lead = await v.evaluate(() => (window.dataLayer || []).some((e) => e && e.event === "generate_lead"));
            check("generate_lead is pushed to the data layer", lead);
            const list = formName ? (await admin(`forms/${formName}/submissions/`)).body : [];
            const stored = (list?.results || list || []).find((x) => JSON.stringify(x).includes(tag));
            check("the submission is also in the CMS inbox", !!stored);
            if (stored) await adminWrite(`forms/${formName}/submissions/${stored.id}/`, "DELETE");
        }
        await ctx.close();
    }

    /* ---------- 9e. Tracking: IDs from Settings, data layer, events (R25) ---------- */
    await adminWrite("settings/site/", "PATCH", { analytics: { gtmId: "GTM-ACCTEST1", dataLayer: [{ key: "cms_acceptance", value: "yes" }], events: { pageView: true, lead: true, contactClicks: true } } });
    {
        const ctx = await browser.newContext();
        await ctx.route(/googletagmanager\.com|connect\.facebook\.net/, (route) => route.abort());
        const v = await ctx.newPage();
        const ready = await poll(async () => {
            await v.goto(`${SITE}${PAGE}`);
            return v.evaluate(() => (window.dataLayer || []).some((e) => e && e.cms_acceptance === "yes"));
        }, { tries: 15, every: 1000 });
        check("data layer variables are pushed before GTM", !!ready);
        check("the GTM container from Settings is loaded", await v.evaluate(() => (window.dataLayer || []).some((e) => e && e["gtm.start"])));
        const here = new URL(v.url()).pathname;
        const target = await v.evaluate((path) => {
            const links = [...document.querySelectorAll('a[href^="/"]')].filter((a) => a.offsetParent && !a.getAttribute("href").startsWith("/admin"));
            const link = links.find((a) => new URL(a.href).pathname !== path);
            return link ? link.getAttribute("href") : null;
        }, here);
        if (target) {
            await v.locator(`a[href="${target}"]:visible`).first().click();
            await v.waitForURL((url) => url.pathname !== here, { timeout: 15000 }).catch(() => {});
            const viewed = await poll(async () => v.evaluate(() => (window.dataLayer || []).some((e) => e && e.event === "page_view")));
            check("page_view is pushed on in-site navigation", !!viewed);
        }
        await ctx.close();
    }

    /* ---------- 10. Full-page admin still works ---------- */
    for (const path of ["/admin", "/admin/pages", "/admin/seo", "/admin/images", "/admin/sitemap", "/admin/settings"]) {
        await page.goto(`${SITE}${path}`);
        await sleep(1200);
        const text = await page.locator("body").innerText();
        check(`${path} renders`, text.length > 100 && !/Application error/i.test(text));
    }

    /* ---------- 11. Sign out ---------- */
    await page.goto(`${SITE}${PAGE}`);
    await bar().getByRole("button", { name: /▾/ }).click();
    await bar().getByRole("button", { name: "Sign out" }).click();
    await poll(async () => (await page.locator("[data-cms-adminbar]").count()) === 0);
    check("sign out removes the admin UI", (await page.locator("[data-cms-adminbar], [data-cms-block]").count()) === 0);
    check("sign out ends the server session", (await admin("auth/session/")).body?.authenticated === false);
} catch (err) {
    check("unexpected error", false, err.message.split("\n")[0]);
    await page.screenshot({ path: "acceptance-failure.png" }).catch(() => {});
    console.log("screenshot: acceptance-failure.png");
} finally {
    // Put everything back.
    if (block || createdEntry || originalSettings || restoreSections.length) {
        if (!(await admin("auth/session/")).body?.authenticated) await login("/").catch(() => {});
        if (block && original) {
            await adminWrite(`home/${block}/`, "PUT", original);
            await adminWrite("drafts/discard/", "POST", { components: [block] });
            check("cleanup: edited block restored", JSON.stringify(await publicJson(`home/${block}/`)) === JSON.stringify(original));
        }
        if (originalSettings) {
            await adminWrite("settings/site/", "PATCH", {
                forms: originalSettings.forms || { notifyEmail: "", subjectPrefix: "" },
                analytics: { ...(originalSettings.analytics || {}), gtmId: originalSettings.analytics?.gtmId || "", dataLayer: originalSettings.analytics?.dataLayer || [] },
            });
            check("cleanup: form and tracking settings restored", true);
        }
        for (const s of restoreSections) {
            if (s.content) await adminWrite(`${s.hostPath}/sections/${s.id}/`, "PATCH", { content: s.content, draft_content: null });
        }
        if (originalSeo) {
            const seoKey = PAGE.replace(/^\/+|\/+$/g, "") || "home";
            await adminWrite(`seo/${seoKey}/`, "PATCH", { keywords: { primary: originalSeo.keywords?.primary || "" } });
            check("cleanup: page keyword restored", ((await admin(`seo/${seoKey}/`)).body?.keywords?.primary || "") === (originalSeo.keywords?.primary || ""));
        }
        if (createdEntry) {
            const del = await adminWrite(`collections/${createdEntry.key}/entries/${createdEntry.slug}/`, "DELETE");
            check("cleanup: test entry deleted", del.status === 204 || del.status === 200);
        }
    }
    check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    await browser.close();
    process.exit(passed === results.length ? 0 : 1);
}
