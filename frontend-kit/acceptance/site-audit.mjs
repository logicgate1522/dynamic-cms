#!/usr/bin/env node
/* =========================================================================
   Site audit — SEO, consistency, data and forms, across EVERY page.
   Complements acceptance.mjs (which tests the editor). Run it against the
   production build:

     SITE_URL=http://localhost:3000 API_URL=http://localhost:8000 \
     CMS_USER=… CMS_PASSWORD=… [FORM_PAGE=/contact] [LAUNCH=1] \
     node site-audit.mjs

   Fails on:
   - any sitemap URL that isn't 200, or is noindex
   - missing/duplicate titles and descriptions; titles > 65 or < 25 chars;
     descriptions outside 110–165 chars
   - canonical missing or pointing elsewhere; og:title/description/image or
     twitter:card missing; no <html lang>
   - not exactly one <h1>; heading levels that skip (h1 → h3)
   - invalid JSON-LD; no BreadcrumbList (except home); articles without
     Article/BlogPosting; FAQ pages without FAQPage
   - <img> without alt
   - broken internal links; robots.txt without a Sitemap line, or one whose
     origin differs from the canonicals
   - contact details that disagree: more than one phone number or email
     across tel:/mailto: links and the Organization JSON-LD
   - the form on FORM_PAGE: empty submit must be blocked client-side, a valid
     submit must succeed and be stored
   - content truth and structure (R26–R29):
     - claims to confirm (client counts, ratings, "fixed fees", credentials,
       visible testimonials) — warnings; with LAUNCH=1 they fail unless the
       owner confirmed them (CLAIMS_CONFIRMED=1)
     - a phone number or email on a page that isn't in SiteSettings.contact,
       or the private form-notification address shown anywhere
     - headings inside <footer> (use styled text); a page whose first
       heading isn't its <h1>
     - a collection entry not linked from its index page; entries under
       ENTRY_MIN_WORDS (default 600) words of main content; a FORM_PAGE with
       under 120 words besides the form
   With LAUNCH=1 it also fails on launch blockers (placeholder text on pages,
   GET launch-check/: localhost site URL, leads that notify nobody, email not
   really sent, indexing off…). Without LAUNCH they are printed as warnings.

   Setup: npm i playwright && npx playwright install chromium
   The submission it creates is deleted again at the end.
========================================================================= */

import { chromium } from "playwright";

const SITE = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
const API = `${(process.env.API_URL || "http://localhost:8000").replace(/\/+$/, "")}/api`;
const { CMS_USER, CMS_PASSWORD } = process.env;
const FORM_PAGE = process.env.FORM_PAGE || "/contact";
const LAUNCH = process.env.LAUNCH === "1";
// Mirrors CLAIMS in api/launch_check.py (R26).
const CLAIMS = /\b\d{2,}[,\d]*\s?\+(?=\s|$|[^\w])|\b\d(?:\.\d)?\s?\/\s?5\b|★{3,}|\b\d{2,3}\s?%\s*(?:client|customer|satisf|success|retention)|\b\d+\+?\s*years?\s+(?:of\s+)?experience|\b(?:trusted|chosen|used)\s+by\s+(?:over\s+)?\d|\bfixed[- ](?:fees?|prices?|pricing)\b|\baward[- ]winning\b|\bchartered\b|\bregistered\s+agents?\b/gi;
const ENTRY_MIN_WORDS = Number(process.env.ENTRY_MIN_WORDS || 600);
const PLACEHOLDER = /\[(?:insert|registered|company|your|add|todo)[^\]]*\]|\b0{4}\s?0{6}\b|@example\.(?:com|org|co\.uk)\b|lorem ipsum|\bTBD\b|\bNew section\b|Write the first paragraph|Describe the offer in one|\bEyebrow\b/gi;

const results = [];
const fail = (where, what) => results.push({ level: "FAIL", where, what });
const warn = (where, what) => results.push({ level: "WARN", where, what });
const launch = (where, what) => (LAUNCH ? fail : warn)(where, `[launch] ${what}`);

const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
);
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

