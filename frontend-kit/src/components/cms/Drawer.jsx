"use client";

import { useEffect } from "react";

import { Layer } from "@/components/cms/floating";

// Slide-over panel shared by every admin editor.
export default function Drawer({ open, title, subtitle, onClose, footer, children, width = 520 }) {
    useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => event.key === "Escape" && onClose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    // The page behind must not scroll while the panel is open: lock it (keeping the scrollbar's width so
    // nothing shifts). Smooth-scroll libraries (Lenis) are told to leave the panel alone via data-lenis-prevent.
    useEffect(() => {
        if (!open) return undefined;
        const html = document.documentElement;
        const body = document.body;
        const previous = { overflow: html.style.overflow, paddingRight: body.style.paddingRight };
        const gutter = window.innerWidth - html.clientWidth;
        html.style.overflow = "hidden";
        if (gutter > 0) body.style.paddingRight = `${gutter}px`;
        return () => {
            html.style.overflow = previous.overflow;
            body.style.paddingRight = previous.paddingRight;
        };
    }, [open]);

    if (!open) return null;

    // In the admin layer: above every site element, unaffected by site zoom.
    return (
        <Layer>
        <div className="cms-ui fixed inset-0 z-[2000] flex justify-end overscroll-contain" data-lenis-prevent role="dialog" aria-modal="true" aria-label={title}>
            <button type="button" aria-label="Close editor" className="absolute inset-0 bg-[#020617]/45 backdrop-blur-[2px]" onClick={onClose} />
            <div
                className="relative flex h-full w-full flex-col bg-white font-sans text-[#1E293B] shadow-[-20px_0_60px_rgba(2,6,23,0.25)]"
                style={{ maxWidth: width }}
            >
                <header className="flex items-start justify-between gap-4 border-b border-[#E2E8F0] px-5 py-4">
                    <div>
                        <h2 className="text-[16px] font-bold text-[#0F172A]">{title}</h2>
                        {subtitle ? <p className="mt-0.5 text-[12px] text-[#64748B]">{subtitle}</p> : null}
                    </div>
                    <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-[18px] leading-none text-[#64748B] hover:bg-[#F1F5F9]" aria-label="Close">
                        ×
                    </button>
                </header>
                <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4" data-lenis-prevent>{children}</div>
                {footer ? <footer className="border-t border-[#E2E8F0] bg-[#F8FAFC] px-5 py-3">{footer}</footer> : null}
            </div>
        </div>
        </Layer>
    );
}

export const buttonStyles = {
    primary: "rounded-lg bg-[var(--cms-accent)] px-4 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50",
    secondary: "rounded-lg border border-[#CBD5E1] bg-white px-4 py-2 text-[13px] font-semibold text-[#334155] hover:bg-[#F1F5F9] disabled:opacity-50",
    danger: "rounded-lg px-3 py-2 text-[13px] font-semibold text-[#B42318] hover:bg-[#FEF3F2] disabled:opacity-50",
    link: "text-[12px] font-semibold text-[var(--cms-accent)] hover:underline disabled:opacity-50",
};
