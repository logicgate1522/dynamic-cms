"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { useAdmin } from "@/components/cms/AdminProvider";
import ArticleBody from "@/components/blog/ArticleBody";
import ArticleHero from "@/components/blog/ArticleHero";
import DynamicPageAdmin from "@/components/dynamic/DynamicPageAdmin";
import { apiRequest } from "@/lib/api";
import { postToArticle } from "@/lib/blog";

// On a 404 an admin may be looking at a CMS page that is still a draft
// (drafts are hidden from the public). Load it with the admin session and
// show it — fully editable for section-built pages; everyone else sees the
// normal 404.
export default function DraftPreview({ children }) {
    const { isAdmin } = useAdmin();
    const pathname = usePathname();
    const [found, setFound] = useState(null);

    useEffect(() => {
        if (!isAdmin || !pathname) return;
        const path = pathname.replace(/^\/+|\/+$/g, "");
        if (!path) return;

        const request = path.startsWith("blog/")
            ? apiRequest(`blog/${path.slice(5)}/`).then((post) => ({
                  kind: "blog",
                  key: post.slug,
                  status: post.status,
                  article: post.body_mode === "dynamic" ? null : postToArticle(post),
              }))
            : apiRequest(`content/pages/${path}/`).then((row) => ({ kind: "content", key: row.path, status: row.status }));

        request.then(setFound).catch(() => setFound(null));
    }, [isAdmin, pathname]);

    if (!found) return children;

    if (found.article) {
        return (
            <>
                <ArticleHero article={found.article} />
                <div className="cms-ui sticky top-[70px] z-50 bg-[#FFFAEB] px-5 py-2.5 text-center text-[13px] font-medium text-[#B54708] lg:top-[76px]">
                    Draft article — only admins can see it. Publish it from Dashboard → Blog posts.
                </div>
                <ArticleBody article={found.article} />
            </>
        );
    }

    return <DynamicPageAdmin kind={found.kind} hostKey={found.key} />;
}
