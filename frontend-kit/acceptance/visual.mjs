#!/usr/bin/env node
/* =========================================================================
   Visual check (R9): the site looks the same after the CMS integration.

     # P0, BEFORE changing anything (the site as it is today):
     SITE_URL=http://localhost:3000 node visual.mjs --baseline --dir <frontend>/.gates/visual
     # later (run-gates.mjs does this for you):
     SITE_URL=http://localhost:3000 node visual.mjs --dir <frontend>/.gates/visual

   Every sitemap page at 390px and 1280px, full height, animations settled,
   as a signed-out visitor with no consent banner (marked chosen). Pages
   compare pixel by pixel (pixelmatch); a page fails when more than
   VISUAL_MAX_DIFF (default 0.5%) of its pixels differ or its height changes
   by more than 2%. Diff images land in <dir>/diff/ for review. Mark live or
   random content with data-visual-ignore (masked in both runs).
========================================================================= */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const SITE = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
const args = process.argv.slice(2);
const BASELINE = args.includes("--baseline");
const DIR = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : ".gates/visual";
const MAX = Number(process.env.VISUAL_MAX_DIFF || 0.005);
const WIDTHS = [390, 1280];

const out = join(DIR, BASELINE ? "baseline" : "current");
mkdirSync(out, { recursive: true });
mkdirSync(join(DIR, "diff"), { recursive: true });
// Bumped when the capture changes in a way that changes what a screenshot
// shows (2: in-view content is revealed to the bottom of the page). A baseline
// from an older capture can't be compared fairly.
const CAPTURE = 2;
if (!BASELINE && existsSync(join(DIR, "baseline", "index.json"))) {
    const meta = existsSync(join(DIR, "baseline", "capture.json")) ? JSON.parse(readFileSync(join(DIR, "baseline", "capture.json"), "utf8")) : {};
    if ((meta.capture || 1) < CAPTURE) {
        console.log(`FAIL  visual: the baseline was taken with capture v${meta.capture || 1} (now v${CAPTURE}: scroll-revealed content is captured) — retake it on the P0 state of the site and say so in the report`);
        process.exit(1);
    }
}
if (!BASELINE && !existsSync(join(DIR, "baseline", "index.json"))) {
    console.log(`FAIL  visual: no baseline — take it in P0 before changing the site: node visual.mjs --baseline --dir ${DIR}`);
    process.exit(1);
}

const sitemap = await (await fetch(`${SITE}/sitemap.xml`)).text().catch(() => "");
const paths = [...new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => {
    try {
        return new URL(m[1].trim()).pathname;
    } catch {
        return null;
    }
}).filter(Boolean))];
if (!paths.includes("/")) paths.unshift("/");

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
const shots = {};
for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 800 ? 844 : 900 }, reducedMotion: "reduce" });
    // A visitor who already chose (no banner covering the page) — consent off.
    await ctx.addCookies([{ name: "cms_consent", value: encodeURIComponent(JSON.stringify({ v: "1", analytics: false, marketing: false })), url: SITE }]);
    const page = await ctx.newPage();
    for (const path of paths) {
        await page.goto(`${SITE}${path}`, { waitUntil: "load" });
        await page.evaluate(async () => {
            // Reveal every in-view (scroll-triggered) element: small steps, a
            // pause at each so observers fire, and a stop at the very bottom
            // (the page may grow while scrolling). Without this, the last
            // cards on long phone pages could be captured still invisible.
            const pause = (ms) => new Promise((r) => setTimeout(r, ms));
            for (let y = 0; y < document.documentElement.scrollHeight; y += 300) {
                window.scrollTo(0, y);
                await pause(120);
            }
            window.scrollTo(0, document.documentElement.scrollHeight);
            await pause(600);
            window.scrollTo(0, 0);
            document.querySelectorAll("[data-cms-consent-banner], [data-visual-ignore], video, iframe").forEach((el) => { el.style.visibility = "hidden"; });
        });
        await page.waitForTimeout(1500);
        const name = `${width}${path.replace(/\//g, "_") || "_"}.png`;
        await page.screenshot({ path: join(out, name), fullPage: true, animations: "disabled", caret: "hide" });
        shots[`${width} ${path}`] = name;
    }
    await ctx.close();
}
await browser.close();
writeFileSync(join(out, "index.json"), JSON.stringify(shots, null, 1));
if (BASELINE) writeFileSync(join(out, "capture.json"), JSON.stringify({ capture: CAPTURE, at: new Date().toISOString() }));

if (BASELINE) {
    console.log(`PASS  visual: baseline of ${Object.keys(shots).length} screenshots saved in ${out}`);
    process.exit(0);
}

const base = JSON.parse(readFileSync(join(DIR, "baseline", "index.json"), "utf8"));
let failed = 0;
for (const [key, name] of Object.entries(shots)) {
    if (!base[key]) {
        console.log(`WARN  visual: ${key} is new (no baseline)`);
        continue;
    }
    const a = PNG.sync.read(readFileSync(join(DIR, "baseline", base[key])));
    const b = PNG.sync.read(readFileSync(join(out, name)));
    const heightChange = Math.abs(a.height - b.height) / a.height;
    const w = Math.min(a.width, b.width);
    const h = Math.min(a.height, b.height);
    const crop = (img) => {
        const c = new PNG({ width: w, height: h });
        PNG.bitblt(img, c, 0, 0, w, h, 0, 0);
        return c;
    };
    const diff = new PNG({ width: w, height: h });
    const changed = pixelmatch(crop(a).data, crop(b).data, diff.data, w, h, { threshold: 0.15 });
    const ratio = changed / (w * h);
    const ok = ratio <= MAX && heightChange <= 0.02;
    if (!ok) {
        failed++;
        writeFileSync(join(DIR, "diff", name), PNG.sync.write(diff));
    }
    console.log(`${ok ? "PASS" : "FAIL"}  visual: ${key} matches its baseline  — ${(ratio * 100).toFixed(2)}% pixels differ, height ${(heightChange * 100).toFixed(1)}%`);
}
for (const key of Object.keys(base)) if (!shots[key]) console.log(`WARN  visual: ${key} is gone (was in the baseline)`);
console.log(`\nvisual: ${Object.keys(shots).length - failed}/${Object.keys(shots).length} pages match${failed ? ` — diffs in ${join(DIR, "diff")}` : ""}`);
process.exit(failed ? 1 : 0);
