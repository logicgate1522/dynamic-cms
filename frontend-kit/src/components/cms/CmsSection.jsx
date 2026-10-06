import { CmsDataProvider } from "@/components/cms/CmsDataProvider";
import { getContents } from "@/lib/cms";

// Server wrapper: fetch the named content blobs, then render children
// with that data available to their useCms() hooks.
export default async function CmsSection({ names, children }) {
    const data = await getContents(names);
    return <CmsDataProvider data={data}>{children}</CmsDataProvider>;
}
