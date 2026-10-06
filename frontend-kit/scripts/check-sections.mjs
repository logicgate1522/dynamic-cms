#!/usr/bin/env node
// Fails if SECTION_REGISTRY drifts from the backend's SECTION_SCHEMA
// (GET ai/section-schema/). Run against a running backend.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/+$/, "")}/api`;

const source = readFileSync(join(root, "src/components/dynamic/registry.js"), "utf8");
const block = source.slice(source.indexOf("SECTION_REGISTRY = {"), source.indexOf("};", source.indexOf("SECTION_REGISTRY = {")));
const registry = [...block.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1]).sort();

const res = await fetch(`${API}/ai/section-schema/`);
if (!res.ok) {
    console.error(`Could not reach ${API}/ai/section-schema/ (${res.status})`);
    process.exit(1);
}
const backend = Object.keys((await res.json()).section_schema).sort();

const missing = backend.filter((t) => !registry.includes(t));
const extra = registry.filter((t) => !backend.includes(t));

if (missing.length || extra.length) {
    if (missing.length) console.error(`Missing renderers for: ${missing.join(", ")}`);
    if (extra.length) console.error(`Renderers with no backend type: ${extra.join(", ")}`);
    process.exit(1);
}

console.log(`SECTION_REGISTRY matches the backend (${backend.length} section types).`);
