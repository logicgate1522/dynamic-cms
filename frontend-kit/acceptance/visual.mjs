#!/usr/bin/env node
/* =========================================================================
   Visual check (R9): the site looks the same after the CMS integration.

     # P0, BEFORE changing anything (the site as it is today):
     SITE_URL=http://localhost:3000 node visual.mjs --baseline --dir <frontend>/.gates/visual
     # later (run-gates.mjs does this for you):
     SITE_URL=http://localhost:3000 node visual.mjs --dir <frontend>/.gates/visual

   Every sitemap page at 390px and 1280px, as a signed-out visitor with no
   consent banner (marked chosen), animations settled, scroll-revealed
   content revealed. Pages are captured several at a time (VISUAL_WORKERS).
   Two modes (the baseline and the later run must use the same one):

   VISUAL_MODE=pixels (default, the strict one). Every page is compared
   pixel by pixel (pixelmatch); a page fails when more than VISUAL_MAX_DIFF
   (default 0.5%) of its pixels differ or its height changes by more than 2%.
   Diff images land in <dir>/diff/.

   VISUAL_MODE=layout (fastest, for sites without animated content). Two checks:

   1. LAYOUT (every page, the main check). The rendered page is read as data:
      every visible piece of text (its words, box, font size/weight/colour),
      every image (file, box) and every coloured block (colour, box). A page
      fails when more than VISUAL_MAX_ITEMS (default 2%) of those items
      changed (missing, new, moved more than 2px, resized, restyled) or its
      height changes by more than 2%. The report names the first items that
      changed, so the fix is obvious. No pixels, so no anti-aliasing or
      animation noise — and it runs in minutes, not an hour.
   2. LOOKS (a sample). A few key pages are also compared pixel by pixel
      (pixelmatch) so what data can't see — a broken image, a wrong crop, a
      gradient — is still caught. VISUAL_PIXELS=all compares every page this
      way (slow); VISUAL_PIXELS=none turns it off; VISUAL_SAMPLE=/a/,/b/
      chooses the pages (default: the home page and the first index page of
      each top-level section, up to 8).

   Mark live or random content with data-visual-ignore (left out of both).
   Env: SITE_URL, VISUAL_MODE, VISUAL_MAX_ITEMS (layout), VISUAL_MAX_DIFF (pixels), VISUAL_WORKERS (default 6),
   VISUAL_ONLY=/a/,/b/ (just these pages — for iterating, never a pass).
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
const WORKERS = Math.max(1, Number(process.env.VISUAL_WORKERS || 6));
const MODE = process.env.VISUAL_MODE === "layout" ? "layout" : "pixels";
const PIXELS = (process.env.VISUAL_PIXELS || (MODE === "pixels" ? "all" : "sample")).toLowerCase();
const WIDTHS = [390, 1280];
const POS_TOL = 3; // px: a box that moved or resized by no more than this is the same
const MAX_ITEMS = Number(process.env.VISUAL_MAX_ITEMS || 0.02); // share of a page's items that may differ

// Bumped when the capture changes in a way that changes what is recorded
// (2: scroll-revealed content; 3: the layout data check). A baseline from an
// older capture can't be compared fairly.
const CAPTURE = 3;

const out = join(DIR, BASELINE ? "baseline" : "current");
mkdirSync(out, { recursive: true });
mkdirSync(join(DIR, "diff"), { recursive: true });
if (!BASELINE && !existsSync(join(DIR, "baseline", "index.json"))) {
    console.log(`FAIL  visual: no baseline — take it in P0 before changing the site: node visual.mjs --baseline --dir ${DIR}`);
    process.exit(1);
}
let base = null;
if (!BASELINE) {
    base = JSON.parse(readFileSync(join(DIR, "baseline", "index.json"), "utf8"));
    if ((base.mode || "pixels") !== MODE) {
        console.log(`FAIL  visual: the baseline was taken in ${base.mode || "pixels"} mode, this run is ${MODE} — use the same VISUAL_MODE for both`);
        process.exit(1);
    }
    if ((base.capture || 1) < CAPTURE) {
        console.log(`FAIL  visual: the baseline was taken with capture v${base.capture || 1} (now v${CAPTURE}: layout data) — retake it on the P0 state of the site and say so in the report`);
        process.exit(1);
    }
}

const sitemap = await (await fetch(`${SITE}/sitemap.xml`)).text().catch(() => "");
let paths = [...new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => {
    try {
        return new URL(m[1].trim()).pathname;
    } catch {
        return null;
    }
}).filter(Boolean))];
if (!paths.includes("/")) paths.unshift("/");
const ONLY = (process.env.VISUAL_ONLY || "").split(",").filter(Boolean);
if (ONLY.length) paths = ONLY;

// The pixel sample: the home page and the first index page of each top-level section.
const sample = (() => {
    if (PIXELS === "none") return new Set();
    if (PIXELS === "all") return new Set(paths);
    if (process.env.VISUAL_SAMPLE) return new Set(process.env.VISUAL_SAMPLE.split(",").filter(Boolean));
    const picked = new Set(["/"]);
    const seen = new Set();
    for (const p of paths) {
        const top = p.split("/").filter(Boolean)[0];
        if (!top || seen.has(top) || picked.size >= 8) continue;
        seen.add(top);
        picked.add(`/${top}/`);
    }
    return new Set([...picked].filter((p) => paths.includes(p)));
})();

const fileName = (width, path, ext) => `${width}${path.replace(/\//g, "_") || "_"}.${ext}`;

/* ---------------------------------------------------------------- capture */

