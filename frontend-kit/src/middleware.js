import { NextResponse } from "next/server";

/* =========================================
   CMS-managed redirects
   The active redirect list is cached in memory
   for a minute and matched locally, so normal
   page views never wait on the backend.
   A match pings redirects/resolve/ so the hit
   counter in the CMS stays accurate.
========================================= */

const API = `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/+$/, "")}/api`;
// Identifies this server to the backend (shared secret, server-only) so its
// requests aren't rate-limited as one anonymous visitor.
const SERVER_HEADERS = process.env.REVALIDATE_SECRET ? { "X-CMS-Frontend": process.env.REVALIDATE_SECRET } : {};
const TTL_MS = 60_000;
const ALLOWED_STATUS = new Set([301, 302, 307, 308]);

let cache = { at: 0, map: null, pending: null };

async function loadRedirects() {
    const map = new Map();
    let url = `${API}/redirects/`;

    for (let page = 0; url && page < 50; page += 1) {
        const res = await fetch(url, { cache: "no-store", headers: SERVER_HEADERS });
        if (!res.ok) throw new Error(`redirects ${res.status}`);
        const data = await res.json();
        const rows = Array.isArray(data) ? data : data.results || [];
        for (const row of rows) {
            if (row.is_active === false || !row.source || !row.destination) continue;
            map.set(normalise(row.source), {
                to: row.destination,
                status: row.effective_status || row.status_code || (row.permanent === false ? 302 : 301),
                source: row.source,
            });
        }
        url = Array.isArray(data) ? null : data.next;
    }

    return map;
}

async function redirects() {
    const now = Date.now();
    if (cache.map && now - cache.at < TTL_MS) return cache.map;
    if (!cache.pending) {
        cache.pending = loadRedirects()
            .then((map) => {
                cache = { at: Date.now(), map, pending: null };
                return map;
            })
            .catch(() => {
                // Backend unreachable: keep serving the last known list.
                cache = { at: Date.now(), map: cache.map || new Map(), pending: null };
                return cache.map;
            });
    }
    return cache.pending;
}

function normalise(path) {
    const clean = `/${String(path).trim().replace(/^\/+/, "")}`.replace(/\/+$/, "");
    return (clean || "/").toLowerCase();
}

export async function middleware(request) {
    const { pathname, search } = request.nextUrl;
    const map = await redirects();
    const match = map.get(normalise(pathname));

    if (!match) return NextResponse.next();

    // Fire-and-forget hit counter.
    fetch(`${API}/redirects/resolve/?path=${encodeURIComponent(match.source)}`, { headers: SERVER_HEADERS }).catch(() => {});

    const destination = new URL(match.to, request.url);
    if (!destination.search && search) destination.search = search;
    const status = ALLOWED_STATUS.has(Number(match.status)) ? Number(match.status) : 301;

    return NextResponse.redirect(destination, status);
}

export const config = {
    // Pages only: skip Next internals, API routes, the admin and static files.
    matcher: ["/((?!_next/|api/|admin|images/|favicon|robots\\.txt|sitemap\\.xml|.*\\.[\\w]+$).*)"],
};