/* ---------- sitemap + robots ---------- */
const sitemap = await (await fetch(`${SITE}/sitemap.xml`)).text();
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (!urls.length) fail("/sitemap.xml", "no URLs");
const robots = await (await fetch(`${SITE}/robots.txt`)).text();
const robotsSitemap = robots.match(/^Sitemap:\s*(\S+)/im)?.[1];
if (!robotsSitemap) fail("/robots.txt", "no Sitemap: line");

/* ---------- every page ---------- */
const titles = {};
const phones = new Map(); // normalised number -> pages
const emails = new Map();
const pageWords = new Map();
const pageLinks = new Map();
const publicSettings = await (await fetch(`${API}/settings/site/`)).json().catch(() => ({}));
const allowedPhone = String(publicSettings.contact?.phone || "").replace(/\(0\)/g, "").replace(/[^\d]/g, "").replace(/^44/, "0");
const allowedEmail = String(publicSettings.contact?.email || "").toLowerCase().trim();
const notifyAddress = String(publicSettings.forms?.notifyEmail || "").toLowerCase().trim();
const note = (map, value, path) => { if (!map.has(value)) map.set(value, new Set()); map.get(value).add(path); };
const descriptions = {};
const links = new Map();
let canonicalOrigin = null;
for (const url of urls) {
    const path = new URL(url).pathname;
    const res = await page.goto(`${SITE}${path}`, { waitUntil: "load" });
    if (res.status() !== 200) {
        fail(path, `in the sitemap but returns ${res.status()}`);
        continue;
    }
    const m = await page.evaluate(() => {
        const q = (s, a = "content") => document.querySelector(s)?.getAttribute(a) || "";
        return {
            title: document.title,
            desc: q('meta[name="description"]'),
            canonical: q('link[rel="canonical"]', "href"),
            robots: q('meta[name="robots"]'),
            og: [q('meta[property="og:title"]'), q('meta[property="og:description"]'), q('meta[property="og:image"]')],
            twitter: q('meta[name="twitter:card"]'),
            lang: document.documentElement.lang,
            h1: document.querySelectorAll("h1").length,
            levels: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1])),
            ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
                try {
                    return JSON.parse(s.textContent);
                } catch (e) {
                    return { __error: e.message };
                }
            }),
            noAlt: [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt")).length,
            hrefs: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
            tel: [...document.querySelectorAll('a[href^="tel:"]')].map((a) => a.getAttribute("href").slice(4)),
            mail: [...document.querySelectorAll('a[href^="mailto:"]')].map((a) => a.getAttribute("href").slice(7).split("?")[0]),
            text: document.body.innerText,
            footerHeadings: document.querySelectorAll("footer h1, footer h2, footer h3").length,
            // Visible headings only: hidden mobile/desktop twins don't count.
            firstHeading: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].find((h) => h.offsetParent !== null && h.getClientRects().length)?.tagName || "",
            mainWords: (() => {
                const main = document.querySelector("main")?.cloneNode(true);
                if (!main) return 0;
                main.querySelectorAll("header, footer, nav, form, script, style").forEach((n) => n.remove());
                return (main.textContent || "").split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
            })(),
        };
    });
    if (!m.title) fail(path, "no <title>");
    else {
        (titles[m.title] ||= []).push(path);
        if (m.title.length > 65 || m.title.length < 25) fail(path, `title is ${m.title.length} chars (25–65): “${m.title}”`);
    }
    if (!m.desc) fail(path, "no meta description");
    else {
        (descriptions[m.desc] ||= []).push(path);
        if (m.desc.length < 110 || m.desc.length > 165) fail(path, `meta description is ${m.desc.length} chars (110–165)`);
    }
    if (!m.canonical) fail(path, "no canonical");
    else {
        const c = new URL(m.canonical);
        canonicalOrigin ||= c.origin;
        if (c.pathname.replace(/\/$/, "") !== path.replace(/\/$/, "")) fail(path, `canonical points to ${m.canonical}`);
    }
    if (/noindex/i.test(m.robots)) fail(path, `listed in the sitemap but robots says “${m.robots}”`);
    if (!m.og[0] || !m.og[1]) fail(path, "og:title / og:description missing");
    if (!m.og[2]) fail(path, "no og:image (set a page image or seoDefaults.defaultOgImage)");
    if (!m.twitter) fail(path, "no twitter:card");
    if (!m.lang) fail(path, "no <html lang>");
    if (m.h1 !== 1) fail(path, `${m.h1} <h1> elements (need exactly 1)`);
    for (let i = 1; i < m.levels.length; i++) {
        if (m.levels[i] - m.levels[i - 1] > 1) {
            fail(path, `heading levels skip h${m.levels[i - 1]} → h${m.levels[i]}`);
            break;
        }
    }
    if (!m.ld.length) fail(path, "no JSON-LD");
    m.ld.filter((d) => d.__error).forEach((d) => fail(path, `invalid JSON-LD: ${d.__error}`));
    const types = m.ld.flatMap((d) => (d["@graph"] || [d]).flatMap((n) => [].concat(n["@type"] || [])));
    if (path !== "/" && !types.includes("BreadcrumbList")) fail(path, "no BreadcrumbList in JSON-LD");
    if (/^\/(blog|news|articles?)\//.test(path) && !types.some((t) => /Article|BlogPosting/.test(t))) fail(path, "article page without Article/BlogPosting schema");
    if (/\/faqs?$/.test(path) && !types.includes("FAQPage")) fail(path, "FAQ page without FAQPage schema");
    if (m.noAlt) fail(path, `${m.noAlt} <img> without alt`);
    // Contact details: every tel:/mailto: link and the JSON-LD must agree.
    const ldNodes = m.ld.flatMap((d) => d["@graph"] || [d]);
    const ldTel = ldNodes.flatMap((n) => [n.telephone, ...[].concat(n.contactPoint || []).map((c) => c?.telephone)]).filter(Boolean);
    const ldMail = ldNodes.flatMap((n) => [n.email, ...[].concat(n.contactPoint || []).map((c) => c?.email)]).filter(Boolean);
    const digits = (t) => String(t).replace(/\(0\)/g, "").replace(/[^\d]/g, "").replace(/^44/, "0").replace(/^00/, "");
    [...m.tel, ...ldTel].forEach((t) => note(phones, digits(t), path));
    [...m.mail, ...ldMail].forEach((e) => note(emails, String(e).toLowerCase().trim(), path));
    // R26–R29: truthful claims, contact details from one source, structure.
    const claims = [...new Set(m.text.match(CLAIMS) || [])];
    if (claims.length) {
        const say = LAUNCH && process.env.CLAIMS_CONFIRMED !== "1" ? fail : warn;
        say(path, `[claims] confirm with the owner or remove: ${claims.slice(0, 5).join(" | ")}`);
    }
    for (const t of m.tel) if (digits(t) !== allowedPhone) fail(path, `phone ${t} is shown but SiteSettings.contact.phone is “${publicSettings.contact?.phone || "empty"}” — contact details come only from there`);
    for (const e of m.mail) if (e.toLowerCase().trim() !== allowedEmail) fail(path, `email ${e} is shown but SiteSettings.contact.email is “${allowedEmail || "empty"}” — contact details come only from there`);
    if (notifyAddress.includes("@") && m.text.toLowerCase().includes(notifyAddress)) fail(path, "the private form-notification address is shown on the page");
    if (m.footerHeadings) fail(path, `${m.footerHeadings} heading(s) inside <footer> — style footer titles as text, not h1–h3`);
    if (m.firstHeading && m.firstHeading !== "H1") fail(path, `the first heading is ${m.firstHeading.toLowerCase()}, not the page's <h1>`);
    pageWords.set(path, m.mainWords);
    pageLinks.set(path, new Set(m.hrefs.map((h) => (h || "").replace(SITE, "").split("#")[0].split("?")[0])));
    const placeholders = [...new Set(m.text.match(PLACEHOLDER) || [])];
    if (placeholders.length) launch(path, `placeholder text on the page: ${placeholders.slice(0, 5).join(" | ")}`);
    for (const href of m.hrefs) {
        if (!href || /^(#|mailto:|tel:|javascript:)/.test(href) || (/^https?:/.test(href) && !href.startsWith(SITE))) continue;
        const clean = href.replace(SITE, "").split("#")[0].split("?")[0] || "/";
        if (!links.has(clean)) links.set(clean, new Set());
        links.get(clean).add(path);
    }
}
if (phones.size > 1) fail("site", `${phones.size} different phone numbers across the site: ${[...phones].map(([n, p]) => `${n} (${[...p].slice(0, 2).join(", ")})`).join(" vs ")}`);
if (emails.size > 1) fail("site", `${emails.size} different email addresses across the site: ${[...emails].map(([e, p]) => `${e} (${[...p].slice(0, 2).join(", ")})`).join(" vs ")}`);
for (const [title, paths] of Object.entries(titles)) if (paths.length > 1) fail(paths.join(", "), `duplicate title “${title}”`);
for (const [desc, paths] of Object.entries(descriptions)) if (paths.length > 1) fail(paths.join(", "), `duplicate description “${desc.slice(0, 50)}…”`);
if (robotsSitemap && canonicalOrigin && new URL(robotsSitemap).origin !== canonicalOrigin) {
    fail("/robots.txt", `Sitemap origin ${new URL(robotsSitemap).origin} ≠ canonical origin ${canonicalOrigin}`);
}
if (canonicalOrigin && /localhost|127\.0\.0\.1/.test(canonicalOrigin)) launch("site", `canonicals use ${canonicalOrigin} — set seoDefaults.siteUrl to the live domain`);

/* ---------- internal links ---------- */
const listed = new Set(urls.map((u) => new URL(u).pathname));
for (const [href, from] of links) {
    if (href.startsWith("/admin") || href.startsWith("/_next")) continue;
    const r = await fetch(`${SITE}${href}`, { redirect: "manual" });
    if (r.status >= 400) fail(href, `broken link (${r.status}) on ${[...from].slice(0, 3).join(", ")}`);
    else if (r.status === 200 && !listed.has(href) && !/\.\w+$/.test(href)) warn(href, `linked from ${[...from].slice(0, 2).join(", ")} but not in the sitemap`);
}

/* ---------- forms, end to end ---------- */
let created = null;
let token = null;
if (CMS_USER && CMS_PASSWORD) {
    const r = await fetch(`${API}/auth/login/`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: CMS_USER, username: CMS_USER, password: CMS_PASSWORD }) });
    token = r.ok ? (await r.json()).key : null;
}
{
    const posts = [];
    page.on("request", (r) => r.method() === "POST" && r.url().includes("/forms/") && posts.push(r.url()));
    await page.goto(`${SITE}${FORM_PAGE}`, { waitUntil: "load" });
    const forms = page.locator("form").filter({ has: page.locator('input[type="email"]') });
    let form = null;
    for (let i = 0; i < (await forms.count()); i++) if (await forms.nth(i).isVisible()) form = form || forms.nth(i);
    if (!form) fail(FORM_PAGE, "no visible form with an email field");
    else {
        await form.locator('button[type="submit"], input[type="submit"]').first().click();
        await page.waitForTimeout(500);
        if (posts.length) fail(FORM_PAGE, "an empty form was submitted to the server (no client-side validation)");
        const tag = `Audit ${Date.now().toString(36)}`;
        const inputs = form.locator("input:visible, textarea:visible, select:visible");
        for (let i = 0; i < (await inputs.count()); i++) {
            const el = inputs.nth(i);
            if ((await el.getAttribute("type")) === "file") continue;
            // Spam traps are visible to bots, not people — never fill them.
            if (await el.evaluate((n) => n.tabIndex < 0 || !!n.closest('[aria-hidden="true"]'))) continue;
            // Date/time pickers may show a text placeholder until focused.
            await el.focus().catch(() => {});
            const type = (await el.getAttribute("type")) || (await el.evaluate((n) => n.tagName.toLowerCase()));
            if (["submit", "button", "hidden", "file"].includes(type)) continue;
            if (type === "checkbox" || type === "radio") await el.check().catch(() => {});
            else if (type === "select") await el.selectOption({ index: 1 }).catch(() => {});
            else if (type === "email") await el.fill("audit@example.org");
            else if (type === "tel") await el.fill("07700 900123");
            else if (type === "number" || type === "range") await el.fill("1");
            else if (type === "date") await el.fill("2030-01-01");
            else if (type === "time") await el.fill("10:30");
            else if (type === "datetime-local") await el.fill("2030-01-01T10:30");
            else if (type === "url") await el.fill("https://example.org");
            else await el.fill(tag);
        }
        const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/forms/"), { timeout: 10000 }).catch(() => null);
        await form.locator('button[type="submit"], input[type="submit"]').first().click();
        const res = await response;
        if (!res) fail(FORM_PAGE, "valid form never reached the server");
        else if (res.status() >= 300) fail(FORM_PAGE, `valid submit returned ${res.status()}: ${(await res.text()).slice(0, 120)}`);
        else if (token) {
            const name = res.url().match(/forms\/([^/]+)\/submit/)?.[1];
            const list = await (await fetch(`${API}/forms/${name}/submissions/`, { headers: { Authorization: `Token ${token}` } })).json();
            created = (list.results || list).find((s) => JSON.stringify(s).includes(tag));
            if (!created) fail(FORM_PAGE, "submission was accepted but not stored");
            else if (created.is_spam) fail(FORM_PAGE, "a genuine submission was stored as spam");
            else created.form = name;
        }
    }
}

