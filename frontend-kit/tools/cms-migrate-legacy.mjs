#!/usr/bin/env node
/* =========================================================================
   cms-migrate-legacy — remove the OLD per-component editor, keep the copy.

   Sites integrated with the first generation of the integration prompt wired
   every editable component the same way: useState(data/tempData/isAdmin/
   editMode/isSaving), a `localStorage.authToken` check, `fetch(ENDPOINT)` to
   GET and PATCH home/<name>/, an Edit/Save/Cancel button, and
   `editMode ? <input/> : <text/>` branches. That layer breaks R1/R3/R4/R7
   (hand-rolled editor, live writes, a token in browser storage, revalidation
   from the browser) and the kit replaces all of it.

     node tools/cms-migrate-legacy.mjs <file.jsx> [--name <block>] [--write]

   What it removes (only inside the default-exported component):
     • state: tempData, isAdmin, editMode, isSaving, uploading*, and the
       `[data, setData] = useState(defaults)` pair
     • effects that read the token or fetch the endpoint
     • every helper that touches tempData / the token / the endpoint /
       revalidate (toggleEdit, setField, save, add*, remove*, upload…)
     • JSX: `isAdmin && …` (the edit buttons), `editMode && …`, and
       `editMode ? A : B` -> B (also inside attributes); `!editMode && X` -> X
     • imports and top-level helpers that are no longer used
   What it adds: `const { data, hidden, E, editButton } = useCms(name,
   defaults, …)` with the block name taken from the old endpoint
   (home/<name>/) so content already saved under it keeps working, the
   `defaults` object (the old `defaultData`, renamed), `if (hidden) return
   null;`, and the "use client" + useCms import.

   Then run `tools/cms-convert.mjs` on the result to wire the copy to
   <E.Text> / <E.Image> / <E.Item> / <E.Add>.

   It prints what it could not decide ("manual:") — typically helpers shared
   with the rest of the component. `npm run check:inline` is the judge.
========================================================================= */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const file = argv.find((a) => !a.startsWith("--") && a !== flag("--name") && a !== flag("--name-expr") && a !== flag("--component"));
if (!file) {
    console.error("usage: node tools/cms-migrate-legacy.mjs <file.jsx> [--name <block>] [--write]");
    process.exit(2);
}
const WRITE = argv.includes("--write");
// --static: the component only displays what it is given (props / a server-merged
// object). The data pair becomes `const data = <initial>`, no useCms is added.
const STATIC = argv.includes("--static");
// --name-expr "`blog-faq-${slug}`": the block name is computed from props (one block per
// article/product/...). Defaults built inside the component are wrapped in useStable().
const NAME_EXPR = flag("--name-expr");
// --component Name: migrate that function instead of the default export (files that
// hold several editable sections). --keep-defaults-name: leave the defaults variable's
// name alone (it is used by neighbouring components too).
const WANTED = flag("--component");
// --again: internal. Edits inside a branch that was itself replaced are dropped in one pass, so the
// tool re-runs itself on its own output (JSX clean-up only) until nothing is left to remove.
const AGAIN = argv.includes("--again");
const KEEP_DEFAULTS_NAME = argv.includes("--keep-defaults-name");

const require = createRequire(join(process.cwd(), "package.json"));
let parser;
for (const id of ["@babel/parser", "next/dist/compiled/babel/parser"]) {
    try {
        parser = require(id);
        break;
    } catch {}
}
if (!parser) {
    console.error("No Babel parser found — run from the Next.js project root.");
    process.exit(2);
}

const path = resolve(file);
const source = readFileSync(path, "utf8");
const ast = parser.parse(source, { sourceType: "module", plugins: ["jsx"] });

const manual = [];
const removed = [];
const edits = []; // { start, end, text }
const remove = (node, why) => {
    edits.push({ start: node.start, end: node.end, text: "" });
    if (why) removed.push(why);
};
const replace = (start, end, text) => edits.push({ start, end, text });
const lineOf = (pos) => source.slice(0, pos).split("\n").length;
const text = (node) => source.slice(node.start, node.end);

