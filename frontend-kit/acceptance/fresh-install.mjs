#!/usr/bin/env node
/* =========================================================================
   Fresh-install test — proves the kit works in ANY Next.js project, not just
   the reference site it was extracted from.

     NODE_MODULES=/path/to/a/next-app/node_modules node fresh-install.mjs

   It scaffolds an empty App Router site in a temp folder, then follows the
   docs exactly as an integrating agent would:
     1. copy frontend-kit/src verbatim (R1)
     2. apply the MANIFEST "ADAPT" steps for a site with no built-in articles,
        no built-in pages and no legacy article components
     3. add the root layout from the spec (§2 P1 step 5) and one section
        converted with the §3 recipe (useCms, E.Text/Item/Add/Link, hidden guard)
     4. run check-inline and `next build`
   Fails if any kit file reaches for a site file the docs don't mention, if
   the reference site's brand leaks into the kit, or if the build breaks.
   NODE_MODULES must contain next, react, react-dom and tailwindcss v4.
========================================================================= */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = process.env.NODE_MODULES;
if (!NODE_MODULES || !existsSync(join(NODE_MODULES, "next"))) {
    console.error("Set NODE_MODULES to a node_modules folder that has next, react, react-dom and tailwindcss.");
    process.exit(2);
}

const app = mkdtempSync(join(tmpdir(), "cms-fresh-"));
const results = [];
const check = (name, ok, detail = "") => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const write = (rel, text) => {
    mkdirSync(dirname(join(app, rel)), { recursive: true });
    writeFileSync(join(app, rel), text);
};
const edit = (rel, from, to) => {
    const file = join(app, rel);
    const text = readFileSync(file, "utf8");
    if (!text.includes(from)) throw new Error(`${rel}: expected to find ${JSON.stringify(from.slice(0, 60))} (MANIFEST ADAPT step out of date?)`);
    writeFileSync(file, text.replace(from, to));
};

// 1. Install the kit verbatim.
cpSync(join(KIT, "src"), join(app, "src"), { recursive: true });
cpSync(join(KIT, "scripts"), join(app, "scripts"), { recursive: true });
symlinkSync(resolve(NODE_MODULES), join(app, "node_modules"));
write("package.json", JSON.stringify({ name: "fresh-site", private: true }, null, 2));
write("jsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }, null, 2));
write("postcss.config.mjs", 'export default { plugins: { "@tailwindcss/postcss": {} } };\n');
write("next.config.mjs", "export default {};\n");
write(".env.local", "NEXT_PUBLIC_API_URL=http://127.0.0.1:9\nNEXT_PUBLIC_SITE_URL=http://localhost:3000\nREVALIDATE_SECRET=fresh\nNEXT_PUBLIC_SITE_NAME=Acme Plumbing\n");

// 2. MANIFEST ADAPT steps for a site with no built-in content.
try {
    edit("src/lib/blog.js", 'import { articles as localArticles } from "@/data/articles";', "const localArticles = [];");
    edit("src/components/dynamic/DynamicContentPage.jsx", 'import { BUILTIN_PAGES, builtinSections } from "@/data/pages";', "const BUILTIN_PAGES = {};\nconst builtinSections = () => [];");
    // DraftPreview: no legacy article components — keep the DynamicPageAdmin branch.
    const preview = join(app, "src/components/cms/DraftPreview.jsx");
    let text = readFileSync(preview, "utf8").replace(/^import .*@\/components\/blog\/.*\n/gm, "");
    const start = text.indexOf("    if (found.article) {");
    const end = text.indexOf("    return <DynamicPageAdmin kind={found.kind}");
    if (start < 0 || end < 0) throw new Error("DraftPreview.jsx: legacy branch not found (MANIFEST ADAPT step out of date?)");
    text = text.slice(0, start) + '    if (found.article) {\n        return found.dynamic ? <DynamicPageAdmin kind="blog" hostKey={found.key} /> : children;\n    }\n\n' + text.slice(end);
    writeFileSync(preview, text);
    check("MANIFEST ADAPT steps apply", true);
} catch (err) {
    check("MANIFEST ADAPT steps apply", false, err.message);
}

// Nothing in the kit may reach for a site file that the docs don't mention.
const missing = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(jsx?|mjs)$/.test(name)) {
            for (const [, spec] of readFileSync(path, "utf8").matchAll(/from "@\/([^"]+)"/g)) {
                const base = join(app, "src", spec);
                if (![".js", ".jsx", ".json", ""].some((ext) => existsSync(base + ext)) && !existsSync(join(base, "index.js"))) missing.push(`${path.replace(app + "/", "")} → @/${spec}`);
            }
        }
    }
})(join(app, "src"));
check("every kit import resolves inside the kit after the ADAPT steps", missing.length === 0, missing.slice(0, 3).join(" | "));

