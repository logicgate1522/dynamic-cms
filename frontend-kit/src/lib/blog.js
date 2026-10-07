import { mediaUrl } from "@/lib/api";
import { SITE_NAME } from "@/lib/brand";
import { articles as localArticles } from "@/data/articles";

/* =========================================
   Blog
   CMS BlogPost <-> the article shape the blog
   components already render. Legacy-mode posts
   keep the article fields inside `content`:

   content: {
     coverImage, coverImageAlt, category, readTime,
     date, goodToKnow,
     sections: [{ id, eyebrow, heading, text: [], bullets: [] }]
   }
========================================= */

export const ARTICLE_CATEGORIES = [
    "VAT",
    "Payroll",
    "Accounting",
    "Personal Tax",
    "Compliance",
    "Small Business",
    "Tax",
];

function formatDate(iso) {
    if (!iso) return "";
    try {
        return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    } catch {
        return "";
    }
}

function readTimeFor(sections = []) {
    const words = sections
        .flatMap((s) => [s.heading, ...(s.text || []), ...(s.bullets || [])])
        .join(" ")
        .split(/\s+/)
        .filter(Boolean).length;
    return `${Math.max(1, Math.round(words / 220))} min read`;
}

export function postToArticle(post) {
    const content = post.content || {};
    const sections = Array.isArray(content.sections) ? content.sections : [];

    return {
        slug: post.slug,
        title: post.title,
        description: post.excerpt || "",
        author: post.author || `${SITE_NAME} Team`,
        category: content.category || "Accounting",
        image: mediaUrl(content.coverImage) || "/images/resources/article-1.png",
        imageAlt: content.coverImageAlt || post.title,
        date: content.date || formatDate(post.published_at || post.created_at),
        read: content.readTime || readTimeFor(sections),
        goodToKnow: content.goodToKnow || "",
        body: sections.map((section, index) => ({
            id: section.id || `section-${index + 1}`,
            eyebrow: section.eyebrow || "",
            heading: section.heading || "",
            text: Array.isArray(section.text) ? section.text : section.text ? [section.text] : [],
            ...(Array.isArray(section.bullets) && section.bullets.length ? { bullets: section.bullets } : {}),
        })),
        bodyMode: post.body_mode || "legacy",
        status: post.status,
        publishedAt: post.published_at,
        updatedAt: post.updated_at,
        source: "cms",
    };
}

export function articleToPost(article, extra = {}) {
    return {
        slug: article.slug,
        title: article.title,
        excerpt: article.description || "",
        author: article.author || "",
        status: "published",
        body_mode: "legacy",
        content: {
            coverImage: article.image || "",
            coverImageAlt: article.imageAlt || article.title,
            category: article.category || "",
            readTime: article.read || "",
            date: article.date || "",
            goodToKnow: article.goodToKnow || "",
            sections: article.body || [],
        },
        ...extra,
    };
}

export function withLocalSource(article) {
    return { ...article, source: "local", bodyMode: "legacy" };
}

// CMS posts when the CMS has any; otherwise the built-in articles, so the
// site never renders an empty blog (backend down, or not seeded yet).
export function articlesFrom(posts) {
    if (Array.isArray(posts) && posts.length) return posts.map(postToArticle);
    return localArticles.map(withLocalSource);
}

export function localArticle(slug) {
    const article = localArticles.find((item) => item.slug === slug);
    return article ? withLocalSource(article) : null;
}
