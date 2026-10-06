import "server-only";

import { resolveSeo, getSiteSettings } from "@/lib/cms";

/* =========================================
   SEO
   generateMetadata() is a thin mapping of
   GET seo/resolve/<path>/ — precedence lives in
   the backend. The page's existing static
   metadata is used only where the CMS is empty.
========================================= */

export { SITE_NAME } from "@/lib/brand";
import { SITE_NAME } from "@/lib/brand";

// The home page has no path segment; the backend keys it as "home".
export function seoKey(path) {
    return path.replace(/^\/+|\/+$/g, "") || "home";
}

function languagesFrom(hreflang = []) {
    const out = {};
    for (const item of hreflang) {
        if (item?.lang && item?.href) out[item.lang] = item.href;
    }
    return Object.keys(out).length ? out : undefined;
}

function robotsFrom(robots = {}) {
    return {
        index: robots.index !== false,
        follow: robots.follow !== false,
        nocache: robots.nocache || robots.noarchive || undefined,
        noarchive: robots.noarchive || undefined,
        nosnippet: robots.nosnippet || undefined,
        noimageindex: robots.noimageindex || undefined,
        googleBot: {
            index: robots.index !== false,
            follow: robots.follow !== false,
            "max-snippet": robots.maxSnippet,
            "max-image-preview": robots.maxImagePreview,
            "max-video-preview": robots.maxVideoPreview,
        },
    };
}

export function verificationFrom(verification = {}) {
    const other = {};
    if (verification.bing) other["msvalidate.01"] = verification.bing;
    if (verification.pinterest) other["p:domain_verify"] = verification.pinterest;
    if (verification.facebookDomain) other["facebook-domain-verification"] = verification.facebookDomain;

    const out = {
        google: verification.google || undefined,
        yandex: verification.yandex || undefined,
        other: Object.keys(other).length ? other : undefined,
    };
    return Object.values(out).some(Boolean) ? out : undefined;
}

// Map a resolve response onto Next's Metadata object. `siteSeo` is
// SiteSettings.seoDefaults: when the resolve only returned those site-wide
// defaults (no page-specific SEO saved), the page's own fallback wins.
export function metadataFromResolved(resolved, fallback = {}, siteSeo = {}) {
    if (!resolved || resolved.path === undefined) return fallback;

    const social = resolved.social || {};
    const canonical = resolved.canonical;

    const fallbackTitle = typeof fallback.title === "string" ? fallback.title : fallback.title?.absolute;
    const genericTitle = !resolved.title || resolved.title === siteSeo.defaultTitle;
    const genericDescription = !resolved.description || resolved.description === siteSeo.defaultDescription;
    const title = (genericTitle && fallbackTitle) || resolved.fullTitle || fallbackTitle;
    const description = (genericDescription && fallback.description) || resolved.description || fallback.description;
    const ogImage = social.ogImage;

    const metadata = {
        ...fallback,
        title: title ? { absolute: title } : fallback.title,
        description,
        robots: robotsFrom(resolved.robots),
        openGraph: {
            ...(fallback.openGraph || {}),
            type: social.ogType || "website",
            title: (!genericTitle && social.ogTitle) || title,
            description: social.ogDescription || description,
            locale: resolved.locale || undefined,
            siteName: SITE_NAME,
            ...(canonical ? { url: canonical } : {}),
            ...(ogImage
                ? { images: [{ url: ogImage, width: 1200, height: 630, alt: social.ogImageAlt || title }] }
                : {}),
        },
        twitter: {
            card: social.twitterCard || "summary_large_image",
            title: (!genericTitle && social.twitterTitle) || title,
            description: social.twitterDescription || description,
            ...(social.twitterHandle ? { site: social.twitterHandle, creator: social.twitterHandle } : {}),
            ...(social.twitterImage ? { images: [social.twitterImage] } : {}),
        },
    };

    const alternates = {};
    if (canonical) alternates.canonical = canonical;
    const languages = languagesFrom(resolved.hreflang);
    if (languages) alternates.languages = languages;
    if (resolved.alternates?.rss) alternates.types = { "application/rss+xml": resolved.alternates.rss };
    if (Object.keys(alternates).length) metadata.alternates = alternates;

    const keywords = resolved.keywords || {};
    const keywordList = [keywords.primary, ...(keywords.secondary || [])].filter(Boolean);
    if (keywordList.length) metadata.keywords = keywordList;

    const verification = verificationFrom(resolved.verification);
    if (verification) metadata.verification = verification;

    const other = {};
    if (resolved.prev) other.prev = resolved.prev;
    if (resolved.next) other.next = resolved.next;
    if (Object.keys(other).length) metadata.other = { ...(fallback.other || {}), ...other };

    return metadata;
}

export async function pageMetadata(path, fallback = {}) {
    const [resolved, settings] = await Promise.all([resolveSeo(seoKey(path)), getSiteSettings()]);
    return metadataFromResolved(resolved, fallback, settings.seoDefaults || {});
}

// JSON-LD graph for a route. The home page drops its self-referencing
// "Home > Home" breadcrumb.
export async function pageJsonLd(path) {
    const resolved = await resolveSeo(seoKey(path));
    const jsonLd = resolved?.jsonLd;
    if (!jsonLd?.["@graph"]) return null;

    if (seoKey(path) === "home") {
        const graph = jsonLd["@graph"].filter((node) => node["@type"] !== "BreadcrumbList");
        return graph.length ? { ...jsonLd, "@graph": graph } : null;
    }

    return jsonLd;
}

export async function siteDefaults() {
    const settings = await getSiteSettings();
    return settings?.seoDefaults || {};
}
