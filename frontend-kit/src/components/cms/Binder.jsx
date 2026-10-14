"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { blankLike } from "@/components/cms/FieldEditor";
import { FloatingTools, Layer, PLACE, useFloating } from "@/components/cms/floating";
import { getPath, uploadImage } from "@/lib/api";

/* =========================================
   The binder — in-place editing for everything a block shows.

   <E.Text> is the primary way to make copy editable, but a block also shows
   strings it did not render through <E.Text>: props handed down from a data
   file, text a child component prints, images from the block's data. The
   binder makes ALL of them editable on the page, so no part of a page is
   "popup only" and none is a dead zone:

   - every visible string that equals a text value in the block's data gets the
     same dashed outline as E.Text; click it and type, right where it is
     (an overlay editor drawn over the text, so the page itself is untouched)
   - every image that is one of the block's image values gets "Replace image"
   - every list of images (a carousel, a 3D card stack, a gallery) gets a strip
     below it: thumbnails with ‹ › reorder, ✕ remove, and "+ Add image"

   It runs only for admins with editing on, inside the admin layer, and never
   changes the page's layout (R30). Text the code builds itself (a template
   string, a truncation) cannot be matched: render those through <E.Text> or
   mark decoration data-cms-static. The inline-coverage gate measures what is
   left uncovered.
========================================= */

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i;
const norm = (value) => String(value).replace(/\s+/g, " ").trim();
const SKIP = "[data-cms-block],[data-cms-layer],[data-cms-adminbar],[data-cms-static],script,style,noscript,textarea,input,select";

function pathOf(value) {
    const raw = String(value || "");
    const wrapped = raw.match(/[?&]url=([^&]+)/); // /_next/image?url=…
    try {
        return decodeURIComponent(new URL(wrapped ? decodeURIComponent(wrapped[1]) : raw, "http://x").pathname);
    } catch {
        return raw;
    }
}
const base = (value) => pathOf(value).split("/").pop();
const IMAGE_KEY = /^(image|img|src|photo|picture|thumb|thumbnail|cover|hero|logo|avatar|poster|background|screenshot|screen|mockup|visual)\w*$/i;
// An image is a file name, a /media/ path, or — for stock-photo URLs with no extension — a URL under an image-like key.
const isImageValue = (value, key = "") => typeof value === "string" && (IMAGE_FILE.test(value) || /\/media\//.test(value) || (IMAGE_KEY.test(String(key)) && /^(https?:\/\/|\/)\S+$/.test(value.trim())));
const isCopy = (value, key = "") => typeof value === "string" && !isImageValue(value, key) && !/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(value.trim()) && norm(value).length > 0;

// Reads the block's data once: where its text, its images and its image lists are.
function indexData(data) {
    const texts = new Map();
    const images = [];
    const lists = [];
    const walk = (value, path) => {
        const key = path.split(".").pop();
        if (typeof value === "string") {
            if (isImageValue(value, key)) images.push({ path, value });
            else if (isCopy(value, key)) {
                const key = norm(value);
                if (!texts.has(key)) texts.set(key, []);
                texts.get(key).push(path);
            }
        } else if (Array.isArray(value)) {
            const imageKey = value.map((item) => (item && typeof item === "object" ? Object.keys(item).find((k) => isImageValue(item[k], k)) : null)).find(Boolean) || null;
            const plain = value.length > 0 && value.every((item) => isImageValue(item, path.split(".").pop() || "image"));
            if (imageKey || plain) lists.push({ path, key: plain ? null : imageKey });
            value.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i)));
        } else if (value && typeof value === "object") {
            for (const [key, child] of Object.entries(value)) if (!key.startsWith("_")) walk(child, path ? `${path}.${key}` : key);
        }
    };
    walk(data, "");
    return { texts, images, lists };
}

function visible(el) {
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
}

