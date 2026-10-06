// The site header is fixed; every first section except a hero needs room
// under it. Plain component — used by server and client renders alike.
export function HeaderSpacer({ sections = [] }) {
    const first = [...sections].sort((a, b) => a.order - b.order)[0];
    if (first?.section_type === "hero") return null;
    return <div aria-hidden="true" className="h-[70px] bg-[#071224] lg:h-[76px]" />;
}

export const HeaderSpacerClient = HeaderSpacer;
