#!/usr/bin/env node
/* =========================================================================
   cms-convert — the §3 section-conversion recipe, applied mechanically.

     node tools/cms-convert.mjs src/components/home/FinalCTA.jsx --name final-cta
     node tools/cms-convert.mjs <file> --name <block> [--label "Label"] [--component Name] [--write]

   Without --write the converted source is printed to stdout and the report
   to stderr, so you can read it before anything changes. With --write the
   file is rewritten in place (commit first; undo is `git checkout`).

   What it does to ONE component in the file (the default export, or
   --component):
     • every JSX text node with words   -> <E.Text path="…" />, the original
       string moved, verbatim, into a module-level `defaults` object (R2, R9)
     • string `alt`                      -> alt={data.…}
     • string `href` on an element with children -> href={data.…} + <E.Link>
     • string `src` on <img>/<Image>     -> src={data.…} + <E.Image> after it
     • `LIST.map(...)` over a module-level array of strings / plain objects
       (and one nested level of arrays inside its items) -> data.list.map,
       index keys, <E.Item> first in each item and <E.Add> after the list
     • adds "use client", the useCms import and call, `if (hidden) return
       null;` before the final return, and {editButton} first in the root

   What it deliberately does NOT do (it prints these as "manual"): text that
   comes from props, function calls or template strings; arrays that hold
   components/JSX (icons); destructured map parameters; early returns;
   fragments as the root; string literals inside expressions. Finish those by
   hand, then run `npm run check:inline`, which is the judge.

   It never changes a CORE kit file and never invents copy: defaults are the
   component's own strings.
========================================================================= */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const file = argv.find((a) => !a.startsWith("--") && a !== flag("--name") && a !== flag("--label") && a !== flag("--component"));
if (!file) {
    console.error('usage: node tools/cms-convert.mjs <file.jsx> [--name <block-name>] [--label "Label"] [--component Name] [--write]');
    process.exit(2);
}
// The block name: --name, or the one an earlier useCms("…") call (cms-migrate-legacy) already uses.
const NAME = flag("--name") || readFileSync(resolve(file), "utf8").match(/useCms\(\s*["']([\w-]+)["']/)?.[1];
if (!NAME) {
    console.error("Pass --name <block-name> (kebab-case, unique per block).");
    process.exit(2);
}
const LABEL = flag("--label") || NAME.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
const WRITE = argv.includes("--write");

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

const HAS_DIRECTIVE = /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*\s*["']use client["']/.test(source);
const warnings = [];
const manual = [];
const edits = []; // { start, end, text }
const defaults = {};
const used = new Map();
let converted = 0;

const indentAt = (pos) => {
    const start = source.lastIndexOf("\n", pos - 1) + 1;
    return source.slice(start).match(/^[ \t]*/)[0];
};
const lineOf = (pos) => source.slice(0, pos).split("\n").length;
const edit = (start, end, text) => edits.push({ start, end, text });
const insert = (pos, text) => edit(pos, pos, text);
const warn = (pos, msg) => warnings.push(`line ${lineOf(pos)}: ${msg}`);

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

/* ----------------------------------------------------------- the component */

function isJsx(node) {
    return node && (node.type === "JSXElement" || node.type === "JSXFragment");
}
function returnedJsx(fn) {
    if (fn.body.type !== "BlockStatement") return isJsx(fn.body) ? { ret: fn.body, statement: null } : null;
    const statements = fn.body.body;
    for (let i = statements.length - 1; i >= 0; i -= 1) {
        const s = statements[i];
        if (s.type === "ReturnStatement" && s.argument) {
            let arg = s.argument;
            if (arg.type === "ParenthesizedExpression") arg = arg.expression;
            return isJsx(arg) ? { ret: arg, statement: s } : null;
        }
    }
    return null;
}

let existingDefaults = null; // module-level `const defaults = { … }`
let existingDefaultsValue = {}; // its literal-able part (for type checks)
const topFunctions = new Map(); // name -> fn node
const topArrays = new Map(); // NAME -> ArrayExpression
let defaultExport = null;
for (const node of ast.program.body) {
    if (node.type === "FunctionDeclaration" && node.id) topFunctions.set(node.id.name, node);
    if (node.type === "VariableDeclaration") {
        for (const d of node.declarations) {
            if (d.id?.type !== "Identifier") continue;
            if (/Function/.test(d.init?.type || "")) topFunctions.set(d.id.name, d.init);
            if (d.init?.type === "ArrayExpression") topArrays.set(d.id.name, d.init);
            if (d.id.name === "defaults" && d.init?.type === "ObjectExpression") {
                existingDefaults = d.init;
                existingDefaultsValue = partial(d.init);
            }
        }
    }
    if (node.type === "ExportDefaultDeclaration") {
        const d = node.declaration;
        if (/Function/.test(d.type)) defaultExport = d.id ? d : Object.assign(d, { __anon: true });
        else if (d.type === "Identifier") defaultExport = d.name;
    }
    if (node.type === "ExportNamedDeclaration" && node.declaration?.type === "FunctionDeclaration") {
        topFunctions.set(node.declaration.id.name, node.declaration);
    }
}
let component = null;
const wanted = flag("--component");
if (wanted) component = topFunctions.get(wanted);
else if (typeof defaultExport === "string") component = topFunctions.get(defaultExport);
else if (defaultExport) component = defaultExport;
if (!component) {
    console.error("Could not find the component to convert (use --component Name).");
    process.exit(2);
}
const found = returnedJsx(component);
if (!found) {
    console.error("The component does not end with a returned JSX element.");
    process.exit(2);
}
const { ret: root, statement: finalReturn } = found;
if (component.body.type !== "BlockStatement") {
    console.error("Arrow components with an expression body are not supported — give it a block body first.");
    process.exit(2);
}

// The literal-able part of an object (computed / imported values are skipped).
function partial(node) {
    const out = {};
    for (const p of node.properties || []) {
        if (p.type !== "ObjectProperty" || p.computed) continue;
        const k = p.key.name || p.key.value;
        const v = literal(p.value);
        if (v !== undefined) out[k] = v;
    }
    return out;
}

/* -------------------------------------------------------------- key naming */

const TAG_KEYS = { h1: "heading", h2: "title", h3: "subtitle", h4: "subtitle", h5: "subtitle", h6: "subtitle", p: "text", li: "item", button: "buttonText", a: "linkText", label: "label", span: "label", small: "note", strong: "highlight", em: "highlight", blockquote: "quote", figcaption: "caption", dt: "term", dd: "description", th: "heading", td: "cell", summary: "question" };

function unique(base) {
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}${n}`;
}
function tagName(el) {
    const n = el?.openingElement?.name;
    if (!n) return "";
    if (n.type === "JSXIdentifier") return n.name;
    if (n.type === "JSXMemberExpression") return n.property.name;
    return "";
}
const HEADING_KEYS = { h1: "heading", h2: "title", h3: "subtitle", h4: "subtitle", h5: "subtitle", h6: "subtitle" };
function classOf(el) {
    const attr = el?.openingElement?.attributes?.find((a) => a.type === "JSXAttribute" && a.name?.name === "className");
    return attr?.value?.type === "StringLiteral" ? attr.value.value : "";
}
function keyFor(parentEl, text, ancestors = []) {
    const tag = tagName(parentEl);
    // A styled fragment inside a heading ("We'll <span>map the system</span>").
    if (/^(span|strong|em|b|i|mark)$/.test(tag)) {
        const heading = [...ancestors].reverse().find((a) => HEADING_KEYS[tagName(a)]);
        if (heading) return unique(`${HEADING_KEYS[tagName(heading)]}Highlight`);
        if (/uppercase|tracking-\[?0?\.[12]/.test(classOf(parentEl))) return unique("eyebrow");
    }
    if (/^(span|p|div)$/.test(tag) && /uppercase/.test(classOf(parentEl)) && text.length < 48) return unique("eyebrow");
    if (TAG_KEYS[tag]) return unique(TAG_KEYS[tag]);
    if (/^[A-Z]/.test(tag) && /Button|Link|Cta/i.test(tag)) return unique("buttonText");
    const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim().split(/\s+/).slice(0, 3);
    const camel = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join("");
    return unique(/^[a-z]/.test(camel) ? camel : "text");
}
function camelOf(constant) {
    return constant.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

const SKIP_TAGS = new Set(["style", "script", "code", "pre", "title"]);

/* ---------------------------------------------------------------- plain-ness */

function literal(node) {
    if (!node) return undefined;
    if (node.type === "StringLiteral") return node.value;
    if (node.type === "NumericLiteral" || node.type === "BooleanLiteral") return node.value;
    if (node.type === "NullLiteral") return null;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
    if (node.type === "ArrayExpression") {
        const out = [];
        for (const el of node.elements) {
            const v = literal(el);
            if (v === undefined) return undefined;
            out.push(v);
        }
        return out;
    }
    if (node.type === "ObjectExpression") {
        const out = {};
        for (const p of node.properties) {
            if (p.type !== "ObjectProperty" || p.computed) return undefined;
            const k = p.key.name || p.key.value;
            const v = literal(p.value);
            if (v === undefined) return undefined;
            out[k] = v;
        }
        return out;
    }
    return undefined;
}

/* --------------------------------------------------------- tree conversion */

const hasPositionClass = (value) => /(^|\s)(relative|absolute|fixed|sticky)(\s|$)/.test(value);

function ensureRelative(el) {
    const attr = el.openingElement.attributes.find((a) => a.type === "JSXAttribute" && a.name?.name === "className");
    if (!attr) {
        insert(el.openingElement.name.end, ' className="relative"');
        return;
    }
    if (attr.value?.type === "StringLiteral") {
        if (!hasPositionClass(attr.value.value)) insert(attr.value.end - 1, " relative");
    } else {
        warn(attr.start, "className is an expression: make sure this element is positioned (relative) so the edit tools anchor to it");
    }
}

function childInsertPoint(el) {
    // right after the opening tag
    return el.openingElement.end;
}

// Static text and image/link attributes of one element. In a list, only
// attributes that read the ITEM are made editable (a literal repeated on every
// item is the same for all of them — it stays code).
function convertAttrs(el, ctx) {
    const tag = tagName(el);
    const attrs = el.openingElement.attributes;
    let linkPath = null; // an E.Link to add before the closing tag
    for (const a of attrs) {
        if (a.type !== "JSXAttribute" || !a.value) continue;
        const name = a.name?.name;
        const expr = a.value.type === "JSXExpressionContainer" ? a.value.expression : null;
        const lit = a.value.type === "StringLiteral" ? a.value.value : expr ? literal(expr) : undefined;
        const fp = expr ? fieldPath(expr, ctx) : null;

        // href / src that already read the block data or the list item
        if (fp && fp.parts.length) {
            const pathExpr = fp.root === "data" ? `"${fp.path}"` : `{\`${ctx.list.itemPrefix}.${fp.parts.join(".")}\`}`;
            if (name === "href" && !el.selfClosing && el.children.length) linkPath = pathExpr;
            if (name === "src" && /^(img|Image)$/.test(tag)) ctx.imageAfter = { el, path: pathExpr };
            continue;
        }

        if (ctx.list || typeof lit !== "string" || !lit.trim()) continue;

        if (name === "alt" && /^(img|Image)$/.test(tag)) {
            const key = ctx.nextImageKey ? `${ctx.nextImageKey}Alt` : unique("imageAlt");
            ctx.set(key, lit);
            edit(a.value.start, a.value.end, `{data.${key}}`);
            converted += 1;
        } else if (name === "src" && /^(img|Image)$/.test(tag) && !/^data:/.test(lit)) {
            const key = unique("image");
            ctx.set(key, lit);
            edit(a.value.start, a.value.end, `{data.${key}}`);
            ctx.imageAfter = { el, path: `"${key}"` };
            converted += 1;
        } else if (name === "href" && !/^(#|mailto:|tel:)/.test(lit) && !/^https?:\/\/(www\.)?(facebook|twitter|x|linkedin|instagram|youtube)\./.test(lit)) {
            if (!el.selfClosing && el.children.length) {
                const key = unique("linkHref");
                ctx.set(key, lit);
                edit(a.value.start, a.value.end, `{data.${key}}`);
                linkPath = `"${key}"`;
                converted += 1;
            } else {
                manual.push(`line ${lineOf(a.start)}: href="${lit}" on a self-closing element — make it a data field by hand`);
            }
        } else if (name === "href" && /^(mailto|tel):/.test(lit)) {
            manual.push(`line ${lineOf(a.start)}: ${lit} — contact details must come from SiteSettings.contact (R27)`);
        }
    }
    return linkPath;
}

const topCtx = {
    list: null,
    ancestors: [],
    imageAfter: null,
    set: (key, value) => {
        defaults[key] = value;
    },
    textTool: (key) => `<E.Text path="${key}" />`,
};

function convertJsx(node, ctx, parentEl = null) {
    if (node.type === "JSXFragment") {
        for (const child of node.children) handleChild(child, node, ctx);
        return;
    }
    const tag = tagName(node);
    if (SKIP_TAGS.has(tag)) return;
    const linkPath = convertAttrs(node, ctx);
    const image = ctx.imageAfter;
    ctx.imageAfter = null;
    ctx.ancestors = [...ctx.ancestors, node];
    for (const child of node.children) handleChild(child, node, ctx);
    ctx.ancestors = ctx.ancestors.slice(0, -1);
    if (linkPath && node.closingElement) {
        const hasLink = /E\.Link/.test(source.slice(node.start, node.end));
        if (!hasLink) insert(node.closingElement.start, `<E.Link path=${linkPath.startsWith("{") ? linkPath : linkPath} />`);
    }
    if (image && image.el === node) {
        const already = /E\.Image/.test(source.slice(parentEl?.start ?? node.start, parentEl?.end ?? node.end));
        if (!already) {
            insert(node.end, `\n${indentAt(node.start)}<E.Image path=${image.path} />`);
            warn(node.start, `<E.Image> was added after this image — its parent must be \`relative\``);
        }
    }
}

function handleChild(child, parentEl, ctx) {
    if (child.type === "JSXText") {
        const raw = child.value;
        if (!/[A-Za-z]{2,}/.test(raw)) return;
        if (ctx.list) {
            manual.push(`line ${lineOf(child.start)}: literal text "${raw.trim().slice(0, 40)}" inside a list item is the same for every item — keep it (cms-static) or make it a field`);
            return;
        }
        const lead = raw.match(/^\s*/)[0].length;
        const trail = raw.match(/\s*$/)[0].length;
        const text = raw.trim().replace(/\s+/g, " ");
        const key = keyFor(parentEl, text, ctx.ancestors);
        ctx.set(key, text);
        edit(child.start + lead, child.end - trail, ctx.textTool(key));
        converted += 1;
        return;
    }
    if (child.type === "JSXElement" || child.type === "JSXFragment") {
        convertJsx(child, ctx, parentEl);
        return;
    }
    if (child.type === "JSXExpressionContainer") handleExpression(child, parentEl, ctx);
}

// `data.a.b`, `data.list[0].x`, and `item.title` inside a list callback ->
// the path it stands for, or null for anything that is not a plain field read.
function fieldPath(node, ctx) {
    const parts = [];
    let n = node;
    while (n && n.type === "MemberExpression") {
        if (n.computed) {
            if (n.property.type === "NumericLiteral") parts.unshift(String(n.property.value));
            else return null;
        } else {
            parts.unshift(n.property.name);
        }
        n = n.object;
    }
    if (n?.type !== "Identifier") return null;
    if (n.name === "data") return { root: "data", path: parts.join("."), parts };
    if (ctx.list && n.name === ctx.list.itemVar) return { root: "item", parts };
    return null;
}
const NOT_TEXT = new Set(["length", "map", "filter", "join", "slice", "toString", "toFixed", "href", "link", "url", "image", "src", "icon"]);
function defaultAt(parts) {
    let v = existingDefaultsValue;
    for (const part of parts) {
        if (v == null || typeof v !== "object") return undefined;
        v = v[part];
    }
    return v;
}

function handleExpression(container, parentEl, ctx) {
    const expr = container.expression;
    if (!expr || expr.type === "JSXEmptyExpression") return;

    // {data.title} / {item.label} -> <E.Text path="…" />
    const fp = fieldPath(expr, ctx);
    if (fp && fp.parts.length && !NOT_TEXT.has(fp.parts[fp.parts.length - 1])) {
        if (fp.root === "data") {
            const known = defaultAt(fp.parts);
            if (known === undefined || typeof known === "string") {
                edit(container.start, container.end, `<E.Text path="${fp.path}" />`);
                converted += 1;
                return;
            }
        } else {
            const sample = fp.parts.reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), ctx.list.sample);
            if (sample === undefined || typeof sample === "string") {
                edit(container.start, container.end, `<E.Text path={\`${ctx.list.itemPrefix}.${fp.parts.join(".")}\`} />`);
                converted += 1;
                return;
            }
        }
    }
    if (ctx.list && expr.type === "Identifier" && expr.name === ctx.list.itemVar && (ctx.list.sample === undefined || typeof ctx.list.sample === "string")) {
        edit(container.start, container.end, `<E.Text path={\`${ctx.list.itemPrefix}\`} />`);
        converted += 1;
        return;
    }

    const lit = literal(expr);
    if (typeof lit === "string" && /[A-Za-z]{2,}/.test(lit) && !ctx.list) {
        const key = keyFor(parentEl, lit, ctx.ancestors);
        ctx.set(key, lit);
        edit(container.start, container.end, ctx.textTool(key));
        converted += 1;
        return;
    }

    // LIST.map(...) / data.list.map(...) / item.sub.map(...)
    if (expr.type === "CallExpression" && expr.callee?.type === "MemberExpression" && expr.callee.property?.name === "map") {
        if (convertList(container, expr, ctx)) return;
        manual.push(`line ${lineOf(container.start)}: a .map(...) this tool could not convert (not a module-level array or data list of plain fields) — wire it by hand`);
        return;
    }

    // `cond && <jsx/>`, `cond ? <a/> : <b/>` — convert the JSX inside.
    visit(expr, (n) => {
        if (n.type === "JSXElement" || n.type === "JSXFragment") {
            convertJsx(n, ctx, parentEl);
            return false;
        }
        if (n.type === "StringLiteral" && /[A-Za-z]{2,} [A-Za-z]{2,}/.test(n.value) && n !== expr && !ctx.list) {
            manual.push(`line ${lineOf(n.start)}: string "${n.value.slice(0, 50)}" inside an expression — if it is visible copy, move it into defaults by hand`);
        }
        return true;
    });
}

/* ------------------------------------------------------------------- lists */

function convertList(container, call, outerCtx) {
    const obj = call.callee.object;
    let sample;
    let basePath; // path template of the list ("items" or "stages.${i}.points")
    let toolPath; // value for the tools' path attribute
    let rename = null; // module array -> data.<key>
    const outer = outerCtx.list;

    const chain = fieldPath(obj, outerCtx);
    if (obj.type === "Identifier" && topArrays.has(obj.name) && !outer) {
        const value = literal(topArrays.get(obj.name));
        if (!Array.isArray(value) || !value.length) return false;
        const key = camelOf(obj.name);
        defaults[key] = { __ref: obj.name, value };
        sample = value[0];
        basePath = key;
        toolPath = `"${key}"`;
        rename = { node: obj, text: `data.${key}` };
    } else if (chain && chain.root === "data" && !outer) {
        basePath = chain.path;
        const list = defaultAt(chain.parts);
        sample = Array.isArray(list) ? list[0] : undefined;
        toolPath = `"${basePath}"`;
    } else if (chain && chain.root === "item" && outer) {
        const inner = chain.parts.reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), outer.sample);
        sample = Array.isArray(inner) ? inner[0] : undefined;
        basePath = `${outer.itemPrefix}.${chain.parts.join(".")}`;
        toolPath = `{\`${basePath}\`}`;
    } else {
        return false;
    }

    const cb = call.arguments[0];
    if (!cb || !/FunctionExpression|ArrowFunctionExpression/.test(cb.type)) return false;
    const [itemParam, indexParam] = cb.params;
    if (!itemParam || itemParam.type !== "Identifier") {
        manual.push(`line ${lineOf(call.start)}: .map callback destructures its item — rename the parameter to \`item\` and use item.field`);
        return false;
    }
    const itemVar = itemParam.name;
    const indexVar = indexParam?.type === "Identifier" ? indexParam.name : outer ? "j" : "i";
    if (!indexParam) {
        insert(itemParam.end, `, ${indexVar}`);
        const before = source.slice(Math.max(0, itemParam.start - 1), itemParam.start);
        if (cb.type === "ArrowFunctionExpression" && before !== "(") {
            insert(itemParam.start, "(");
            insert(itemParam.end, ")");
        }
    }
    if (rename) edit(rename.node.start, rename.node.end, rename.text);

    let itemRoot = null;
    if (cb.body.type === "BlockStatement") {
        const last = [...cb.body.body].reverse().find((st) => st.type === "ReturnStatement" && st.argument);
        let arg = last?.argument;
        if (arg?.type === "ParenthesizedExpression") arg = arg.expression;
        if (isJsx(arg)) itemRoot = arg;
    } else {
        itemRoot = cb.body.type === "ParenthesizedExpression" ? cb.body.expression : cb.body;
    }
    if (!itemRoot || itemRoot.type !== "JSXElement") {
        manual.push(`line ${lineOf(call.start)}: the .map callback does not return a single JSX element`);
        return false;
    }

    const itemPrefix = `${basePath}.\${${indexVar}}`;
    const listCtx = {
        ...outerCtx,
        list: { itemVar, indexVar, sample, itemPrefix },
        ancestors: [],
        imageAfter: null,
    };

    // keys -> the index
    visit(itemRoot, (n) => {
        if (n.type === "JSXAttribute" && n.name?.name === "key" && n.value?.type === "JSXExpressionContainer") {
            edit(n.value.start, n.value.end, `{${indexVar}}`);
            return false;
        }
        return true;
    });

    convertJsx(itemRoot, listCtx);

    ensureRelative(itemRoot);
    if (!itemRoot.selfClosing) insert(childInsertPoint(itemRoot), `\n${indentAt(itemRoot.start)}  <E.Item path=${toolPath} index={${indexVar}} />`);
    else warn(itemRoot.start, "list item root is self-closing — add <E.Item> by hand");
    insert(container.end, `\n${indentAt(container.start)}<E.Add path=${toolPath} label="Add item" />`);
    return true;
}

