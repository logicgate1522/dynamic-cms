import Script from "next/script";

import AnalyticsEvents from "@/components/seo/AnalyticsEvents";
import RawHtmlInjector from "@/components/seo/RawHtmlInjector";

/* =========================================
   Tracking tags from Site tools → Settings → Tracking & analytics
   (SiteSettings.analytics). Nothing renders until an ID is filled in.

   One bootstrap script runs first, in this order:
     1. window.dataLayer + gtag() exist
     2. Google consent-mode default (if set): granted | denied
     3. the data-layer variables an admin defined ({ key: value } pairs)
     4. GTM, GA4 and Google Ads
   then Meta Pixel, TikTok, LinkedIn, Clarity, Hotjar and any custom code.
   Events (page views on in-site navigation, leads, phone/email clicks) go
   through lib/track.js — see <AnalyticsEvents>.
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

export default function Analytics({ analytics = {} }) {
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
    const consent = analytics.consentDefault === "granted" || analytics.consentDefault === "denied" ? analytics.consentDefault : null;
    const google = gtm || ga4 || ads;

    const bootstrap = [
        "window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){dataLayer.push(arguments);};",
        consent
            ? `gtag('consent','default',${inline({ ad_storage: consent, ad_user_data: consent, ad_personalization: consent, analytics_storage: consent, wait_for_update: 500 })});`
            : "",
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

            {pixel ? (
                <Script id="meta-pixel" strategy="afterInteractive">
                    {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',${inline(pixel)});fbq('track','PageView');`}
                </Script>
            ) : null}

            {tiktok ? (
                <Script id="tiktok-pixel" strategy="afterInteractive">
                    {`!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=d.createElement("script");o.type="text/javascript";o.async=!0;o.src=i+"?sdkid="+e+"&lib="+t;var a=d.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load(${inline(tiktok)});ttq.page();}(window,document,'ttq');`}
                </Script>
            ) : null}

            {clarity ? (
                <Script id="clarity" strategy="afterInteractive">
                    {`(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script",${inline(clarity)});`}
                </Script>
            ) : null}

            {hotjar ? (
                <Script id="hotjar" strategy="lazyOnload">
                    {`(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};h._hjSettings={hjid:${Number(hotjar)},hjsv:6};a=o.getElementsByTagName('head')[0];r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');`}
                </Script>
            ) : null}

            {linkedin ? (
                <Script id="linkedin-insight" strategy="lazyOnload">
                    {`_linkedin_partner_id=${inline(linkedin)};window._linkedin_data_partner_ids=window._linkedin_data_partner_ids||[];window._linkedin_data_partner_ids.push(_linkedin_partner_id);(function(l){if(!l){window.lintrk=function(a,b){window.lintrk.q.push([a,b])};window.lintrk.q=[]}var s=document.getElementsByTagName("script")[0];var b=document.createElement("script");b.type="text/javascript";b.async=true;b.src="https://snap.licdn.com/li.lms-analytics/insight.min.js";s.parentNode.insertBefore(b,s);})(window.lintrk);`}
                </Script>
            ) : null}

            <AnalyticsEvents analytics={{ events: analytics.events, excludeAdmins: analytics.excludeAdmins, googleAdsId: ads, googleAdsLeadLabel: analytics.googleAdsLeadLabel, linkedinLeadConversionId: analytics.linkedinLeadConversionId }} />

            <RawHtmlInjector snippets={analytics.customHead} target="head" />
            <RawHtmlInjector snippets={analytics.customBodyStart} target="body" position="start" />
            <RawHtmlInjector snippets={analytics.customBodyEnd} target="body" />
        </>
    );
}
