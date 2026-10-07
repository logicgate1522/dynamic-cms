import { containsKeyword } from "@/lib/keywords";

/* =========================================
   Every mechanical SEO rule, in display order.
   MIRRORS api/prompts.py#seo_rule_checks id-for-id
   (the backend uses the same list in AI prompts and
   the whole-page assist) — change both together.
   Each rule says where it is fixed (tab + field) and how.
========================================= */

export const SEARCH_INTENTS = ["informational", "commercial", "transactional", "navigational", "local"];

// The subset the whole-page AI assist shows as "Other SEO rules".
export const PAGE_ASSIST_RULES = ["keyword-set", "title-keyword", "desc-keyword", "title-length", "desc-length", "schema-enabled"];

// `site` = SiteSettings data (for the site-wide default social image).
export function seoChecks(seo = {}, site = {}) {
    const keyword = String(seo.keywords?.primary || "").trim();
    const title = String(seo.seoTitle || "").trim();
    const desc = String(seo.metaDescription || "").trim();
    const social = seo.social || {};
    const robots = seo.robots || {};
    const secondary = (seo.keywords?.secondary || []).filter((k) => String(k).trim());

    const rule = (id, label, pass, field, tab, fix, skip = false) => ({ id, label, pass: Boolean(pass), skip, field, tab, fix });

    return [
        rule("keyword-set", "Primary keyword is set", keyword, "keywords.primary", "essentials",
            "Add the one phrase this page should rank for (Ask AI → Find keywords can choose it)."),
        rule("title-set", "SEO title is set", title, "seoTitle", "essentials",
            "Write an SEO title — it is the clickable headline in search results."),
        rule("title-length", `SEO title is 50–60 characters (now ${title.length})`, title.length >= 50 && title.length <= 60, "seoTitle", "essentials",
            "Tighten or expand the SEO title to 50–60 characters, keyword first."),
        rule("title-keyword", "SEO title contains the keyword", keyword && title && containsKeyword(title, keyword), "seoTitle", "essentials",
            "Work the primary keyword into the SEO title, near the start.", !keyword),
        rule("desc-set", "Meta description is set", desc, "metaDescription", "essentials",
            "Write a meta description — the two lines under the title in search results."),
        rule("desc-length", `Meta description is 120–160 characters (now ${desc.length})`, desc.length >= 120 && desc.length <= 160, "metaDescription", "essentials",
            "Adjust the meta description to 120–160 characters."),
        rule("desc-keyword", "Meta description contains the keyword", keyword && desc && containsKeyword(desc, keyword), "metaDescription", "essentials",
            "Work the primary keyword into the meta description.", !keyword),
        rule("secondary", `At least 3 secondary keywords (now ${secondary.length})`, secondary.length >= 3, "keywords.secondary", "essentials",
            "Add 3–8 related phrases the page also covers."),
        rule("intent-set", "Search intent is set", SEARCH_INTENTS.includes(seo.searchIntent), "searchIntent", "essentials",
            "Choose what a searcher wants: informational, commercial, transactional, navigational or local."),
        rule("canonical", "Canonical URL is set", seo.canonicalSelf !== false || String(seo.canonicalUrl || "").trim(), "canonicalUrl", "essentials",
            "Leave the canonical empty to use this page's own URL, or set the preferred URL."),
        rule("og-title", "Social title is available", social.ogTitle || title, "social.ogTitle", "sharing",
            "Set an SEO title (social reuses it) or a dedicated social title."),
        rule("og-desc", "Social description is available", social.ogDescription || desc, "social.ogDescription", "sharing",
            "Set a meta description (social reuses it) or a dedicated social description."),
        rule("og-image", "Social share image is set (this page's or the site default)", social.ogImage || site?.seoDefaults?.defaultOgImage, "social.ogImage", "sharing",
            "Upload a 1200×630 image for this page, or a site default in Settings → SEO defaults."),
        rule("og-alt", "Social image has alt text", !social.ogImage || social.ogImageAlt, "social.ogImageAlt", "sharing",
            "Describe the social image in one short sentence."),
        rule("indexable", "Page can be indexed", robots.index !== false, "robots.index", "sharing",
            "Turn “Allow indexing” back on — this page is hidden from search results."),
        rule("followable", "Links on the page are followed", robots.follow !== false, "robots.follow", "sharing",
            "Turn “Follow links” back on."),
        rule("sitemap", "Included in the sitemap", seo.sitemap?.include !== false, "sitemap.include", "sharing",
            "Turn “Include in sitemap” back on."),
        rule("schema-enabled", "Structured data (schema) is enabled", seo.schema?.enabled !== false, "schema.enabled", "advanced",
            "Re-enable structured data in Advanced."),
    ];
}

export function seoScore(checks) {
    const counted = checks.filter((c) => !c.skip);
    return counted.length ? Math.round((counted.filter((c) => c.pass).length / counted.length) * 100) : 0;
}
