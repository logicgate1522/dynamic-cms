import { createHmac, timingSafeEqual } from "node:crypto";

import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

/* =========================================
   Cache refresh webhook — called by the CMS
   backend (api/revalidation.py) after every
   content write, never by the browser.

   Headers: X-CMS-Timestamp, X-CMS-Signature =
   "sha256=" + HMAC-SHA256(REVALIDATE_SECRET,
   "<timestamp>.<raw body>"). Body: {"tags": [...]}.
========================================= */

const ALLOWED_TAG = /^cms(:[\w./-]+)*$/;
const MAX_SKEW_SECONDS = 300;

function validSignature(raw, timestamp, signature) {
    const secret = process.env.REVALIDATE_SECRET;
    if (!secret || !timestamp || !signature) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
    const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request) {
    const raw = await request.text();
    if (!validSignature(raw, request.headers.get("x-cms-timestamp"), request.headers.get("x-cms-signature"))) {
        return NextResponse.json({ detail: "Invalid signature." }, { status: 401 });
    }

    let body = {};
    try {
        body = JSON.parse(raw);
    } catch {
        return NextResponse.json({ detail: "Invalid JSON." }, { status: 400 });
    }

    const tags = (Array.isArray(body.tags) ? body.tags : []).filter((tag) => ALLOWED_TAG.test(tag));
    for (const tag of tags) revalidateTag(tag);

    return NextResponse.json({ revalidated: tags });
}