/* ---------- collections: every entry linked from its index, and substantial (R28) ---------- */
if (token) {
    const r = await fetch(`${API}/collections/`, { headers: { Authorization: `Token ${token}` } });
    for (const col of r.ok ? await r.json() : []) {
        const index = `/${col.indexPath || ""}`.replace(/\/+$/, "") || "/";
        const entries = await (await fetch(`${API}/collections/${col.key}/entries/`, { headers: { Authorization: `Token ${token}` } })).json().catch(() => []);
        for (const entry of (entries.results || entries).filter((e) => e.status === "published" && e.href)) {
            if (pageLinks.has(index) && !pageLinks.get(index).has(entry.href)) fail(entry.href, `not linked from its index page ${index}`);
            const words = pageWords.get(entry.href);
            if (col.hostKind === "content" && words !== undefined && words < ENTRY_MIN_WORDS) fail(entry.href, `${words} words of content (${col.label} pages need ≥ ${ENTRY_MIN_WORDS})`);
        }
    }
}
if (pageWords.has(FORM_PAGE) && pageWords.get(FORM_PAGE) < 120) fail(FORM_PAGE, `${pageWords.get(FORM_PAGE)} words besides the form — say what happens after someone submits it`);

/* ---------- launch check ---------- */
if (token) {
    const r = await fetch(`${API}/launch-check/`, { headers: { Authorization: `Token ${token}` } });
    if (r.ok) {
        for (const item of (await r.json()).items) {
            (item.level === "blocker" ? launch : warn)("launch-check", `${item.label}${item.detail ? ` — ${item.detail.slice(0, 160)}` : ""}`);
        }
    }
    if (created?.id) {
        await fetch(`${API}/forms/${created.form}/submissions/${created.id}/`, { method: "DELETE", headers: { Authorization: `Token ${token}` } }).catch(() => {});
    }
} else {
    warn("launch-check", "set CMS_USER / CMS_PASSWORD to verify stored submissions and run the launch check");
}

await browser.close();
const fails = results.filter((r) => r.level === "FAIL");
for (const r of [...fails, ...results.filter((x) => x.level === "WARN")]) console.log(`${r.level}  ${r.where.padEnd(34)} ${r.what}`);
console.log(`\n${urls.length} pages, ${links.size} internal links, ${fails.length} failure(s), ${results.length - fails.length} warning(s)${LAUNCH ? " (launch mode)" : ""}`);
process.exit(fails.length ? 1 : 0);
