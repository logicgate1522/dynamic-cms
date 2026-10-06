import JsonLd from "@/components/seo/JsonLd";
import SeoEditPanel from "@/components/cms/SeoEditPanel";
import { pageJsonLd, seoKey } from "@/lib/seo";

// Per-route JSON-LD + the admin-only SEO editor for that route.
export default async function PageSeo({ path }) {
    const jsonLd = await pageJsonLd(path);

    return (
        <>
            <JsonLd data={jsonLd} />
            <SeoEditPanel path={seoKey(path)} />
        </>
    );
}
