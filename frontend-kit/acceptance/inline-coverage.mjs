#!/usr/bin/env node
/* =========================================================================
   Inline coverage (R2, R11): everything a visitor can read or see is edited ON
   the page. As a signed-in admin with editing on, every sitemap page is
   measured:

     TEXT    the share of visible text that is editable in place (an <E.Text>
             span or a bound string — components/cms/Binder.jsx). Text that is
             not is "dead": the editor can only change it in code (or in a
             popup, which is not an answer — R2).
     IMAGES  the share of content images (≥120px, not decorative) that have a
             "Replace image" tool (an <E.Image> or a bound image).

   A page fails below INLINE_MIN_TEXT (default 85) % text or INLINE_MIN_IMAGES
   (default 80) % images, and the report lists the biggest uncovered strings
   and the section they sit in, so the fix is obvious: print them through
   useCms + <E.Text>, add the data they come from to the block's data, or — for
   decoration that is not content — mark the element data-cms-static.
   Collections (blog posts, case studies…) count too: render their lists from
   CMS data, not from a code file.

     SITE_URL=… CMS_USER=… CMS_PASSWORD=… node inline-coverage.mjs
   Env: INLINE_MIN_TEXT, INLINE_MIN_IMAGES, INLINE_EXEMPT=/a,/b, INLINE_WORKERS (4)
========================================================================= */

import { chromium } from "playwright";

const SITE = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
const { CMS_USER, CMS_PASSWORD } = process.env;
const MIN_TEXT = Number(process.env.INLINE_MIN_TEXT || 85);
const MIN_IMAGES = Number(process.env.INLINE_MIN_IMAGES || 80);
const WORKERS = Math.max(1, Number(process.env.INLINE_WORKERS || 4));
const EXEMPT = new Set((process.env.INLINE_EXEMPT || "").split(",").map((p) => p.trim().replace(/(.)\/+$/, "$1")).filter(Boolean));
if (!CMS_USER || !CMS_PASSWORD) {
    console.error("Set CMS_USER and CMS_PASSWORD (a staff account).");
    process.exit(2);
}

const sitemap = await (await fetch(`${SITE}/sitemap.xml`)).text();
const paths = [...new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1].trim()).pathname))]
    .filter((p) => !EXEMPT.has(p.replace(/(.)\/+$/, "$1")));
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});

function measure() {
    const root = document.querySelector("main") || document.body;
    const SKIP = "script,style,noscript,[aria-hidden='true'],[data-cms-layer],[data-cms-adminbar],[data-cms-static],[data-cms-consent-banner]";
    const editable = "[data-cms-block][data-cms-path],[data-cms-bind]";
    let total = 0;
    let covered = 0;
    const dead = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent.replace(/\s+/g, " ").trim();
        const el = node.parentElement;
        if (text.length < 2 || !el || el.closest(SKIP)) continue;
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (cs.display === "none" || cs.visibility === "hidden" || !rect.width || !rect.height) continue;
        total += text.length;
        if (el.closest(editable)) covered += text.length;
        else {
            const section = el.closest("section,header,footer,nav,article,aside");
            dead.push({ n: text.length, text: text.slice(0, 70), where: section ? (section.getAttribute("aria-label") || section.querySelector("h1,h2,h3")?.textContent?.trim().slice(0, 40) || section.tagName.toLowerCase()) : "" });
        }
    }
    let images = 0;
    let imagesCovered = 0;
    const loose = [];
    for (const img of document.querySelectorAll("img")) {
        if (img.closest(SKIP)) continue;
        const rect = img.getBoundingClientRect();
        const cs = getComputedStyle(img);
        if (rect.width < 120 || rect.height < 80 || cs.display === "none" || cs.visibility === "hidden" || (img.getAttribute("alt") === "" && img.getAttribute("role") === "presentation")) continue;
        images += 1;
        const has = img.hasAttribute("data-cms-bind-img") || img.parentElement?.querySelector(':scope > [data-cms-image-anchor="inline"]') || img.closest("[data-cms-bind-img]");
        if (has) imagesCovered += 1;
        else loose.push((img.getAttribute("src") || "").split("/").pop().split("?")[0].slice(0, 40));
    }
    dead.sort((a, b) => b.n - a.n);
    return { total, covered, dead: dead.slice(0, 5), images, imagesCovered, loose: loose.slice(0, 3) };
}

const results = {};
const queue = [...paths];
await Promise.all(Array.from({ length: Math.min(WORKERS, paths.length) }, async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies([{ name: "cms_consent", value: encodeURIComponent(JSON.stringify({ v: "1", analytics: false, marketing: false })), url: SITE }]);
    const page = await ctx.newPage();
    await page.goto(`${SITE}/admin/login?next=%2F`, { waitUntil: "load" });
    await page.fill("#email", CMS_USER);
    await page.fill("#password", CMS_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/admin/login"), { timeout: 30000 });
    const toggle = page.locator("[data-cms-adminbar] button[aria-pressed]").first();
    await toggle.waitFor({ timeout: 20000 });
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        try {
            await page.goto(`${SITE}${path}`, { waitUntil: "load", timeout: 60000 }).catch(() => page.goto(`${SITE}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 }));
            await page.evaluate(async () => {
                for (let y = 0; y < document.body.scrollHeight; y += 600) {
                    window.scrollTo(0, y);
                    await new Promise((r) => setTimeout(r, 60));
                }
                window.scrollTo(0, 0);
            });
            await page.waitForTimeout(1200); // the binder settles
            results[path] = await page.evaluate(measure);
        } catch (error) {
            results[path] = { error: error.message.split("\n")[0] };
        }
    }
    await ctx.close();
}));
await browser.close();

let failed = 0;
let totalText = 0;
let totalCovered = 0;
for (const [path, r] of Object.entries(results).sort(([a], [b]) => a.localeCompare(b))) {
    if (r.error) {
        failed += 1;
        console.log(`FAIL  inline: ${path} could not be measured — ${r.error}`);
        continue;
    }
    totalText += r.total;
    totalCovered += r.covered;
    const text = r.total ? Math.round((100 * r.covered) / r.total) : 100;
    const imgs = r.images ? Math.round((100 * r.imagesCovered) / r.images) : 100;
    const ok = text >= MIN_TEXT && imgs >= MIN_IMAGES;
    if (!ok) failed += 1;
    const dead = r.dead.map((d) => `“${d.text}”${d.where ? ` in “${d.where}”` : ""}`).join(" | ");
    console.log(`${ok ? "PASS" : "FAIL"}  inline: ${path} — ${text}% of its text and ${imgs}% of its ${r.images} images are editable in place${ok ? "" : ` (need ${MIN_TEXT}% / ${MIN_IMAGES}%) · not editable: ${dead}${r.loose.length ? ` · images without a Replace tool: ${r.loose.join(", ")}` : ""}`}`);
}
console.log(`\ninline coverage: ${Object.keys(results).length - failed}/${Object.keys(results).length} pages pass · ${totalText ? Math.round((100 * totalCovered) / totalText) : 100}% of all visible text is editable in place`);
process.exit(failed ? 1 : 0);