// Finds the page elements that show the block's text and images.
function scan(root, index, owner) {
    const found = { texts: [], images: [] };
    const used = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        const value = norm(node.data);
        const el = node.parentElement;
        if (!value || !el || el.closest(SKIP) || !visible(el)) continue;
        const owned = el.closest("[data-cms-bind-owner]");
        if (owned && owned.getAttribute("data-cms-bind-owner") !== owner) continue;
        const paths = index.texts.get(value);
        if (!paths || norm(el.textContent) !== value) continue;
        const n = used.get(value) || 0;
        used.set(value, n + 1);
        found.texts.push({ el, path: paths.length === 1 ? paths[0] : paths[Math.min(n, paths.length - 1)] });
    }
    const byFull = new Map(index.images.map((i) => [pathOf(i.value), i.path]));
    const byBase = new Map(index.images.map((i) => [base(i.value), i.path]));
    for (const img of root.querySelectorAll("img")) {
        if (img.closest("[data-cms-layer],[data-cms-adminbar],[data-cms-static]") || !visible(img)) continue;
        // Already has its own "Replace image" (an <E.Image> next to it).
        if (img.parentElement?.querySelector(':scope > [data-cms-image-anchor="inline"]')) continue;
        const rect = img.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) continue;
        const src = img.getAttribute("src") || img.currentSrc;
        const path = byFull.get(pathOf(src)) || byBase.get(base(src));
        if (path) {
            found.images.push({ el: img, path });
            img.setAttribute("data-cms-bind-img", path);
        }
    }
    return found;
}

/* ------------------------------------------------------------------ the editor drawn over a piece of text */

function TextField({ el, value, onCommit, onCancel }) {
    const ref = useRef(null);
    const [text, setText] = useState(value);
    const [box] = useState(() => {
        const rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
            rect,
            style: {
                font: cs.font, color: cs.color, textAlign: cs.textAlign, textTransform: cs.textTransform,
                letterSpacing: cs.letterSpacing, lineHeight: cs.lineHeight, whiteSpace: "pre-wrap",
            },
        };
    });
    useLayoutEffect(() => {
        const previous = el.style.visibility;
        el.style.visibility = "hidden";
        const field = ref.current;
        field.focus();
        field.select();
        field.style.height = `${field.scrollHeight}px`;
        return () => {
            el.style.visibility = previous;
        };
    }, [el]);
    const commit = () => onCommit(text);
    return (
        <textarea
                ref={ref}
                data-cms-bind-editor
                value={text}
                aria-label="Edit text"
                rows={1}
                onChange={(event) => {
                    setText(event.target.value);
                    event.target.style.height = "auto";
                    event.target.style.height = `${event.target.scrollHeight}px`;
                }}
                onBlur={commit}
                onKeyDown={(event) => {
                    if (event.key === "Escape") onCancel();
                    else if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        commit();
                    }
                }}
                style={{
                    position: "fixed", left: box.rect.left - 2, top: box.rect.top - 2, width: Math.max(box.rect.width + 4, 48), minHeight: box.rect.height + 4,
                    margin: 0, padding: 2, border: 0, resize: "none", overflow: "hidden", background: "transparent", boxSizing: "border-box",
                    outline: "2px solid var(--cms-accent, #0b7a68)", borderRadius: 2, zIndex: 20, ...box.style,
                }}
            />
    );
}

// The field is mounted inside the admin layer (after it exists), so it can focus itself on mount.
function TextOverlay(props) {
    return (
        <Layer>
            <TextField {...props} />
        </Layer>
    );
}

/* ------------------------------------------------------------------ replace one image */

