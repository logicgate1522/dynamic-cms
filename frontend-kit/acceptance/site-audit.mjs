#!/usr/bin/env node
/* =========================================================================
   Site audit — SEO, consistency, data and forms, across EVERY page.
   Complements acceptance.mjs (which tests the editor). Run it against the
   production build:

     SITE_URL=http://localhost:3000 API_URL=http://localhost:8000 \
     CMS_USER=… CMS_PASSWORD=… [FORM_PAGE=/contact] [LAUNCH=1] \
     [AUDIT_JSON=<frontend>/.gates/seo-baseline.json] node site-audit.mjs

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
   - a search engine verification code set in Settings whose <meta> tag is
     missing from the home page <head>
   - broken internal links; robots.txt without a Sitemap line, or one whose
     origin differs from the canonicals
   - internal linking (R34, analysed by the backend's api/link_audit.py):
     orphan or unreachable pages, pages more than 3 clicks from home,
     offering pages linked from fewer than 2 pages' content, articles nobody
     links to from content, articles that don't link an offering and
     offerings that don't link an article, "read more"-style or empty
     anchors, links to redirected URLs, internal rel=nofollow; a page
     (legal pages aside) without its own primary keyword, or two pages
     sharing one
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
       heading isn't its <h1>; an H1 that shares no keyword with the title
     - a collection entry not linked from its index page; entries under
       ENTRY_MIN_WORDS (default 600) words of main content; a FORM_PAGE with
       under 120 words besides the form
   - article categories (R28): no list, the kit's placeholder list, or a
     published article outside it (launch-check item article-categories);
   - tracking (R31–R33): a plan that doesn't cover every lead form, offering
     page, booking/contact page and form segment option; pages tied to an
     offering without block markers;
     FAQ toggles without aria-expanded/<summary>; dangling plan triggers and
     an unapproved plan (warnings; failures with LAUNCH=1); a pre-ticked
     marketing opt-in; tags set but no consent banner / "Cookie settings";
     a privacy page that doesn't mention analytics cookies
   - responsive (R20), at RESPONSIVE_WIDTHS (default 390,1024): visible text
     smaller than 11px, or text pushed past the screen edge (after in-view
     animations have finished)
   With LAUNCH=1 it also fails on launch blockers (placeholder text on pages,
   GET launch-check/: localhost site URL, leads that notify nobody, email not
   really sent, indexing off…). Without LAUNCH they are printed as warnings.

   Setup (once, in this folder): npm run setup
   The submission it creates is deleted again at the end.
========================================================================= */

import { chromium } from "playwright";

const SITE = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
const API = `${(process.env.API_URL || "http://localhost:8000").replace(/\/+$/, "")}/api`;
const { CMS_USER, CMS_PASSWORD } = process.env;
const FORM_PAGE = process.env.FORM_PAGE || "/contact";
const LAUNCH = process.env.LAUNCH === "1";
// Mirrors CLAIMS in api/launch_check.py (R26).
const CLAIMS = /\b\d{2,}[,\d]*\s?\+(?=\s|$|[^\w])|\b\d(?:\.\d)?\s?\/\s?5\b|★{3,}|\b\d{2,3}\s?%\s*(?:client|customer|satisf|success|retention)|\b\d+\+?\s*years?\s+(?:of\s+)?experience|\b(?:trusted|chosen|used)\s+by\s+(?:over\s+)?\d|\bfixed[- ](?:fees?|prices?|pricing)\b|\baward[- ]winning\b|\b(?:certified|accredited|chartered)\b/gi;
const ENTRY_MIN_WORDS = Number(process.env.ENTRY_MIN_WORDS || 600);
const PLACEHOLDER = /\[(?:insert|registered|company|your|add|todo)[^\]]*\]|\b0{4}\s?0{6}\b|@example\.(?:com|org|co\.uk)\b|lorem ipsum|\bTBD\b|\bNew section\b|Write the first paragraph|Describe the offer in one|\bEyebrow\b/gi;

