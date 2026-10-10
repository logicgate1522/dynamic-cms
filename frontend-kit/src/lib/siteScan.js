/* =========================================
   Site scan (R31): what the site looks like to a visitor, for the tracking
   plan's facts (backend site_facts.py). Run from the Tracking panel (the
   admin's browser) or the headless runner; POSTed to tracking/scan/.

   Reads /sitemap.xml, fetches every page's server-rendered HTML and
   collects: blocks (span[data-track-block] / [data-track-block]) with their
   headings, CTAs (links to pages that hold a form, and [data-track-cta]),
   header/footer navigation, FAQ questions ([aria-expanded] / <summary>),
   forms (form[data-cms-form] with field names, types and options),
   tel/mailto/WhatsApp links, downloads, outbound links and word counts.
   For the internal-link audit (R34, backend api/link_audit.py) it also keeps
   every internal link (target, accessible text, area: main/header/footer/
   nav, rel), the H1 and the main text. Site tools → SEO → Internal links
   runs the same scan.
========================================= */

const MAX_PAGES = 150;

function norm(href, base) {
    try {
        const u = new URL(href, base);
        if (u.origin !== new URL(base).origin) return null;
        return u.pathname.replace(/\/+$/, "") || "/";
    } catch {
        return null;
    }
}

function text(el) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function blockFor(el) {
    for (let node = el; node && node.tagName !== "BODY"; node = node.parentElement) {
        if (node.dataset?.trackBlock && node.tagName !== "SPAN") return node.dataset.trackBlock;
        const marker = node.querySelector?.(":scope > span[data-track-block]");
        if (marker) return marker.dataset.trackBlock;
    }
    return "";
}

function itemFor(el) {
    for (let node = el; node && node.tagName !== "BODY"; node = node.parentElement) {
        const marker = node.querySelector?.(":scope > span[data-track-item]");
        if (marker) return marker.dataset.trackItem;
    }
    return "";
}

function fields(form) {
    const out = new Map();
    for (const el of form.querySelectorAll("input, select, textarea")) {
        const name = el.name;
        if (!name || el.type === "hidden" || el.type === "submit") continue;
        const type = el.dataset.cmsField === "consent_marketing" ? "consent_marketing" : el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : el.type || "text";
        const entry = out.get(name) || { name, type: type === "checkbox" && out.has(name) ? "checkboxes" : type, options: [] };
        if (el.tagName === "SELECT") {
            for (const o of el.options) if (o.value) entry.options.push({ value: o.value, label: text(o) || o.value });
        } else if ((el.type === "checkbox" || el.type === "radio") && el.value && el.value !== "on") {
            entry.options.push({ value: el.value, label: text(el.closest("label")) || el.value });
            if (el.type === "checkbox") entry.type = "checkboxes";
        }
        out.set(name, entry);
    }
    return [...out.values()];
}