// 3. The spec's root layout and one §3-recipe section.
write("src/app/globals.css", '@import "tailwindcss";\n');
write("src/app/layout.jsx", `import "./globals.css";
import "./cms.css";
import { AdminProvider } from "@/components/cms/AdminProvider";
import AdminBar from "@/components/cms/AdminBar";
import Analytics from "@/components/seo/Analytics";
import { getSiteSettings } from "@/lib/cms";

export default async function RootLayout({ children }) {
    const settings = await getSiteSettings();
    return (
        <html lang={(settings.seoDefaults?.locale || "en_US").split("_")[0]}>
            <body>
                <AdminProvider>
                    {children}
                    <AdminBar />
                    <Analytics analytics={settings.analytics} />
                </AdminProvider>
            </body>
        </html>
    );
}
`);
write("src/components/site/Pricing.jsx", `"use client";
import { useCms } from "@/components/cms/useCms";
import { submitForm } from "@/lib/forms";

const defaults = {
    emailLabel: "Your email",
    title: "Simple plans",
    plans: [
        { name: "Starter", price: "£49" },
        { name: "Growth", price: "£99" },
    ],
    buttonText: "Get in touch",
    buttonHref: "/contact",
};

export default function Pricing() {
    const { data, hidden, E, editButton } = useCms("pricing", defaults, { label: "Pricing" });
    if (hidden) return null;
    return (
        <section className="relative">
            {editButton}
            <h1><E.Text path="title" /></h1>
            <form data-cms-form="contact" onSubmit={(e) => { e.preventDefault(); submitForm("contact", { email: e.currentTarget.email.value }); }}>
                <input name="email" type="email" aria-label={data.emailLabel} />
                <button type="submit"><E.Text path="buttonText" /></button>
            </form>
            <ul>
                {data.plans.map((plan, i) => (
                    <li key={i} className="relative">
                        <E.Item path="plans" index={i} />
                        <h2><E.Text path={\`plans.\${i}.name\`} /></h2>
                        <p><E.Text path={\`plans.\${i}.price\`} /></p>
                    </li>
                ))}
                <E.Add path="plans" label="Add plan" />
            </ul>
            <a href={data.buttonHref}><E.Text path="buttonText" /><E.Link path="buttonHref" /></a>
        </section>
    );
}
`);
write("src/app/page.jsx", `import CmsSection from "@/components/cms/CmsSection";
import PageSeo from "@/components/seo/PageSeo";
import Pricing from "@/components/site/Pricing";
import { pageMetadata } from "@/lib/seo";

export function generateMetadata() {
    return pageMetadata("/", { title: "Acme Plumbing", description: "Plumbing services." });
}

export default function Home() {
    return (
        <CmsSection names={["pricing"]}>
            <main><Pricing /></main>
            <PageSeo path="/" />
        </CmsSection>
    );
}
`);

// 4. The gates a real integration must pass.
const run = (cmd) => {
    try {
        return { ok: true, out: execSync(cmd, { cwd: app, stdio: "pipe", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } }).toString() };
    } catch (err) {
        return { ok: false, out: `${err.stdout || ""}${err.stderr || ""}` };
    }
};
const inline = run("node scripts/check-inline.mjs src");
check("check-inline passes on a fresh install", inline.ok, inline.ok ? "" : inline.out.split("\n").slice(0, 3).join(" | "));
const build = run("node node_modules/next/dist/bin/next build");
check("next build passes on a fresh install (backend unreachable is fine)", build.ok, build.ok ? "" : build.out.split("\n").filter((l) => /error|Error|Module not found|Can't resolve/.test(l)).slice(0, 4).join(" | "));

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed${failed ? `  (app kept for debugging: ${app})` : ""}`);
if (!failed) rmSync(app, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
