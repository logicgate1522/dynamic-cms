#!/usr/bin/env node
/* =========================================================================
   run-gates.mjs — THE definition of done for a dynamic-cms integration.

   Runs every gate against the RUNNING PRODUCTION BUILD, maps every result to
   the rules R1–R33 (rules-map.json), and enforces the three passes of P8:

     node run-gates.mjs --frontend <path> --pass 1     fix until this is green
     (rm -rf .next && next build && next start — change NOTHING else)
     node run-gates.mjs --frontend <path> --pass 2     clean re-verification
     node run-gates.mjs --frontend <path> --pass 3 --report <path>/CMS_REPORT.md

   Env: SITE_URL, API_URL, CMS_USER, CMS_PASSWORD, FORM_PAGE (default
   /contact), CMS_DYNAMIC_PAGE (a CMS page), RUNNER_SECRET (the backend's
   REVALIDATE_SECRET, for the headless tracking checks), [LAUNCH=1].

   A pass is GREEN only when every gate exits 0 AND every rule has its
   evidence in the same run. Pass 2 refuses to run unless pass 1 was green
   on exactly the same files, and proves a fresh build (a different build id).
   Pass 3 refuses unless pass 2 was green with no file changed since, then
   checks the agent's report: every rule ticked with evidence, the pass-2
   fingerprint quoted, "Defaults taken" and "Needs from the owner" present,
   and the §11 anti-pattern sweep confirmed. Results: <frontend>/.gates/.
   --only gate,gate   iterate on some gates during pass 1 (never green).
========================================================================= */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = resolve(HERE, "..");
const args = process.argv.slice(2);
const arg = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const FRONTEND = resolve(arg("--frontend", process.cwd()));
const PASS = Number(arg("--pass", "1"));
const ONLY = (arg("--only", "") || "").split(",").filter(Boolean);
const REPORT = arg("--report");
const SITE = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
const API = (process.env.API_URL || "http://localhost:8000").replace(/\/+$/, "");
const GATES_DIR = join(FRONTEND, ".gates");
mkdirSync(GATES_DIR, { recursive: true });

const RULES = JSON.parse(readFileSync(join(HERE, "rules-map.json"), "utf8"));
delete RULES._about;
const RULE_IDS = Object.keys(RULES);

function fail(msg) {
    console.log(`\n✖ ${msg}\n`);
    process.exit(1);
}
if (![1, 2, 3].includes(PASS)) fail("--pass must be 1, 2 or 3");
if (!existsSync(join(FRONTEND, "src"))) fail(`--frontend ${FRONTEND} has no src/ folder`);

/* ------------------------------------------------------------ fingerprints */

function treeHash() {
    const h = createHash("sha256");
    const skip = new Set(["node_modules", ".next", ".gates", ".git", ".turbo", ".vercel"]);
    const walk = (dir) => {
        for (const name of readdirSync(dir).sort()) {
            if (skip.has(name) || name === ".DS_Store") continue;
            const p = join(dir, name);
            const st = statSync(p);
            if (st.isDirectory()) walk(p);
            else if (st.size < 20 * 1024 * 1024) {
                h.update(relative(FRONTEND, p));
                h.update(readFileSync(p));
            }
        }
    };
    for (const part of ["src", "public", "scripts"]) if (existsSync(join(FRONTEND, part))) walk(join(FRONTEND, part));
    for (const f of readdirSync(FRONTEND)) if (/^(package\.json|next\.config\.\w+|jsconfig\.json|tsconfig\.json|postcss\.config\.\w+|tailwind\.config\.\w+)$/.test(f)) {
        h.update(f);
        h.update(readFileSync(join(FRONTEND, f)));
    }
    return h.digest("hex").slice(0, 16);
}

async function servedBuildId() {
    // Next embeds the build id in every page's RSC payload ("b":"<id>"); fully
    // static pages also start with <!--<id>-->.
    const html = await (await fetch(`${SITE}/`)).text().catch(() => "");
    return html.match(/\\?"b\\?":\\?"([\w-]{10,})\\?"/)?.[1] || html.match(/^<!DOCTYPE html><!--([\w-]{10,})-->/i)?.[1] || null;
}

