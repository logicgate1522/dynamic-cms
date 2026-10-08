"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* =========================================
   Floating edit tools — the ONLY way edit chrome
   is drawn over the page (R30):
   - rendered into one admin layer at the end of <body>, so tools never take
     layout space (editing on/off moves nothing), are never covered by an
     overlapping section and never clipped by overflow-hidden cards
   - the layer cancels any zoom/scale the site puts on <body>, so admin UI is
     always 1:1 and lines up with what it edits
   - placed next to their target, clamped inside the viewport and below the
     site's fixed header (--cms-first-section-tools-top)
   - shown while the target is hovered, focused or tapped (touch), and while
     the pointer is over the tools themselves
========================================= */

let layer = null;

function syncZoom(el) {
    const zoom = (node) => parseFloat(getComputedStyle(node).zoom) || 1;
    el.style.zoom = String(1 / (zoom(document.documentElement) * zoom(document.body)));
}

// The admin layer: one fixed, full-viewport, click-through container.
export function cmsLayer() {
    if (typeof document === "undefined") return null;
    if (layer && document.body.contains(layer)) return layer;
    layer = document.createElement("div");
    layer.setAttribute("data-cms-layer", "");
    layer.className = "cms-ui cms-layer";
    document.body.appendChild(layer);
    syncZoom(layer);
    window.addEventListener("resize", () => syncZoom(layer));
    return layer;
}

// Renders children into the admin layer (after mount; nothing on the server).
export function Layer({ children }) {
    const [el, setEl] = useState(null);
    useEffect(() => setEl(cmsLayer()), []);
    return el ? createPortal(children, el) : null;
}

// Is the element inside a fixed or sticky bar (e.g. the site header)?
function inFixed(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
        const position = getComputedStyle(node).position;
        if (position === "fixed" || position === "sticky") return true;
    }
    return false;
}

// Fixed headers sit above the page: tools never go higher than this.
function minTop() {
    const value = getComputedStyle(document.documentElement).getPropertyValue("--cms-first-section-tools-top");
    const px = parseFloat(value);
    return Number.isFinite(px) ? px : 8;
}

/**
 * Tracks the element the tools belong to (the anchor's parent by default)
 * and returns its rect while it is active.
 *   const anchor = useRef(null);
 *   const tools = useFloating(anchor, { pinned });
 *   <span ref={anchor} hidden />  … <FloatingTools tools={tools} place={…}>…</FloatingTools>
 */
export function useFloating(anchorRef, { enabled = true, pinned = false, target: pickTarget } = {}) {
    const [rect, setRect] = useState(null);
    const [active, setActive] = useState(false);
    const [target, setTarget] = useState(null);
    const hideTimer = useRef(null);
    const toolsRef = useRef(null);
    const targetRef = useRef(null);

    // The target element can be replaced (a section re-mounts after drafts
    // load, a list re-renders…): re-resolve it after every render and
    // re-attach the listeners whenever it changes.
    useLayoutEffect(() => {
        const next = enabled ? (pickTarget ? pickTarget(anchorRef.current) : anchorRef.current?.parentElement) || null : null;
        if (next !== targetRef.current) {
            targetRef.current = next;
            setTarget(next);
        }
    });

    useEffect(() => {
        if (!enabled || !target) return undefined;
        const show = () => {
            clearTimeout(hideTimer.current);
            setActive(true);
        };
        const hide = () => {
            clearTimeout(hideTimer.current);
            hideTimer.current = setTimeout(() => setActive(false), 220);
        };
        const onFocusOut = (event) => {
            if (toolsRef.current?.contains(event.relatedTarget)) return;
            hide();
        };
        // Touch: a tap on the target shows its tools; a tap elsewhere hides them.
        const onTap = (event) => event.pointerType !== "mouse" && show();
        const onDocTap = (event) => {
            if (event.pointerType === "mouse") return;
            if (target.contains(event.target) || toolsRef.current?.contains(event.target)) return;
            hide();
        };
        target.addEventListener("mouseenter", show);
        target.addEventListener("mouseleave", hide);
        target.addEventListener("focusin", show);
        target.addEventListener("focusout", onFocusOut);
        target.addEventListener("pointerdown", onTap);
        document.addEventListener("pointerdown", onDocTap);
        return () => {
            clearTimeout(hideTimer.current);
            target.removeEventListener("mouseenter", show);
            target.removeEventListener("mouseleave", hide);
            target.removeEventListener("focusin", show);
            target.removeEventListener("focusout", onFocusOut);
            target.removeEventListener("pointerdown", onTap);
            document.removeEventListener("pointerdown", onDocTap);
        };
    }, [enabled, target]);

    const visible = enabled && (active || pinned);
    useEffect(() => {
        if (!visible) {
            setRect(null);
            return undefined;
        }
        let frame = 0;
        const measure = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const target = targetRef.current;
                setRect(target && target.isConnected ? target.getBoundingClientRect() : null);
            });
        };
        measure();
        window.addEventListener("scroll", measure, true);
        window.addEventListener("resize", measure);
        const observer = typeof ResizeObserver !== "undefined" && targetRef.current ? new ResizeObserver(measure) : null;
        observer?.observe(targetRef.current);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener("scroll", measure, true);
            window.removeEventListener("resize", measure);
            observer?.disconnect();
        };
    }, [visible]);

    const keep = () => clearTimeout(hideTimer.current);
    const release = () => {
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setActive(false), 220);
    };
    return { rect, visible, toolsRef, keep, release, inFixed: rect ? inFixed(targetRef.current) : false, show: () => { keep(); setActive(true); } };
}

