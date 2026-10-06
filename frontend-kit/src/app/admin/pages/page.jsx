"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

import { Card, Notice, PageTitle, StatusBadge } from "@/components/admin/AdminShell";
import { fetchAll, formatDate, rows } from "@/components/admin/useApi";
import { buttonStyles } from "@/components/cms/Drawer";
import { humanize, ObjectFields } from "@/components/cms/FieldEditor";
import { apiRequest, mediaUrl } from "@/lib/api";
import { CreatePageForm } from "@/components/cms/CreatePage";

/* =========================================
   Pages & builder
   1. Generate an AI prompt for chosen section types
      (or a "copy structure" prompt for an existing page)
   2. Paste the AI's JSON → content/paste-to-build/
   3. Upload the pending images per slot
   4. Publish (blocked until required images exist)
========================================= */

export default function PagesAdmin() {
    return (
        <Suspense>
            <PagesAdminInner />
        </Suspense>
    );
}

function PagesAdminInner() {
    const params = useSearchParams();
    const router = useRouter();
    const blogSlug = params.get("blog");
    const pagePath = params.get("page");

    if (blogSlug || pagePath) {
        return (
            <HostManager
                kind={blogSlug ? "blog" : "content"}
                hostKey={blogSlug || pagePath}
                onBack={() => router.push(blogSlug ? "/admin/blog" : "/admin/pages")}
            />
        );
    }

    return <PagesOverview defaultType={params.get("type") === "article" ? "article" : "generic"} />;
}

/* ------------------------------------------------ list + builder */

