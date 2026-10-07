#!/usr/bin/env node
/* =========================================
   Fails when a CMS-wired component still has hard-coded copy.

     node scripts/check-inline.mjs [srcDir=src]

   Scans every .jsx/.tsx file that imports useCms (or the dynamic-section
   edit context) and reports:
   1. each JSX text node with real words in it (visible copy) — those must be
      <E.Text path="…" /> with the original string moved into `defaults`;
   2. each list `key` built from the item's own text (e.g. key={item.title}
      or key={`${item.title}-${i}`}) — editing that text would change the key,
      React would replace the element and the field would lose focus after
      one keystroke. Use the map index (or a stable item.id / item.slug).

   To keep a string fixed on purpose (a unit, a legal mark, a screen-reader
   label, admin-only chrome), put a JSX comment containing "cms-static" on
   the same line or the line above:   {/* cms-static: currency symbol *\/}

   Uses the Babel parser that ships inside Next.js (or @babel/parser if
   installed), so it needs no extra install in a Next project.
========================================= */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] || "src");
const require = createRequire(join(process.cwd(), "package.json"));
let parser;
for (const id of ["@babel/parser", "next/dist/compiled/babel/parser"]) {
    try {
        parser = require(id);
        break;
    } catch {}
}
if (!parser) {
    console.error("No Babel parser found — run from the Next.js project root, or npm i -D @babel/parser.");
    process.exit(2);
}

const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(jsx|tsx)$/.test(name)) files.push(path);
    }
})(root);

function visit(node, fn) {
    if (!node || typeof node.type !== "string") return;
    fn(node);
    for (const key of Object.keys(node)) {
        if (key === "loc" || key === "start" || key === "end") continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach((child) => visit(child, fn));
        else if (value && typeof value.type === "string") visit(value, fn);
    }
}

// Names bound by a destructuring pattern / identifier param.
function boundNames(param, out = new Set()) {
    if (!param) return out;
    if (param.type === "Identifier") out.add(param.name);
    else if (param.type === "ObjectPattern") param.properties.forEach((p) => boundNames(p.type === "RestElement" ? p.argument : p.value, out));
    else if (param.type === "ArrayPattern") param.elements.forEach((e) => boundNames(e, out));
    else if (param.type === "AssignmentPattern") boundNames(param.left, out);
    else if (param.type === "RestElement") boundNames(param.argument, out);
    return out;
}

// A list key built from the item's own (editable) text changes on every
// keystroke: React replaces the element and the field loses focus. Keys must
// be the map index (or a stable item.id / item.slug).
function textDerivedKeys(ast, report) {
    visit(ast.program, (node) => {
        if (node.type !== "CallExpression" || node.callee?.property?.name !== "map") return;
        const fn = node.arguments[0];
        if (!fn || !/FunctionExpression|ArrowFunctionExpression/.test(fn.type)) return;
        const itemNames = boundNames(fn.params[0]);
        if (!itemNames.size) return;
        visit(fn.body, (inner) => {
            if (inner.type !== "JSXAttribute" || inner.name?.name !== "key" || !inner.value) return;
            let bad = false;
            visit(inner.value, (ref) => {
                if (ref.type === "MemberExpression" && ref.object?.type === "Identifier" && itemNames.has(ref.object.name)) {
                    const prop = ref.property?.name;
                    if (prop !== "id" && prop !== "slug") bad = true;
                } else if (ref.type === "Identifier" && itemNames.has(ref.name)) {
                    bad = true;
                }
            });
            // `item.id` is a MemberExpression whose object Identifier is visited too — re-check:
            if (bad) {
                const exprs = [];
                visit(inner.value, (ref) => exprs.push(ref));
                const onlyStable = exprs.every((ref) =>
                    !(ref.type === "Identifier" && itemNames.has(ref.name)) ||
                    exprs.some((m) => m.type === "MemberExpression" && m.object === ref && ["id", "slug"].includes(m.property?.name))
                );
                if (onlyStable) bad = false;
            }
            if (bad) report(inner.loc.start.line);
        });
    });
}

let problems = 0;
let scanned = 0;
for (const file of files) {
    const source = readFileSync(file, "utf8");
    const usesCms = /import\s*\{[^}]*\buseCms\b[^}]*\}\s*from/.test(source);
    const usesSectionEdit = /from\s+["']@\/components\/dynamic\/edit-context["']/.test(source);
    if (!usesCms && !usesSectionEdit) continue;
    scanned++;
    const lines = source.split("\n");
    const ast = parser.parse(source, {
        sourceType: "module",
        plugins: ["jsx", ...(file.endsWith(".tsx") ? ["typescript"] : [])],
    });
    textDerivedKeys(ast, (line) => {
        if (`${lines[line - 2] || ""}${lines[line - 1]}`.includes("cms-static")) return;
        problems++;
        console.log(`${relative(process.cwd(), file)}:${line}  list key built from the item's text — use the map index (fields lose focus after one keystroke otherwise)`);
    });
    // Raw CSS background URLs ship the original (often multi-MB) file.
    lines.forEach((line, i) => {
        if (/url\(\s*['"`]?(\$\{|\/)/.test(line) && !/bgImage|cms-static/.test(line)) {
            problems++;
            console.log(`${relative(process.cwd(), file)}:${i + 1}  raw CSS url(...) — use bgImage() from @/lib/bgImage (optimised AVIF/WebP)`);
        }
    });
    if (!usesCms) continue;
    visit(ast.program, (node) => {
        if (node.type !== "JSXText") return;
        const text = node.value.replace(/\s+/g, " ").trim();
        if (!/[A-Za-z]{2,}/.test(text)) return;
        // the line the words are on (a text node starts right after the previous tag)
        const first = text.split(" ")[0];
        let line = node.loc.start.line;
        while (line < node.loc.end.line && !lines[line - 1].includes(first)) line++;
        if (`${lines[line - 2] || ""}${lines[line - 1]}`.includes("cms-static")) return;
        problems++;
        console.log(`${relative(process.cwd(), file)}:${line}  "${text.slice(0, 70)}"`);
    });
}

if (problems) {
    console.log(`\n${problems} problem(s) in ${scanned} CMS component file(s).`);
    console.log('Hard-coded text: wire it with <E.Text path="…" /> (original string -> defaults), or mark it {/* cms-static: reason */}.');
    console.log("Text-derived list keys: use the map index (key={index}).");
    process.exit(1);
}
console.log(`check-inline: OK — ${scanned} CMS component file(s): no hard-coded copy, no text-derived list keys.`);
