#!/usr/bin/env node
/* =========================================================================
   Look-alike check (R9): the site's content is the same after the CMS
   integration. A CODE check: no browser, no screenshots — it runs in seconds.

     # P0, BEFORE changing anything (the site as it is today):
     SITE_URL=http://localhost:3000 node visual.mjs --baseline --dir <frontend>/.gates/visual
     # later (run-gates.mjs does this for you):
     SITE_URL=http://localhost:3000 node visual.mjs --dir <frontend>/.gates/visual

   Every sitemap page is fetched as a visitor gets it (the server-rendered
   HTML) and reduced to what a visitor can read and follow: the visible words
   in reading order, the headings, every link (where it goes) and every image
   (which file, its alt text). Each page is compared with the P0 baseline; a
   page fails when its words, links or images differ. The report names the
   first words/links/images that changed, so the fix is obvious.

   What it proves: the defaults are the original copy, verbatim (R9), links
   and images are all still there, nothing was dropped or reworded. What it
   does not look at: colours, spacing and fonts — keep the original classes
   when converting a component (the converters do), and review the site once
   by eye. <head> metadata (title, description) is R34's job, not this one's.

   Mark content that is meant to differ per visit with data-visual-ignore
   (left out of both runs). Env: SITE_URL, VISUAL_ONLY=/a/,/b/ (just these
   pages — for iterating, never a pass).
========================================================================= */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
const args = process.argv.slice(2);
const BASELINE = args.includes("--baseline");
const DIR = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : ".gates/visual";
const CAPTURE = 4; // bumped when what is recorded changes; an older baseline can't be compared
const out = join(DIR, BASELINE ? "baseline" : "current");
mkdirSync(out, { recursive: true });
mkdirSync(join(DIR, "diff"), { recursive: true });

let base = null;
if (!BASELINE) {
    if (!existsSync(join(DIR, "baseline", "index.json"))) {
        console.log(`FAIL  visual: no baseline — take it in P0 before changing the site: node visual.mjs --baseline --dir ${DIR}`);
        process.exit(1);
    }
    base = JSON.parse(readFileSync(join(DIR, "baseline", "index.json"), "utf8"));
    if ((base.capture || 1) < CAPTURE) {
        console.log(`FAIL  visual: the baseline was taken with capture v${base.capture || 1} (now v${CAPTURE}: a code check on the page's words, links and images) — retake it on the P0 state of the site and say so in the report`);
        process.exit(1);
    }
}

/* ------------------------------------------------------------ the reader */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", middot: "·", rarr: "→", copy: "©" };
const decode = (t) => t
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);

// Removes whole elements (balanced) whose opening tag matches `test`.
function dropElements(html, test) {
    const tag = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
    let out = "";
    let last = 0;
    let match;
    let skipDepth = 0;
    let skipName = "";
    while ((match = tag.exec(html))) {
        const [whole, closing, name, attrs, selfClosing] = match;
        const lower = name.toLowerCase();
        if (skipDepth) {
            if (lower === skipName) skipDepth += closing ? -1 : selfClosing || VOID.has(lower) ? 0 : 1;
            if (!skipDepth) last = tag.lastIndex;
            continue;
        }
        if (!closing && test(lower, attrs)) {
            out += html.slice(last, match.index);
            if (selfClosing || VOID.has(lower)) {
                last = tag.lastIndex;
            } else {
                skipDepth = 1;
                skipName = lower;
            }
        }
    }
    return out + (skipDepth ? "" : html.slice(last));
}

