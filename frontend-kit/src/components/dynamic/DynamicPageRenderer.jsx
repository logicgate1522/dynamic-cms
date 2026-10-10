import { SECTION_REGISTRY } from "@/components/dynamic/registry";
import { Fallback } from "@/components/dynamic/sections";
import { isHidden, stripHidden } from "@/lib/visibility";

// Renders CMS dynamic sections in order. Unknown types show a visible
// fallback box — content is never dropped and the route never crashes.
export default function DynamicPageRenderer({ sections = [] }) {
    return [...sections]
        .filter((section) => !isHidden(section.content)) // hidden by an admin: not rendered at all
        .sort((a, b) => a.order - b.order)
        .map((section) => {
            const Component = SECTION_REGISTRY[section.section_type];

            if (!Component) {
                return <Fallback key={section.id} type={section.section_type} />;
            }

            const content = stripHidden(section.content || {});
            const rendered = <Component {...content} media={section.media || []} />;

            // Optional "anchor" gives the section an id for in-page links (/legal#privacy).
            const anchor = typeof content.anchor === "string" && /^[\w-]+$/.test(content.anchor) ? content.anchor : null;

            // data-track-block: tracking knows which section a click or view
            // belongs to (R31). The wrapper adds no box styles of its own.
            return (
                <div key={section.id} id={anchor || undefined} className={anchor ? "scroll-mt-24" : undefined}
                     data-track-block={`section-${section.id}`} data-track-type={section.section_type}>
                    {rendered}
                </div>
            );
        });
}
