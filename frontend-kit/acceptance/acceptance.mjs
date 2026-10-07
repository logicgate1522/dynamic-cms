#!/usr/bin/env node
/* =========================================================================
   Acceptance test for a frontend wired with the dynamic-cms frontend kit.
   An integration is DONE only when every check here passes.

   Setup (once, in any folder):
     npm i playwright && npx playwright install chromium

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

import { chromium } from "playwright";

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
    if (block || createdEntry) {
        if (!(await admin("auth/session/")).body?.authenticated) await login("/").catch(() => {});
        if (block && original) {
            await adminWrite(`home/${block}/`, "PUT", original);
            await adminWrite("drafts/discard/", "POST", { components: [block] });
            check("cleanup: edited block restored", JSON.stringify(await publicJson(`home/${block}/`)) === JSON.stringify(original));
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
