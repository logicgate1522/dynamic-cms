import Image from "next/image";
import Link from "next/link";

import { AddItem, ItemTools, SlotUpload, T } from "@/components/dynamic/edit-context";
import EditableParagraphs from "@/components/dynamic/EditableParagraphs";
import { itemImage, keyOf, MAP_URL, paragraphs, pick, safeHref, slotImage, VIDEO_URL } from "@/components/dynamic/media";

/* =========================================
   Dynamic section adapters
   One thin component per SECTION_SCHEMA type.
   Props = section.content + `media`.
   Visual language matches the rest of the site:
   navy #123A5C, teal #0F9E86, coral #FF6B4A,
   serif headings, 1280px container.
========================================= */

const container = "mx-auto w-full max-w-[1280px] px-5 sm:px-6 lg:px-8";
const sectionY = "py-16 sm:py-20 lg:py-24";
const eyebrowClass = "text-[11px] font-semibold uppercase tracking-[0.32em] text-[#0F9E86] sm:text-xs";
const h2Class = "font-serif text-[32px] font-bold leading-[1.1] tracking-[-0.02em] text-[#123A5C] sm:text-[40px] lg:text-[46px]";
const bodyClass = "text-[15px] leading-7 text-[#475569] sm:text-[16px]";

export function Fallback({ type, reason }) {
    return (
        <div className={`${container} my-8`}>
            <div className="rounded-xl border border-dashed border-[#CC0000] p-4 text-[14px] text-[#7A1F1F]">
                {reason || "Unsupported section type"}: <code>{type}</code>
            </div>
        </div>
    );
}

function Heading({ heading, eyebrow, center = false, light = false }) {
    if (!heading && !eyebrow) return null;
    return (
        <div className={`mb-10 max-w-[760px] ${center ? "mx-auto text-center" : ""}`}>
            {eyebrow ? <p className={eyebrowClass}><T path="eyebrow" value={eyebrow} /></p> : null}
            {heading ? <h2 className={`${h2Class} ${eyebrow ? "mt-3" : ""} ${light ? "text-white" : ""}`}><T path="heading" value={heading} /></h2> : null}
        </div>
    );
}

// Rich text: plain paragraphs for visitors; one multi-line editable block for admins.
function Body({ path = "content", text, className = bodyClass }) {
    return <EditableParagraphs path={path} text={text} className={className} />;
}

function Paragraphs({ text, className = bodyClass }) {
    return paragraphs(text).map((p, i) => (
        <p key={i} className={`${className} ${i ? "mt-4" : ""}`}>{p}</p>
    ));
}

function Button({ text, href, variant = "coral", textPath = "button_text" }) {
    if (!text) return null;
    const url = safeHref(href) || "/contact";
    const styles = {
        coral: "bg-[#FF6B4A] text-white hover:brightness-95",
        outline: "border border-white/40 text-white hover:bg-white/10",
        navy: "bg-[#123A5C] text-white hover:brightness-110",
    };
    return (
        <Link href={url} className={`inline-flex min-h-[46px] items-center justify-center gap-2 rounded-lg px-6 py-3 text-[14px] font-semibold transition ${styles[variant]}`}>
            <T path={textPath} value={text} /> <span aria-hidden="true">→</span>
        </Link>
    );
}

function CmsImage({ image, className = "", sizes = "(max-width: 1024px) 100vw, 50vw", priority = false }) {
    if (!image) return null;
    return (
        <div className={`relative overflow-hidden ${className}`}>
            <Image src={image.src} alt={image.alt} fill sizes={sizes} priority={priority} className="object-cover" />
        </div>
    );
}

const items = (list) => (Array.isArray(list) ? list : []);

