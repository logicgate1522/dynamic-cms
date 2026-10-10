"use client";

import { useEffect, useState } from "react";

import { useCms } from "@/components/cms/useCms";
import { configureConsent, getConsent, needsBanner, openConsentSettings, setConsent } from "@/lib/consent";

/* =========================================
   Cookie consent banner (R32). Shown when any tracking tag is set and the
   visitor hasn't chosen (opt-in regions), and whenever "Cookie settings" is
   clicked (any element with data-cms-consent-open, or openConsentSettings()).
   - "Accept all" and "Reject all" are equally prominent (UK ICO guidance)
   - "Choose" lets the visitor pick analytics / marketing separately
   - sits at the bottom, never covers more than ~40% of a phone screen
   - every word is editable in place (useCms "consent-banner")
   Theme with CSS variables: --consent-bg, --consent-fg, --consent-muted,
   --consent-accent, --consent-accent-fg, --consent-border.
========================================= */

const defaults = {
    title: "Cookies on this site",
    text: "We use necessary cookies to make this site work. With your permission we'd also like to use analytics cookies to understand how the site is used, and marketing cookies to measure our advertising.",
    acceptText: "Accept all",
    rejectText: "Reject all",
    chooseText: "Choose",
    saveText: "Save choices",
    analyticsLabel: "Analytics",
    analyticsHelp: "Anonymous statistics about which pages are useful.",
    marketingLabel: "Marketing",
    marketingHelp: "Measures which ads bring visitors, and shows our ads to people who visited.",
    necessaryLabel: "Necessary",
    necessaryHelp: "Needed for the site to work. Always on.",
    policyText: "Cookie policy",
    policyHref: "/privacy",
};

export function CookieSettingsLink({ children, className = "" }) {
    return (
        <button type="button" data-cms-consent-open className={className} onClick={openConsentSettings}>
            {children}
        </button>
    );
}

export default function ConsentBanner({ consent = null }) {
    const { data, hidden, E, editButton, editMode } = useCms("consent-banner", defaults, { label: "Cookie banner", hideable: false });
    const [open, setOpen] = useState(false);
    const [choosing, setChoosing] = useState(false);
    const [choice, setChoice] = useState({ analytics: false, marketing: false });

    useEffect(() => {
        // Configure here too: <AnalyticsEvents> may render later (Suspense).
        if (consent) configureConsent(consent);
        if (needsBanner()) setOpen(true);
        const show = () => {
            const c = getConsent();
            setChoice({ analytics: c.analytics, marketing: c.marketing });
            setChoosing(true);
            setOpen(true);
        };
        const onClick = (e) => {
            if (e.target?.closest?.("[data-cms-consent-open]")) show();
        };
        window.addEventListener("cms:consent-open", show);
        document.addEventListener("click", onClick);
        return () => {
            window.removeEventListener("cms:consent-open", show);
            document.removeEventListener("click", onClick);
        };
    }, [consent]);

    if (hidden || !open) return null;

    const done = (c) => {
        setConsent(c);
        if (!editMode) setOpen(false);
    };

    const button = "inline-flex min-h-[44px] flex-1 items-center justify-center rounded-lg px-4 text-[14px] font-semibold transition sm:flex-none";
    const solid = `${button} bg-[var(--consent-accent,#0F766E)] text-[var(--consent-accent-fg,#fff)] hover:brightness-110`;

    return (
        <section
            role="region"
            aria-label={data.title}
            data-cms-consent-banner
            className="fixed inset-x-0 bottom-0 z-[1500] max-h-[42vh] overflow-y-auto border-t border-[var(--consent-border,rgba(255,255,255,0.12))] bg-[var(--consent-bg,#0F172A)] text-[var(--consent-fg,#F8FAFC)] shadow-[0_-12px_40px_rgba(0,0,0,0.25)]"
        >
            {editButton}
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6 md:flex-row md:items-end md:gap-6">
                <div className="min-w-0 flex-1">
                    <h2 className="text-[16px] font-bold"><E.Text path="title" /></h2>
                    <p className="mt-1 text-[13px] leading-6 text-[var(--consent-muted,#CBD5E1)]">
                        <E.Text path="text" multiline />{" "}
                        <a href={data.policyHref} className="underline underline-offset-2"><E.Text path="policyText" /><E.Link path="policyHref" /></a>
                    </p>
                    {choosing ? (
                        <div className="mt-3 grid gap-2 sm:grid-cols-3">
                            <label className="flex items-start gap-2 text-[13px] opacity-80">
                                <input type="checkbox" checked disabled className="mt-1" />
                                <span><strong className="block"><E.Text path="necessaryLabel" /></strong><E.Text path="necessaryHelp" /></span>
                            </label>
                            <label className="flex items-start gap-2 text-[13px]">
                                <input type="checkbox" className="mt-1" checked={choice.analytics} onChange={(e) => setChoice({ ...choice, analytics: e.target.checked })} />
                                <span><strong className="block"><E.Text path="analyticsLabel" /></strong><E.Text path="analyticsHelp" /></span>
                            </label>
                            <label className="flex items-start gap-2 text-[13px]">
                                <input type="checkbox" className="mt-1" checked={choice.marketing} onChange={(e) => setChoice({ ...choice, marketing: e.target.checked })} />
                                <span><strong className="block"><E.Text path="marketingLabel" /></strong><E.Text path="marketingHelp" /></span>
                            </label>
                        </div>
                    ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                    <button type="button" className={solid} data-cms-consent="reject" onClick={() => done({ analytics: false, marketing: false })}>
                        <E.Text path="rejectText" />
                    </button>
                    <button type="button" className={solid} data-cms-consent="accept" onClick={() => done({ analytics: true, marketing: true })}>
                        <E.Text path="acceptText" />
                    </button>
                    {choosing ? (
                        <button type="button" className={`${button} border border-current`} data-cms-consent="save" onClick={() => done(choice)}>
                            <E.Text path="saveText" />
                        </button>
                    ) : (
                        <button type="button" className={`${button} border border-current`} data-cms-consent="choose" onClick={() => setChoosing(true)}>
                            <E.Text path="chooseText" />
                        </button>
                    )}
                </div>
            </div>
        </section>
    );
}
