#!/usr/bin/env node
/* =========================================
   Install the tracking plan set up during integration (conversions, intents,
   segments, stages) on this environment, approved, so it is there from day one
   and the owner only adjusts it under Admin -> Tracking.

   node scripts/tracking-seed.mjs            install when no approved plan exists yet
   node scripts/tracking-seed.mjs --force    replace the plan with the fixture
   (npm run cms:seed runs this as its last step.)

   The fixture scripts/tracking-seed.json comes from the integration database:
   python manage.py tracking_export ../frontend/scripts/tracking-seed.json
   Tool IDs (GA4, GTM, Meta, ...) are never part of it: set them in Settings -> Analytics.
========================================= */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");

for (const file of [".env.local", ".env"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
}

const API = `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/+$/, "").replace(/\/api$/, "")}/api`;
const { CMS_EMAIL, CMS_PASSWORD } = process.env;
const fixturePath = join(root, "scripts", "tracking-seed.json");

if (!existsSync(fixturePath)) {
    console.log("tracking-seed: no scripts/tracking-seed.json — nothing to install (export one with `manage.py tracking_export`).");
    process.exit(0);
}
if (!CMS_EMAIL || !CMS_PASSWORD) {
    console.error("Set CMS_EMAIL and CMS_PASSWORD (a staff account).");
    process.exit(1);
}

let token = "";
async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(`${API}/${path}`, {
        method,
        headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Token ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
token = (await api("auth/login/", { method: "POST", body: { email: CMS_EMAIL, password: CMS_PASSWORD } })).key;

const current = await api("tracking/plan/");
if (!force && current.plan?.status === "approved" && (current.plan.conversions || []).length) {
    console.log(`tracking-seed: an approved plan with ${current.plan.conversions.length} conversions already exists — left as the owner has it (use --force to replace).`);
    process.exit(0);
}

// The facts the plan is checked against: only when the site has not been scanned yet.
if (force || !current.facts?.scanned) await api("tracking/scan/?source=headless", { method: "POST", body: fixture.scan });
await api("tracking/plan/?unlock=1", { method: "PUT", body: { plan: fixture.plan } });
const approved = await api("tracking/plan/approve/", { method: "POST" });
console.log(`tracking-seed: approved plan v${approved.plan.version}: ${approved.plan.conversions.length} conversions, ${approved.plan.intents.length} intents, ${approved.plan.segments.length} segments.`);
