"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";

import VerifyHarness from "@/components/seo/VerifyHarness";
import { API } from "@/lib/api";
import { configureConsent, getConsent, onConsent } from "@/lib/consent";
import { initProfile, setProfilePersistence, visitorId } from "@/lib/intentProfile";
import { configureTracking, setVerifyToken } from "@/lib/track";
import { startCapture, startPage } from "@/lib/trackCapture";

/* =========================================
   Starts tracking on every page (R31/R32):
   - consent (lib/consent.js) from the plan's region and the stored choice
   - the intent profile (session-only until analytics consent)
   - lib/track.js with Settings → Tracking and GET tracking/config/
   - automatic capture (lib/trackCapture.js): page views on navigation
     (the tags record the first load), CTAs, sections, scroll, FAQs, forms…
   - verification runs (?cms-verify=<token>) via <VerifyHarness>
   Leads (generate_lead) fire from lib/forms.js after a stored submission.
========================================= */

function verifyTokenFromUrl() {
    try {
        const fromUrl = new URLSearchParams(window.location.search).get("cms-verify");
        if (fromUrl) window.sessionStorage.setItem("cms_verify", fromUrl);
        return fromUrl || window.sessionStorage.getItem("cms_verify") || "";
    } catch {
        return "";
    }
}

function Events({ analytics, tracking, consent }) {
    const pathname = usePathname();
    const search = useSearchParams();
    const first = useRef(true);
    const ready = useRef(false);

    if (!ready.current && typeof window !== "undefined") {
        ready.current = true;
        const token = verifyTokenFromUrl();
        setVerifyToken(token);
        configureConsent(consent);
        configureTracking(analytics, tracking);
        initProfile({ analytics: getConsent().analytics });
        window.__cmsVisitorId = visitorId();
    }

    useEffect(() => {
        configureTracking(analytics, tracking);
    }, [analytics, tracking]);

    useEffect(() => onConsent((next, prev) => {
        const forgotten = setProfilePersistence(next.analytics);
        window.__cmsVisitorId = visitorId();
        if (forgotten && prev.analytics && !next.analytics) {
            const body = JSON.stringify({ vid: forgotten });
            try {
                navigator.sendBeacon(`${API}/events/forget/`, new Blob([body], { type: "text/plain" }));
            } catch {
                /* best effort */
            }
        }
    }), []);

    useEffect(() => {
        startCapture();
    }, []);

    useEffect(() => {
        startPage({ initial: first.current });
        first.current = false;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname, search?.get("page")]);

    return null;
}

export default function AnalyticsEvents({ analytics = {}, tracking = null, consent = {} }) {
    return (
        <Suspense fallback={null}>
            <Events analytics={analytics} tracking={tracking} consent={consent} />
            <VerifyHarness />
        </Suspense>
    );
}
