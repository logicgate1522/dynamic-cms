"use client";

import { useState } from "react";

/* =========================================
   The one AI round-trip every assist uses:
     1. backend builds the prompt (ai/* endpoints)
     2. admin copies it into any AI chat
     3. admin pastes the reply back
     4. backend cleans it (ai/normalize/) and the
        panel applies the result as a DRAFT
========================================= */

export function Notice({ tone = "info", children }) {
    if (!children) return null;
    const tones = {
        info: "bg-[#EFF6FF] text-[#1E40AF]",
        success: "bg-[#ECFDF3] text-[#067647]",
        warning: "bg-[#FFFAEB] text-[#B54708]",
        error: "bg-[#FEF3F2] text-[#B42318]",
    };
    return <div className={`whitespace-pre-line rounded-lg px-3 py-2 text-[12px] leading-5 ${tones[tone]}`}>{children}</div>;
}

export function Step({ number, title, children }) {
    return (
        <div className="space-y-2">
            <p className="flex items-center gap-2 text-[12px] font-bold text-[#0F172A]">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#0F172A] text-[10px] text-white">{number}</span>
                {title}
            </p>
            {children}
        </div>
    );
}

export function PromptBox({ prompt, rows = 8 }) {
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState("");
    if (!prompt) return null;
    return (
        <div className="space-y-1.5">
            <textarea
                readOnly
                rows={rows}
                value={prompt}
                onFocus={(e) => e.target.select()}
                className="w-full rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-2.5 font-mono text-[11px] leading-4 text-[#334155]"
            />
            <button
                type="button"
                onClick={async () => {
                    try {
                        await navigator.clipboard.writeText(prompt);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                    } catch {
                        setError("Your browser blocked the clipboard — select the text above and copy it.");
                    }
                }}
                className="w-full rounded-lg bg-[#0F172A] px-3 py-2 text-[12px] font-semibold text-white hover:bg-[#1E293B]"
            >
                {copied ? "Copied ✓" : "Copy prompt"}
            </button>
            <p className="text-[11px] text-[#64748B]">Paste it into ChatGPT, Claude or any AI chat, then paste the reply below.</p>
            <Notice tone="error">{error}</Notice>
        </div>
    );
}

export function PasteBox({ onApply, placeholder = "Paste the AI's reply here…", applyLabel = "Apply as draft", busy = false, rows = 6 }) {
    const [value, setValue] = useState("");
    return (
        <div className="space-y-1.5">
            <textarea
                rows={rows}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={placeholder}
                className="w-full rounded-lg border border-[#CBD5E1] p-2.5 font-mono text-[11px] leading-4 outline-none focus:border-[#0F9E86]"
            />
            <button
                type="button"
                disabled={busy || !value.trim()}
                onClick={async () => {
                    const ok = await onApply(value);
                    if (ok !== false) setValue("");
                }}
                className="w-full rounded-lg border-2 border-[#0F9E86] bg-white px-3 py-2 text-[12px] font-semibold text-[#0B7A68] hover:bg-[#ECFDF5] disabled:opacity-40"
            >
                {busy ? "Applying…" : applyLabel}
            </button>
        </div>
    );
}

export function Segmented({ value, onChange, options }) {
    return (
        <div className="inline-flex rounded-lg bg-[#F1F5F9] p-0.5">
            {options.map(([key, label]) => (
                <button
                    key={key}
                    type="button"
                    onClick={() => onChange(key)}
                    className={`rounded-md px-3 py-1 text-[12px] font-semibold ${value === key ? "bg-white text-[#0F172A] shadow-sm" : "text-[#64748B]"}`}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}

export const STRATEGY_OPTIONS = [
    ["expand", "Improve (keep what works)"],
    ["override", "Rewrite freely"],
];

export const INTENT_OPTIONS = ["", "informational", "commercial", "transactional", "navigational", "local"];

// Visible text of the page, minus admin UI — sent with SEO/keyword prompts.
export function pageTextExcerpt(limit = 2500) {
    if (typeof document === "undefined") return "";
    const main = document.querySelector("main") || document.body;
    const clone = main.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, .cms-ui, [aria-hidden='true']").forEach((el) => el.remove());
    return (clone.innerText || clone.textContent || "").replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, limit);
}

// The current page's SEO key ("home" for "/").
export function currentSeoPath(pathname) {
    return (pathname || "/").replace(/^\/+|\/+$/g, "") || "home";
}