const results = [];
const proven = []; // checks that need the admin login; printed as PASS lines for run-gates (rules-map.json)
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
const linkPages = []; // R34: the rendered link graph, analysed by the backend
let linkReport = null; // the backend's analysis (summary, issues, suggestions), kept in AUDIT_JSON
const publicSettings = await (await fetch(`${API}/settings/site/`)).json().catch(() => ({}));
const allowedPhone = String(publicSettings.contact?.phone || "").replace(/\(0\)/g, "").replace(/[^\d]/g, "").replace(/^44/, "0");
const allowedEmail = String(publicSettings.contact?.email || "").toLowerCase().trim();
const notifyAddress = String(publicSettings.forms?.notifyEmail || "").toLowerCase().trim();

/* ---------- search engine verification (R25) ---------- */
// Every code set in Settings must be in the home page's <head> as the meta
// tag the search engine looks for, or "Verify" fails in its console.
{
    const VERIFY_META = { google: "google-site-verification", bing: "msvalidate.01", yandex: "yandex-verification", pinterest: "p:domain_verify", facebookDomain: "facebook-domain-verification" };
    const home = await (await fetch(`${SITE}/`)).text();
    const head = home.split(/<\/head>/i)[0];
    for (const [key, name] of Object.entries(VERIFY_META)) {
        const code = String(publicSettings.verification?.[key] || "").trim();
        if (!code) continue;
        const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const tag = new RegExp(`<meta[^>]*name="${esc(name)}"[^>]*content="${esc(code)}"|<meta[^>]*content="${esc(code)}"[^>]*name="${esc(name)}"`, "i");
        if (!tag.test(head)) fail("/", `verification.${key} is set but <meta name="${name}" content="${code}"> is not in the home page <head>`);
    }
    if (!["google", "bing"].some((k) => String(publicSettings.verification?.[k] || "").trim())) {
        warn("/", "no Google or Bing verification code in Settings (fine if the domain is verified by DNS) — see LAUNCH_GUIDE.md");
    }
}
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
            // R34: every internal link with its area, accessible text and rel,
            // for the backend link audit (api/link_audit.py).
            linkGraph: [...document.querySelectorAll("a[href]")].flatMap((a) => {
                let u;
                try { u = new URL(a.getAttribute("href"), location.href); } catch { return []; }
                if (u.origin !== location.origin || /^(mailto|tel|javascript):/i.test(a.getAttribute("href"))) return [];
                if (a.closest("[data-cms-layer], [data-cms-adminbar], [hidden], [aria-hidden='true']")) return [];
                const area = a.closest("header") ? "header" : a.closest("footer") ? "footer" : a.closest("nav, [data-track-nav]") ? "nav" : "main";
                const text = (a.getAttribute("aria-label") || a.textContent || [...a.querySelectorAll("img[alt]")].map((i) => i.alt).join(" ")).replace(/\s+/g, " ").trim();
                return [{ to: u.pathname.replace(/\/+$/, "") || "/", text: text.slice(0, 120), area, rel: a.getAttribute("rel") || "" }];
            }),
            mainText: (() => {
                const main = (document.querySelector("main") || document.body).cloneNode(true);
                // Copy only: text that is already a link can't become one.
                main.querySelectorAll("header, footer, nav, form, script, style, noscript, [hidden], a").forEach((n) => n.remove());
                return (main.textContent || "").replace(/\s+/g, " ").trim().slice(0, 6000);
            })(),
            tel: [...document.querySelectorAll('a[href^="tel:"]')].map((a) => a.getAttribute("href").slice(4)),
            mail: [...document.querySelectorAll('a[href^="mailto:"]')].map((a) => a.getAttribute("href").slice(7).split("?")[0]),
            text: document.body.innerText,
            // Text pieces joined with spaces: line-broken spans must not glue words
            // ("the" + "experts"), even when the H1 is a hidden twin.
            h1Text: (() => {
                const h1 = document.querySelector("h1");
                if (!h1) return "";
                const walker = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT);
                const parts = [];
                while (walker.nextNode()) parts.push(walker.currentNode.textContent);
                return parts.join(" ").replace(/\s+/g, " ").trim();
            })(),
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
    // R29: the H1 names the page's topic — it shares at least one meaningful
    // word with the (keyword-led) title. A slogan-only H1 fails.
    {
        // Drop the brand as a phrase (the title template appends it), not its words.
        const brandName = String(publicSettings.organization?.name || "").toLowerCase().trim();
        const STOP = new Set("about your with from that this what when where which their there have will into than then them they more most just only also every each very much many over under after before while home page".split(" "));
        const words = (t) => new Set((t.toLowerCase().match(/[a-z]{4,}/g) || []).map((w) => w.replace(/(ies)$/, "y").replace(/s$/, "")).filter((w) => !STOP.has(w)));
        const titleWords = words((m.title || "").toLowerCase().split(brandName).join(" "));
        const shared = [...words(m.h1Text || "")].filter((w) => titleWords.has(w));
        if (m.h1Text && titleWords.size && !shared.length) fail(path, `H1 “${m.h1Text.slice(0, 60)}” shares no keyword with the title “${m.title}” — name the topic in the H1, keep slogans in the eyebrow/subtitle (R29)`);
    }
    pageWords.set(path, m.mainWords);
    linkPages.push({ path, title: m.title, h1: m.h1Text, text: m.mainText, links: m.linkGraph });
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

