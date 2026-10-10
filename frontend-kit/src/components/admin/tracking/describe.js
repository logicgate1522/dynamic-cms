// Plain-words descriptions of plan items for the Tracking panel.

export const EVENT_LABELS = {
    generate_lead: "A form is submitted",
    cta_click: "A call-to-action is clicked",
    nav_click: "A menu link is clicked",
    section_view: "A section is seen (2s)",
    scroll_depth: "A page is scrolled to a depth",
    service_engaged: "An offering's page is read (30s or half-way)",
    faq_open: "A FAQ is opened",
    form_start: "Someone starts a form",
    form_error: "A form shows an error",
    form_abandon: "Someone starts a form but leaves",
    contact_click: "A phone / email / WhatsApp link is clicked",
    outbound_click: "A link to another site is clicked",
    file_download: "A file is downloaded",
    search: "The site search is used",
    page_view: "A page is viewed",
};

export function labelOf(plan, kind, id) {
    return (plan?.[kind] || []).find((x) => x.id === id)?.label || id;
}

export function describeTrigger(trigger = {}, plan = {}) {
    const w = trigger.where || {};
    const parts = [EVENT_LABELS[trigger.event] || trigger.event];
    if (w.form) parts.push(`form “${w.form}”`);
    if (w.field && w.option != null) parts.push(`with “${w.option}” chosen in ${w.field}`);
    if (w.intent) parts.push(`about ${labelOf(plan, "intents", w.intent)}`);
    if (w.stage) parts.push(`signalling “${labelOf(plan, "stages", w.stage)}”`);
    if (w.segment) parts.push(`by ${labelOf(plan, "segments", w.segment)}`);
    if (w.blocks?.length) parts.push(`in ${w.blocks.join(", ")}`);
    if (w.ctaTargets?.length) parts.push(`going to ${w.ctaTargets.join(", ")}`);
    if (w.ctaLabel) parts.push(`labelled “${w.ctaLabel}”`);
    if (w.path) parts.push(`on ${w.path}`);
    if (w.pathPrefix) parts.push(`under ${w.pathPrefix}/`);
    if (w.pageType) parts.push(`on ${w.pageType} pages`);
    if (w.percent) parts.push(`to ${w.percent}%`);
    if (w.method) parts.push(`(${w.method})`);
    return parts.join(" ");
}

export function describeRule(rule = {}, plan = {}) {
    if (rule.conversion) return `did “${labelOf(plan, "conversions", rule.conversion)}”`;
    const bits = [EVENT_LABELS[rule.event] || rule.event];
    if (rule.intent) bits.push(`about ${labelOf(plan, "intents", rule.intent)}`);
    if (rule.stage) bits.push(`signalling “${labelOf(plan, "stages", rule.stage)}”`);
    if (rule.segment) bits.push(`as ${labelOf(plan, "segments", rule.segment)}`);
    if (rule.percent) bits.push(`${rule.percent}%`);
    return bits.join(" ");
}

export const TOOL_NAMES = { ga4: "Google Analytics 4", gtm: "Google Tag Manager", meta: "Meta (Facebook / Instagram)", googleAds: "Google Ads",
    tiktok: "TikTok", linkedin: "LinkedIn", clarity: "Microsoft Clarity", hotjar: "Hotjar" };

export const STATUS_TONE = {
    ok: "bg-[#ECFDF3] text-[#067647]", in_sync: "bg-[#ECFDF3] text-[#067647]", passed: "bg-[#ECFDF3] text-[#067647]", connected: "bg-[#ECFDF3] text-[#067647]",
    fail: "bg-[#FEF3F2] text-[#B42318]", failed: "bg-[#FEF3F2] text-[#B42318]", error: "bg-[#FEF3F2] text-[#B42318]", refused: "bg-[#FEF3F2] text-[#B42318]",
    needs_reauth: "bg-[#FEF3F2] text-[#B42318]", warn: "bg-[#FFFAEB] text-[#B54708]", manual: "bg-[#FFFAEB] text-[#B54708]", pending: "bg-[#FFFAEB] text-[#B54708]",
    blocked: "bg-[#F1F5F9] text-[#475569]", skipped: "bg-[#F1F5F9] text-[#475569]", inactive: "bg-[#F1F5F9] text-[#475569]",
    orphaned: "bg-[#F1F5F9] text-[#475569]", unmanaged: "bg-[#F1F5F9] text-[#475569]", draft: "bg-[#FFFAEB] text-[#B54708]", approved: "bg-[#ECFDF3] text-[#067647]",
};
