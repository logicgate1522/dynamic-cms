/* =========================================
   Automatic capture (R31) — engagement events with no per-site code.

   Blocks: every useCms block renders {editButton}, which for visitors is a
   hidden marker <span data-track-block="name">; the marker's parent is the
   block. CMS-page sections are wrapped in [data-track-block]. List items
   carry <span data-track-item="path.index"> (from E.Item). So every event
   knows its page, block and intent without the site adding anything.

   Events (TRACKING_IMPLEMENTATION_PLAN.md §4.2):
     cta_click        [data-track-cta] or any link to a form page
     nav_click        links inside header / footer / [data-track-nav]
     section_view     a block ≥50% visible for 2s (once per page view)
     scroll_depth     25/50/75/90% of <main> on article/entry pages
     service_engaged  30s visible time or 50% scroll on an intent page
     faq_open         <details> opened or [aria-expanded] → true
     form_start       first input in a form[data-cms-form]
     form_abandon     started, not sent, page left (last field reached)
     outbound_click   link to another site · file_download  pdf/docx/…
     contact_click    tel: / mailto: / WhatsApp
   Never tracked: admins (setting), edit mode, prerender, back-forward
   restores count as a new page view.
========================================= */

import { notePageTime } from "@/lib/intentProfile";
import { flush, track, trackingPlan } from "@/lib/track";

const DOWNLOAD_RE = /\.(pdf|docx?|xlsx?|csv|zip|pptx?|txt|rtf|odt|ods)(\?|#|$)/i;
let started = false;
let page = null;
let observer = null;
let mutation = null;
const timers = new Map();

function normPath(href) {
    try {
        const u = new URL(href, window.location.href);
        if (u.origin !== window.location.origin) return null;
        return u.pathname.replace(/\/+$/, "") || "/";
    } catch {
        return null;
    }
}

/** The CMS block an element belongs to: { name, root }. */
export function blockOf(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
        if (node.dataset?.trackBlock && node.tagName !== "SPAN") return { name: node.dataset.trackBlock, root: node };
        const marker = node.querySelector?.(":scope > span[data-track-block]");
        if (marker) return { name: marker.dataset.trackBlock, root: node };
    }
    return { name: "", root: null };
}

function itemOf(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
        const marker = node.querySelector?.(":scope > span[data-track-item]");
        if (marker) return marker.dataset.trackItem;
        if (node.dataset?.trackBlock) break;
    }
    return "";
}

function blockIntent(name) {
    const plan = trackingPlan();
    return (plan.intents || []).find((i) => (i.blocks || []).includes(name))?.id;
}

function words(text) {
    return ` ${String(text || "").toLowerCase().replace(/[^a-z0-9£$€% ]+/g, " ")} `;
}

// Keyword match, whole word (stems allowed when the keyword ends in a letter run).
function hits(text, keywords) {
    const t = words(text);
    return (keywords || []).some((k) => {
        const kw = String(k).toLowerCase().trim();
        return kw && t.includes(` ${kw}`);
    });
}

function classify(text) {
    const plan = trackingPlan();
    const pick = (list) => (list || []).filter((x) => hits(text, x.keywords)).map((x) => x.id);
    return { intents: pick(plan.intents), segments: pick(plan.segments), stages: pick(plan.stages) };
}