/* ---------- responsive: readable and nothing off-screen (R20) ---------- */
for (const width of (process.env.RESPONSIVE_WIDTHS || "390,1024").split(",").map(Number)) {
    await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
    for (const url of urls) {
        const path = new URL(url).pathname;
        if (process.env.AUDIT_DEBUG) console.error(`[responsive ${width}] ${path}`);
        await page.goto(`${SITE}${path}`, { waitUntil: "load" });
        // Scroll through slowly so in-view animations run, then let them finish.
        await page.evaluate(async () => {
            for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
            window.scrollTo(0, 0);
        });
        await page.waitForTimeout(1400);
        const r = await page.evaluate((vw) => {
            const out = { tiny: [], cut: [] };
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim().length > 2 ? 1 : 2) });
            const parents = new Set();
            while (walker.nextNode()) parents.add(walker.currentNode.parentElement);
            for (const el of parents) {
                if (!el || el.closest("[aria-hidden='true'], [data-cms-adminbar], [data-cms-layer], script, style, noscript, [inert]")) continue;
                const rect = el.getBoundingClientRect();
                if (!rect.width || !rect.height) continue;
                const cs = getComputedStyle(el);
                if (cs.visibility === "hidden" || cs.opacity === "0") continue;
                const text = el.textContent.trim().replace(/\s+/g, " ").slice(0, 40);
                if (parseFloat(cs.fontSize) < 11) out.tiny.push(`${parseFloat(cs.fontSize)}px “${text}”`);
                if (rect.right > vw + 2 || rect.left < -2) {
                    let clip = null;
                    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
                        const st = getComputedStyle(a);
                        if (/(hidden|clip)/.test(st.overflowX + st.overflow)) { clip = a.getBoundingClientRect(); break; }
                    }
                    const cut = clip ? rect.right > Math.min(clip.right, vw) + 2 || rect.left < Math.max(clip.left, 0) - 2 : true;
                    if (cut) out.cut.push(`“${text}” at ${Math.round(rect.left)}→${Math.round(rect.right)}`);
                }
            }
            return { tiny: [...new Set(out.tiny)], cut: [...new Set(out.cut)] };
        }, width);
        if (r.tiny.length) fail(path, `[${width}px] text smaller than 11px: ${r.tiny.slice(0, 4).join(" | ")}`);
        if (r.cut.length) fail(path, `[${width}px] text off the screen: ${r.cut.slice(0, 3).join(" | ")}`);
    }
}
await page.setViewportSize({ width: 1440, height: 900 });

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

