"use client";

import { useEffect } from "react";

import { getConsent, onConsent } from "@/lib/consent";

/* =========================================
   Non-Google tags, loaded only with consent (R32):
     marketing → Meta Pixel, TikTok, LinkedIn Insight
     analytics → Microsoft Clarity, Hotjar
   Loaded once, when consent is (or becomes) granted. Withdrawing consent
   stops events (lib/track.js checks consent on every call) and asks the
   vendors to revoke (lib/consent.js).
   During a verification run (?cms-verify) Meta/TikTok/LinkedIn are replaced
   by recording stubs: checks see exactly what would be sent, and nothing is
   counted in the real accounts (the server copy uses each tool's test code).
========================================= */

const loaded = new Set();

function inject(id, code) {
    if (loaded.has(id) || document.getElementById(id)) return;
    loaded.add(id);
    const s = document.createElement("script");
    s.id = id;
    s.text = code;
    document.head.appendChild(s);
}

const q = (v) => JSON.stringify(String(v));

const LOADERS = {
    pixel: (id) => `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',${q(id)});fbq('track','PageView');`,
    tiktok: (id) => `!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=d.createElement("script");o.type="text/javascript";o.async=!0;o.src=i+"?sdkid="+e+"&lib="+t;var a=d.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load(${q(id)});ttq.page();}(window,document,'ttq');`,
    linkedin: (id) => `_linkedin_partner_id=${q(id)};window._linkedin_data_partner_ids=window._linkedin_data_partner_ids||[];window._linkedin_data_partner_ids.push(_linkedin_partner_id);(function(l){if(!l){window.lintrk=function(a,b){window.lintrk.q.push([a,b])};window.lintrk.q=[]}var s=document.getElementsByTagName("script")[0];var b=document.createElement("script");b.type="text/javascript";b.async=true;b.src="https://snap.licdn.com/li.lms-analytics/insight.min.js";s.parentNode.insertBefore(b,s);})(window.lintrk);`,
    clarity: (id) => `(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script",${q(id)});`,
    hotjar: (id) => `(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};h._hjSettings={hjid:${Number(id)},hjsv:6};a=o.getElementsByTagName('head')[0];r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');`,
};

function verifying() {
    try {
        return Boolean(new URLSearchParams(window.location.search).get("cms-verify") || window.sessionStorage.getItem("cms_verify"));
    } catch {
        return false;
    }
}

function stubs() {
    const calls = (window.__cmsVendorCalls = window.__cmsVendorCalls || []);
    window.fbq = window.fbq || ((...args) => calls.push({ tool: "meta", args }));
    window.ttq = window.ttq || { track: (...args) => calls.push({ tool: "tiktok", args }), page: () => {} };
    window.lintrk = window.lintrk || ((...args) => calls.push({ tool: "linkedin", args }));
}

export default function ConsentedTags({ pixel, tiktok, linkedin, clarity, hotjar }) {
    useEffect(() => {
        const ids = { pixel, tiktok, linkedin, clarity, hotjar };
        const apply = (c) => {
            if (verifying()) {
                stubs();
                return;
            }
            for (const key of ["pixel", "tiktok", "linkedin"]) if (ids[key] && c.marketing) inject(`cms-tag-${key}`, LOADERS[key](ids[key]));
            for (const key of ["clarity", "hotjar"]) if (ids[key] && c.analytics) inject(`cms-tag-${key}`, LOADERS[key](ids[key]));
        };
        apply(getConsent());
        return onConsent((c) => apply(c));
    }, [pixel, tiktok, linkedin, clarity, hotjar]);
    return null;
}