function label(el) {
    return (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/* ------------------------------------------------------------- clicks */

function onClick(event) {
    const el = event.target?.closest?.("a[href], button, [data-track-cta]");
    if (!el || el.closest(".cms-ui, [data-cms-layer]")) return;
    const href = el.getAttribute("href") || "";
    const block = blockOf(el);
    const base = { block: block.name || undefined, item: itemOf(el) || undefined, intent: blockIntent(block.name) };
    if (/^(tel:|mailto:)/i.test(href) || /wa\.me|api\.whatsapp\.com/i.test(href)) {
        track("contact_click", { ...base, method: href.startsWith("tel:") ? "phone" : href.startsWith("mailto:") ? "email" : "whatsapp" });
        return;
    }
    if (DOWNLOAD_RE.test(href) || el.hasAttribute("download")) {
        const file = href.split("/").pop()?.split(/[?#]/)[0] || "";
        track("file_download", { ...base, file_ext: (file.split(".").pop() || "").toLowerCase(), file_name: file.slice(0, 80) });
        return;
    }
    const path = href ? normPath(href) : null;
    if (href && !path && /^https?:/i.test(href)) {
        try {
            track("outbound_click", { ...base, link_domain: new URL(href).hostname.replace(/^www\./, "") });
        } catch {
            /* malformed */
        }
        return;
    }
    const plan = trackingPlan();
    const isCta = el.hasAttribute("data-track-cta") || el.closest("[data-track-cta]") || (path && (plan.formPages || []).includes(path) && path !== page?.path);
    if (isCta) {
        track("cta_click", { ...base, cta_label: label(el), cta_target: path || undefined, intent: base.intent || plan.pageIntents?.[path] });
        return;
    }
    const area = el.closest("header") ? "header" : el.closest("footer") ? "footer" : el.closest("[data-track-nav]") ? "menu" : "";
    if (area && path) track("nav_click", { nav_area: area, nav_label: label(el), intent: plan.pageIntents?.[path] });
    // FAQ toggles are buttons: handled after React updates aria-expanded.
    if (el.hasAttribute("aria-expanded")) setTimeout(() => faqToggled(el), 0);
}

function faqToggled(el) {
    if (el.getAttribute("aria-expanded") !== "true") return;
    const text = label(el);
    const block = blockOf(el);
    const topicEl = el.closest("[data-track-faq-topic]");
    const c = classify(text);
    track("faq_open", { block: block.name || undefined, item: itemOf(el) || undefined, faq_id: `${block.name}#${itemOf(el) || text.slice(0, 30)}`,
        faq_topic: topicEl?.dataset.trackFaqTopic, intent: c.intents[0] || blockIntent(block.name), stage: c.stages[0],
        stages: c.stages, segments: c.segments, intents: c.intents });
}

function onToggle(event) {
    const details = event.target;
    if (details?.tagName !== "DETAILS" || !details.open) return;
    const summary = details.querySelector("summary");
    if (summary) {
        summary.setAttribute("aria-expanded", "true");
        faqToggled(summary);
    }
}

/* -------------------------------------------------------------- forms */

const forms = new Map(); // form element -> { name, last, submitted }

function formOf(el) {
    const form = el?.closest?.("form");
    if (!form || form.closest(".cms-ui, [data-cms-layer]")) return null;
    if (!forms.has(form)) forms.set(form, { name: form.dataset.cmsForm || form.getAttribute("name") || form.id || "form", last: "", started: false, submitted: false });
    return forms.get(form);
}

function onInput(event) {
    const state = formOf(event.target);
    if (!state) return;
    state.last = event.target.name || state.last;
    if (!state.started) {
        state.started = true;
        track("form_start", { form_name: state.name, block: blockOf(event.target).name || undefined });
    }
}

function onFormResult(event) {
    const { form, ok } = event.detail || {};
    for (const state of forms.values()) if (state.name === form && ok) state.submitted = true;
}

function abandonForms() {
    for (const state of forms.values()) {
        if (state.started && !state.submitted) {
            track("form_abandon", { form_name: state.name, last_field: state.last || undefined });
            state.submitted = true; // once
        }
    }
}

/* ---------------------------------------------------- sections, scroll */

function observeBlocks() {
    observer?.disconnect();
    if (typeof IntersectionObserver === "undefined") return;
    observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const el = entry.target;
            const name = el.dataset.trackRoot;
            if (!name || page.seen.has(name)) continue;
            const short = entry.boundingClientRect.height < 120;
            const visible = short ? entry.intersectionRatio >= 0.99 : entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= window.innerHeight * 0.5;
            if (visible && !timers.has(el)) {
                timers.set(el, setTimeout(() => {
                    timers.delete(el);
                    if (document.visibilityState !== "visible" || page.seen.has(name)) return;
                    page.seen.add(name);
                    const intent = blockIntent(name);
                    track("section_view", { block: name, intent, block_intent: intent ? 1 : undefined });
                }, 2000));
            } else if (!visible && timers.has(el)) {
                clearTimeout(timers.get(el));
                timers.delete(el);
            }
        }
    }, { threshold: [0, 0.5, 0.99] });
    for (const marker of document.querySelectorAll("span[data-track-block]")) {
        const root = marker.parentElement;
        if (root && !root.closest(".cms-ui")) {
            root.dataset.trackRoot = marker.dataset.trackBlock;
            observer.observe(root);
        }
    }
    for (const root of document.querySelectorAll("[data-track-block]:not(span)")) {
        root.dataset.trackRoot = root.dataset.trackBlock;
        observer.observe(root);
    }
}

function content() {
    return document.querySelector("[data-track-content]") || document.querySelector("main") || document.body;
}

function scrollPercent() {
    const el = content();
    const rect = el.getBoundingClientRect();
    const total = rect.height;
    if (total <= window.innerHeight * 1.2) return 100;
    const seen = Math.min(total, window.innerHeight - rect.top);
    return Math.max(0, Math.min(100, Math.round((seen / total) * 100)));
}

function onScroll() {
    if (!page || page.scrollPending) return;
    page.scrollPending = true;
    requestAnimationFrame(() => {
        page.scrollPending = false;
        const pct = scrollPercent();
        page.maxScroll = Math.max(page.maxScroll, pct);
        const type = trackingPlan().pageTypes?.[page.path];
        if (type === "article" || type === "entry") {
            for (const t of [25, 50, 75, 90]) {
                if (pct >= t && !page.depths.has(t)) {
                    page.depths.add(t);
                    track("scroll_depth", { percent: t });
                }
            }
        }
        maybeEngaged();
    });
}

function maybeEngaged() {
    const intent = trackingPlan().pageIntents?.[page.path];
    if (!intent || page.engaged) return;
    if (page.visible >= 30 || page.maxScroll >= 50) {
        page.engaged = true;
        track("service_engaged", { intent });
    }
}

/* ------------------------------------------------------------- pages */

function tick() {
    if (!page) return;
    const now = Date.now();
    if (document.visibilityState === "visible" && now - page.lastInput < 30000) page.visible += (now - page.lastTick) / 1000;
    page.lastTick = now;
    maybeEngaged();
}

function leavePage() {
    if (!page) return;
    tick();
    notePageTime(page.visible);
    abandonForms();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
}

/** A new page view (first load, SPA navigation or back-forward restore). */
export function startPage({ initial = false } = {}) {
    leavePage();
    forms.clear();
    page = { path: window.location.pathname.replace(/\/+$/, "") || "/", seen: new Set(), depths: new Set(), maxScroll: 0,
             visible: 0, lastTick: Date.now(), lastInput: Date.now(), engaged: false, scrollPending: false };
    track("page_view", { page_location: window.location.href, page_title: document.title }, { initial });
    // Content renders after navigation: observe once it has painted.
    requestAnimationFrame(() => setTimeout(() => {
        observeBlocks();
        onScroll();
    }, 300));
}

export function startCapture() {
    if (started || typeof window === "undefined") return;
    started = true;
    const opts = { capture: true, passive: true };
    document.addEventListener("click", onClick, opts);
    document.addEventListener("toggle", onToggle, true);
    document.addEventListener("input", onInput, opts);
    document.addEventListener("change", onInput, opts);
    window.addEventListener("scroll", onScroll, { passive: true });
    // Activity keeps the reading clock running (a reader moves the mouse or
    // the wheel without clicking). Cheap: one timestamp write per event.
    for (const type of ["pointerdown", "pointermove", "keydown", "scroll", "wheel", "touchstart"]) {
        window.addEventListener(type, () => page && (page.lastInput = Date.now()), { passive: true });
    }
    window.addEventListener("cms:form-result", onFormResult);
    window.addEventListener("pagehide", () => {
        leavePage();
        flush();
    });
    window.addEventListener("pageshow", (e) => e.persisted && startPage());
    setInterval(tick, 1000);
    // Blocks added later (lazy sections, client-only blocks).
    if (typeof MutationObserver !== "undefined") {
        let pending = null;
        mutation = new MutationObserver(() => {
            clearTimeout(pending);
            pending = setTimeout(observeBlocks, 500);
        });
        mutation.observe(document.body, { childList: true, subtree: true });
    }
}

export function captureState() {
    return { page, forms: [...forms.values()] };
}

export function abandonNow() {
    abandonForms();
    flush();
}