/* ---------- tracking, consent, contacts (R31–R33) ---------- */
{
    const config = await (await fetch(`${API}/tracking/config/`)).json().catch(() => ({}));
    const a = publicSettings.analytics || {};
    const hasTags = ["gtmId", "ga4Id", "googleAdsId", "metaPixelId", "tiktokPixelId", "linkedinPartnerId", "clarityId", "hotjarId"].some((k) => String(a[k] || "").trim());
    // R31: every page tied to an offering carries block markers, so its clicks
    // and views are attributed; FAQ pages use accessible toggles.
    for (const path of Object.keys(config.pageIntents || {})) {
        const html = await (await fetch(`${SITE}${path}`)).text().catch(() => "");
        if (!/data-track-block=/.test(html)) fail(path, "no tracking block markers — blocks must render {editButton}, sections need the kit renderer (R31)");
    }
    for (const [path, type] of Object.entries(config.pageTypes || {})) {
        if (type !== "faq") continue;
        await page.goto(`${SITE}${path}`, { waitUntil: "load" });
        const toggles = await page.evaluate(() => document.querySelectorAll("main [aria-expanded], main summary").length);
        if (!toggles) fail(path, "FAQ answers have no aria-expanded / <summary> toggle — FAQ opens can't be tracked and screen readers can't tell (R31)");
    }
    if (token) {
        const state = await (await fetch(`${API}/tracking/plan/`, { headers: { Authorization: `Token ${token}` } })).json().catch(() => ({}));
        for (const d of state.report?.dangling || []) (LAUNCH ? fail : warn)("tracking", `trigger doesn't match the site: ${d}`);
        if (state.plan?.status !== "approved") (LAUNCH ? fail : warn)("tracking", "the tracking plan isn't approved (Site tools → Tracking)");
        // R31: the plan covers what the site has (tracking_plan.completeness):
        // every lead form, offering page, booking/contact page and "who are
        // you" option. A valid but thin plan is not done.
        for (const g of state.report?.gaps || []) fail("tracking", `plan incomplete: ${g} (R31)`);
        if (state.plan?.status === "approved" && Array.isArray(state.report?.gaps) && !state.report.gaps.length) {
            proven.push("tracking: the approved plan covers every lead form, offering page, booking page and segment");
        }
    }
    // R33: a marketing opt-in is never pre-ticked.
    await page.goto(`${SITE}${FORM_PAGE}`, { waitUntil: "load" });
    if (await page.evaluate(() => [...document.querySelectorAll("input[data-cms-field='consent_marketing']")].some((i) => i.checked))) {
        fail(FORM_PAGE, "the marketing opt-in is ticked before the visitor chooses (R33)");
    }
    // R32: with any tag set, a fresh visitor gets the banner and every page a way back to it.
    if (hasTags) {
        const ctx = await browser.newContext();
        const v = await ctx.newPage();
        await v.goto(`${SITE}/`, { waitUntil: "load" });
        await v.waitForTimeout(1500);
        const banner = await v.locator("[data-cms-consent-banner]").count();
        if (config.region !== "us" && !banner) fail("/", "tracking tags are set but no consent banner appears for a new visitor (R32)");
        if (!(await v.locator("[data-cms-consent-open]").count())) fail("/", "no “Cookie settings” control (data-cms-consent-open) — visitors can't change their choice (R32)");
        await ctx.close();
    }
    // R32/R33: the privacy page explains analytics cookies and enquiry records.
    const policy = urls.map((u) => new URL(u).pathname).find((p) => /privacy|legal|cookie/i.test(p));
    if (policy) {
        const text = (await (await fetch(`${SITE}${policy}`)).text()).replace(/<[^>]+>/g, " ").toLowerCase();
        if (hasTags && !(/cookie/.test(text) && /analytic/.test(text))) fail(policy, "the privacy/cookie policy doesn't mention analytics cookies (R32)");
        if (!/(keep|retain|store)[^.]{0,120}(month|year)/.test(text)) warn(policy, "the privacy policy doesn't say how long enquiry records are kept (R33)");
    } else if (hasTags) {
        fail("/", "no privacy/cookie policy page in the sitemap (R32)");
    }
}

