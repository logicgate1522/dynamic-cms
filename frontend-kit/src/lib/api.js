/* =========================================
   CMS API client
   Shared by server and client components.
   Backend contract: dynamic-cms/FRONTEND_INTEGRATION_PROMPT.md

   Browser admin auth is a server-side session
   (HttpOnly cookie) + CSRF — no token ever
   touches JavaScript or localStorage:
     every request  -> credentials: "include"
     unsafe methods -> X-CSRFToken from GET auth/csrf/
========================================= */

export const API_ORIGIN = (
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"
).replace(/\/+$/, "");

export const API = `${API_ORIGIN}/api`;

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class ApiError extends Error {
    constructor(message, status, body) {
        super(message);
        this.status = status;
        this.body = body;
    }
}

async function parseBody(res) {
    const text = await res.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { detail: text };
    }
}

// Human-readable message from any of the backend's error shapes.
export function errorMessage(body, fallback = "Something went wrong.") {
    if (!body || typeof body !== "object") return fallback;
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail) && body.detail.every((d) => typeof d === "string")) return body.detail.join(" ");
    if (Array.isArray(body.errors)) {
        return body.errors
            .map((e) => (e.section_index === null || e.section_index === undefined ? "" : `Section ${e.section_index + 1}: `) + (e.message || JSON.stringify(e)))
            .join(" ");
    }
    const errors = body.errors && typeof body.errors === "object" ? body.errors : body;
    const parts = Object.entries(errors)
        .filter(([, value]) => typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string")))
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(" ") : value}`);
    return parts.length ? parts.join(" · ") : fallback;
}

/* ---------------- CSRF ---------------- */

let csrfPromise = null;

function csrfToken(refresh = false) {
    if (refresh || !csrfPromise) {
        csrfPromise = fetch(`${API}/auth/csrf/`, { credentials: "include", cache: "no-store" })
            .then((res) => res.json())
            .then((data) => data.csrfToken)
            .catch((error) => {
                csrfPromise = null;
                throw error;
            });
    }
    return csrfPromise;
}

/* ---------------- requests ---------------- */

// Raw fetch with the session cookie + CSRF (for blobs, CSV downloads…).
export async function apiFetch(path, { method = "GET", body, headers, retry = true, ...rest } = {}) {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const unsafe = UNSAFE.has(method.toUpperCase());

    const res = await fetch(`${API}/${String(path).replace(/^\/+/, "")}`, {
        method,
        cache: "no-store",
        credentials: "include",
        headers: {
            ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
            ...(unsafe ? { "X-CSRFToken": await csrfToken() } : {}),
            ...headers,
        },
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
        ...rest,
    });

    // The CSRF token rotates on login; fetch a fresh one and retry once.
    if (res.status === 403 && unsafe && retry) {
        const peek = await res.clone().json().catch(() => ({}));
        if (/csrf/i.test(peek.detail || "")) {
            await csrfToken(true);
            return apiFetch(path, { method, body, headers, retry: false, ...rest });
        }
    }

    return res;
}

// JSON request from the browser. Throws ApiError on non-2xx.
export async function apiRequest(path, options = {}) {
    const res = await apiFetch(path, options);
    if (res.status === 204) return {};
    const data = await parseBody(res);
    if (!res.ok) {
        throw new ApiError(errorMessage(data, `${options.method || "GET"} ${path} failed (${res.status})`), res.status, data);
    }
    return data;
}

/* ---------------- session ---------------- */

export async function getSession() {
    try {
        const res = await fetch(`${API}/auth/session/`, { credentials: "include", cache: "no-store" });
        return res.ok ? await res.json() : { authenticated: false };
    } catch {
        return { authenticated: false };
    }
}

// `identifier` is a username or an email address.
export async function login(identifier, password) {
    const data = await apiRequest("auth/login/", {
        method: "POST",
        body: { username: identifier, password, session: true },
    });
    await csrfToken(true); // login rotates the CSRF token
    return data.user;
}

export async function logout() {
    try {
        await apiRequest("auth/logout/", { method: "POST" });
    } finally {
        csrfPromise = null;
    }
}

// The only correct way to attach an image: upload, then store image_url.
export async function uploadImage(file, category = "content") {
    const fd = new FormData();
    fd.append("image", file);
    fd.append("category", category);
    const data = await apiRequest("images/", { method: "POST", body: fd });
    return data.image_url;
}

/* ---------------- helpers ---------------- */

// Media URLs from the backend may be relative; make them absolute.
export function mediaUrl(url) {
    if (!url) return "";
    if (/^(https?:)?\/\//i.test(url) || url.startsWith("data:")) return url;
    if (url.startsWith("/media/")) return `${API_ORIGIN}${url}`;
    return url;
}

export function isEmpty(value) {
    return !value || (typeof value === "object" && Object.keys(value).length === 0);
}

/* -----------------------------------------
   Deep merge for CMS data over built-in defaults.
   Objects merge key-by-key; arrays and scalars from
   `override` replace the default wholesale — the same
   semantics the backend uses for PATCH.
----------------------------------------- */

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeDefaults(defaults, override) {
    if (override === undefined || override === null) return defaults;
    if (isPlainObject(defaults) && isPlainObject(override)) {
        const out = { ...defaults };
        for (const [key, value] of Object.entries(override)) {
            out[key] = key in defaults ? mergeDefaults(defaults[key], value) : value;
        }
        return out;
    }
    return override;
}

// "items.2.title" -> value
export function getPath(object, path) {
    return String(path)
        .split(".")
        .reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), object);
}

// Immutable set: returns a copy of `object` with `path` set to `value`.
export function setPath(object, path, value) {
    const keys = String(path).split(".");
    const root = Array.isArray(object) ? [...object] : { ...(object || {}) };
    let node = root;
    keys.forEach((key, index) => {
        if (index === keys.length - 1) {
            node[key] = value;
            return;
        }
        const nextKey = keys[index + 1];
        const child = node[key];
        node[key] = Array.isArray(child) ? [...child] : child && typeof child === "object" ? { ...child } : /^\d+$/.test(nextKey) ? [] : {};
        node = node[key];
    });
    return root;
}
