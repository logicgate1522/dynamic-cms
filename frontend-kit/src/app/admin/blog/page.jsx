"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Card, Notice, PageTitle, StatusBadge } from "@/components/admin/AdminShell";
import { fetchAll, formatDate } from "@/components/admin/useApi";
import BlogPostEditor from "@/components/cms/BlogPostEditor";
import { buttonStyles } from "@/components/cms/Drawer";

export default function BlogAdminPage() {
    const [posts, setPosts] = useState(null);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [editing, setEditing] = useState(undefined); // undefined = closed, null = new

    const load = useCallback(async () => {
        try {
            setPosts(await fetchAll("blog/"));
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
                title="Blog posts"
                description="Articles shown on the Resources page. Drafts and scheduled posts are only visible to signed-in admins."
                actions={
                    <>
                        <Link href="/admin/pages?type=article" className={buttonStyles.secondary}>Build with AI</Link>
                        <button type="button" className={buttonStyles.primary} onClick={() => setEditing(null)}>New article</button>
                    </>
                }
            />
            <Notice error={error} success={success} />

            <Card className="overflow-x-auto p-0">
                <table className="w-full min-w-[720px] text-left text-[13px]">
                    <thead className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-[11px] uppercase tracking-[0.08em] text-[#64748B]">
                        <tr>
                            <th scope="col" className="px-5 py-3">Title</th>
                            <th scope="col" className="px-3 py-3">Status</th>
                            <th scope="col" className="px-3 py-3">Format</th>
                            <th scope="col" className="px-3 py-3">Published</th>
                            <th scope="col" className="px-5 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {posts === null ? (
                            <tr><td colSpan={5} className="px-5 py-6 text-[#64748B]">Loading…</td></tr>
                        ) : posts.length === 0 ? (
                            <tr>
                                <td colSpan={5} className="px-5 py-6 text-[#64748B]">
                                    No posts in the CMS yet — the site is showing its built-in articles. Run <code>npm run cms:seed</code> to import them.
                                </td>
                            </tr>
                        ) : (
                            posts.map((post) => {
                                const scheduled = post.status === "published" && post.published_at && new Date(post.published_at) > new Date();
                                return (
                                    <tr key={post.id} className="border-b border-[#F1F5F9] last:border-0">
                                        <td className="px-5 py-3">
                                            <p className="font-semibold text-[#0F172A]">{post.title}</p>
                                            <p className="text-[12px] text-[#94A3B8]">/blog/{post.slug}</p>
                                        </td>
                                        <td className="px-3 py-3">{scheduled ? <StatusBadge status="scheduled" /> : <StatusBadge status={post.status} />}</td>
                                        <td className="px-3 py-3 text-[#475569]">{post.body_mode === "dynamic" ? "Sections" : "Article"}</td>
                                        <td className="px-3 py-3 text-[#475569]">{formatDate(post.published_at)}</td>
                                        <td className="px-5 py-3 text-right">
                                            <div className="flex justify-end gap-3">
                                                <Link href={`/blog/${post.slug}`} className={buttonStyles.link} target="_blank">View</Link>
                                                {post.body_mode === "dynamic" ? (
                                                    <Link href={`/admin/pages?blog=${post.slug}`} className={buttonStyles.link}>Sections</Link>
                                                ) : null}
                                                <button type="button" className={buttonStyles.link} onClick={() => setEditing(post)}>Edit</button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </Card>

            {editing !== undefined ? (
                <BlogPostEditor
                    post={editing}
                    onClose={() => setEditing(undefined)}
                    onSaved={(saved) => {
                        setEditing(undefined);
                        setSuccess(`Saved “${saved.title}”.`);
                        load();
                    }}
                    onDeleted={(post) => {
                        setEditing(undefined);
                        setSuccess(`Deleted “${post.title}”.`);
                        load();
                    }}
                />
            ) : null}
        </>
    );
}
