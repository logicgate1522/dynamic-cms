"use client";

import { useCallback, useEffect, useState } from "react";

import { Card, Notice, PageTitle } from "@/components/admin/AdminShell";
import { rows } from "@/components/admin/useApi";
import { buttonStyles } from "@/components/cms/Drawer";
import { apiRequest, mediaUrl, uploadImage } from "@/lib/api";

const FILTERS = [
    ["all", "All", ""],
    ["missing_alt", "Missing alt text", "missing_alt=1"],
    ["unused", "Unused", "unused=1"],
];

// Image library: upload, fix alt text (accessibility + image SEO), see where
// each image is used, delete unused ones.
export default function ImagesPage() {
    const [filter, setFilter] = useState("all");
    const [page, setPage] = useState(1);
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");
    const [uploading, setUploading] = useState(false);

    const query = FILTERS.find((f) => f[0] === filter)[2];

    const load = useCallback(async () => {
        try {
            setData(await apiRequest(`images/?page=${page}${query ? `&${query}` : ""}`));
            setError("");
        } catch (err) {
            setError(err.message);
        }
    }, [page, query]);

    useEffect(() => {
        load();
    }, [load]);

    async function upload(files) {
        setUploading(true);
        setError("");
        try {
            for (const file of files) await uploadImage(file, "content");
            setSuccess(`Uploaded ${files.length} image${files.length === 1 ? "" : "s"}.`);
            await load();
        } catch (err) {
            setError(err.message);
        } finally {
            setUploading(false);
        }
    }

    const list = rows(data);

    return (
        <>
            <PageTitle
                title="Images"
                description="Every uploaded image. Alt text describes the image for screen readers and search engines — fill it in for every image that carries meaning."
                actions={
                    <label className={`${buttonStyles.primary} cursor-pointer`}>
                        {uploading ? "Uploading…" : "Upload images"}
                        <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            e.target.value = "";
                            if (files.length) upload(files);
                        }} />
                    </label>
                }
            />
            <Notice error={error} success={success} />
            <div className="mb-4 flex gap-1">
                {FILTERS.map(([key, label]) => (
                    <button key={key} type="button" onClick={() => { setFilter(key); setPage(1); }} className={`rounded-md px-3 py-1.5 text-[12px] font-semibold ${filter === key ? "bg-[#123A5C] text-white" : "bg-white text-[#475569]"}`}>
                        {label}
                    </button>
                ))}
                <span className="ml-auto self-center text-[12px] text-[#64748B]">{data?.count ?? "…"} image(s)</span>
            </div>
            {data && !list.length ? <Card><p className="text-[13px] text-[#64748B]">Nothing here.</p></Card> : null}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((image) => (
                    <ImageCard key={image.id} image={image} onChanged={load} onError={setError} />
                ))}
            </div>
            {data?.next || data?.previous ? (
                <div className="mt-4 flex justify-between">
                    <button type="button" className={buttonStyles.secondary} disabled={!data.previous} onClick={() => setPage((p) => p - 1)}>← Previous</button>
                    <button type="button" className={buttonStyles.secondary} disabled={!data.next} onClick={() => setPage((p) => p + 1)}>Next →</button>
                </div>
            ) : null}
        </>
    );
}

function ImageCard({ image, onChanged, onError }) {
    const [alt, setAlt] = useState(image.alt_text || "");
    const [usage, setUsage] = useState(null);
    const [saving, setSaving] = useState(false);

    async function saveAlt() {
        setSaving(true);
        try {
            await apiRequest(`images/${image.id}/`, { method: "PATCH", body: { alt_text: alt } });
            await onChanged();
        } catch (err) {
            onError(err.message);
        } finally {
            setSaving(false);
        }
    }

    async function remove() {
        try {
            await apiRequest(`images/${image.id}/`, { method: "DELETE" });
            await onChanged();
        } catch (err) {
            if (err.status === 409) {
                const where = err.body?.usage || [];
                if (window.confirm(`This image is used in:\n• ${where.join("\n• ")}\n\nDelete it anyway? Those places will show a broken image.`)) {
                    await apiRequest(`images/${image.id}/?force=1`, { method: "DELETE" });
                    await onChanged();
                }
            } else {
                onError(err.message);
            }
        }
    }

    return (
        <Card className="p-0">
            <div className="aspect-[4/3] overflow-hidden rounded-t-2xl bg-[#F1F5F9]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={mediaUrl(image.image_url)} alt={image.alt_text || ""} className="h-full w-full object-cover" />
            </div>
            <div className="space-y-2 p-3 text-[12px]">
                <p className="truncate text-[#64748B]">{image.width}×{image.height} · {image.format || "?"} · {Math.round((image.file_size || 0) / 1024)} KB · {image.category}</p>
                <div className="flex gap-1">
                    <input
                        value={alt}
                        onChange={(e) => setAlt(e.target.value)}
                        placeholder="Alt text — describe the image"
                        className={`min-w-0 flex-1 rounded-md border px-2 py-1 text-[12px] outline-none focus:border-[#0F9E86] ${alt ? "border-[#CBD5E1]" : "border-[#FEC84B] bg-[#FFFAEB]"}`}
                    />
                    <button type="button" className={buttonStyles.link} disabled={saving || alt === (image.alt_text || "")} onClick={saveAlt}>{saving ? "…" : "Save"}</button>
                </div>
                <div className="flex items-center justify-between">
                    <button type="button" className={buttonStyles.link} onClick={async () => setUsage(await apiRequest(`images/${image.id}/usage/`))}>Where is it used?</button>
                    <button type="button" className="text-[12px] font-semibold text-[#B42318] hover:underline" onClick={remove}>Delete</button>
                </div>
                {usage ? (
                    <p className="text-[11px] text-[#475569]">{usage.usage.length ? usage.usage.map((u) => u.ref).join(" · ") : "Not used anywhere."}</p>
                ) : null}
            </div>
        </Card>
    );
}
