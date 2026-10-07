"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { getPath, uploadImage } from "@/lib/api";
import { blankLike } from "@/components/cms/FieldEditor";

/* =========================================
   Inline editing primitives — the default way
   content is edited. Created per useCms() hook
   (stable identities) and read the hook's live
   state through a ref:

     <E.Text path="title" />                 click & type, in place
     <E.Text path="intro" multiline />       Enter = new line ("\n" -> <br/> when shown)
     <E.Image path="image" />                "Replace image" over the image
     <E.Item path="items" index={i} />       ↑ ↓ duplicate remove, floating above the item
     <E.Add path="items" label="Add FAQ" />  appends a blank item
     <E.Link path="buttonHref" />            edit a link's URL

   Every editable span carries data-cms-block (the useCms name, or
   "section:<id>") and data-cms-path — a stable hook for tests and tooling.

   For visitors (and admins with editing off) every
   primitive renders exactly the original output —
   E.Text renders the bare string, the others nothing.
========================================= */

const toolButton =
    "inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-white px-1.5 text-[11px] font-bold text-[#0F172A] shadow-sm ring-1 ring-black/10 hover:bg-[var(--cms-accent-soft)] disabled:opacity-30";

function stop(event) {
    event.preventDefault();
    event.stopPropagation();
}

function lines(text) {
    return String(text)
        .split("\n")
        .map((line, index) => (
            <Fragment key={index}>
                {index > 0 ? <br /> : null}
                {line}
            </Fragment>
        ));
}

/* Focus survives re-mounts. If the element being typed in is ever replaced
   (a list keyed by its own text, a parent that re-creates children…), the
   replacement for the same block + path takes focus back with the caret
   where it was — typing is never interrupted after one keystroke. */
let pendingFocus = null; // { id, offset, at }

function caretOffset(node) {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!node.contains(range.endContainer)) return null;
    const before = range.cloneRange();
    before.selectNodeContents(node);
    before.setEnd(range.endContainer, range.endOffset);
    return before.toString().length;
}

