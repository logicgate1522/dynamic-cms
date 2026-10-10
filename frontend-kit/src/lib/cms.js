import "server-only";

import { API } from "@/lib/api";

/* =========================================
   Server-side CMS reads.
   Every read is cached (ISR) and never throws:
   if the backend is down the site renders its
   built-in defaults instead of failing.
========================================= */

export const REVALIDATE = {
    content: 60,
    settings: 3600,
    seo: 300,
    blog: 300,
};

// The site's server identifies itself with the shared REVALIDATE_SECRET so
// the backend doesn't rate-limit it as one anonymous visitor (every page
// render comes from this one IP). Server-only: never reaches the browser.
const SERVER_HEADERS = process.env.REVALIDATE_SECRET ? { "X-CMS-Frontend": process.env.REVALIDATE_SECRET } : {};

async function cmsFetch(path, { revalidate = REVALIDATE.content, tags = [], fallback = {} } = {}) {
    try {
        const res = await fetch(`${API}/${path}`, {
            headers: SERVER_HEADERS,
            next: { revalidate, tags: ["cms", ...tags] },
        });
        if (!res.ok) return fallback;
        return await res.json();
    } catch {
        return fallback;
    }
}

// Walk a paginated {count,next,previous,results} list. Returns null when
// the backend is unreachable so callers can fall back to local data.
async function cmsFetchAll(path, options = {}) {
    const first = await cmsFetch(path, { ...options, fallback: null });
    if (!first) return null;
    if (Array.isArray(first)) return first;

    const results = [...(first.results || [])];
    let next = first.next;

    for (let page = 2; next && page <= 50; page += 1) {
        const sep = path.includes("?") ? "&" : "?";
        const data = await cmsFetch(`${path}${sep}page=${page}`, { ...options, fallback: null });
        if (!data) break;
        results.push(...(data.results || []));
        next = data.next;
    }

    return results;
}

export function contentTag(name) {
    return `cms:home:${name}`;
}

export function getContent(name) {
    return cmsFetch(`home/${name}/`, { tags: [contentTag(name)] });
}

// { name: data } for several editable sections at once (fetched in parallel).
export async function getContents(names) {
    const entries = await Promise.all(names.map(async (name) => [name, await getContent(name)]));
    return Object.fromEntries(entries);
}

// Tracking plan as the kit needs it (R31): conversions, page → intent,
// vocabulary. Public and cached; refreshed by the "cms:tracking" webhook tag.
export function getTrackingConfig() {
    return cmsFetch("tracking/config/", { revalidate: REVALIDATE.settings, tags: ["cms:settings", "cms:tracking", "cms:pages"] });
}

export function getSiteSettings() {
    return cmsFetch("settings/site/", { revalidate: REVALIDATE.settings, tags: ["cms:settings"] });
}

// The home page resolves at the root (seo/resolve/), stored as "home".
export function resolveSeo(path) {
    const key = path.replace(/^\/+|\/+$/g, "");
    const isHome = !key || key === "home";
    return cmsFetch(isHome ? "seo/resolve/" : `seo/resolve/${key}/`, {
        revalidate: REVALIDATE.seo,
        tags: ["cms:seo", `cms:seo:${isHome ? "home" : key}`],
    });
}

export function getBlogPosts() {
    return cmsFetchAll("blog/", { revalidate: REVALIDATE.blog, tags: ["cms:blog"] });
}

export async function getBlogPost(slug) {
    const data = await cmsFetch(`blog/${slug}/`, {
        revalidate: REVALIDATE.blog,
        tags: ["cms:blog", `cms:blog:${slug}`],
        fallback: null,
    });
    return data && data.slug ? data : null;
}

export async function getBlogSections(slug) {
    const data = await cmsFetch(`blog/${slug}/sections/`, {
        revalidate: REVALIDATE.blog,
        tags: [`cms:blog:${slug}`],
        fallback: [],
    });
    return Array.isArray(data) ? data : data.results || [];
}

export async function getContentPage(path) {
    const data = await cmsFetch(`content/pages/${path}/`, {
        revalidate: REVALIDATE.blog,
        tags: ["cms:pages", `cms:page:${path}`],
        fallback: null,
    });
    return data && data.path ? data : null;
}

export async function getContentPages() {
    return (await cmsFetchAll("content/pages/", { revalidate: REVALIDATE.blog, tags: ["cms:pages"] })) || [];
}

export async function getPageSeoList() {
    return (await cmsFetchAll("seo/", { revalidate: REVALIDATE.seo, tags: ["cms:seo"] })) || [];
}