function ReplaceImage({ el, path, update }) {
    const anchor = useRef(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    // Hover the image (or the wrapper it sits in, when something covers the image itself).
    const tools = useFloating(anchor, {
        pinned: busy || Boolean(error),
        target: () => {
            const parent = el.parentElement;
            const a = el.getBoundingClientRect();
            const b = parent?.getBoundingClientRect();
            return parent && b && b.width * b.height <= a.width * a.height * 1.7 ? parent : el;
        },
    });
    return (
        <>
            <span ref={anchor} hidden data-cms-image-anchor="bound" />
            <FloatingTools tools={tools} place={PLACE.insideTopLeft} className="flex flex-col items-start gap-1" data-cms-image-tools>
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#0F172A]/90 px-3 py-1.5 text-[11px] font-semibold text-white shadow-lg ring-1 ring-white/40 hover:bg-[#0F172A]">
                    {busy ? "Uploading…" : "Replace image"}
                    <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={busy}
                        onChange={async (event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (!file) return;
                            setBusy(true);
                            setError("");
                            try {
                                update(path, await uploadImage(file, "content"));
                            } catch (err) {
                                setError(err.message);
                            } finally {
                                setBusy(false);
                            }
                        }}
                    />
                </label>
                {error ? <span className="rounded bg-[#FEF3F2] px-2 py-1 text-[11px] text-[#B42318]">{error}</span> : null}
            </FloatingTools>
        </>
    );
}

/* ------------------------------------------------------------------ the strip under a stack / carousel / gallery */

function lowestCommonAncestor(elements, fallback) {
    if (!elements.length) return fallback;
    let node = elements[0].parentElement;
    while (node && !elements.every((el) => node.contains(el))) node = node.parentElement;
    return node && fallback.contains(node) ? node : fallback;
}

const belowTarget = (r, s, min) => {
    const vh = window.innerHeight;
    const below = r.bottom + 10;
    return { left: r.left + r.width / 2 - s.w / 2, top: below + s.h <= vh - 8 ? below : Math.max(min, r.bottom - s.h - 10) };
};

function StripRow({ list, data, update, label, setBusyUp }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const items = getPath(data, list.path) || [];
    const valueOf = (item) => (list.key ? item?.[list.key] : item);
    useEffect(() => { setBusyUp(busy || Boolean(error)); }, [busy, error, setBusyUp]);
    const write = (next) => update(list.path, next);
    const move = (from, to) => {
        if (to < 0 || to >= items.length) return;
        const next = [...items];
        [next[from], next[to]] = [next[to], next[from]];
        write(next);
    };
    return (
            <div data-cms-image-strip-row={list.path} className="flex items-center gap-2 overflow-x-auto">
                <span className="w-24 shrink-0 px-1 text-[11px] font-bold uppercase leading-tight tracking-[0.08em] text-[#475569]">{label} · {items.length}</span>
                {items.map((item, index) => {
                    const value = valueOf(item);
                    return (
                        <span key={`${index}-${value}`} className="group relative h-14 w-20 shrink-0 overflow-hidden rounded-md bg-[#E2E8F0] ring-1 ring-black/10">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {value ? <img src={value} alt="" className="h-full w-full object-cover" /> : null}
                            <span className="absolute inset-x-0 bottom-0 flex justify-between bg-[#0F172A]/80 px-0.5 text-white">
                                <button type="button" title="Move earlier" aria-label="Move earlier" disabled={index === 0} onClick={() => move(index, index - 1)} className="px-1 text-[12px] disabled:opacity-30">‹</button>
                                <button type="button" title="Remove this image" aria-label="Remove this image" data-cms-action="remove-image" onClick={() => write(items.filter((_, i) => i !== index))} className="px-1 text-[12px]">✕</button>
                                <button type="button" title="Move later" aria-label="Move later" disabled={index === items.length - 1} onClick={() => move(index, index + 1)} className="px-1 text-[12px] disabled:opacity-30">›</button>
                            </span>
                        </span>
                    );
                })}
                <label className="inline-flex h-14 w-20 shrink-0 cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-[#94A3B8] text-[11px] font-semibold text-[#334155] hover:bg-[#F1F5F9]">
                    <span aria-hidden="true" className="text-[16px] leading-none">+</span>
                    {busy ? "Uploading…" : "Add image"}
                    <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        disabled={busy}
                        data-cms-action="add-image"
                        onChange={async (event) => {
                            const files = [...(event.target.files || [])];
                            event.target.value = "";
                            if (!files.length) return;
                            setBusy(true);
                            setError("");
                            try {
                                let next = [...items];
                                for (const file of files) {
                                    const url = await uploadImage(file, "content");
                                    const template = items.length ? items[items.length - 1] : null;
                                    next = [...next, list.key ? { ...blankLike(template || {}), [list.key]: url } : url];
                                }
                                write(next);
                            } catch (err) {
                                setError(err.message);
                            } finally {
                                setBusy(false);
                            }
                        }}
                    />
                </label>
                {error ? <span className="shrink-0 rounded bg-[#FEF3F2] px-2 py-1 text-[11px] text-[#B42318]">{error}</span> : null}
            </div>
    );
}


// "phoneImages" -> "Phone images"
const labelOf = (path, only) => {
    if (only) return "Images";
    const last = String(path).split(".").pop().replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
    return last ? last[0].toUpperCase() + last.slice(1) : "Images";
};

// ONE strip per block however many image lists it has: separate floating strips for lists that share
// an area would pile up on top of each other. Rows are stacked in a single tray under the images.
function ImageStrips({ lists, data, update, root, found }) {
    const anchor = useRef(null);
    const [pinned, setPinned] = useState(false);
    const els = found.images.filter((i) => lists.some((l) => i.path.startsWith(`${l.path}.`))).map((i) => i.el);
    const tools = useFloating(anchor, { pinned, target: () => lowestCommonAncestor(els, root) });
    return (
        <>
            <span ref={anchor} hidden data-cms-image-anchor="strip" />
            <FloatingTools tools={tools} place={belowTarget} data-cms-image-strip className="flex max-h-[45vh] max-w-[min(92vw,56rem)] flex-col gap-2 overflow-y-auto rounded-xl bg-white p-2 shadow-[0_12px_32px_rgba(2,6,23,0.35)] ring-1 ring-black/10">
                {lists.map((list) => (
                    <StripRow key={list.path} list={list} data={data} update={update} label={labelOf(list.path, lists.length === 1)} setBusyUp={setPinned} />
                ))}
            </FloatingTools>
        </>
    );
}

/* ------------------------------------------------------------------ the binder */

export default function Binder({ name, data, update }) {
    const anchor = useRef(null);
    const [root, setRoot] = useState(null);
    const [found, setFound] = useState({ texts: [], images: [] });
    const [editing, setEditing] = useState(null); // { el, path }
    const index = useMemo(() => indexData(data || {}), [data]);
    const latest = useRef({ index, data, update });
    latest.current = { index, data, update };

    useLayoutEffect(() => {
        setRoot(anchor.current?.parentElement || null);
    }, []);

    // Keep the bindings in step with what is on the page.
    useEffect(() => {
        if (!root) return undefined;
        let frame = 0;
        let bound = [];
        const apply = () => {
            const next = scan(root, latest.current.index, name);
            for (const el of bound) if (!next.texts.some((t) => t.el === el)) {
                el.removeAttribute("data-cms-bind");
                el.removeAttribute("data-cms-bind-owner");
            }
            for (const { el, path } of next.texts) {
                el.setAttribute("data-cms-bind", path);
                el.setAttribute("data-cms-bind-owner", name);
            }
            bound = next.texts.map((t) => t.el);
            setFound((prev) => (prev.texts.length === next.texts.length && prev.images.length === next.images.length
                && prev.texts.every((t, i) => t.el === next.texts[i].el && t.path === next.texts[i].path)
                && prev.images.every((t, i) => t.el === next.images[i].el && t.path === next.images[i].path) ? prev : next));
        };
        const schedule = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(apply);
        };
        schedule();
        const observer = new MutationObserver(schedule);
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        window.addEventListener("resize", schedule);
        const settle = setTimeout(schedule, 900); // images and fonts finish loading
        return () => {
            cancelAnimationFrame(frame);
            clearTimeout(settle);
            observer.disconnect();
            window.removeEventListener("resize", schedule);
            for (const el of bound) {
                el.removeAttribute("data-cms-bind");
                el.removeAttribute("data-cms-bind-owner");
            }
        };
    }, [root, name, index]);

    // Click a bound piece of text: edit it in place.
    useEffect(() => {
        if (!root) return undefined;
        const onClick = (event) => {
            const el = event.target?.closest?.("[data-cms-bind]");
            if (!el || el.getAttribute("data-cms-bind-owner") !== name || !root.contains(el) || event.target.closest?.("[data-cms-layer]")) return;
            event.preventDefault();
            event.stopPropagation();
            setEditing({ el, path: el.getAttribute("data-cms-bind") });
        };
        document.addEventListener("click", onClick, true);
        return () => document.removeEventListener("click", onClick, true);
    }, [root, name]);

    return (
        <>
            <span ref={anchor} hidden data-cms-binder={name} />
            {editing ? (
                <TextOverlay
                    el={editing.el}
                    value={String(getPath(latest.current.data, editing.path) ?? "")}
                    onCancel={() => setEditing(null)}
                    onCommit={(text) => {
                        const old = String(getPath(latest.current.data, editing.path) ?? "");
                        setEditing(null);
                        if (text !== old) latest.current.update(editing.path, text);
                    }}
                />
            ) : null}
            {found.images.map(({ el, path }, i) => <ReplaceImage key={`${path}:${i}`} el={el} path={path} update={update} />)}
            {root && index.lists.length ? <ImageStrips lists={index.lists} data={data} update={update} root={root} found={found} /> : null}
        </>
    );
}
