"use client";

import { useState } from "react";

import { buttonStyles } from "@/components/cms/Drawer";
import { apiFetch } from "@/lib/api";

/* How events reach Google Tag Manager, in order, with the one button each step needs. The site always
   pushes every event and conversion into the data layer and loads the container when its ID is set;
   what GTM does with them is the CONTAINER: importing it is the step people miss. Used in
   Settings → Tracking and in Tracking → Tools. */
export default function GtmGuide({ analytics = {} }) {
    const [error, setError] = useState("");
    const gtm = String(analytics.gtmId || "").trim();
    const ga4 = String(analytics.ga4Id || "").trim();

    const [fired, setFired] = useState("");
    // On a site page (the tracking drawer) fire into THIS page's data layer; in the admin, open the site and fire there.
    const fire = async () => {
        setFired("");
        if (typeof window.__cmsFireEvents === "function") {
            const result = await window.__cmsFireEvents();
            if (result) setFired(`Sent ${result.events} events and ${result.conversions} conversions.`);
        } else {
            window.open("/?cms-fire-events=1", "_blank", "noopener");
            setFired("Opened your site in a new tab: it sends every event and conversion once, then shows a confirmation.");
        }
    };

    const download = async () => {
        setError("");
        try {
            const res = await apiFetch("tracking/gtm/");
            const url = URL.createObjectURL(await res.blob());
            Object.assign(document.createElement("a"), { href: url, download: "gtm-container-dynamic-cms.json" }).click();
            URL.revokeObjectURL(url);
        } catch (err) {
            setError(err.message);
        }
    };

    return (
        <div data-cms-gtm-guide className="rounded-xl border border-[#E2E8F0] bg-white p-4">
            <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[14px] font-bold">Send conversions to Google Tag Manager</h3>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${gtm ? "bg-[#ECFDF3] text-[#067647]" : "bg-[#FFFAEB] text-[#B54708]"}`}>{gtm ? `container ${gtm} is loaded on the site` : "no container ID yet"}</span>
            </div>
            <ol className="mt-3 space-y-2 text-[13px] text-[#334155]">
                <li><strong>1. Set the container ID</strong> in Settings → Tracking (GTM-…). {gtm ? "Done." : "Until then nothing is loaded."}</li>
                <li>
                    <strong>2. Give GTM the mapping.</strong> The site already pushes every event and every conversion (<code>event: &quot;conversion&quot;</code>, <code>conversion_id</code>) into the data layer; GTM only acts on them once the container has triggers and tags.
                    <div className="mt-1.5"><button type="button" className={buttonStyles.primary} onClick={download} data-cms-action="download-gtm">Download the container</button></div>
                    <span className="mt-1 block text-[12px] text-[#64748B]">In GTM: Admin → Import Container → choose the file → pick a workspace → <em>Merge</em> (not overwrite). It adds the data-layer variables, a trigger for each event and for conversions, and the GA4 event tags.{ga4 ? " Your GA4 ID is already loaded by the site, so the container does not add a second Google tag (page views are not counted twice)." : " Set the GA4 measurement ID in Settings first, or the GA4 tags in the file carry a placeholder."}</span>
                </li>
                <li><strong>3. Preview, then publish.</strong> In GTM click Preview, open your site and do a conversion (submit the form, click a phone number): the left list shows each event and the tags that fired. Publish when it looks right.</li>
                <li>
                    <strong>4. Send the events to GTM.</strong> One click fires every event and every conversion once into the data layer, flagged as test traffic (no ad pixels, no server copies, no visitor data). Do it while GTM Preview is connected to the site, so each one shows up in the left list with the tags that fired.
                    <div className="mt-1.5 flex flex-wrap items-center gap-2"><button type="button" className={buttonStyles.secondary} onClick={fire} data-cms-action="fire-test-events">Send test events to GTM</button>{fired ? <span className="text-[12px] font-semibold text-[#067647]">{fired}</span> : null}</div>
                    <span className="mt-1 block text-[12px] text-[#64748B]">With Preview: click Preview in GTM, enter your site address, then in the tab it opens add <code>?cms-fire-events=1</code> to the address (signed in to the CMS).</span>
                </li>
                <li><strong>5. Prove it.</strong> Tracking → Checks → <em>Run checks</em> triggers every conversion on the live site and shows what each tool received.</li>
            </ol>
            <p className="mt-3 text-[12px] text-[#64748B]">Meta, TikTok, LinkedIn, Clarity and Hotjar are loaded by the site itself from their IDs (consent-gated): they do not need GTM tags. Google Ads conversions are sent by the site when the Ads ID and lead label are set; do not add them in GTM as well.</p>
            {error ? <p className="mt-2 text-[12px] text-[#B42318]">{error}</p> : null}
        </div>
    );
}
