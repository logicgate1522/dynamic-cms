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

   Everything the test changes is put back at the end: the edited block is
   restored to its original published data and the page it creates is
   deleted.
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
async function publishMenu(item) {
    await bar().getByRole("button", { name: /^Publish \(\d+\)/ }).click();
    await bar().getByRole("button", { name: item }).click();
}
const closeDrawer = () => page.locator('[role="dialog"] [aria-label="Close"]').first().click();

let block = null;
let original = null;
let createdPath = null;

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
    await bar().getByRole("button", { name: "All published" }).waitFor({ timeout: 15000 });
    check("publish copies the draft live", (await publicJson(`home/${block}/`))[field] === `${STAMP} inline`);
    const fresh = await poll(async () => (await (await fetch(`${SITE}${PAGE}`)).text()).includes(`${STAMP} inline`), { tries: 30, every: 700 });
    check("visitor HTML updated (revalidate webhook)", !!fresh);

    /* ---------- 5. Whole-page AI assist: prompt + messy paste ---------- */
    await bar().getByRole("button", { name: /AI assist/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Build prompt/ }).click();
    const prompt = page.getByRole("dialog").locator("textarea[readonly]").first();
    await prompt.waitFor({ timeout: 10000 });
    const promptText = await prompt.inputValue();
    check("page-assist prompt built by the backend", promptText.length > 500 && promptText.includes(block), `${promptText.length} chars`);
    const reply = `Here you go!\n\n\`\`\`json\n${JSON.stringify({ [block]: { content: { [field]: `${STAMP} ai [link](https://example.com) ok` } } })}\n\`\`\`\nAnything else?`;
    await page.getByRole("dialog").locator("textarea:not([readonly])").last().fill(reply);
    await page.getByRole("dialog").getByRole("button", { name: /Apply/ }).click();
    const aiValue = await poll(async () => {
        const v = (await admin(`home/${block}/?mode=draft`)).body?.[field];
        return v && v.startsWith(`${STAMP} ai`) ? v : null;
    });
    check("AI paste normalised (prose, fences, wrapper, markdown link)", aiValue === `${STAMP} ai link ok`, aiValue || "no draft");
    await closeDrawer();

    /* ---------- 6. Discard ---------- */
    await publishMenu(/Discard this page/);
    await bar().getByRole("button", { name: "All published" }).waitFor({ timeout: 15000 });
    check("discard drops the draft", (await admin(`home/${block}/?mode=draft`)).body?.[field] === `${STAMP} inline`);

    /* ---------- 7. SEO panel + its AI prompts ---------- */
    const seoButton = bar().getByRole("button", { name: "SEO", exact: true });
    if (await seoButton.count()) {
        await seoButton.click();
        await page.getByRole("dialog").getByRole("button", { name: /^AI/ }).first().click();
        const build = page.getByRole("dialog").getByRole("button", { name: /Build|prompt/i });
        if (await build.count()) await build.first().click();
        const seoPrompt = await poll(async () => (await page.getByRole("dialog").locator("textarea[readonly]").first().inputValue().catch(() => "")).length > 200);
        check("SEO AI prompt available", !!seoPrompt);
        await closeDrawer();
    } else {
        check("SEO button on the admin bar", false, "this route has no seoPath — wire PageSeo / setSeoPath");
    }

    /* ---------- 8. Dynamic CMS page: inline section edit + discard ---------- */
    if (DYNAMIC_PAGE) {
        await page.goto(`${SITE}${DYNAMIC_PAGE}`);
        await ensureEditing();
        const sectionText = page.locator('[data-cms-block^="section:"]').first();
        await sectionText.waitFor({ timeout: 10000 });
        const before = (await sectionText.innerText()).trim();
        await typeInto(sectionText, `${STAMP} section`);
        const listed = await poll(async () => ((await admin("drafts/")).body?.hosts || []).length > 0);
        check("section edit saved as a host draft", !!listed);
        check("visitors still see the published section", !(await (await fetch(`${SITE}${DYNAMIC_PAGE}`)).text()).includes(`${STAMP} section`));
        await publishMenu(/Discard this page/);
        const restored = await poll(async () => (await page.locator('[data-cms-block^="section:"]').first().innerText()).trim() === before);
        check("discard restores the section on screen", !!restored);
        const builder = bar().getByRole("button", { name: "Page builder" });
        check("Page builder offered on CMS pages", (await builder.count()) === 1);
    }

    /* ---------- 9. Create a page from pasted AI JSON ---------- */
    createdPath = `acceptance-${STAMP.toLowerCase()}`;
    await bar().getByRole("button", { name: /New page/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('input[placeholder^="Title"]').fill("Acceptance Test Page");
    const pathInput = dialog.locator('input[placeholder*="path" i]').first();
    if (await pathInput.count()) await pathInput.fill(createdPath);
    await dialog.getByRole("button", { name: "Build prompt" }).click();
    await dialog.locator("textarea[readonly]").first().waitFor({ timeout: 10000 });
    check("new-page prompt built", (await dialog.locator("textarea[readonly]").first().inputValue()).length > 800);
    await dialog.locator("textarea:not([readonly])").last().fill("```json\n" + JSON.stringify({
        title: "Acceptance Test Page",
        seo: { title: "Acceptance Test Page", description: "A page created by the dynamic-cms acceptance test; it is deleted when the test ends." },
        sections: [
            { type: "hero", heading: `${STAMP} hero`, description: "Created by the acceptance test." },
            { type: "faq", heading: "Questions", items: [1, 2, 3].map((n) => ({ question: `Q${n}?`, answer: `A${n}` })) },
        ],
    }) + "\n```");
    await dialog.getByRole("button", { name: /Create draft/ }).click();
    await page.waitForURL((url) => url.pathname === `/${createdPath}`, { timeout: 15000 });
    await page.getByText(`${STAMP} hero`).first().waitFor({ timeout: 15000 });
    check("created draft page renders for staff", true);
    check("draft page is 404 for visitors", (await fetch(`${SITE}/${createdPath}`)).status === 404);
    check("page SEO seeded from the pasted JSON", JSON.stringify((await admin(`seo/${createdPath}/`)).body).includes("Acceptance Test Page"));

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
    if (block || createdPath) {
        if (!(await admin("auth/session/")).body?.authenticated) await login("/").catch(() => {});
        if (block && original) {
            await adminWrite(`home/${block}/`, "PUT", original);
            await adminWrite("drafts/discard/", "POST", { components: [block] });
            check("cleanup: edited block restored", JSON.stringify(await publicJson(`home/${block}/`)) === JSON.stringify(original));
        }
        if (createdPath) {
            const del = await adminWrite(`content/pages/${createdPath}/`, "DELETE");
            await adminWrite(`seo/${createdPath}/`, "DELETE");
            check("cleanup: test page deleted", del.status === 204 || del.status === 200 || del.status === 404);
        }
    }
    check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    await browser.close();
    process.exit(passed === results.length ? 0 : 1);
}