function readPage(html) {
    let body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, html])[1];
    body = body.replace(/<!--[\s\S]*?-->/g, "");
    body = body.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ");
    body = dropElements(body, (_name, attrs) => /\bdata-visual-ignore\b|\bdata-cms-adminbar\b|\bdata-cms-layer\b|\bdata-cms-consent-banner\b/.test(attrs));
    const attr = (attrs, key) => decode((attrs.match(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i")) || [])[1] ?? (attrs.match(new RegExp(`\\b${key}\\s*=\\s*'([^']*)'`, "i")) || [])[1] ?? "");
    const links = [];
    const images = [];
    for (const m of body.matchAll(/<a\b([^>]*)>/gi)) {
        const href = attr(m[1], "href");
        // The staff entry points (/admin/…) are the CMS's own, not the site's content.
        if (href && !/^(javascript:|#$|\/admin(\/|\?|$))/.test(href)) links.push(href.replace(/^https?:\/\/[^/]+/, "").replace(/(.)\/+$/, "$1"));
    }
    for (const m of body.matchAll(/<img\b([^>]*)>/gi)) {
        let src = attr(m[1], "src");
        const wrapped = src.match(/[?&]url=([^&]+)/); // /_next/image?url=… is named by the file it serves
        if (wrapped) src = decodeURIComponent(wrapped[1]);
        images.push(`${src.split("?")[0].split("/").pop() || src}|${attr(m[1], "alt")}`);
    }
    const headings = [...body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => `h${m[1]}: ${decode(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()}`);
    const text = decode(body.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    return { words: text.split(" ").filter(Boolean), headings, links: links.sort(), images: images.sort() };
}

/* ------------------------------------------------------------ the pages */

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

const pages = {};
const queue = [...paths];
await Promise.all(Array.from({ length: 8 }, async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const res = await fetch(`${SITE}${path}`, { headers: { "user-agent": "cms-visual-check" } }).catch(() => null);
        pages[path] = res && res.ok ? readPage(await res.text()) : { error: res ? `HTTP ${res.status}` : "no response" };
    }
}));
const sorted = Object.fromEntries(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(out, "index.json"), JSON.stringify({ capture: CAPTURE, at: new Date().toISOString(), pages: sorted }));

if (BASELINE) {
    console.log(`PASS  visual: baseline of ${Object.keys(sorted).length} pages (words, headings, links, images) saved in ${out}`);
    process.exit(0);
}

/* ------------------------------------------------------------ compare */

// Multiset difference of two sorted-or-not lists: what was lost, what is new.
function listDiff(before, after) {
    const count = new Map();
    for (const item of after) count.set(item, (count.get(item) || 0) + 1);
    const lost = [];
    for (const item of before) {
        if (count.get(item)) count.set(item, count.get(item) - 1);
        else lost.push(item);
    }
    const had = new Map();
    for (const item of before) had.set(item, (had.get(item) || 0) + 1);
    const added = [];
    for (const item of after) {
        if (had.get(item)) had.set(item, had.get(item) - 1);
        else added.push(item);
    }
    return { lost, added };
}

// First place two word lists part ways, with a little context.
function firstDifference(before, after) {
    let i = 0;
    while (i < before.length && i < after.length && before[i] === after[i]) i++;
    const show = (words) => words.slice(Math.max(0, i - 3), i + 6).join(" ");
    return `at word ${i}: “${show(before)}” → “${show(after)}”`;
}

let failed = 0;
let checked = 0;
for (const [path, now] of Object.entries(sorted)) {
    const was = base.pages?.[path];
    if (!was) {
        console.log(`WARN  visual: ${path} is new (no baseline)`);
        continue;
    }
    checked++;
    const problems = [];
    if (now.error) problems.push(`the page failed to load (${now.error})`);
    else if (was.error) problems.push(`the baseline page had failed to load (${was.error}) — retake the baseline`);
    else {
        if (was.words.join(" ") !== now.words.join(" ")) problems.push(`words differ — ${firstDifference(was.words, now.words)}`);
        const links = listDiff(was.links, now.links);
        if (links.lost.length) problems.push(`links gone: ${links.lost.slice(0, 4).join(", ")}${links.lost.length > 4 ? ` (+${links.lost.length - 4})` : ""}`);
        if (links.added.length) problems.push(`links added: ${links.added.slice(0, 4).join(", ")}${links.added.length > 4 ? ` (+${links.added.length - 4})` : ""}`);
        const images = listDiff(was.images, now.images);
        if (images.lost.length) problems.push(`images gone: ${images.lost.slice(0, 3).join(", ")}${images.lost.length > 3 ? ` (+${images.lost.length - 3})` : ""}`);
        if (images.added.length) problems.push(`images added: ${images.added.slice(0, 3).join(", ")}${images.added.length > 3 ? ` (+${images.added.length - 3})` : ""}`);
    }
    const ok = !problems.length;
    if (!ok) {
        failed++;
        writeFileSync(join(DIR, "diff", `${path.replace(/\//g, "_") || "_"}.txt`), problems.join("\n"));
    }
    console.log(`${ok ? "PASS" : "FAIL"}  visual: ${path} has the same words, links and images as its baseline${ok ? "" : ` — ${problems.join(" | ")}`}`);
}
for (const path of Object.keys(base.pages || {})) if (!sorted[path] && !ONLY.length) console.log(`WARN  visual: ${path} is gone (was in the baseline)`);
console.log(`\nvisual: ${checked - failed}/${checked} pages match${failed ? ` — details in ${join(DIR, "diff")}` : ""}`);
process.exit(failed ? 1 : 0);
