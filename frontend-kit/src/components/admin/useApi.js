"use client";

import { useCallback, useEffect, useState } from "react";

import { apiRequest } from "@/lib/api";

// Authenticated GET with loading/error state and a reload().
export function useApi(path) {
    const [data, setData] = useState(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);

    const reload = useCallback(async () => {
        if (!path) return;
        setLoading(true);
        try {
            setData(await apiRequest(path));
            setError("");
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [path]);

    useEffect(() => {
        reload();
    }, [reload]);

    return { data, error, loading, reload, setData };
}

export function rows(data) {
    if (!data) return [];
    return Array.isArray(data) ? data : data.results || [];
}

// Follow `next` links of a paginated list.
export async function fetchAll(path) {
    const out = [];
    let next = path;
    for (let i = 0; next && i < 50; i += 1) {
        const data = await apiRequest(next.replace(/^https?:\/\/[^/]+\/api\//, ""));
        out.push(...rows(data));
        next = Array.isArray(data) ? null : data.next;
    }
    return out;
}

export function formatDate(value) {
    if (!value) return "—";
    try {
        return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    } catch {
        return value;
    }
}
