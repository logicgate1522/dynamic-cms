import Script from "next/script";

import RawHtmlInjector from "@/components/seo/RawHtmlInjector";

const SAFE_ID = /^[\w-]+$/;

function id(value) {
    return typeof value === "string" && SAFE_ID.test(value.trim()) ? value.trim() : null;
}

// Tracking tags built from the IDs in SiteSettings.analytics.
// Nothing renders until an admin fills those IDs in.
export default function Analytics({ analytics = {} }) {
    const gtm = id(analytics.gtmId);
    const ga4 = id(analytics.ga4Id);
    const pixel = id(analytics.metaPixelId);
    const clarity = id(analytics.clarityId);
    const hotjar = id(analytics.hotjarId);
    const linkedin = id(analytics.linkedinPartnerId);

    return (
        <>
            {gtm ? (
                <Script id="gtm" strategy="afterInteractive">
                    {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtm}');`}
                </Script>
            ) : null}

            {ga4 ? (
                <>
                    <Script src={`https://www.googletagmanager.com/gtag/js?id=${ga4}`} strategy="afterInteractive" />
                    <Script id="ga4" strategy="afterInteractive">
                        {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${ga4}');`}
                    </Script>
                </>
            ) : null}

            {pixel ? (
                <Script id="meta-pixel" strategy="afterInteractive">
                    {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixel}');fbq('track','PageView');`}
                </Script>
            ) : null}

            {clarity ? (
                <Script id="clarity" strategy="afterInteractive">
                    {`(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${clarity}");`}
                </Script>
            ) : null}

            {hotjar ? (
                <Script id="hotjar" strategy="lazyOnload">
                    {`(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};h._hjSettings={hjid:${Number(hotjar) || 0},hjsv:6};a=o.getElementsByTagName('head')[0];r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');`}
                </Script>
            ) : null}

            {linkedin ? (
                <Script id="linkedin-insight" strategy="lazyOnload">
                    {`_linkedin_partner_id="${linkedin}";window._linkedin_data_partner_ids=window._linkedin_data_partner_ids||[];window._linkedin_data_partner_ids.push(_linkedin_partner_id);(function(l){if(!l){window.lintrk=function(a,b){window.lintrk.q.push([a,b])};window.lintrk.q=[]}var s=document.getElementsByTagName("script")[0];var b=document.createElement("script");b.type="text/javascript";b.async=true;b.src="https://snap.licdn.com/li.lms-analytics/insight.min.js";s.parentNode.insertBefore(b,s);})(window.lintrk);`}
                </Script>
            ) : null}

            <RawHtmlInjector snippets={analytics.customHead} target="head" />
            <RawHtmlInjector snippets={analytics.customBodyStart} target="body" position="start" />
            <RawHtmlInjector snippets={analytics.customBodyEnd} target="body" />
        </>
    );
}
