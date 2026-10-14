"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";

import VerifyHarness from "@/components/seo/VerifyHarness";
import { API } from "@/lib/api";
import { configureConsent, getConsent, onConsent } from "@/lib/consent";
import { initProfile, setProfilePersistence, visitorId } from "@/lib/intentProfile";
import { configureTracking, fireTestEvents, setVerifyToken } from "@/lib/track";
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

    // "Send test events" (Settings → Tracking, Tracking → Tools): fire every event and conversion once into the
    // data layer of THIS page, so a GTM Preview / GA4 DebugView session attached to it receives them.
    // `?cms-fire-events=1` does it on load for a signed-in admin; the tracking drawer calls window.__cmsFireEvents.
    useEffect(() => {
        const note = (text, done) => {
            let box = document.querySelector("[data-cms-fire-note]");
            if (!box) {
                box = Object.assign(document.createElement("div"), { className: "cms-ui" });
                box.setAttribute("data-cms-fire-note", "");
                box.setAttribute("data-visual-ignore", "");
                box.style.cssText = "position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:2147483000;max-width:92vw;padding:10px 16px;border-radius:12px;background:#0F172A;color:#fff;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 12px 32px rgba(2,6,23,.4)";
                document.body.appendChild(box);
            }
            box.textContent = text;
            if (done) setTimeout(() => box.remove(), 9000);
        };
        const run = async () => {
            if (!window.__cmsAdmin) {
                note("Sign in to the CMS on this browser to send test events.", true);
                return null;
            }
            const result = await fireTestEvents({ onProgress: (p) => note(`Sending test ${p.step}: ${p.name}…`) });
            note(`Sent ${result.events} events and ${result.conversions} conversions to this page's data layer. Check GTM Preview or GA4 DebugView.`, true);
            return result;
        };
        window.__cmsFireEvents = run;
        let timer = 0;
        if (new URLSearchParams(window.location.search).get("cms-fire-events")) {
            // The admin flag is set once the session check finishes.
            let tries = 0;
            timer = setInterval(() => {
                tries += 1;
                if (window.__cmsAdmin || tries > 20) {
                    clearInterval(timer);
                    run();
                }
            }, 400);
        }
        return () => {
            clearInterval(timer);
            delete window.__cmsFireEvents;
        };
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