function placeCaret(node, offset) {
    const range = document.createRange();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let remaining = offset ?? Number.MAX_SAFE_INTEGER;
    let text = walker.nextNode();
    let placed = false;
    while (text) {
        if (remaining <= text.length) {
            range.setStart(text, remaining);
            placed = true;
            break;
        }
        remaining -= text.length;
        text = walker.nextNode();
    }
    if (!placed) {
        range.selectNodeContents(node);
        range.collapse(false);
    } else {
        range.collapse(true);
    }
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

function EditableSpan({ value, multiline, placeholder, label, block, path, onChange }) {
    const ref = useRef(null);
    const focused = useRef(false);
    const start = useRef(value);
    const id = `${block}::${path}`;

    // Uncontrolled while focused, so the caret never jumps.
    useLayoutEffect(() => {
        const node = ref.current;
        if (node && !focused.current && node.innerText !== value) node.innerText = value;
    }, [value]);

    // Re-mounted mid-edit? Take focus back (runs after the text is set above).
    useLayoutEffect(() => {
        const node = ref.current;
        if (node && pendingFocus && pendingFocus.id === id && Date.now() - pendingFocus.at < 1500) {
            const { offset, original } = pendingFocus;
            pendingFocus = null;
            focused.current = true;
            start.current = original;
            node.focus({ preventScroll: true });
            placeCaret(node, offset);
        }
        return () => {
            if (node && (focused.current || document.activeElement === node)) {
                pendingFocus = { id, offset: caretOffset(node), original: start.current, at: Date.now() };
            }
        };
    }, [id]);

    const read = (node) => {
        const text = node.innerText.replace(/\n$/, "");
        return multiline ? text : text.replace(/\s*\n\s*/g, " ");
    };

    return (
        <span
            ref={ref}
            contentEditable="plaintext-only"
            suppressContentEditableWarning
            role="textbox"
            aria-label={label}
            aria-multiline={multiline || undefined}
            spellCheck
            data-placeholder={placeholder}
            data-cms-block={block}
            data-cms-path={path}
            className="cms-editable"
            style={multiline ? { whiteSpace: "pre-line" } : undefined}
            onFocus={() => {
                focused.current = true;
                start.current = value;
            }}
            onBlur={(event) => {
                focused.current = false;
                onChange(read(event.currentTarget));
            }}
            onInput={(event) => onChange(read(event.currentTarget))}
            onKeyDown={(event) => {
                if (event.key === "Enter" && !multiline) {
                    event.preventDefault();
                    event.currentTarget.blur();
                }
                if (event.key === "Escape") {
                    event.currentTarget.innerText = start.current;
                    onChange(start.current);
                    event.currentTarget.blur();
                }
            }}
            onPaste={(event) => {
                event.preventDefault();
                const text = event.clipboardData.getData("text/plain");
                document.execCommand("insertText", false, multiline ? text : text.replace(/\s*\n\s*/g, " "));
            }}
            // Links, cards and carousels must not react while editing text —
            // except Cmd/Ctrl-click, which follows a link as usual.
            title={label ? "Click to edit · Cmd/Ctrl-click to follow a link" : undefined}
            onClick={(event) => {
                if (event.metaKey || event.ctrlKey) {
                    event.currentTarget.blur();
                    return;
                }
                stop(event);
            }}
            onMouseDown={(event) => {
                if (!event.metaKey && !event.ctrlKey) event.stopPropagation();
            }}
        />
    );
}

export function createInline(stateRef) {
    function Text({ path, multiline = false, placeholder = "Add text…" }) {
        const { data, editMode, label, block } = stateRef.current;
        const raw = getPath(data, path);
        const value = raw === undefined || raw === null ? "" : String(raw);
        if (!editMode) return multiline && value.includes("\n") ? lines(value) : value;
        return (
            <EditableSpan
                value={value}
                multiline={multiline}
                placeholder={placeholder}
                label={`${label}: ${path}`}
                block={block}
                path={path}
                onChange={(next) => {
                    if (next !== String(getPath(stateRef.current.data, path) ?? "")) stateRef.current.update(path, next);
                }}
            />
        );
    }

    function ImageEdit({ path, category = "content", className = "left-2 top-2" }) {
        const { editMode } = stateRef.current;
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState("");
        if (!editMode) return null;
        return (
            <span className={`cms-ui ${busy || error ? "" : "cms-hover-tools"} absolute z-[55] flex flex-col items-start gap-1 ${className}`}>
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#0F172A]/85 px-3 py-1.5 text-[11px] font-semibold text-white shadow-lg ring-1 ring-white/30 backdrop-blur hover:bg-[var(--cms-accent)]">
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
                                stateRef.current.update(path, await uploadImage(file, category));
                            } catch (err) {
                                setError(err.message);
                            } finally {
                                setBusy(false);
                            }
                        }}
                    />
                </label>
                {error ? <span className="rounded bg-[#FEF3F2] px-2 py-1 text-[11px] text-[#B42318]">{error}</span> : null}
            </span>
        );
    }

    // List-item tools (↑ ↓ ⧉ ✕) float just ABOVE the hovered / focused item,
    // rendered into <body>: they never cover the item's own text and can't be
    // clipped by an overflow-hidden card. No per-site positioning needed
    // (`className` is accepted for compatibility and ignored).
    function Item({ path, index }) {
        const { data, editMode } = stateRef.current;
        const anchor = useRef(null);
        const hideTimer = useRef(null);
        const [rect, setRect] = useState(null);

        useEffect(() => {
            const item = anchor.current?.parentElement;
            if (!editMode || !item) return undefined;
            const show = () => {
                clearTimeout(hideTimer.current);
                setRect(item.getBoundingClientRect());
            };
            const hide = () => {
                clearTimeout(hideTimer.current);
                hideTimer.current = setTimeout(() => setRect(null), 180);
            };
            item.addEventListener("mouseenter", show);
            item.addEventListener("mouseleave", hide);
            item.addEventListener("focusin", show);
            item.addEventListener("focusout", hide);
            return () => {
                clearTimeout(hideTimer.current);
                item.removeEventListener("mouseenter", show);
                item.removeEventListener("mouseleave", hide);
                item.removeEventListener("focusin", show);
                item.removeEventListener("focusout", hide);
            };
        }, [editMode]);

        const visible = Boolean(rect);
        useEffect(() => {
            if (!visible) return undefined;
            const follow = () => {
                const item = anchor.current?.parentElement;
                setRect(item ? item.getBoundingClientRect() : null);
            };
            window.addEventListener("scroll", follow, true);
            window.addEventListener("resize", follow);
            return () => {
                window.removeEventListener("scroll", follow, true);
                window.removeEventListener("resize", follow);
            };
        }, [visible]);

        if (!editMode) return null;
        const list = getPath(data, path);
        if (!Array.isArray(list)) return null;
        const write = (next) => stateRef.current.update(path, next);
        const move = (delta) => {
            const target = index + delta;
            if (target < 0 || target >= list.length) return;
            const next = [...list];
            [next[index], next[target]] = [next[target], next[index]];
            write(next);
        };
        const above = rect && rect.top > 36;
        const style = rect
            ? {
                  position: "fixed",
                  top: above ? rect.top - 30 : rect.bottom + 4,
                  right: Math.max(4, window.innerWidth - rect.right),
              }
            : null;
        return (
            <>
                <span ref={anchor} hidden />
                {rect && typeof document !== "undefined"
                    ? createPortal(
                          <span
                              data-cms-item-tools
                              style={style}
                              className="cms-ui z-[1450] flex gap-1 rounded-lg bg-white/95 p-0.5 shadow-lg ring-1 ring-black/10"
                              onMouseEnter={() => clearTimeout(hideTimer.current)}
                              onMouseLeave={() => {
                                  hideTimer.current = setTimeout(() => setRect(null), 180);
                              }}
                              onMouseDown={(e) => e.preventDefault()}
                          >
                              <button type="button" title="Move earlier" aria-label="Move earlier" className={toolButton} disabled={index === 0} onClick={(e) => { stop(e); move(-1); }}>↑</button>
                              <button type="button" title="Move later" aria-label="Move later" className={toolButton} disabled={index === list.length - 1} onClick={(e) => { stop(e); move(1); }}>↓</button>
                              <button type="button" title="Duplicate" aria-label="Duplicate" className={toolButton} onClick={(e) => { stop(e); write([...list.slice(0, index + 1), structuredClone(list[index]), ...list.slice(index + 1)]); }}>⧉</button>
                              <button type="button" title="Remove" aria-label="Remove" className={`${toolButton} text-[#B42318]`} onClick={(e) => { stop(e); write(list.filter((_, i) => i !== index)); }}>✕</button>
                          </span>,
                          document.body
                      )
                    : null}
            </>
        );
    }

    function Add({ path, label = "Add item", className = "" }) {
        const { data, editMode, defaults } = stateRef.current;
        if (!editMode) return null;
        const list = getPath(data, path);
        const sample = (Array.isArray(list) && list[0]) ?? getPath(defaults, path)?.[0] ?? "";
        return (
            <button
                type="button"
                onClick={(e) => {
                    stop(e);
                    const current = getPath(stateRef.current.data, path);
                    stateRef.current.update(path, [...(Array.isArray(current) ? current : []), blankLike(sample)]);
                }}
                className={`cms-ui cms-hover-tools inline-flex items-center gap-1.5 rounded-full border-2 border-dashed border-[var(--cms-accent)] bg-white/90 px-4 py-2 text-[12px] font-semibold text-[var(--cms-accent-strong)] shadow-sm hover:bg-[var(--cms-accent-soft)] ${className}`}
            >
                + {label}
            </button>
        );
    }

    function LinkEdit({ path, className = "" }) {
        const { data, editMode } = stateRef.current;
        const [open, setOpen] = useState(false);
        const [value, setValue] = useState("");
        if (!editMode) return null;
        const current = getPath(data, path) || "";
        return (
            <span className={`cms-ui ${open ? "" : "cms-hover-tools"} relative inline-flex align-middle ${className}`} onClick={stop} onMouseDown={(e) => e.stopPropagation()}>
                <button
                    type="button"
                    title={`Link: ${current || "not set"}`}
                    aria-label="Edit link"
                    className={`${toolButton} ml-1`}
                    onClick={(e) => {
                        stop(e);
                        setValue(current);
                        setOpen((v) => !v);
                    }}
                >
                    🔗
                </button>
                {open ? (
                    <span className="absolute left-0 top-full z-[70] mt-1 flex w-64 gap-1 rounded-lg bg-white p-1.5 shadow-xl ring-1 ring-black/10">
                        <input
                            autoFocus
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    stateRef.current.update(path, value.trim());
                                    setOpen(false);
                                }
                                if (e.key === "Escape") setOpen(false);
                            }}
                            placeholder="/contact or https://…"
                            className="min-w-0 flex-1 rounded-md border border-[#CBD5E1] px-2 py-1 text-[12px] font-normal text-[#0F172A] outline-none focus:border-[var(--cms-accent)]"
                        />
                        <button
                            type="button"
                            className="rounded-md bg-[var(--cms-accent)] px-2 text-[11px] font-semibold text-white"
                            onClick={(e) => {
                                stop(e);
                                stateRef.current.update(path, value.trim());
                                setOpen(false);
                            }}
                        >
                            Save
                        </button>
                    </span>
                ) : null}
            </span>
        );
    }

    return { Text, Image: ImageEdit, Item, Add, Link: LinkEdit };
}