/* ----------------------------------------------------------------- run it */

if (root.type === "JSXFragment") {
    warn(root.start, "the component returns a fragment: {editButton} and `relative` need a root element — wrap it in one");
}
convertJsx(root, topCtx);

for (const st of component.body.body) {
    if (st !== finalReturn && st.type === "IfStatement" && /return/.test(source.slice(st.start, st.end))) {
        warn(st.start, "early return: the hidden guard is placed before the FINAL return only — check hooks order");
    }
}

if (root.type === "JSXElement" && !root.selfClosing) {
    ensureRelative(root);
    if (!/\beditButton\b/.test(source.slice(root.start, root.end))) insert(childInsertPoint(root), `\n${indentAt(root.start)}  {editButton}`);
}

// Hook + guard (an existing useCms call — e.g. from cms-migrate-legacy — is kept).
const hasHook = /\buseCms\(/.test(source);
if (!hasHook) {
    insert(component.body.start + 1, `\n  const { data, hidden, E, editButton } = useCms("${NAME}", defaults, { label: ${JSON.stringify(LABEL)} });`);
}
if (finalReturn && !/\bif \(hidden\)/.test(source)) insert(finalReturn.start, "if (hidden) return null;\n  ");

// defaults object: append to the existing one, or create it.
function printValue(value, indent) {
    return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}
const defaultLines = Object.entries(defaults).map(([key, value]) => {
    if (value && value.__ref) return `  ${key}: ${value.__ref},`;
    return `  ${key}: ${printValue(value, "  ")},`;
});
if (existingDefaults) {
    if (defaultLines.length) {
        const last = existingDefaults.properties[existingDefaults.properties.length - 1];
        const note = "  // added by cms-convert: copy that was hard-coded in the JSX\n";
        if (!last) {
            insert(existingDefaults.start + 1, `\n${note}${defaultLines.join("\n")}\n`);
        } else {
            const trailing = source.slice(last.end, existingDefaults.end).match(/^\s*,/);
            // after the existing trailing comma, or add one
            insert(last.end + (trailing ? trailing[0].length : 0), `${trailing ? "" : ","}\n${note}${defaultLines.join("\n")}`);
        }
    }
} else {
    const defaultsBlock = `\n// The ORIGINAL copy, verbatim (R9). Edited in place by admins; saved as drafts.\nconst defaults = {\n${defaultLines.join("\n")}\n};\n`;
    const componentStart = (() => {
        for (const node of ast.program.body) {
            if (node === component || node.declaration === component || (node.declarations || []).some((d) => d.init === component)) return node.start;
        }
        return component.start;
    })();
    insert(componentStart, defaultsBlock + "\n");
}

// Imports + directive
if (!/useCms/.test(source.split("\n").filter((l) => /^import /.test(l)).join("\n"))) {
    let importEnd = 0;
    for (const node of ast.program.body) if (node.type === "ImportDeclaration") importEnd = node.end;
    insert(importEnd, '\nimport { useCms } from "@/components/cms/useCms";');
}
if (!HAS_DIRECTIVE) insert(0, '"use client";\n\n');

// Apply edits (descending; same-position inserts keep their given order).
const ordered = edits
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => b.start - a.start || b.end - a.end || b.i - a.i);
let out = source;
for (const e of ordered) out = out.slice(0, e.start) + e.text + out.slice(e.end);

const report = [
    `${basename(path)} -> block "${NAME}"`,
    `  converted: ${converted} strings/links/images into ${Object.keys(defaults).length} new default field(s)`,
    ...warnings.map((w) => `  check:  ${w}`),
    ...manual.map((m) => `  manual: ${m}`),
    "  next:   review the diff, then `npm run check:inline` and a visual comparison.",
];
if (WRITE) {
    writeFileSync(path, out);
    console.error(report.join("\n"));
} else {
    process.stdout.write(out);
    console.error(report.join("\n"));
}