function PagesOverview({ defaultType }) {
    const [pages, setPages] = useState(null);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        try {
            setPages(await fetchAll("content/pages/"));
        } catch (err) {
            setError(err.message);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    return (
        <>
            <PageTitle
                title="Pages & builder"
                description="Build new landing, service or article pages from AI-generated JSON. Pages stay as drafts until every required image is uploaded."
            />
            <Notice error={error} />

            <Builder defaultType={defaultType} onBuilt={load} />

            <Card className="mt-6 overflow-x-auto p-0">
                <h2 className="px-5 pt-5 text-[15px] font-bold">CMS pages</h2>
                <table className="mt-3 w-full min-w-[640px] text-left text-[13px]">
                    <thead className="border-y border-[#E2E8F0] bg-[#F8FAFC] text-[11px] uppercase tracking-[0.08em] text-[#64748B]">
                        <tr>
                            <th scope="col" className="px-5 py-3">Page</th>
                            <th scope="col" className="px-3 py-3">Status</th>
                            <th scope="col" className="px-3 py-3">Updated</th>
                            <th scope="col" className="px-5 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {pages === null ? (
                            <tr><td colSpan={4} className="px-5 py-6 text-[#64748B]">Loading…</td></tr>
                        ) : pages.length === 0 ? (
                            <tr><td colSpan={4} className="px-5 py-6 text-[#64748B]">No CMS pages yet. Build one above.</td></tr>
                        ) : (
                            pages.map((page) => (
                                <tr key={page.id} className="border-b border-[#F1F5F9] last:border-0">
                                    <td className="px-5 py-3">
                                        <p className="font-semibold text-[#0F172A]">{page.title}</p>
                                        <p className="text-[12px] text-[#94A3B8]">/{page.path}</p>
                                    </td>
                                    <td className="px-3 py-3"><StatusBadge status={page.status} /></td>
                                    <td className="px-3 py-3 text-[#475569]">{formatDate(page.updated_at)}</td>
                                    <td className="px-5 py-3 text-right">
                                        <div className="flex justify-end gap-3">
                                            <Link href={`/${page.path}`} target="_blank" className={buttonStyles.link}>View</Link>
                                            <Link href={`/admin/pages?page=${encodeURIComponent(page.path)}`} className={buttonStyles.link}>Manage</Link>
                                        </div>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </Card>
        </>
    );
}

function Builder({ defaultType, onBuilt }) {
    return (
        <Card>
            <h2 className="mb-4 text-[15px] font-bold">Create a page with AI</h2>
            <CreatePageForm defaultKind={defaultType === "article" ? "blog" : "content"} onDone={onBuilt} />
        </Card>
    );
}

/* ------------------------------------------------ manage one page / article */

function HostManager({ kind, hostKey, onBack }) {
    const [host, setHost] = useState(null);
    const [sections, setSections] = useState([]);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [missing, setMissing] = useState([]);
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(null);

    const base = kind === "blog" ? `blog/${hostKey}` : `content/${hostKey}`;
    const hostUrl = kind === "blog" ? `blog/${hostKey}/` : `content/pages/${hostKey}/`;
    const publicPath = kind === "blog" ? `/blog/${hostKey}` : `/${hostKey}`;

    const load = useCallback(async () => {
        try {
            const [hostData, sectionData] = await Promise.all([apiRequest(hostUrl), apiRequest(`${base}/sections/`)]);
            setHost(hostData);
            setSections(rows(sectionData).sort((a, b) => a.order - b.order));
        } catch (err) {
            setError(err.message);
        }
    }, [hostUrl, base]);

    useEffect(() => {
        load();
    }, [load]);

    async function run(action, message) {
        setBusy(true);
        setError("");
        setSuccess("");
        try {
            await action();
            await load();
            if (message) setSuccess(message);
        } catch (err) {
            if (Array.isArray(err.body?.missing)) setMissing(err.body.missing);
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    const setStatus = (status) =>
        run(async () => {
            setMissing([]);
            await apiRequest(hostUrl, { method: "PATCH", body: { status } });
        }, status === "published" ? "Published." : "Moved back to draft.");

    const move = (index, delta) => {
        const ids = sections.map((s) => s.id);
        const target = index + delta;
        [ids[index], ids[target]] = [ids[target], ids[index]];
        run(() => apiRequest(`${base}/sections/reorder/`, { method: "POST", body: { order: ids } }));
    };

    const remove = (section) => {
        if (!window.confirm(`Delete this ${humanize(section.section_type)} section?`)) return;
        run(() => apiRequest(`${base}/sections/${section.id}/`, { method: "DELETE" }), "Section deleted.");
    };

    const upload = (section, slot, file) => {
        const fd = new FormData();
        fd.append("image", file);
        run(() => apiRequest(`${base}/sections/${section.id}/media/${encodeURIComponent(slot)}/`, { method: "POST", body: fd }), "Image uploaded.");
    };

    const saveContent = (section, content) =>
        run(async () => {
            await apiRequest(`${base}/sections/${section.id}/?mode=draft`, { method: "PATCH", body: { content } });
            setEditing(null);
        }, "Saved as a draft — publish it from the admin bar on the page (or Publish all below).");

    const deleteHost = () => {
        if (!window.confirm(`Delete “${host.title}” and all of its sections?`)) return;
        run(async () => {
            await apiRequest(hostUrl, { method: "DELETE" });
            onBack();
        });
    };

    if (!host) {
        return (
            <>
                <button type="button" className={buttonStyles.link} onClick={onBack}>← Back</button>
                <Notice error={error} />
                {!error ? <p className="mt-4 text-[13px] text-[#64748B]">Loading…</p> : null}
            </>
        );
    }

    const pendingCount = sections.flatMap((s) => s.media).filter((m) => m.required && !m.image).length;

    return (
        <>
            <button type="button" className={buttonStyles.link} onClick={onBack}>← Back</button>
            <PageTitle
                title={host.title}
                description={`${kind === "blog" ? "Blog article" : "Page"} · ${publicPath}`}
                actions={
                    <>
                        <Link href={publicPath} target="_blank" className={buttonStyles.secondary}>Preview</Link>
                        {host.status === "published" ? (
                            <button type="button" className={buttonStyles.secondary} onClick={() => setStatus("draft")} disabled={busy}>Unpublish</button>
                        ) : (
                            <button type="button" className={buttonStyles.primary} onClick={() => setStatus("published")} disabled={busy}>Publish</button>
                        )}
                        <button type="button" className={buttonStyles.danger} onClick={deleteHost} disabled={busy}>Delete</button>
                    </>
                }
            />
            <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
                <StatusBadge status={host.status} />
                {pendingCount ? <span className="text-[#B54708]">{pendingCount} required image(s) missing</span> : <span className="text-[#067647]">All required images uploaded</span>}
            </div>
            <Notice error={error} success={success} />
            {missing.length ? (
                <ul className="mb-4 rounded-lg bg-[#FFFAEB] px-4 py-3 text-[12px] text-[#B54708]">
                    {missing.map((m) => <li key={`${m.section_id}-${m.slot}`}>Section #{m.section_id} · {m.slot}: {m.image_prompt}</li>)}
                </ul>
            ) : null}

            <div className="space-y-4">
                {sections.map((section, index) => (
                    <Card key={section.id}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0F9E86]">{index + 1}. {humanize(section.section_type)}</p>
                                <p className="mt-1 text-[14px] font-semibold text-[#0F172A]">{section.content.heading || section.content.text || "—"}</p>
                            </div>
                            <div className="flex gap-1">
                                <button type="button" className={buttonStyles.secondary} onClick={() => move(index, -1)} disabled={busy || index === 0} aria-label="Move up">↑</button>
                                <button type="button" className={buttonStyles.secondary} onClick={() => move(index, 1)} disabled={busy || index === sections.length - 1} aria-label="Move down">↓</button>
                                <button type="button" className={buttonStyles.secondary} onClick={() => setEditing(editing === section.id ? null : section.id)}>
                                    {editing === section.id ? "Close" : "Edit"}
                                </button>
                                <button type="button" className={buttonStyles.danger} onClick={() => remove(section)} disabled={busy}>Delete</button>
                            </div>
                        </div>

                        {section.media.length ? (
                            <div className="mt-4 grid gap-3 sm:grid-cols-2">
                                {section.media.map((m) => (
                                    <div key={m.id} className={`flex gap-3 rounded-xl border p-3 ${m.image ? "border-[#E2E8F0]" : "border-[#FEC84B] bg-[#FFFAEB]"}`}>
                                        <div className="h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-[#F1F5F9]">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            {m.image ? <img src={mediaUrl(m.image.url)} alt="" className="h-full w-full object-cover" /> : null}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-[12px] font-semibold">{m.slot}{m.required ? " *" : ""}</p>
                                            <p className="mt-0.5 line-clamp-2 text-[11px] text-[#64748B]">{m.image_prompt || "No description"}</p>
                                            <label className={`${buttonStyles.link} mt-1 inline-block cursor-pointer`}>
                                                {m.image ? "Replace" : "Upload"}
                                                <input type="file" accept="image/*" className="hidden" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(section, m.slot, e.target.files[0])} />
                                            </label>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : null}

                        {editing === section.id ? <SectionContentEditor section={section} onSave={(c) => saveContent(section, c)} busy={busy} /> : null}
                    </Card>
                ))}
            </div>
        </>
    );
}

function SectionContentEditor({ section, onSave, busy }) {
    const [draft, setDraft] = useState(() => structuredClone(section.draft_content ?? section.content));
    return (
        <div className="mt-4 space-y-3 border-t border-[#E2E8F0] pt-4">
            <ObjectFields value={draft} template={section.draft_content ?? section.content} onChange={setDraft} />
            <button type="button" className={buttonStyles.primary} onClick={() => onSave(draft)} disabled={busy}>Save section</button>
        </div>
    );
}
