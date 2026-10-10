"use client";

import { STATUS_TONE } from "@/components/admin/tracking/describe";

export function Pill({ status, children }) {
    return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_TONE[status] || "bg-[#F1F5F9] text-[#475569]"}`}>{children || String(status || "").replace(/_/g, " ")}</span>;
}

export const input = "w-full rounded-lg border border-[#CBD5E1] bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cms-accent)] focus:ring-2 focus:ring-[var(--cms-accent)]/20";

export function Section({ title, description, actions, children }) {
    return (
        <section className="mb-6">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
                <div>
                    <h3 className="text-[15px] font-bold text-[#0F172A]">{title}</h3>
                    {description ? <p className="mt-0.5 text-[12px] text-[#64748B]">{description}</p> : null}
                </div>
                {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
            </div>
            {children}
        </section>
    );
}

export function Empty({ children }) {
    return <p className="rounded-lg border border-dashed border-[#CBD5E1] px-3 py-4 text-center text-[13px] text-[#64748B]">{children}</p>;
}
