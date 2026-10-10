import Script from "next/script";

import AnalyticsEvents from "@/components/seo/AnalyticsEvents";
import ConsentBanner from "@/components/seo/ConsentBanner";
import ConsentedTags from "@/components/seo/ConsentedTags";
import RawHtmlInjector from "@/components/seo/RawHtmlInjector";
import { getTrackingConfig } from "@/lib/cms";

/* =========================================
   Tracking tags from Site tools → Settings → Tracking & analytics
   (SiteSettings.analytics). Nothing renders until an ID is filled in.

   One bootstrap script runs first, in this order:
     1. window.dataLayer + gtag() exist
     2. Google Consent Mode default (R32): from the plan's region
        (uk_eu → denied until the visitor chooses; us → granted; other →
        Settings → Consent default), then the stored choice
     3. the data-layer variables an admin defined ({ key: value } pairs)
     4. GTM, GA4 and Google Ads
   Meta Pixel, TikTok and LinkedIn load only with marketing consent, Clarity
   and Hotjar only with analytics consent (<ConsentedTags>). The consent
   banner shows when any tag is set and the visitor hasn't chosen.
   Events go through lib/track.js — see <AnalyticsEvents>. Render this INSIDE
   <AdminProvider> so the banner's text is editable in place.
========================================= */

const PATTERNS = {
    gtmId: /^GTM-[A-Z0-9]{4,12}$/,
    ga4Id: /^G-[A-Z0-9]{4,16}$/,
    googleAdsId: /^AW-\d{6,14}$/,
    metaPixelId: /^\d{10,20}$/,
    tiktokPixelId: /^[A-Z0-9]{15,30}$/,
    linkedinPartnerId: /^\d{4,12}$/,
    clarityId: /^[a-z0-9]{8,16}$/,
    hotjarId: /^\d{5,12}$/,
};

function id(analytics, key) {
    const value = String(analytics[key] || "").trim();
    return PATTERNS[key].test(value) ? value : null;
}

// JSON safe to inline in a <script> (no "</script>" breakouts).
const inline = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

export default async function Analytics({ analytics = {} }) {
    const tracking = await getTrackingConfig();
    const gtm = id(analytics, "gtmId");
    const ga4 = id(analytics, "ga4Id");
    const ads = id(analytics, "googleAdsId");
    const pixel = id(analytics, "metaPixelId");
    const tiktok = id(analytics, "tiktokPixelId");
    const linkedin = id(analytics, "linkedinPartnerId");
    const clarity = id(analytics, "clarityId");
    const hotjar = id(analytics, "hotjarId");

    const variables = Object.fromEntries(
        (Array.isArray(analytics.dataLayer) ? analytics.dataLayer : [])
            .filter((row) => row && /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(row.key || ""))
            .map((row) => [row.key, row.value])
    );
    const region = tracking?.region || (analytics.consentDefault === "granted" ? "other" : "uk_eu");
    const consentDefault = region === "us" || (region === "other" && analytics.consentDefault === "granted") ? "granted" : "denied";
    const google = gtm || ga4 || ads;
    const hasTags = Boolean(google || pixel || tiktok || linkedin || clarity || hotjar || (analytics.customHead || []).length);
    const consentVersion = String(analytics.consentVersion || "1");

    // The stored choice (cms_consent cookie) is applied before any tag runs,
    // so a returning visitor's consent is in place for the first hit.
    const storedChoice = `try{var m=document.cookie.match(/(?:^|; )cms_consent=([^;]*)/);if(m){var c=JSON.parse(decodeURIComponent(m[1]));if(c.v===${inline(consentVersion)}){var a=c.analytics?'granted':'denied',k=c.marketing?'granted':'denied';gtag('consent','update',{analytics_storage:a,ad_storage:k,ad_user_data:k,ad_personalization:k});}}}catch(e){}`;
    const bootstrap = [
        "window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){dataLayer.push(arguments);};",
        `gtag('consent','default',${inline({ ad_storage: consentDefault, ad_user_data: consentDefault, ad_personalization: consentDefault, analytics_storage: consentDefault, wait_for_update: 500 })});`,
        storedChoice,
        Object.keys(variables).length ? `dataLayer.push(${inline(variables)});` : "",
        gtm
            ? `window.__cmsGtm=true;(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${inline(gtm)});`
            : "",
        ga4 || ads ? "gtag('js',new Date());" : "",
        ga4 ? `gtag('config',${inline(ga4)});` : "",
        ads ? `gtag('config',${inline(ads)});` : "",
    ].join("");

    return (
        <>
            {google || Object.keys(variables).length ? (
                <Script id="cms-tags-bootstrap" strategy="afterInteractive">{bootstrap}</Script>
            ) : null}
            {ga4 || ads ? <Script src={`https://www.googletagmanager.com/gtag/js?id=${ga4 || ads}`} strategy="afterInteractive" /> : null}

            <ConsentedTags pixel={pixel} tiktok={tiktok} linkedin={linkedin} clarity={clarity} hotjar={hotjar} />

            <AnalyticsEvents
                analytics={{ events: analytics.events, excludeAdmins: analytics.excludeAdmins, googleAdsId: ads, ga4Id: ga4,
                    googleAdsLeadLabel: analytics.googleAdsLeadLabel, linkedinLeadConversionId: analytics.linkedinLeadConversionId }}
                tracking={tracking && tracking.vocab ? tracking : null}
                consent={{ region, consentDefault: analytics.consentDefault, version: consentVersion, hasTags }}
            />
            {hasTags ? <ConsentBanner consent={{ region, consentDefault: analytics.consentDefault, version: consentVersion, hasTags }} /> : null}

            <RawHtmlInjector snippets={analytics.customHead} target="head" />
            <RawHtmlInjector snippets={analytics.customBodyStart} target="body" position="start" />
            <RawHtmlInjector snippets={analytics.customBodyEnd} target="body" />
        </>
    );
}