/* ------------------------------------------------ hero */
// Optional extras: `secondary_text`/`secondary_href` (an outline button, e.g.
// to the matching guide) and `highlights` [{label, value}] — an "at a glance"
// card beside the copy when the hero has no image.
export function Hero({ heading, description, eyebrow, button_text, button_href, secondary_text, secondary_href, highlights, highlights_title, media }) {
    const image = slotImage(media, "image");
    const facts = items(highlights);
    const aside = Boolean(image || facts.length);
    return (
        <section className="relative overflow-hidden bg-[linear-gradient(180deg,#061120_0%,#08152A_50%,#071224_100%)] pt-[110px] text-white">
            <div className="pointer-events-none absolute -right-40 -top-40 h-[480px] w-[480px] rounded-full bg-[#0F9E86]/10 blur-3xl" aria-hidden="true" />
            <div className="pointer-events-none absolute -bottom-48 -left-32 h-[420px] w-[420px] rounded-full bg-[#123A5C]/40 blur-3xl" aria-hidden="true" />
            <SlotUpload slot="image" className="right-4 top-24" />
            <div className={`${container} relative grid items-center gap-10 pb-16 lg:pb-24 ${aside ? "lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-14" : ""}`}>
                <div className={aside ? "max-w-[620px]" : "max-w-[760px] py-6 lg:py-10"}>
                    {eyebrow ? <p className={eyebrowClass}><T path="eyebrow" value={eyebrow} /></p> : null}
                    <h1 className="mt-3 text-[36px] font-bold leading-[1.04] tracking-[-0.04em] sm:text-[46px] lg:text-[56px]"><T path="heading" value={heading} /></h1>
                    <div className="mt-5">
                        <Body path="description" text={description} className="text-[15px] leading-7 text-[#DFE7F3] sm:text-[17px] sm:leading-8" />
                    </div>
                    {button_text || secondary_text ? (
                        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                            <Button text={button_text} href={button_href} />
                            <Button text={secondary_text} href={secondary_href} variant="outline" textPath="secondary_text" />
                        </div>
                    ) : null}
                </div>
                {image ? <CmsImage image={image} priority className="aspect-[4/3] rounded-[28px] shadow-[0_30px_80px_rgba(0,0,0,0.35)]" /> : null}
                {!image && facts.length ? (
                    <aside className="relative w-full rounded-[28px] border border-white/10 bg-white/[0.06] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.35)] backdrop-blur-md sm:p-8 lg:max-w-[460px] lg:justify-self-end">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-[#5EEAD4]"><T path="highlights_title" value={highlights_title || "At a glance"} /></p>
                        <dl className="mt-5 divide-y divide-white/10">
                            {facts.map((fact, i) => (
                                <div key={i} className="relative flex items-start gap-4 py-4 first:pt-0 last:pb-0">
                                    <ItemTools path="highlights" index={i} />
                                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#0F9E86]/15 text-[15px] text-[#5EEAD4]" aria-hidden="true">✓</span>
                                    <div className="min-w-0">
                                        <dt className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#9FB3C8]"><T path={`highlights.${i}.label`} value={fact.label} /></dt>
                                        <dd className="mt-1 text-[16px] font-semibold leading-6 text-white"><T path={`highlights.${i}.value`} value={fact.value} /></dd>
                                    </div>
                                </div>
                            ))}
                        </dl>
                        <AddItem path="highlights" label="Add highlight" />
                    </aside>
                ) : null}
            </div>
        </section>
    );
}

/* ------------------------------------------------ rich_text */
// The heading sits beside the text on large screens. A paragraph whose lines
// all start with "- " renders as a ticked list (EditableParagraphs).
export function RichText({ heading, eyebrow, content }) {
    return (
        <section className={`bg-white ${sectionY}`}>
            <div className={`${container} ${heading ? "grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16" : "max-w-[860px]"}`}>
                {heading ? (
                    <div>
                        {eyebrow ? <p className={`${eyebrowClass} mb-3`}><T path="eyebrow" value={eyebrow} /></p> : null}
                        <h2 className={`${h2Class} lg:sticky lg:top-28`}><T path="heading" value={heading} /></h2>
                    </div>
                ) : null}
                <div className="min-w-0"><Body text={content} /></div>
            </div>
        </section>
    );
}

/* ------------------------------------------------ image_text */
export function ImageText({ heading, content, image_position, button_text, button_href, media }) {
    const image = slotImage(media, "image");
    const imageLeft = image_position === "left";
    return (
        <section className={`relative bg-[#F4F7F8] ${sectionY}`}>
            <SlotUpload slot="image" className="right-4 top-4" />
            <div className={`${container} grid items-center gap-10 lg:grid-cols-2 lg:gap-16`}>
                <div className={imageLeft ? "lg:order-2" : ""}>
                    <h2 className={h2Class}><T path="heading" value={heading} /></h2>
                    <div className="mt-6"><Body text={content} /></div>
                    {button_text ? <div className="mt-8"><Button text={button_text} href={button_href} variant="navy" /></div> : null}
                </div>
                {image ? (
                    <CmsImage image={image} className={`aspect-[4/3] rounded-[28px] shadow-[0_24px_60px_rgba(18,58,92,0.18)] ${imageLeft ? "lg:order-1" : ""}`} />
                ) : null}
            </div>
        </section>
    );
}

/* ------------------------------------------------ cards */
export function Cards({ heading, eyebrow, items: list, media }) {
    return (
        <section className={`bg-white ${sectionY}`}>
            <div className={container}>
                <Heading heading={heading} eyebrow={eyebrow} />
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {items(list).map((item, i) => {
                        const image = itemImage(media, i, item);
                        const href = safeHref(item.href || item.link);
                        const body = (
                            <>
                                <ItemTools index={i} />
                                <SlotUpload slot={`items[${i}].image`} className="left-2 top-2" />
                                {image ? <CmsImage image={image} sizes="(max-width: 640px) 100vw, 33vw" className="aspect-[4/3]" /> : null}
                                <div className="p-6">
                                    <h3 className="text-[19px] font-bold text-[#123A5C]"><T path={`items.${i}.${keyOf(item, "title", "name", "heading")}`} value={pick(item, "title", "name", "heading")} /></h3>
                                    <p className="mt-3 text-[14px] leading-6 text-[#64748B]"><T path={`items.${i}.${keyOf(item, "description", "body", "text")}`} value={pick(item, "description", "body", "text")} /></p>
                                    {href ? <span className="mt-4 inline-block text-[13px] font-semibold text-[#0F9E86]">Learn more →</span> : null}
                                </div>
                            </>
                        );
                        const cls = "relative block overflow-hidden rounded-[22px] border border-[#E2E6E5] bg-white shadow-[0_14px_35px_rgba(18,58,92,0.08)] transition hover:-translate-y-1";
                        return href ? <Link key={i} href={href} className={cls}>{body}</Link> : <div key={i} className={cls}>{body}</div>;
                    })}
                    <AddItem />
                </div>
            </div>
        </section>
    );
}

/* ------------------------------------------------ features */
export function Features({ heading, eyebrow, items: list }) {
    return (
        <section className={`bg-[#F4F7F8] ${sectionY}`}>
            <div className={container}>
                <Heading heading={heading} eyebrow={eyebrow} center />
                <div className={`grid gap-5 sm:grid-cols-2 ${items(list).length % 3 === 0 ? "lg:grid-cols-3" : "lg:grid-cols-4"}`}>
                    {items(list).map((item, i) => (
                        <div key={i} className="relative rounded-[20px] bg-white p-6 shadow-[0_10px_30px_rgba(18,58,92,0.07)] transition hover:-translate-y-1 hover:shadow-[0_18px_40px_rgba(18,58,92,0.12)]">
                            <ItemTools index={i} />
                            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#0F9E86]/10 text-[18px] text-[#0F9E86]" aria-hidden="true">
                                {item.icon && item.icon.length <= 2 ? item.icon : "✓"}
                            </span>
                            <h3 className="mt-4 text-[17px] font-bold text-[#123A5C]"><T path={`items.${i}.${keyOf(item, "title", "name", "heading")}`} value={pick(item, "title", "name", "heading")} /></h3>
                            <p className="mt-2 text-[14px] leading-6 text-[#64748B]"><T path={`items.${i}.${keyOf(item, "description", "text", "body")}`} value={pick(item, "description", "text", "body")} /></p>
                        </div>
                    ))}
                    <AddItem />
                </div>
            </div>
        </section>
    );
}

/* ------------------------------------------------ statistics */
export function Statistics({ heading, items: list }) {
    return (
        <section className="bg-[#123A5C] py-14 text-white sm:py-16">
            <div className={container}>
                {heading ? <h2 className="mb-10 text-center font-serif text-[30px] font-bold sm:text-[36px]"><T path="heading" value={heading} /></h2> : null}
                <dl className="grid grid-cols-2 gap-8 text-center lg:grid-cols-4">
                    {items(list).map((item, i) => (
                        <div className="relative" key={i}>
                            <ItemTools index={i} />
                            <dt className="sr-only"><T path={`items.${i}.${keyOf(item, "label", "title")}`} value={pick(item, "label", "title")} /></dt>
                            <dd className="text-[38px] font-bold leading-none text-[#5EEAD4] sm:text-[46px]"><T path={`items.${i}.${keyOf(item, "value", "number", "stat")}`} value={pick(item, "value", "number", "stat")} /></dd>
                            <dd className="mt-2 text-[14px] text-[#C5D0D8]"><T path={`items.${i}.${keyOf(item, "label", "title", "description")}`} value={pick(item, "label", "title", "description")} /></dd>
                        </div>
                    ))}
                    <AddItem />
                </dl>
            </div>
        </section>
    );
}

/* ------------------------------------------------ testimonials */
export function Testimonials({ heading, eyebrow, items: list }) {
    return (
        <section className={`bg-[#F9FCFD] ${sectionY}`}>
            <div className={container}>
                <Heading heading={heading} eyebrow={eyebrow || "Testimonials"} center />
                <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                    {items(list).map((item, i) => (
                        <figure key={i} className="relative flex flex-col rounded-[24px] bg-[#123A5C] p-7 text-white shadow-[0_18px_40px_rgba(18,58,92,0.25)]">
                            <ItemTools index={i} />
                            <div className="text-[#FF6B4A]" aria-label={`${Number(item.rating) || 5} out of 5 stars`}>
                                {"★".repeat(Math.min(5, Math.max(1, Number(item.rating) || 5)))}
                            </div>
                            <blockquote className="mt-4 flex-1 text-[15px] leading-7 text-[#E2E8F0]">“<T path={`items.${i}.${keyOf(item, "quote", "text", "content")}`} value={pick(item, "quote", "text", "content")} />”</blockquote>
                            <figcaption className="mt-6">
                                <p className="font-semibold"><T path={`items.${i}.${keyOf(item, "author", "name")}`} value={pick(item, "author", "name")} /></p>
                                <p className="text-[13px] text-[#C5D0D8]"><T path={`items.${i}.${keyOf(item, "role", "company", "title")}`} value={pick(item, "role", "company", "title")} /></p>
                            </figcaption>
                        </figure>
                    ))}
                    <AddItem />
                </div>
            </div>
        </section>
    );
}

/* ------------------------------------------------ gallery */
export function Gallery({ heading, items: list, media }) {
    return (
        <section className={`bg-white ${sectionY}`}>
            <div className={container}>
                <Heading heading={heading} />
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                    {items(list).map((item, i) => {
                        const image = itemImage(media, i, item);
                        return (
                            <figure className="relative" key={i}>
                                <ItemTools index={i} />
                                <SlotUpload slot={`items[${i}].image`} className="left-2 top-2" />
                                {image ? (
                                    <CmsImage image={image} sizes="(max-width: 1024px) 50vw, 33vw" className="aspect-[3/2] rounded-[18px]" />
                                ) : (
                                    <div className="aspect-[3/2] rounded-[18px] bg-[#E2E8F0]" />
                                )}
                                {item.caption ? <figcaption className="mt-2 text-[13px] text-[#64748B]"><T path={`items.${i}.caption`} value={item.caption} /></figcaption> : null}
                            </figure>
                        );
                    })}
                    <AddItem />
                </div>
            </div>
        </section>
    );
}

/* ------------------------------------------------ team */
export function Team({ heading, eyebrow, items: list, media }) {
    return (
        <section className={`bg-[#F4F7F8] ${sectionY}`}>
            <div className={container}>
                <Heading heading={heading} eyebrow={eyebrow} center />
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                    {items(list).map((item, i) => {
                        const image = itemImage(media, i, item);
                        return (
                            <div key={i} className="relative overflow-hidden rounded-[22px] bg-white shadow-[0_12px_32px_rgba(18,58,92,0.08)]">
                                <ItemTools index={i} />
                                <SlotUpload slot={`items[${i}].image`} className="left-2 top-2" />
                                {image ? <CmsImage image={image} sizes="(max-width: 640px) 100vw, 25vw" className="aspect-square" /> : null}
                                <div className="p-5">
                                    <h3 className="text-[17px] font-bold text-[#123A5C]"><T path={`items.${i}.name`} value={item.name} /></h3>
                                    <p className="text-[13px] font-semibold text-[#0F9E86]"><T path={`items.${i}.${keyOf(item, "role", "title")}`} value={pick(item, "role", "title")} /></p>
                                    {item.bio ? <p className="mt-3 text-[14px] leading-6 text-[#64748B]"><T path={`items.${i}.bio`} value={item.bio} /></p> : null}
                                </div>
                            </div>
                        );
                    })}
                    <AddItem />
                </div>
            </div>
        </section>
    );
}

/* ------------------------------------------------ timeline */
export function Timeline({ heading, items: list, media }) {
    return (
        <section className={`bg-white ${sectionY}`}>
            <div className={`${container} max-w-[920px]`}>
                <Heading heading={heading} />
                <ol className="relative border-l-2 border-[#0F9E86]/30 pl-8">
                    {items(list).map((item, i) => {
                        const image = itemImage(media, i, item);
                        return (
                            <li key={i} className="relative pb-10 last:pb-0">
                                <ItemTools index={i} />
                                <SlotUpload slot={`items[${i}].image`} className="left-2 top-2" />
                                <span className="absolute -left-[41px] top-1 h-4 w-4 rounded-full border-4 border-white bg-[#0F9E86] shadow" aria-hidden="true" />
                                {item.date ? <p className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[#0F9E86]"><T path={`items.${i}.date`} value={item.date} /></p> : null}
                                <h3 className="mt-1 text-[19px] font-bold text-[#123A5C]"><T path={`items.${i}.${keyOf(item, "title", "heading")}`} value={pick(item, "title", "heading")} /></h3>
                                <p className="mt-2 text-[15px] leading-7 text-[#64748B]"><T path={`items.${i}.${keyOf(item, "description", "text")}`} value={pick(item, "description", "text")} /></p>
                                {image ? <CmsImage image={image} sizes="(max-width: 920px) 100vw, 640px" className="mt-4 aspect-[16/9] max-w-[560px] rounded-[18px]" /> : null}
                            </li>
                        );
                    })}
                    <AddItem />
                </ol>
            </div>
        </section>
    );
}

/* ------------------------------------------------ pricing */
export function Pricing({ heading, eyebrow, items: list }) {
    return (
        <section className={`bg-[#F4F7F8] ${sectionY}`}>
            <div className={container}>
                <Heading heading={heading} eyebrow={eyebrow} center />
                <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                    {items(list).map((item, i) => {
                        const featured = item.highlighted || item.featured;
                        const features = Array.isArray(item.features) ? item.features : [];
                        return (
                            <div key={i} className={`relative flex flex-col rounded-[26px] p-8 ${featured ? "bg-[#123A5C] text-white shadow-[0_24px_60px_rgba(18,58,92,0.3)]" : "bg-white text-[#123A5C] shadow-[0_12px_32px_rgba(18,58,92,0.08)]"}`}>
                                <ItemTools index={i} />
                                <h3 className="text-[18px] font-bold"><T path={`items.${i}.${keyOf(item, "name", "title")}`} value={pick(item, "name", "title")} /></h3>
                                <p className="mt-4 text-[40px] font-bold leading-none">
                                    <T path={`items.${i}.price`} value={item.price} />
                                    {item.period ? <span className={`ml-1 text-[14px] font-medium ${featured ? "text-[#C5D0D8]" : "text-[#64748B]"}`}>/<T path={`items.${i}.period`} value={item.period} /></span> : null}
                                </p>
                                {item.description ? <p className={`mt-3 text-[14px] leading-6 ${featured ? "text-[#D7E2EE]" : "text-[#64748B]"}`}><T path={`items.${i}.description`} value={item.description} /></p> : null}
                                <ul className="mt-6 flex-1 space-y-2.5 text-[14px]">
                                    {features.map((f, j) => (
                                        <li key={j} className="flex gap-2"><span className="text-[#0F9E86]" aria-hidden="true">✓</span>{f}</li>
                                    ))}
                                </ul>
                                {item.button_text ? <div className="mt-8"><Button text={item.button_text} textPath={`items.${i}.button_text`} href={item.button_href} variant={featured ? "coral" : "navy"} /></div> : null}
                            </div>
                        );
                    })}
                    <AddItem />
                </div>
            </div>
        </section>
    );
}

/* ------------------------------------------------ logos */
export function Logos({ heading, items: list, media }) {
    return (
        <section className="bg-white py-12 sm:py-14">
            <div className={container}>
                {heading ? <p className="mb-8 text-center text-[13px] font-semibold uppercase tracking-[0.24em] text-[#64748B]"><T path="heading" value={heading} /></p> : null}
                <ul className="flex flex-wrap items-center justify-center gap-x-12 gap-y-6">
                    {items(list).map((item, i) => {
                        const image = itemImage(media, i, item);
                        const name = pick(item, "name", "title", "alt");
                        return (
                            <li key={i} className="relative flex h-14 w-[140px] items-center justify-center">
                                <ItemTools index={i} />
                                <SlotUpload slot={`items[${i}].image`} className="left-2 top-2" />
                                {image ? (
                                    <div className="relative h-full w-full">
                                        <Image src={image.src} alt={image.alt || name} fill sizes="140px" className="object-contain opacity-80 grayscale transition hover:opacity-100 hover:grayscale-0" />
                                    </div>
                                ) : (
                                    <span className="text-[15px] font-bold text-[#123A5C]">{name}</span>
                                )}
                            </li>
                        );
                    })}
                    <AddItem />
                </ul>
            </div>
        </section>
    );
}

/* ------------------------------------------------ steps */
export function Steps({ heading, eyebrow, items: list, media }) {
    return (
        <section className="bg-[linear-gradient(180deg,#0B2240_0%,#123A5C_100%)] py-16 text-white sm:py-20 lg:py-24">
            <div className={container}>
                <Heading heading={heading} eyebrow={eyebrow || "Our process"} light />
                <ol className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
                    {items(list).map((item, i) => {
                        const image = itemImage(media, i, item);
                        return (
                            <li key={i} className="relative overflow-hidden rounded-[22px] border border-white/10 bg-white/[0.06] backdrop-blur">
                                <ItemTools index={i} />
                                <SlotUpload slot={`items[${i}].image`} className="left-2 top-2" />
                                {image ? <CmsImage image={image} sizes="(max-width: 768px) 100vw, 25vw" className="aspect-[4/3]" /> : null}
                                <div className="p-6">
                                    <p className="text-[13px] font-bold text-[#5EEAD4]">{String(i + 1).padStart(2, "0")}</p>
                                    <h3 className="mt-2 font-serif text-[21px] font-bold"><T path={`items.${i}.${keyOf(item, "title", "heading")}`} value={pick(item, "title", "heading")} /></h3>
                                    <p className="mt-2 text-[14px] leading-6 text-[#C5D0D8]"><T path={`items.${i}.${keyOf(item, "description", "text")}`} value={pick(item, "description", "text")} /></p>
                                </div>
                            </li>
                        );
                    })}
                    <AddItem />
                </ol>
            </div>
        </section>
    );
}

/* ------------------------------------------------ cta */
export function Cta({ heading, description, button_text, button_href, secondary_text, secondary_href }) {
    return (
        <section className="bg-white py-14 sm:py-16">
            <div className={container}>
                <div className="relative flex flex-col items-start justify-between gap-6 overflow-hidden rounded-[30px] bg-[#06182F] px-8 py-10 text-white shadow-[0_30px_80px_rgba(6,24,47,0.3)] sm:px-12 lg:flex-row lg:items-center">
                    <div className="pointer-events-none absolute -right-20 -top-24 h-[260px] w-[260px] rounded-full bg-[#0F9E86]/15 blur-2xl" aria-hidden="true" />
                    <div className="relative max-w-[640px]">
                        <h2 className="font-serif text-[30px] font-bold leading-tight sm:text-[38px]"><T path="heading" value={heading} /></h2>
                        {description ? <p className="mt-3 text-[15px] leading-7 text-[#D7E2EE]"><T path="description" value={description} /></p> : null}
                    </div>
                    <div className="relative flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
                        <Button text={button_text} href={button_href} />
                        <Button text={secondary_text} href={secondary_href} variant="outline" textPath="secondary_text" />
                    </div>
                </div>
            </div>
        </section>
    );
}

/* ------------------------------------------------ banner */
export function Banner({ text, link_text, link_href }) {
    const href = safeHref(link_href);
    return (
        <div className="bg-[#0F9E86] px-5 py-3 text-center text-[14px] font-medium text-white">
            <T path="text" value={text} />
            {link_text && href ? <Link href={href} className="ml-3 font-bold underline underline-offset-4"><T path="link_text" value={link_text} /></Link> : null}
        </div>
    );
}

/* ------------------------------------------------ video */
export function Video({ heading, video_url }) {
    if (!VIDEO_URL.test(video_url || "")) return <Fallback type="video" reason="Video URL is not an allowed YouTube/Vimeo embed" />;
    return (
        <section className={`bg-white ${sectionY}`}>
            <div className={`${container} max-w-[1000px]`}>
                {heading ? <h2 className={`${h2Class} mb-8 text-center`}><T path="heading" value={heading} /></h2> : null}
                <div className="relative aspect-video overflow-hidden rounded-[24px] bg-[#0B1A2E] shadow-[0_24px_60px_rgba(18,58,92,0.2)]">
                    <iframe
                        src={video_url}
                        title={heading || "Video"}
                        className="absolute inset-0 h-full w-full"
                        loading="lazy"
                        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
                        allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                        allowFullScreen
                    />
                </div>
            </div>
        </section>
    );
}

/* ------------------------------------------------ contact_block */
export function ContactBlock({ heading, email, phone, address, hours }) {
    const rows = [
        ["Email", email, email ? `mailto:${email}` : null, "email"],
        ["Phone", phone, phone ? `tel:${String(phone).replace(/[^+\d]/g, "")}` : null, "phone"],
        ["Address", address, null, "address"],
        ["Opening hours", hours, null, "hours"],
    ].filter(([, value]) => value);
    return (
        <section className={`bg-[#F4F7F8] ${sectionY}`}>
            <div className={container}>
                <Heading heading={heading || "Get in touch"} />
                <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                    {rows.map(([label, value, href, field], index) => (
                        <div key={index} className="rounded-[20px] bg-white p-6 shadow-[0_10px_30px_rgba(18,58,92,0.07)]">
                            <dt className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[#0F9E86]">{label}</dt>
                            <dd className="mt-2 whitespace-pre-line text-[15px] font-medium text-[#123A5C]">
                                {href ? <a href={href} className="hover:underline"><T path={field} value={value} /></a> : <T path={field} value={value} multiline />}
                            </dd>
                        </div>
                    ))}
                </dl>
            </div>
        </section>
    );
}

/* ------------------------------------------------ map_block */
export function MapBlock({ heading, embed_url }) {
    if (!MAP_URL.test(embed_url || "")) return <Fallback type="map_block" reason="Map URL is not an allowed Google Maps / OpenStreetMap embed" />;
    return (
        <section className={`bg-white ${sectionY}`}>
            <div className={container}>
                {heading ? <h2 className={`${h2Class} mb-8`}><T path="heading" value={heading} /></h2> : null}
                <div className="relative aspect-[16/7] min-h-[320px] overflow-hidden rounded-[24px] border border-[#E2E6E5]">
                    <iframe
                        src={embed_url}
                        title={heading || "Map"}
                        className="absolute inset-0 h-full w-full"
                        loading="lazy"
                        referrerPolicy="no-referrer-when-downgrade"
                        sandbox="allow-scripts allow-same-origin allow-popups"
                    />
                </div>
            </div>
        </section>
    );
}
