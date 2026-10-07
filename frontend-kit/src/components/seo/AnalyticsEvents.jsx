"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";

import { configureTracking, track } from "@/lib/track";

/* =========================================
   Automatic events (lib/track.js):
   - page_view on every in-site navigation (the tags record the first load)
   - contact_click when a tel: or mailto: link is clicked
   Leads (generate_lead) fire from lib/forms.js after a stored submission.
========================================= */

function Events({ analytics }) {
    const pathname = usePathname();
    const search = useSearchParams();
    const first = useRef(true);

    useEffect(() => {
        configureTracking(analytics);
    }, [analytics]);

    useEffect(() => {
        if (first.current) {
            first.current = false;
            return;
        }
        track("page_view", { page_path: pathname, page_location: window.location.href, page_title: document.title });
    }, [pathname, search]);

    useEffect(() => {
        const onClick = (event) => {
            const link = event.target.closest?.('a[href^="tel:"], a[href^="mailto:"]');
            if (!link) return;
            const href = link.getAttribute("href");
            track("contact_click", { method: href.startsWith("tel:") ? "phone" : "email", value: href.replace(/^(tel|mailto):/, "").split("?")[0] });
        };
        document.addEventListener("click", onClick, true);
        return () => document.removeEventListener("click", onClick, true);
    }, []);

    return null;
}

export default function AnalyticsEvents({ analytics = {} }) {
    return (
        <Suspense fallback={null}>
            <Events analytics={analytics} />
        </Suspense>
    );
}