/* ---------- internal links (R34) ---------- */
// The backend's link audit (api/link_audit.py) analyses the production
// build's link graph — the same analyser as Site tools → SEO → Internal links.
if (token) {
    const r = await fetch(`${API}/seo/links/analyze/`, {
        method: "POST", headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ pages: linkPages }),
    });
    if (!r.ok) fail("links", `seo/links/analyze/ → HTTP ${r.status}`);
    else {
        const a = await r.json();
        linkReport = a;
        for (const i of a.issues) (i.level === "fail" ? fail : warn)(i.path, `[${i.kind || "links"}] ${i.text} — ${i.fix} (R34)`);
        if (!a.summary.fail) proven.push(`links: every page is linked in context, within 3 clicks, with descriptive anchors (${a.summary.pages} pages, ${a.summary.links} links, ${a.summary.suggestions} suggestions)`);
        if (a.suggestions.length) warn("links", `${a.suggestions.length} suggested link(s), e.g. ${a.suggestions.slice(0, 3).map((x) => `${x.from}: [${x.anchor}](${x.to})`).join(" · ")}`);
    }
}

/* ---------- launch check ---------- */
if (token) {
    const r = await fetch(`${API}/launch-check/`, { headers: { Authorization: `Token ${token}` } });
    if (r.ok) {
        for (const item of (await r.json()).items) {
            const line = `${item.label}${item.detail ? ` — ${item.detail.slice(0, 160)}` : ""}`;
            // Article categories are the site's own (R28): fails at any level.
            if (item.id === "article-categories") fail("categories", `${line} (R28)`);
            else (item.level === "blocker" ? launch : warn)("launch-check", line);
        }
        if (!results.some((x) => x.where === "categories")) proven.push("categories: articles use the site's own category list");
    }
    if (created?.id) {
        // The audit's own enquiry also made a contact (R33): erase it with the submission.
        const found = await (await fetch(`${API}/contacts/?q=audit%40example.org`, { headers: { Authorization: `Token ${token}` } })).json().catch(() => ({}));
        for (const c of found.results || []) {
            await fetch(`${API}/contacts/${c.id}/erase/`, { method: "POST", headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "ERASE" }) }).catch(() => {});
        }
        await fetch(`${API}/forms/${created.form}/submissions/${created.id}/`, { method: "DELETE", headers: { Authorization: `Token ${token}` } }).catch(() => {});
    }
} else {
    warn("launch-check", "set CMS_USER / CMS_PASSWORD to verify stored submissions and run the launch check");
}

await browser.close();
const fails = results.filter((r) => r.level === "FAIL");
for (const r of [...fails, ...results.filter((x) => x.level === "WARN")]) console.log(`${r.level}  ${r.where.padEnd(34)} ${r.what}`);
for (const name of proven) console.log(`PASS  ${name}`);
console.log(`\n${urls.length} pages, ${links.size} internal links, ${fails.length} failure(s), ${results.length - fails.length} warning(s)${LAUNCH ? " (launch mode)" : ""}`);
// AUDIT_JSON=<file>: the full result as JSON. P0 writes the SEO baseline
// this way (<frontend>/.gates/seo-baseline.json, before anything changes);
// run-gates writes each pass's audit beside it, and CMS_REPORT.md compares them (R34).
if (process.env.AUDIT_JSON) {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(process.env.AUDIT_JSON), { recursive: true });
    writeFileSync(process.env.AUDIT_JSON, JSON.stringify({ at: new Date().toISOString(), site: SITE, pages: urls.length, internalLinks: links.size,
        fail: fails.length, warn: results.length - fails.length, results,
        links: linkReport && { summary: linkReport.summary, suggestions: linkReport.suggestions, pages: linkReport.pages } }, null, 1));
}
process.exit(fails.length ? 1 : 0);
