import { notFound } from "next/navigation";

import DynamicPageAdmin from "@/components/dynamic/DynamicPageAdmin";
import DynamicPageRenderer from "@/components/dynamic/DynamicPageRenderer";
import { HeaderSpacer } from "@/components/dynamic/HeaderSpacer";
import PageSeo from "@/components/seo/PageSeo";
import { BUILTIN_PAGES, builtinSections } from "@/data/pages";
import { getContentPage } from "@/lib/cms";
import { pageMetadata, SITE_NAME } from "@/lib/seo";

/* =========================================
   A CMS ContentPage (built with Paste to Build
   or seeded) rendered at `path`.
   - Published CMS page  -> rendered from the CMS
   - Otherwise, a built-in page for that path
     (src/data/pages) so linked routes never 404
   - Otherwise -> 404. Admins preview drafts from
     the not-found page.
========================================= */

async function load(path) {
    const page = await getContentPage(path);
    if (page && page.body_mode === "dynamic") {
        return { title: page.title, seoPath: page.seo_path || page.path, sections: page.sections || [], cms: true };
    }

    const builtin = BUILTIN_PAGES[path];
    if (builtin) {
        return { title: builtin.title, seoPath: builtin.path, sections: builtinSections(builtin), seo: builtin.seo };
    }

    return null;
}

export async function dynamicPageMetadata(path) {
    const page = await load(path);
    if (!page) return { title: { absolute: `Page Not Found | ${SITE_NAME}` }, robots: { index: false, follow: true } };
    return pageMetadata(`/${page.seoPath}`, {
        title: `${page.seo?.title || page.title} | ${SITE_NAME}`,
        ...(page.seo?.description ? { description: page.seo.description } : {}),
    });
}

export default async function DynamicContentPage({ path }) {
    const page = await load(path);

    if (!page) notFound();

    const rendered = (
        <>
            <HeaderSpacer sections={page.sections} />
            <DynamicPageRenderer sections={page.sections} />
        </>
    );

    return (
        <>
            {page.cms ? <DynamicPageAdmin kind="content" hostKey={path}>{rendered}</DynamicPageAdmin> : rendered}
            <PageSeo path={`/${page.seoPath}`} />
        </>
    );
}