// Placement helpers: (targetRect, toolsSize) -> {left, top}. Clamping is automatic.
// Rules of thumb: tools sit outside small targets (so they never cover the
// text they belong to or its neighbours) and inside large ones.
const SHORT = 140;
export const PLACE = {
    // Block tools: inside the top-right of a section; just below a short block
    // (a header bar), where they don't cover its buttons.
    insideTopRight: (r, s) => (r.height < SHORT ? { left: r.right - s.w - 12, top: r.bottom + 6 } : { left: r.right - s.w - 12, top: r.top + 12 }),
    insideTopLeft: (r) => ({ left: r.left + 8, top: r.top + 8 }),
    // Item tools: above the item's right end; below its left end when there is no room above.
    aboveRight: (r, s, min) => (r.top - s.h - 6 >= min ? { left: r.right - s.w, top: r.top - s.h - 6 } : { left: r.left, top: r.bottom + 6 }),
    // 🔗: perched on the link's top-right corner, clear of the next word.
    corner: (r, s) => ({ left: r.right - s.w / 2, top: r.top - s.h * 0.65 }),
    // "+ Add": just outside the list's bottom-right.
    afterList: (r, s) => ({ left: r.right - s.w, top: r.bottom + 6 }),
};
// Back-compat names.
PLACE.afterMiddle = PLACE.corner;
PLACE.bottomCenter = PLACE.afterList;

/** The tools themselves, in the admin layer, positioned by `place`. */
export function FloatingTools({ tools, place = PLACE.insideTopRight, className = "", children, ...rest }) {
    // The node mounts inside the admin layer (a portal), so its size is
    // measured when it attaches and whenever it changes — positioning and
    // viewport clamping always use the real size.
    const [node, setNode] = useState(null);
    const [size, setSize] = useState(null);
    useLayoutEffect(() => {
        if (!node) return undefined;
        const measure = () => {
            const r = node.getBoundingClientRect();
            setSize((prev) => (prev && Math.abs(prev.w - r.width) <= 0.5 && Math.abs(prev.h - r.height) <= 0.5 ? prev : { w: r.width, h: r.height }));
        };
        measure();
        const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
        observer?.observe(node);
        return () => observer?.disconnect();
    }, [node]);
    if (!tools.rect) return null;
    const s = size || { w: 0, h: 0 };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Page content must keep its tools below the fixed header; elements that
    // are part of a fixed/sticky bar (the header itself) may use that space.
    const min = tools.inFixed ? 8 : minTop();
    // Target scrolled out of view (or under the fixed header): no tools, so
    // clamped tools never pile up at the screen edges.
    if (tools.rect.bottom < min || tools.rect.top > vh || tools.rect.right < 0 || tools.rect.left > vw) return null;
    let { left, top } = place(tools.rect, s, min);
    left = Math.min(Math.max(8, left), Math.max(8, vw - s.w - 8));
    top = Math.min(Math.max(min, top), Math.max(min, vh - s.h - 8));
    // Never under the admin bar: lift the tools above it if they would overlap.
    const bar = document.querySelector("[data-cms-adminbar]")?.getBoundingClientRect();
    if (bar && top + s.h > bar.top - 6 && top < bar.bottom && left + s.w > bar.left && left < bar.right) top = Math.max(min, bar.top - s.h - 8);
    return (
        <Layer>
            <div
                {...rest}
                ref={(el) => {
                    tools.toolsRef.current = el;
                    if (el !== node) setNode(el);
                }}
                onMouseEnter={tools.keep}
                onMouseLeave={tools.release}
                onMouseDown={(e) => e.stopPropagation()}
                style={{ position: "fixed", left, top, visibility: size ? "visible" : "hidden" }}
                className={`cms-ui cms-floating ${className}`}
            >
                {children}
            </div>
        </Layer>
    );
}

/** Keep a popover inside the viewport, opening above or below its button. */
export function usePopoverPosition(open, buttonRef, { width = 288, gap = 8, prefer = "above" } = {}) {
    const [pos, setPos] = useState(null);
    useEffect(() => {
        if (!open) {
            setPos(null);
            return undefined;
        }
        const measure = () => {
            const b = buttonRef.current?.getBoundingClientRect();
            if (!b) return;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const w = Math.min(width, vw - 16);
            const left = Math.min(Math.max(8, b.left + b.width / 2 - w / 2), vw - w - 8);
            const spaceAbove = b.top - gap - 8;
            const spaceBelow = vh - b.bottom - gap - 8;
            const above = prefer === "above" ? spaceAbove >= Math.min(spaceBelow, 240) : spaceBelow < 240 && spaceAbove > spaceBelow;
            setPos(above
                ? { left, width: w, bottom: vh - b.top + gap, maxHeight: spaceAbove }
                : { left, width: w, top: b.bottom + gap, maxHeight: spaceBelow });
        };
        measure();
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return () => {
            window.removeEventListener("resize", measure);
            window.removeEventListener("scroll", measure, true);
        };
    }, [open, buttonRef, width, gap, prefer]);
    return pos;
}
