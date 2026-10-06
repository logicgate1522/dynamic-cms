"use client";

import { useState } from "react";

import Drawer, { buttonStyles } from "@/components/cms/Drawer";
import { ObjectFields } from "@/components/cms/FieldEditor";
import { apiRequest } from "@/lib/api";
import { ARTICLE_CATEGORIES } from "@/lib/blog";
import { SITE_NAME } from "@/lib/brand";

const SECTION_TEMPLATE = { id: "", eyebrow: "", heading: "", text: [""], bullets: [""] };

const CONTENT_TEMPLATE = {
    coverImage: "",
    coverImageAlt: "",
    category: ARTICLE_CATEGORIES[0],
    readTime: "",
    date: "",
    goodToKnow: "",
    sections: [SECTION_TEMPLATE],
};

const POST_TEMPLATE = {
    title: "",
    excerpt: "",
    author: `${SITE_NAME} Team`,
    status: "draft",
    published_at: "",
    seo_title: "",
    meta_description: "",
    og_image: "",
};

const HINTS = {
    excerpt: { label: "Excerpt / description", type: "textarea" },
    status: { type: "select", options: ["draft", "published"] },
    published_at: { label: "Publish date (blank = now when published)", type: "datetime" },
    seo_title: { label: "SEO title (optional)" },
    meta_description: { label: "Meta description (optional)", type: "textarea" },
    og_image: { label: "Social share image (1200×630)", type: "image", category: "seo" },
    coverImage: { label: "Cover image", category: "blog" },
    category: { type: "select", options: ARTICLE_CATEGORIES },
    readTime: { label: "Read time (blank = calculated)" },
    date: { label: "Display date (blank = publish date)" },
    goodToKnow: { label: "\"Good to know\" callout", type: "textarea" },
    "sections[].id": { label: "Anchor id (used in the table of contents)" },
    "sections[].text": { label: "Paragraphs" },
    "sections[].text[]": { type: "textarea" },
};

function toLocalInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function slugify(text) {
    return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function initialState(post) {
    const meta = {};
    for (const key of Object.keys(POST_TEMPLATE)) meta[key] = post?.[key] ?? POST_TEMPLATE[key];
    meta.published_at = toLocalInput(post?.published_at);
    const content = { ...structuredClone(CONTENT_TEMPLATE), ...(post?.content || {}) };
    return { meta, content };
}

// Create or edit a BlogPost. `post` = null creates a new one.
export default function BlogPostEditor({ post, onClose, onSaved, onDeleted }) {
    const [state, setState] = useState(() => initialState(post));
    const [slug, setSlug] = useState(post?.slug || "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const isNew = !post;
    const isDynamic = post?.body_mode === "dynamic";

    async function save() {
        setSaving(true);
        setError("");
        try {
            const content = structuredClone(state.content);
            content.sections = (content.sections || []).map((section, i) => ({
                ...section,
                id: section.id || slugify(section.heading || `section-${i + 1}`),
                text: (section.text || []).filter((p) => p.trim()),
                bullets: (section.bullets || []).filter((b) => b.trim()),
            }));

            const body = {
                ...state.meta,
                published_at: state.meta.published_at ? new Date(state.meta.published_at).toISOString() : null,
                ...(isDynamic ? {} : { content, body_mode: "legacy" }),
                ...(isNew && slug ? { slug: slugify(slug) } : {}),
            };

            const saved = isNew
                ? await apiRequest("blog/", { method: "POST", body })
                : await apiRequest(`blog/${post.slug}/`, { method: "PATCH", body });

            onSaved?.(saved);
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    }

    async function remove() {
        if (!window.confirm(`Delete “${post.title}” permanently?`)) return;
        setSaving(true);
        try {
            await apiRequest(`blog/${post.slug}/`, { method: "DELETE" });
            onDeleted?.(post);
        } catch (err) {
            setError(err.message);
            setSaving(false);
        }
    }

    return (
        <Drawer
            open
            width={640}
            title={isNew ? "New article" : `Edit article`}
            subtitle={isNew ? "Saved to blog/" : `blog/${post.slug}/`}
            onClose={onClose}
            footer={
                <div className="flex items-center justify-between gap-3">
                    {isNew ? <span /> : (
                        <button type="button" className={buttonStyles.danger} onClick={remove} disabled={saving}>Delete</button>
                    )}
                    <div className="flex gap-2">
                        <button type="button" className={buttonStyles.secondary} onClick={onClose}>Cancel</button>
                        <button type="button" className={buttonStyles.primary} onClick={save} disabled={saving || !state.meta.title.trim()}>
                            {saving ? "Saving…" : isNew ? "Create article" : "Save article"}
                        </button>
                    </div>
                </div>
            }
        >
            {error ? <p className="mb-3 rounded-lg bg-[#FEF3F2] px-3 py-2 text-[12px] text-[#B42318]">{error}</p> : null}

            <div className="space-y-4">
                {isNew ? (
                    <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#475569]">URL slug (blank = from title)</span>
                        <input
                            className="w-full rounded-lg border border-[#D6DEE8] px-3 py-2 text-[13px]"
                            value={slug}
                            onChange={(e) => setSlug(e.target.value)}
                            placeholder={slugify(state.meta.title) || "my-article"}
                        />
                    </label>
                ) : null}

                <ObjectFields
                    value={state.meta}
                    template={POST_TEMPLATE}
                    hints={HINTS}
                    onChange={(meta) => setState((s) => ({ ...s, meta }))}
                />

                <h3 className="border-t border-[#E2E8F0] pt-4 text-[13px] font-bold text-[#0F172A]">Article content</h3>

                {isDynamic ? (
                    <p className="rounded-lg bg-[#F1F5F9] px-3 py-2 text-[12px] text-[#475569]">
                        This article is built from dynamic sections. Edit its sections from Dashboard → Pages &amp; builder.
                    </p>
                ) : (
                    <ObjectFields
                        value={state.content}
                        template={CONTENT_TEMPLATE}
                        hints={HINTS}
                        onChange={(content) => setState((s) => ({ ...s, content }))}
                    />
                )}
            </div>
        </Drawer>
    );
}