/* ------------------------------------------------------------------ gates */

function run(name, cmd, argv, { cwd = HERE, env = {} } = {}) {
    process.stdout.write(`▶ ${name} … `);
    const started = Date.now();
    const r = spawnSync(cmd, argv, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const output = `${r.stdout || ""}${r.stderr || ""}`;
    writeFileSync(join(GATES_DIR, `pass-${PASS}-${name}.log`), output);
    const lines = output.split("\n");
    const checks = lines.map((l) => l.match(/^(PASS|FAIL)\s{2}(.+?)(?:\s{2}—\s.*)?$/)).filter(Boolean).map((m) => ({ ok: m[1] === "PASS", name: m[2].trim() }));
    const ok = r.status === 0;
    console.log(`${ok ? "green" : "RED"} (${Math.round((Date.now() - started) / 1000)}s${checks.length ? `, ${checks.filter((c) => c.ok).length}/${checks.length} checks` : ""})`);
    if (!ok) {
        const bad = lines.filter((l) => /^FAIL|error|Error/.test(l)).slice(0, 8);
        for (const l of bad) console.log(`    ${l.slice(0, 220)}`);
    }
    return { name, ok, checks, log: `pass-${PASS}-${name}.log` };
}

function kitVerbatim() {
    const sync = readFileSync(join(KIT, "sync_kit.py"), "utf8");
    const core = [...sync.slice(sync.indexOf("CORE = ["), sync.indexOf("]", sync.indexOf("CORE = ["))).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const scripts = [...(sync.match(/SCRIPTS = \[([^\]]*)\]/)?.[1] || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const diffs = [];
    // The one place a site may edit a CORE file: the theme block (the first
    // :root { … } rule) at the top of app/cms.css (R1, R17).
    const normalise = (rel, text) => (rel === "app/cms.css" ? text.replace(/:root\s*\{[^}]*\}/, ":root{}") : text);
    for (const rel of core) {
        const mine = join(FRONTEND, "src", rel);
        if (!existsSync(mine)) diffs.push(`missing src/${rel}`);
        else if (normalise(rel, readFileSync(mine, "utf8")) !== normalise(rel, readFileSync(join(KIT, "src", rel), "utf8"))) diffs.push(`changed src/${rel}`);
    }
    for (const name of scripts) {
        const mine = join(FRONTEND, "scripts", name);
        if (!existsSync(mine) || readFileSync(mine, "utf8") !== readFileSync(join(KIT, "scripts", name), "utf8")) diffs.push(`scripts/${name} differs from the kit`);
    }
    const ok = diffs.length === 0;
    console.log(`▶ kit-verbatim … ${ok ? "green" : "RED"} (${core.length} kit files, ${scripts.length} gate scripts)`);
    for (const d of diffs.slice(0, 10)) console.log(`    FAIL  ${d} — install the kit verbatim (R1); only ADAPT files may differ`);
    return { name: "kit-verbatim", ok, checks: [{ ok, name: "kit files match frontend-kit/src" }] };
}

async function buildGate() {
    const local = existsSync(join(FRONTEND, ".next", "BUILD_ID")) ? readFileSync(join(FRONTEND, ".next", "BUILD_ID"), "utf8").trim() : null;
    const served = await servedBuildId();
    const ok = Boolean(local && served && local === served);
    console.log(`▶ production-build … ${ok ? "green" : "RED"} (build ${local || "none"}, served ${served || "unknown"})`);
    if (!ok) console.log("    FAIL  the gates must run against THIS build: rm -rf .next && next build && next start (not next dev)");
    return { name: "production-build", ok, buildId: local, checks: [{ ok, name: "the running server is this build" }] };
}

function reportGate(fingerprint) {
    const problems = [];
    if (!REPORT || !existsSync(REPORT)) problems.push(`--report <path to CMS_REPORT.md> is required in pass 3 (not found: ${REPORT || "none"})`);
    else {
        const text = readFileSync(REPORT, "utf8");
        for (const id of RULE_IDS) {
            const line = text.split("\n").find((l) => new RegExp(`^- \\[x\\] \\*\\*${id}\\*\\*`).test(l.trim()));
            if (!line) problems.push(`${id}: no ticked line "- [x] **${id}** … evidence: …"`);
            else if (!/evidence:\s*\S{3,}/i.test(line)) problems.push(`${id}: the line has no "evidence:" (the gate line or what you checked)`);
        }
        if (!text.includes(fingerprint)) problems.push(`the report doesn't quote the pass-2 fingerprint ${fingerprint}`);
        for (const h of ["Defaults taken", "Needs from the owner"]) if (!new RegExp(`^#+\\s*${h}`, "mi").test(text)) problems.push(`no "${h}" section`);
        if (!/§11[^\n]*(none|no anti-pattern|not found|clean)/i.test(text)) problems.push(`no line confirming the §11 anti-pattern sweep ("§11: none found — …")`);
    }
    const ok = problems.length === 0;
    console.log(`▶ report … ${ok ? "green" : "RED"}`);
    for (const p of problems.slice(0, 40)) console.log(`    FAIL  ${p}`);
    return { name: "report", ok, checks: [{ ok, name: "the report covers every rule with evidence" }] };
}

/* ------------------------------------------------------------------ passes */

const previous = PASS > 1 ? join(GATES_DIR, `pass-${PASS - 1}.json`) : null;
const prev = previous && existsSync(previous) ? JSON.parse(readFileSync(previous, "utf8")) : null;
const tree = treeHash();
if (PASS > 1) {
    if (!prev?.green) fail(`pass ${PASS - 1} isn't green yet — run --pass ${PASS - 1} until it is (it was ${prev ? "red" : "never run"})`);
    if (prev.tree !== tree) fail(`files changed since pass ${PASS - 1} (${prev.tree} → ${tree}). Any change sends you back to --pass 1.`);
}

console.log(`\n=== run-gates: pass ${PASS} of 3 · ${FRONTEND} · ${SITE} · files ${tree} ===\n`);
const gates = [];
const want = (g) => !ONLY.length || ONLY.includes(g);
const nodeEnv = { SITE_URL: SITE, API_URL: API, NEXT_PUBLIC_API_URL: API };

if (want("kit-verbatim")) gates.push(kitVerbatim());
if (want("check-inline")) gates.push(run("check-inline", "node", ["scripts/check-inline.mjs", "src"], { cwd: FRONTEND }));
if (want("check-sections")) gates.push(run("check-sections", "node", ["scripts/check-sections.mjs"], { cwd: FRONTEND, env: nodeEnv }));
const build = want("production-build") ? await buildGate() : null;
if (build) gates.push(build);
if (PASS === 2 && build && prev?.buildId && build.buildId === prev.buildId) {
    fail("pass 2 must run on a FRESH build (same build id as pass 1): rm -rf .next && next build && next start, change nothing, then --pass 2");
}
if (PASS < 3) {
    if (want("visual")) gates.push(run("visual", "node", ["visual.mjs", "--dir", join(GATES_DIR, "visual")], { env: nodeEnv }));
    if (want("acceptance")) gates.push(run("acceptance", "node", ["acceptance.mjs"], { env: nodeEnv }));
    if (want("tracking-edge")) gates.push(run("tracking-edge", "node", ["tracking-edge.mjs"], { env: nodeEnv }));
    if (want("verify-tracking")) {
        gates.push(process.env.RUNNER_SECRET
            ? run("verify-tracking", "node", ["verify-tracking.mjs", "--schedule"], { env: nodeEnv })
            : (console.log("▶ verify-tracking … RED\n    FAIL  set RUNNER_SECRET (the backend's REVALIDATE_SECRET)"), { name: "verify-tracking", ok: false, checks: [] }));
    }
    if (want("site-audit")) gates.push(run("site-audit", "node", ["site-audit.mjs"], { env: nodeEnv }));
} else {
    const p2 = prev;
    for (const g of p2.gates) if (!gates.find((x) => x.name === g.name)) gates.push({ ...g, fromPass: 2 });
    gates.push(reportGate(p2.fingerprint));
}

/* --------------------------------------------------------------- evidence */

const byGate = Object.fromEntries(gates.map((g) => [g.name, g]));
const ruleRows = RULE_IDS.map((id) => {
    const missing = [];
    for (const item of RULES[id]) {
        const g = byGate[item.gate];
        if (item.gate === "report" && PASS < 3) continue; // proven in pass 3
        if (!g) missing.push(`${item.gate} not run`);
        else if (!g.ok) missing.push(`${item.gate} is red`);
        else if (item.check && !g.checks.some((c) => c.ok && new RegExp(item.check).test(c.name))) missing.push(`no PASS “${item.check}” in ${item.gate}`);
    }
    const deferred = PASS < 3 && RULES[id].some((i) => i.gate === "report");
    return { id, ok: missing.length === 0, missing, deferred };
});

const allGatesGreen = gates.every((g) => g.ok) && !ONLY.length;
const allRules = ruleRows.every((r) => r.ok);
const green = allGatesGreen && allRules;
const fingerprint = createHash("sha256").update(`${tree}:${build?.buildId}:${PASS}:${JSON.stringify(gates.map((g) => [g.name, g.ok]))}`).digest("hex").slice(0, 12);

const table = ["| Rule | Proven | Evidence |", "|---|---|---|",
    ...ruleRows.map((r) => `| ${r.id} | ${r.ok ? (r.deferred ? "yes (report in pass 3)" : "yes") : "**NO**"} | ${r.ok ? RULES[r.id].map((i) => i.check ? `${i.gate}: “${i.check.replace(/[\\^$]/g, "")}”` : i.gate).join("; ") : r.missing.join("; ")} |`)].join("\n");
writeFileSync(join(GATES_DIR, `pass-${PASS}-rules.md`), `# Rule evidence — pass ${PASS} (fingerprint ${fingerprint})\n\n${table}\n`);
writeFileSync(join(GATES_DIR, `pass-${PASS}.json`), JSON.stringify({ pass: PASS, green, tree, buildId: build?.buildId || prev?.buildId, fingerprint,
    at: new Date().toISOString(), gates: gates.map(({ name, ok, checks, log }) => ({ name, ok, checks, log })), rules: ruleRows }, null, 1));

console.log("\n--- rules ---");
for (const r of ruleRows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}${r.ok ? (r.deferred ? "  (report checked in pass 3)" : "") : `  — ${r.missing.join("; ")}`}`);
console.log(`\nRule table: ${join(GATES_DIR, `pass-${PASS}-rules.md`)}`);
if (green) {
    console.log(`\n✔ PASS ${PASS} GREEN — fingerprint ${fingerprint}`);
    console.log(PASS === 1 ? "Next: rm -rf .next && next build && next start, change NOTHING, then --pass 2."
        : PASS === 2 ? `Next: write CMS_REPORT.md (quote fingerprint ${fingerprint}, tick every rule with evidence), then --pass 3 --report <path>.`
        : "ALL GATES GREEN — 3 of 3 passes. The integration is done.");
    process.exit(0);
}
const onlyReport = PASS === 3 && gates.filter((g) => !g.ok).every((g) => g.name === "report");
console.log(onlyReport
    ? "\n✖ PASS 3 RED — the report is incomplete: fix CMS_REPORT.md (no code change) and run --pass 3 again."
    : `\n✖ PASS ${PASS} RED${ONLY.length ? " (--only never counts as a pass)" : ""} — fix every failure at its cause, then run --pass 1 again.`);
process.exit(1);