// Runs in the page: the page as data. Positions are document coordinates.
function readLayout() {
    const SKIP = "script, style, noscript, template, [data-visual-ignore], [data-cms-adminbar], [data-cms-layer], [data-cms-consent-banner]";
    const shown = (el) => {
        if (typeof el.checkVisibility !== "function") return true;
        // Opacity is not checked: a scroll-reveal that has not fired yet is the same layout as one that has.
        return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true });
    };
    const box = (r) => ({ x: Math.round((r.left + scrollX) * 10) / 10, y: Math.round((r.top + scrollY) * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 });
    const items = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent.replace(/\s+/g, " ").trim();
        const el = node.parentElement;
        if (!text || !el || el.closest(SKIP) || !shown(el)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue; // visually-hidden text (sr-only) is 1px
        const cs = getComputedStyle(el);
        items.push({ k: "t", key: text, ...box(r), fs: cs.fontSize, fw: cs.fontWeight, c: cs.color, ff: cs.fontFamily.split(",")[0].trim(), tt: cs.textTransform });
    }
    for (const el of document.body.querySelectorAll("img, svg, canvas, video")) {
        if (el.closest(SKIP) || !shown(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        let src = el.currentSrc || el.getAttribute("src") || el.tagName.toLowerCase();
        // Optimised images (/_next/image?url=…) are named by the file they serve, whatever host or size was asked for.
        const wrapped = src.match(/[?&]url=([^&]+)/);
        if (wrapped) src = decodeURIComponent(wrapped[1]);
        items.push({ k: "i", key: src.split("?")[0].split("/").pop() || src, ...box(r) });
    }
    for (const el of document.body.querySelectorAll("*")) {
        if (el.closest(SKIP) || !shown(el)) continue;
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor;
        const hasBg = bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
        const img = cs.backgroundImage && cs.backgroundImage !== "none" ? cs.backgroundImage.slice(0, 60) : "";
        if (!hasBg && !img) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < 1500) continue;
        items.push({ k: "b", key: `${hasBg ? bg : ""}|${img}`, ...box(r), br: cs.borderRadius });
    }
    return { height: document.documentElement.scrollHeight, items };
}

const layouts = {};
const shots = {};

async function capture(page, width, path) {
    // A slow third-party image must not abort the run: wait for the load event, then settle for the parsed page.
    await page.goto(`${SITE}${path}`, { waitUntil: "load", timeout: 60000 }).catch(() => page.goto(`${SITE}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 }));
    await page.evaluate(async (fast) => {
        // Reveal every in-view (scroll-triggered) element: steps with a short pause so observers fire, and a stop at
        // the very bottom (the page may grow while scrolling).
        const pause = (ms) => new Promise((r) => setTimeout(r, ms));
        // Pixel mode scrolls slowly enough for every reveal to fire; layout mode only needs the boxes in place.
        const step = fast ? 400 : 300;
        const dwell = fast ? 70 : 120;
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await pause(dwell);
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
        await pause(fast ? 400 : 700);
        // Bounded waits: images still loading, then the page height holding still (both change what is captured).
        for (const until = Date.now() + 4000; Date.now() < until && [...document.images].some((img) => !img.complete);) await pause(100);
        for (let last = -1, same = 0, i = 0; i < 6 && same < 2; i++) {
            const height = document.documentElement.scrollHeight;
            same = height === last ? same + 1 : 0;
            last = height;
            await pause(250);
        }
        window.scrollTo(0, 0);
        // The header and other scroll-linked parts finish their transition back to the top state.
        for (let i = 0; i < 10 && window.scrollY > 0; i++) await pause(100);
        await pause(fast ? 700 : 1200);
    }, MODE === "layout");
    if (MODE === "layout") {
        const layout = await page.evaluate(readLayout);
        const file = fileName(width, path, "json");
        writeFileSync(join(out, file), JSON.stringify(layout));
        layouts[`${width} ${path}`] = file;
    }
    if (sample.has(path)) {
        await page.evaluate(() => document.querySelectorAll("[data-cms-consent-banner], [data-visual-ignore], video, iframe").forEach((el) => { el.style.visibility = "hidden"; }));
        const name = fileName(width, path, "png");
        await page.screenshot({ path: join(out, name), fullPage: true, animations: "disabled", caret: "hide" });
        shots[`${width} ${path}`] = name;
    }
}

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
for (const width of WIDTHS) {
    // Pages are independent reads: WORKERS browser contexts take them from one queue.
    const queue = [...paths];
    const worker = async () => {
        const ctx = await browser.newContext({ viewport: { width, height: width < 800 ? 844 : 900 }, reducedMotion: "reduce" });
        // A visitor who already chose (no banner covering the page) — consent off.
        await ctx.addCookies([{ name: "cms_consent", value: encodeURIComponent(JSON.stringify({ v: "1", analytics: false, marketing: false })), url: SITE }]);
        const page = await ctx.newPage();
        for (let path = queue.shift(); path !== undefined; path = queue.shift()) await capture(page, width, path);
        await ctx.close();
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, paths.length) }, worker));
}
await browser.close();
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(out, "index.json"), JSON.stringify({ capture: CAPTURE, mode: MODE, at: new Date().toISOString(), layout: sorted(layouts), shots: sorted(shots) }, null, 1));

if (BASELINE) {
    console.log(`PASS  visual: baseline of ${paths.length * WIDTHS.length} page views (${MODE} mode, ${Object.keys(shots).length} screenshots) saved in ${out}`);
    process.exit(0);
}

/* ---------------------------------------------------------------- compare */

const sig = (item) => `${item.k}|${item.key}`;
const near = (a, b) => Math.abs(a - b) <= POS_TOL;
const kindName = (k) => (k === "t" ? "text" : k === "i" ? "image" : "block");

// Pairs every baseline item with the nearest unmatched current item of the same kind and content; returns the differences.
function compareLayouts(before, after) {
    const group = (items) => {
        const map = new Map();
        for (const item of items) {
            const key = sig(item);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(item);
        }
        return map;
    };
    const b = group(after.items);
    const problems = [];
    for (const item of [...before.items].sort((p, q) => p.y - q.y || p.x - q.x)) {
        const label = `${kindName(item.k)} “${String(item.key).slice(0, 40)}”`;
        const pool = b.get(sig(item)) || [];
        let best = -1;
        let bestDistance = Infinity;
        pool.forEach((candidate, i) => {
            const distance = Math.abs(candidate.x - item.x) + Math.abs(candidate.y - item.y);
            if (distance < bestDistance) {
                best = i;
                bestDistance = distance;
            }
        });
        if (best < 0) {
            problems.push(`${label} is missing (was at ${Math.round(item.x)},${Math.round(item.y)})`);
            continue;
        }
        const [now] = pool.splice(best, 1);
        if (!near(item.x, now.x) || !near(item.y, now.y)) problems.push(`${label} moved (${Math.round(item.x)},${Math.round(item.y)} → ${Math.round(now.x)},${Math.round(now.y)})`);
        else if (!near(item.w, now.w) || !near(item.h, now.h)) problems.push(`${label} resized (${Math.round(item.w)}×${Math.round(item.h)} → ${Math.round(now.w)}×${Math.round(now.h)})`);
        else if (item.k === "t" && (item.fs !== now.fs || item.fw !== now.fw || item.c !== now.c || item.ff !== now.ff || item.tt !== now.tt)) {
            problems.push(`${label} restyled (${item.fs}/${item.fw}/${item.c} → ${now.fs}/${now.fw}/${now.c})`);
        } else if (item.k === "b" && item.br !== now.br) problems.push(`${label} corners changed (${item.br} → ${now.br})`);
    }
    for (const pool of b.values()) for (const item of pool) problems.push(`new ${kindName(item.k)} “${String(item.key).slice(0, 40)}” at ${Math.round(item.x)},${Math.round(item.y)}`);
    return problems;
}

let failed = 0;
let total = 0;
for (const [key, file] of Object.entries(layouts)) {
    if (!base.layout?.[key]) {
        console.log(`WARN  visual: ${key} is new (no baseline)`);
        continue;
    }
    total++;
    const before = JSON.parse(readFileSync(join(DIR, "baseline", base.layout[key]), "utf8"));
    const after = JSON.parse(readFileSync(join(out, file), "utf8"));
    const problems = compareLayouts(before, after);
    const heightChange = Math.abs(before.height - after.height) / before.height;
    const ratio = problems.length / Math.max(1, before.items.length);
    const ok = ratio <= MAX_ITEMS && heightChange <= 0.02;
    if (!ok) {
        failed++;
        writeFileSync(join(DIR, "diff", file.replace(/\.json$/, ".txt")), problems.join("\n"));
    }
    console.log(`${ok ? "PASS" : "FAIL"}  visual: ${key} layout matches its baseline  — ${problems.length} of ${before.items.length} items differ (${(ratio * 100).toFixed(2)}%), height ${(heightChange * 100).toFixed(1)}%${ok ? "" : ` · first: ${problems.slice(0, 3).join(" | ")}`}`);
}
for (const key of Object.keys(base.layout || {})) if (!layouts[key] && !ONLY.length) console.log(`WARN  visual: ${key} is gone (was in the baseline)`);

// The sample: pixel by pixel.
for (const [key, name] of Object.entries(shots)) {
    if (!base.shots?.[key]) {
        console.log(`WARN  visual: ${key} has no baseline screenshot`);
        continue;
    }
    total++;
    const a = PNG.sync.read(readFileSync(join(DIR, "baseline", base.shots[key])));
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
    console.log(`${ok ? "PASS" : "FAIL"}  visual: ${key} looks like its baseline  — ${(ratio * 100).toFixed(2)}% pixels differ, height ${(heightChange * 100).toFixed(1)}%`);
}
console.log(`\nvisual: ${total - failed}/${total} checks pass${failed ? ` — details in ${join(DIR, "diff")}` : ""}`);
process.exit(failed ? 1 : 0);