function parsePage(html, url) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const path = norm(url, url);
    const main = doc.querySelector("main") || doc.body;
    const blocks = [];
    const seen = new Set();
    for (const marker of doc.querySelectorAll("span[data-track-block], [data-track-block]:not(span)")) {
        const name = marker.dataset.trackBlock;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const root = marker.tagName === "SPAN" ? marker.parentElement : marker;
        const items = root ? [...root.querySelectorAll("span[data-track-item]")] : [];
        blocks.push({ name, heading: text(root?.querySelector("h1, h2, h3")).slice(0, 120), items: items.length,
            itemLabels: items.slice(0, 20).map((m) => text(m.parentElement?.querySelector("h3, h4, strong, [class*=title]") || m.parentElement).slice(0, 60)) });
    }
    const links = [...doc.querySelectorAll("a[href]")];
    const nav = [];
    for (const a of links) {
        const area = a.closest("header") ? "header" : a.closest("footer") ? "footer" : a.closest("[data-track-nav]") ? "menu" : "";
        const href = norm(a.getAttribute("href"), url);
        if (area && href) nav.push({ label: text(a).slice(0, 60), href, area });
    }
    const faqs = [];
    for (const el of doc.querySelectorAll("[aria-expanded], summary")) {
        if (el.closest("header, nav")) continue;
        const q = text(el);
        if (q.length >= 8 && q.length <= 200 && /\?$|^(how|what|when|why|do|does|can|is|are|will|should|who)\b/i.test(q)) {
            faqs.push({ question: q, block: blockFor(el), item: itemFor(el), topic: el.closest("[data-track-faq-topic]")?.dataset.trackFaqTopic || "" });
        }
    }
    // Internal links for the link audit: where each sits and what it says.
    const internal = [];
    for (const a of links) {
        const to = norm(a.getAttribute("href"), url);
        if (!to || /^(mailto:|tel:|javascript:)/i.test(a.getAttribute("href"))) continue;
        const area = a.closest("header") ? "header" : a.closest("footer") ? "footer" : a.closest("nav, [data-track-nav]") ? "nav" : "main";
        const label = a.getAttribute("aria-label") || text(a) || [...a.querySelectorAll("img[alt]")].map((i) => i.alt).join(" ");
        internal.push({ to, text: label.slice(0, 120), area, rel: a.getAttribute("rel") || "" });
    }
    const body = (doc.querySelector("main") || doc.body).cloneNode(true);
    // Copy only: text that is already a link can't become one.
    body.querySelectorAll("header, footer, nav, form, script, style, noscript, [hidden], a").forEach((n) => n.remove());
    const forms = [...doc.querySelectorAll("form[data-cms-form]")].map((f) => ({ name: f.dataset.cmsForm, fields: fields(f) }));
    const ctaCandidates = links.filter((a) => !a.closest("header, footer")).map((a) => ({ el: a, target: norm(a.getAttribute("href"), url) }))
        .filter((x) => x.target && x.target !== path).map((x) => ({ label: text(x.el).slice(0, 60), target: x.target, block: blockFor(x.el), explicit: x.el.hasAttribute("data-track-cta") }));
    return {
        path, title: text(doc.querySelector("title")).slice(0, 200), words: text(main).split(" ").length,
        h1: text(doc.querySelector("h1")).slice(0, 200), text: text(body).slice(0, 6000), links: internal.slice(0, 300),
        blocks, nav: nav.slice(0, 60), faqs: faqs.slice(0, 200), forms, ctaCandidates,
        tel: links.some((a) => a.getAttribute("href").startsWith("tel:")),
        mailto: links.some((a) => a.getAttribute("href").startsWith("mailto:")),
        whatsapp: links.some((a) => /wa\.me|api\.whatsapp\.com/.test(a.getAttribute("href"))),
        downloads: links.some((a) => /\.(pdf|docx?|xlsx?|csv|zip|pptx?)(\?|#|$)/i.test(a.getAttribute("href")) || a.hasAttribute("download")),
        outbound: links.some((a) => /^https?:/i.test(a.getAttribute("href")) && !norm(a.getAttribute("href"), url)),
        search: Boolean(doc.querySelector("input[type=search], form[role=search]")),
    };
}

/** Scan the whole site. onProgress(done, total). Returns the scan payload. */
export async function scanSite({ onProgress } = {}) {
    const origin = window.location.origin;
    const sitemap = await fetch(`${origin}/sitemap.xml`, { cache: "no-store" }).then((r) => r.text()).catch(() => "");
    // The sitemap lists the canonical (live) domain; scan the same paths on
    // the origin the admin is viewing (staging, preview, localhost…).
    const pathOf = (loc) => {
        try {
            return new URL(loc).pathname.replace(/\/+$/, "") || "/";
        } catch {
            return null;
        }
    };
    const urls = [...new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => pathOf(m[1].trim())).filter(Boolean))].slice(0, MAX_PAGES);
    if (!urls.includes("/")) urls.unshift("/");
    const pages = [];
    let done = 0;
    const queue = [...urls];
    const worker = async () => {
        while (queue.length) {
            const path = queue.shift();
            try {
                const res = await fetch(`${origin}${path}`, { credentials: "omit", cache: "no-store" });
                if (res.ok && (res.headers.get("content-type") || "").includes("html")) pages.push(parsePage(await res.text(), `${origin}${path}`));
            } catch {
                /* unreachable page: skipped */
            }
            done += 1;
            onProgress?.(done, urls.length);
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    // CTAs = links to pages that hold a form, plus explicit [data-track-cta].
    // Not the home page (a logo link isn't a call-to-action), and when the
    // form repeats on many pages, only the ones that ARE the contact or
    // booking page (mirrors site_facts.CONTACT_RE).
    const withForm = pages.filter((p) => p.forms.length && p.path !== "/").map((p) => p.path);
    const named = withForm.filter((p) => /(^|\/)(contact|book|booking|enquir|quote|get-started|appointment)/i.test(p));
    const formPages = new Set(named.length ? named : withForm);
    for (const page of pages) {
        const ctas = page.ctaCandidates.filter((c) => c.explicit || formPages.has(c.target));
        page.ctas = ctas.slice(0, 60).map(({ label, target, block }) => ({ label, target, block }));
        delete page.ctaCandidates;
    }
    return { pages };
}
