#!/usr/bin/env node
/* =========================================
   Fails when a CMS-wired component still has hard-coded copy.

     node scripts/check-inline.mjs [srcDir=src]

   Scans every .jsx/.tsx file that imports useCms and reports each JSX text
   node with real words in it (visible copy) — those must be
   <E.Text path="…" /> with the original string moved into `defaults`.

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

let problems = 0;
let scanned = 0;
for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!/import\s*\{[^}]*\buseCms\b[^}]*\}\s*from/.test(source)) continue;
    scanned++;
    const lines = source.split("\n");
    const ast = parser.parse(source, {
        sourceType: "module",
        plugins: ["jsx", ...(file.endsWith(".tsx") ? ["typescript"] : [])],
    });
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
    console.log(`\n${problems} hard-coded string(s) in ${scanned} CMS component file(s).`);
    console.log('Wire each with <E.Text path="…" /> (original string -> defaults), or mark it {/* cms-static: reason */}.');
    process.exit(1);
}
console.log(`check-inline: OK — ${scanned} CMS component file(s), no hard-coded copy.`);
