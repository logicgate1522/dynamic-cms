"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import ArticleBody from "@/components/blog/ArticleBody";
import ArticleHero from "@/components/blog/ArticleHero";
import RelatedArticles from "@/components/blog/RelatedArticles";
import DynamicPageAdmin from "@/components/dynamic/DynamicPageAdmin";
import { apiRequest } from "@/lib/api";
import { articlesFrom, postToArticle } from "@/lib/blog";

// On a 404 an admin may be looking at a CMS page that is still a draft
// (drafts are hidden from the public). Load it with the admin session and
// show it EXACTLY as it will look once published — same hero, same body,
// same related list — fully editable; everyone else sees the normal 404.
export default function DraftPreview({ children }) {
    const { isAdmin, collection } = useAdmin();
    const entryVersion = collection.entry?.updated_at;
    const pathname = usePathname();
    const [found, setFound] = useState(null);

    useEffect(() => {
        if (!isAdmin || !pathname) return;
        const path = pathname.replace(/^\/+|\/+$/g, "");
        if (!path) return;

        const request = path.startsWith("blog/")
            ? Promise.all([apiRequest(`blog/${path.slice(5)}/`), apiRequest("blog/").catch(() => [])]).then(([post, list]) => ({
                  kind: "blog",
                  key: post.slug,
                  status: post.status,
                  dynamic: post.body_mode === "dynamic",
                  article: postToArticle(post),
                  articles: articlesFrom(Array.isArray(list) ? list : list.results || []),
              }))
            : apiRequest(`content/pages/${path}/`).then((row) => ({ kind: "content", key: row.path, status: row.status }));

        request.then(setFound).catch(() => setFound(null));
    }, [isAdmin, pathname, entryVersion]);

    if (!found) return children;

    if (found.article) {
        return (
            <>
                <ArticleHero article={found.article} />
                {found.dynamic ? (
                    <DynamicPageAdmin kind="blog" hostKey={found.key} />
                ) : (
                    <>
                        <div className="cms-ui sticky top-[70px] z-50 bg-[#FFFAEB] px-5 py-2.5 text-center text-[13px] font-medium text-[#B54708] lg:top-[76px]">
                            Draft article — only admins can see it. Publish it from Dashboard → Blog posts.
                        </div>
                        <ArticleBody article={found.article} />
                    </>
                )}
                <RelatedArticles article={found.article} articles={found.articles} />
            </>
        );
    }

    return <DynamicPageAdmin kind={found.kind} hostKey={found.key} />;
}