function visit(node, fn, parent = null) {
    if (!node || typeof node.type !== "string") return;
    if (fn(node, parent) === false) return;
    for (const key of Object.keys(node)) {
        if (["loc", "start", "end", "leadingComments", "trailingComments", "innerComments", "extra"].includes(key)) continue;
        const value = node[key];
        if (Array.isArray(value)) value.forEach((child) => visit(child, fn, node));
        else if (value && typeof value.type === "string") visit(value, fn, node);
    }
}

/* -------------------------------------------------- find the component */

let component = null;
const functions = new Map();
for (const node of ast.program.body) {
    if (node.type === "FunctionDeclaration" && node.id) functions.set(node.id.name, node);
    if (WANTED && node.type === "FunctionDeclaration" && node.id?.name === WANTED) component = node;
    if (!WANTED && node.type === "ExportDefaultDeclaration") {
        const d = node.declaration;
        if (/Function/.test(d.type)) component = d;
        else if (d.type === "Identifier") component = functions.get(d.name);
    }
}
if (!component) {
    console.error("No default-exported function component found.");
    process.exit(2);
}
const body = component.body.body;

/* -------------------------------------------- the old endpoint and defaults */

const endpointMatch = source.match(/home\/([\w-]+)\//);
const sectionHook = source.match(/use\w*CmsSection\(\s*["'`]([\w-]+)["'`]\s*,\s*(\w+)/);
const NAME = STATIC || AGAIN ? "static" : NAME_EXPR ? "dynamic" : flag("--name") || endpointMatch?.[1] || sectionHook?.[1];
if (!NAME) {
    console.error("Could not read the block name from the old ENDPOINT (home/<name>/) — pass --name.");
    process.exit(2);
}
let defaultsName = null;
for (const stmt of body) {
    if (stmt.type !== "VariableDeclaration") continue;
    for (const d of stmt.declarations) {
        if (d.id?.type === "ArrayPattern" && d.init?.callee?.name === "useState" && d.id.elements[0]?.name === "data") {
            defaultsName = d.init.arguments[0]?.name || null;
        }
    }
}
if (!defaultsName && sectionHook) defaultsName = sectionHook[2];
if (!defaultsName) {
    for (const node of ast.program.body) {
        if (node.type === "VariableDeclaration") for (const d of node.declarations) if (/^(default(Data)?|DEFAULTS?)$/i.test(d.id?.name || "")) defaultsName = d.id.name;
    }
}
if (!defaultsName && !STATIC && !AGAIN) {
    console.error("Could not find the defaults object (the argument of useState for `data`).");
    process.exit(2);
}

/* ------------------------------------------------------------- the body */

const STATE_NAMES = /^(tempData|isAdmin|editMode|isSaving|saving|editing|isEditing)$|^uploading|^isUploading/;
const LEGACY_TOUCH = /\btempData\b|\bsetTempData\b|localStorage\.(get|set)Item\(\s*["'`]auth|\bENDPOINT\b|\brevalidate\w*\(|\bsetEditMode\b|\bsetIsSaving\b|\bsetIsAdmin\b|\bsetData\b/;

const removedNames = new Set(["tempData", "setTempData", "editMode", "setEditMode", "isAdmin", "setIsAdmin", "isSaving", "setIsSaving", "setData"]);
let viewAlias = null;

for (const stmt of body) {
    if (stmt.type === "VariableDeclaration") {
        for (const d of stmt.declarations) {
            const id = d.id;
            if (id?.type === "ObjectPattern" && /^use\w*CmsSection$/.test(d.init?.callee?.name || "")) {
                // second-generation hook: const { data, tempData, setField, ... } = useCmsSection("x", defaults)
                for (const prop of id.properties) if (prop.value?.name && prop.value.name !== "data") removedNames.add(prop.value.name);
                remove(stmt, "useCmsSection destructure");
            } else if (id?.type === "ArrayPattern") {
                const names = id.elements.map((e) => e?.name).filter(Boolean);
                if (d.init?.callee?.name === "useState" && (names.some((n) => STATE_NAMES.test(n)) || names[0] === "data")) {
                    names.forEach((n) => removedNames.add(n));
                    if (STATIC && names[0] === "data") {
                        removedNames.delete("data");
                        removedNames.delete(names[1]);
                        replace(stmt.start, stmt.end, `const data = ${text(d.init.arguments[0])};`);
                        removed.push("data state -> const");
                    } else remove(stmt, `state ${names.join(", ")}`);
                }
            } else if (id?.type === "Identifier") {
                if (/Function/.test(d.init?.type || "") && LEGACY_TOUCH.test(text(d.init))) {
                    removedNames.add(id.name);
                    remove(stmt, `helper ${id.name}`);
                } else if (d.init?.type === "ConditionalExpression" && /^editMode$/.test(d.init.test?.name || "") && /tempData/.test(text(d.init.consequent))) {
                    viewAlias = id.name; // const view = editMode ? tempData : data;
                    remove(stmt, `view alias ${id.name}`);
                }
            }
        }
    } else if (stmt.type === "ExpressionStatement" && stmt.expression?.callee?.name === "useEffect" && LEGACY_TOUCH.test(text(stmt))) {
        remove(stmt, "effect that read the token / fetched the endpoint");
    } else if (stmt.type === "FunctionDeclaration" && LEGACY_TOUCH.test(text(stmt))) {
        removedNames.add(stmt.id.name);
        remove(stmt, `helper ${stmt.id.name}`);
    }
}
// Helpers that call something we removed (setField, toggleEdit, uploadImage ...) are dead too.
for (let pass = 0; pass < 3; pass++) {
    for (const stmt of body) {
        if (stmt.type !== "VariableDeclaration") continue;
        for (const d of stmt.declarations) {
            if (d.id?.type !== "Identifier" || !/Function/.test(d.init?.type || "") || removedNames.has(d.id.name)) continue;
            const t = text(d.init);
            if ([...removedNames].filter((n) => !["data", "view", "editMode", "isAdmin", "isSaving"].includes(n)).some((n) => new RegExp(`\\b${n}\\b`).test(t))) {
                removedNames.add(d.id.name);
                remove(stmt, `helper ${d.id.name}`);
            }
        }
    }
}
// Keep a statement removed only once (a removed helper may sit inside another).
const nested = (e) => edits.some((o) => o !== e && o.start <= e.start && o.end >= e.end && (o.start < e.start || o.end > e.end));

/* ----------------------------------------------------------------- JSX */

const isId = (n, name) => n?.type === "Identifier" && n.name === name;
const isNot = (n) => n?.type === "UnaryExpression" && n.operator === "!";

function altSource(node) {
    // source of a node without wrapping parentheses
    let n = node;
    while (n.type === "ParenthesizedExpression") n = n.expression;
    return n;
}

visit(component.body, (node, parent) => {
    // if (editMode) { return <edit card/>; }  — the edit-only early return inside a .map()
    if (node.type === "IfStatement" && isId(node.test, "editMode")) {
        if (node.alternate) replace(node.start, node.end, text(node.alternate));
        else remove(node, "edit-only branch");
        return false;
    }
    // <SomethingEditBar ... />  (the old floating edit/save bar)
    if (node.type === "JSXElement" && /(EditBar|AdminControls|AdminToolbar)$/.test(node.openingElement.name?.name || "")) {
        remove(node, "edit bar");
        return false;
    }
    // {isAdmin && (...)}  /  {editMode && (...)}
    if (node.type === "JSXExpressionContainer" && node.expression?.type === "LogicalExpression" && node.expression.operator === "&&") {
        // `editMode && a && b` parses as (editMode && a) && b: test the leftmost operand
        let left = node.expression.left;
        while (left.type === "LogicalExpression" && left.operator === "&&") left = left.left;
        if (isId(left, "isAdmin") || isId(left, "editMode")) {
            remove(node, "edit chrome");
            return false;
        }
        if (isNot(left) && isId(left.argument, "editMode")) {
            const right = altSource(node.expression.right);
            replace(node.start, node.end, right.type.startsWith("JSX") ? text(right) : `{${text(right)}}`);
            removed.push("editMode guard");
            return false;
        }
    }
    // {editMode ? A : B}  anywhere (child or attribute)
    if (node.type === "ConditionalExpression") {
        const t = node.test;
        const editTest = isId(t, "editMode");
        const viewTest = isNot(t) && isId(t.argument, "editMode");
        if (editTest || viewTest) {
            const keep = altSource(editTest ? node.alternate : node.consequent);
            const container = parent?.type === "JSXExpressionContainer" ? parent : null;
            if (keep.type === "NullLiteral") {
                remove(container || node, "edit branch");
            } else if (container && keep.type.startsWith("JSX")) {
                replace(container.start, container.end, text(keep));
            } else if (container) {
                replace(container.start, container.end, `{${text(keep)}}`);
            } else {
                replace(node.start, node.end, text(keep));
            }
            removed.push("editMode branch");
            return false;
        }
    }
    return true;
});

// `view` -> `data`
if (viewAlias) {
    visit(component.body, (node, parent) => {
        if (node.type === "Identifier" && node.name === viewAlias) {
            const isKey = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
            const isProp = parent?.type === "ObjectProperty" && parent.key === node && !parent.computed;
            if (!isKey && !isProp) replace(node.start, node.end, "data");
        }
        return true;
    });
}

/* --------------------------------------------- apply, then clean up */

function apply(src, list) {
    const ordered = list
        .filter((e) => !nested(e))
        .map((e, i) => ({ ...e, i }))
        .sort((a, b) => b.start - a.start || b.i - a.i);
    let out = src;
    for (const e of ordered) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return out;
}
// Overlapping edits (a replace inside a removed block) are dropped by `nested`.
let out = apply(source, edits);

// `view.x` -> `data.x` (an edit inside a replaced branch is lost, so do it on the text too)
if (viewAlias) out = out.replace(new RegExp(`\\b${viewAlias}\\b(?=\\??\\.\\w|\\[)`, "g"), "data");
// ENDPOINT / apiUrl constants and the defaults rename
out = out.replace(/\nconst apiUrl = [\s\S]*?;\n/, "\n").replace(/\nconst (?:\w*_)?ENDPOINT = [\s\S]*?;\n/g, "\n");
if (!STATIC && !KEEP_DEFAULTS_NAME && !AGAIN) out = out.replace(new RegExp(`\\b${defaultsName}\\b`, "g"), "defaults");

// Insert the hook as the first statement of the component.
const label = (NAME_EXPR ? basename(path).replace(/\.\w+$/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase() : NAME).split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const sig = AGAIN ? ["", ""] : out.match(WANTED ? new RegExp(`function ${WANTED}\\s*\\([^)]*\\)\\s*\\{`) : /export default function \w*\([^)]*\)\s*\{/);
if (!sig) {
    console.error("Lost the component signature while editing.");
    process.exit(2);
}
const at = AGAIN ? 0 : sig.index + sig[0].length;
const needsHidden = !STATIC && !WANTED && !/\bif \(hidden\)/.test(out);
if (!STATIC && !AGAIN) out = out.slice(0, at) + `\n  const { data, hidden, E, editButton } = useCms(${NAME_EXPR || JSON.stringify(NAME)}, ${KEEP_DEFAULTS_NAME ? defaultsName : "defaults"}, { label: ${JSON.stringify(label)} });` + out.slice(at);

if (NAME_EXPR && !AGAIN) {
    // defaults computed inside the component must keep their identity between renders
    const m = out.match(/(\n\s*)const defaults =([\s\S]*?);(\n)/);
    if (m && m.index > at) {
        out = out.replace(m[0], `${m[1]}const defaults = useStable(${m[2].trim()});${m[3]}`);
        out = out.replace(/(\nimport [^\n]*\n)(?![\s\S]*\nimport )/, `$1import { useStable } from "@/lib/useStable";\n`);
    } else manual.push("defaults must be a stable object: wrap it in useStable() from @/lib/useStable");
}
// Imports: add useCms, drop names nothing uses any more.
if (!STATIC && !AGAIN && !/useCms/.test(source)) out = out.replace(/(\nimport [^\n]*\n)(?![\s\S]*\nimport )/, `$1import { useCms } from "@/components/cms/useCms";\n`);
if (!AGAIN && !/^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*\s*["']use client["']/.test(out)) out = `"use client";\n\n${out}`;

out = out.replace(/\nimport [A-Za-z_$][\w$]* from ["'](\.\.?\/[^"']*lib\/revalidate)["'];?/g, "");

// Top-level helpers nothing references any more (edit-only sub-components).
const reparsed = parser.parse(out, { sourceType: "module", plugins: ["jsx"] });
const drop = [];
for (const node of reparsed.program.body) {
    const name = node.type === "FunctionDeclaration" ? node.id?.name : null;
    if (!name || node.declaration) continue;
    const uses = (out.match(new RegExp(`\\b${name}\\b`, "g")) || []).length;
    if (uses === 1) drop.push(node);
}
for (const node of drop.reverse()) {
    out = out.slice(0, node.start) + out.slice(node.end);
    removed.push(`unused helper ${node.id.name}`);
}
// default imports nothing uses any more (the old EditBar, helpers)
out = out.replace(/^import ([A-Za-z_$][\w$]*) from ["'][^"']+["'];?\n/gm, (whole, name) => {
    const rest = out.replace(whole, "");
    return new RegExp(`\\b${name}\\b`).test(rest) ? whole : "";
});
out = out.replace(/^import \{\s*use\w*CmsSection\s*\} from ["'][^"']+["'];?\n/gm, "");
const importRe = /import\s*\{([^}]*)\}\s*from\s*(["'][^"']+["']);?/g;
out = out.replace(importRe, (whole, names, from) => {
    const rest = out.replace(whole, "");
    const kept = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
        .filter((n) => new RegExp(`\\b${n.split(/\s+as\s+/).pop()}\\b`).test(rest));
    if (!kept.length) return "";
    return `import { ${kept.join(", ")} } from ${from};`;
});
out = out.replace(/^[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");

// What is left that still mentions the old layer?
for (const name of ["tempData", "setTempData", "editMode", "isAdmin", "isSaving", "localStorage", "ENDPOINT", "revalidate"]) {
    out.split("\n").forEach((line, i) => {
        if (new RegExp(`\\b${name}\\b`).test(line)) manual.push(`line ${i + 1}: still mentions ${name}: ${line.trim().slice(0, 80)}`);
    });
}
if (needsHidden) manual.push("add `if (hidden) return null;` before the final return (cms-convert does this)");

const report = [
    `${basename(path)} -> block "${NAME}" (defaults: ${defaultsName} -> defaults)`,
    `  removed: ${[...new Set(removed)].join("; ") || "nothing"}`,
    ...manual.map((m) => `  manual: ${m}`),
    "  next:   node tools/cms-convert.mjs <file> --name " + NAME + " --write",
];
if (WRITE) {
    writeFileSync(path, out);
    console.error(report.join("\n"));
    if (!AGAIN) {
        // second, third... pass over the output until a pass removes nothing
        const { execFileSync } = await import("node:child_process");
        const passArgs = [process.argv[1], file, "--again", "--write", ...(WANTED ? ["--component", WANTED] : []), ...(STATIC ? ["--static"] : [])];
        for (let i = 0; i < 4; i += 1) {
            const before = readFileSync(path, "utf8");
            try {
                execFileSync(process.execPath, passArgs, { stdio: ["ignore", "ignore", "ignore"] });
            } catch {
                break;
            }
            if (readFileSync(path, "utf8") === before) break;
        }
    }
} else {
    process.stdout.write(out);
    console.error(report.join("\n"));
}
