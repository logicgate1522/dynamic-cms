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

   3. site-wide (every file): forms only via lib/forms (R24), tracking only via
      lib/track (R25), no dangerouslySetInnerHTML outside JsonLd (R10), no
      secret or X-CMS-Frontend in browser code (R19), no AI prompt wording
      (R5), no auth token in browser storage (R4), no hard-coded tel:/mailto:
      contact details (R27).

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
        else if (/\.(jsx|tsx|js|ts|mjs)$/.test(name)) files.push(path);
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

// Site-wide rules: forms and tracking each have ONE entry point.
const OWN = {
    forms: /lib\/forms\.(js|ts)$/,
    tracking: /lib\/(track|consent)\.(js|ts)$|components\/seo\/(Analytics(Events)?|ConsentedTags|VerifyHarness)\.(jsx|tsx)$/,
};
function siteWideRules(file, source, lines, report) {
    if (!OWN.forms.test(file)) {
        lines.forEach((line, i) => {
            if (/formsubmit\.co|\/forms\/[^"'`]*\/submit/.test(line) && !/cms-static/.test(line)) {
                report(i + 1, "form submitted directly — use submitForm() from @/lib/forms (stores the lead, emails it via FormSubmit, fires generate_lead)");
            }
        });
    }
    if (!OWN.tracking.test(file)) {
        lines.forEach((line, i) => {
            if (/\b(gtag|fbq|lintrk)\s*\(|\bttq\.(track|page)\(|dataLayer\.push\(|googletagmanager\.com|connect\.facebook\.net/.test(line) && !/cms-static/.test(line)) {
                report(i + 1, "tracking code outside lib/track.js / Analytics.jsx — use track(name, params) and the IDs in Settings → Tracking");
            }
        });
    }
}

// Rules that used to be "review by hand" (R4, R5, R10, R19), now automatic.
const SAFE_HTML = /components\/seo\/JsonLd\.(jsx|tsx)$/; // escaped JSON-LD only
const SERVER_SECRET_FILES = /lib\/cms\.(js|ts)$|middleware\.(js|ts)$|app\/api\/revalidate\/route\.(js|ts)$/;
function contractRules(file, source, lines, report) {
    const isClient = /^\s*["']use client["']/.test(source);
    lines.forEach((line, i) => {
        if (/cms-static/.test(line)) return;
        if (/dangerouslySetInnerHTML/.test(line) && !SAFE_HTML.test(file)) {
            report(i + 1, "dangerouslySetInnerHTML — CMS and AI text renders as plain text (R10); JSON-LD goes through <JsonLd>");
        }
        if (/NEXT_PUBLIC_\w*(SECRET|TOKEN|PASSWORD)/.test(line)) {
            report(i + 1, "secret exposed to the browser through a NEXT_PUBLIC_ variable (R19)");
        }
        if (/X-CMS-Frontend|REVALIDATE_SECRET/.test(line) && (isClient || !SERVER_SECRET_FILES.test(file))) {
            report(i + 1, "X-CMS-Frontend / REVALIDATE_SECRET outside lib/cms.js, middleware.js and the revalidate route (R19)");
        }
        if (/FINAL CHECK|Return ONLY|Respond (only )?with (valid )?JSON|You are an? (expert|senior|SEO|copywriter|content)/i.test(line)) {
            report(i + 1, "AI prompt wording in the frontend — prompts come from the backend ai/* endpoints (R5)");
        }
        if (/["'`](?:tel|mailto):[^"'`${}\s]+["'`]/.test(line)) {
            report(i + 1, "hard-coded tel:/mailto: link — contact details come from SiteSettings.contact or CMS content, and only when the owner publishes them (R27)");
        }
        if (/(local|session)Storage\.setItem\(\s*[^,]*(token|auth|csrf|jwt|session)/i.test(line) || /document\.cookie\s*=.*(token|auth)/i.test(line)) {
            report(i + 1, "auth token in browser storage — session cookie + CSRF only (R4)");
        }
        // R32: visitor data is stored only by the consent-aware kit modules.
        if (/\b(localStorage|sessionStorage)\.setItem\(|document\.cookie\s*=/.test(line) && !VISITOR_STORAGE_OK.test(file)) {
            report(i + 1, "visitor data stored outside lib/consent.js / lib/intentProfile.js — storage needs consent (R32)");
        }
        // R33: a marketing opt-in is never pre-ticked.
        if (/consent_marketing/.test(line) && /(default|checked)\s*[:=]\s*\{?\s*true/.test(line)) {
            report(i + 1, "marketing opt-in pre-ticked — it must start unticked (R33)");
        }
    });
}

// Files that may store visitor state (consent, the intent profile) or admin
// conveniences (edit mode, drafts) — everything else must not (R32).
const VISITOR_STORAGE_OK = /lib\/(consent|intentProfile|forms|api)\.(js|ts)$|components\/(cms|admin)\/|components\/seo\/(AnalyticsEvents|ConsentedTags|VerifyHarness)\.(jsx|tsx)$/;

// A form must say which form it is (data-cms-form), so starts, errors and
// abandons are tracked against it (R31).
function formRules(file, source, lines, report) {
    if (!/submitForm\s*\(/.test(source) || OWN.forms.test(file)) return;
    lines.forEach((line, i) => {
        if (/<form\b/.test(line) && !/data-cms-form/.test(`${line}${lines[i + 1] || ""}${lines[i + 2] || ""}`)) {
            report(i + 1, "<form> without data-cms-form=\"<name>\" — tracking can't attribute starts and abandons (R31)");
        }
    });
}

// A block must render {editButton} inside its root: admins get the block's
// tools (R30), visitors a hidden marker that tells tracking which block a
// click or view belongs to (R31).
function editButtonRule(ast, source, report) {
    visit(ast.program, (node) => {
        if (!/Function/.test(node.type) || node.body?.type !== "BlockStatement") return;
        const body = node.body.body;
        const callsUseCms = body.some((stmt) => stmt.type === "VariableDeclaration" && stmt.declarations.some((d) => d.init?.type === "CallExpression" && d.init.callee?.name === "useCms"));
        if (!callsUseCms) return;
        const last = [...body].reverse().find((stmt) => stmt.type === "ReturnStatement");
        if (!last?.argument || /ObjectExpression|CallExpression|Identifier/.test(last.argument.type)) return;
        const text = source.slice(node.body.start, node.body.end);
        if ((text.match(/\beditButton\b/g) || []).length < 2) report(node.loc.start.line);
    });
}

// A component that renders a useCms block must honour `hidden`
// (if (hidden) return null;) — otherwise "Hide" does nothing for visitors.
function hiddenGuard(ast, source, report) {
    visit(ast.program, (node) => {
        if (!/Function/.test(node.type) || node.body?.type !== "BlockStatement") return;
        const body = node.body.body;
        const callsUseCms = body.some((stmt) => stmt.type === "VariableDeclaration" && stmt.declarations.some((d) => d.init?.type === "CallExpression" && d.init.callee?.name === "useCms"));
        if (!callsUseCms) return;
        const last = [...body].reverse().find((stmt) => stmt.type === "ReturnStatement");
        if (!last?.argument || /ObjectExpression|CallExpression|Identifier/.test(last.argument.type)) return; // a hook, not a component
        if (!/\bhidden\b/.test(source.slice(node.body.start, node.body.end))) report(node.loc.start.line);
    });
}

// Every list a block owns must be fully editable: item tools (E.Item: move,
// hide, duplicate, remove) and "+ Add" (E.Add) — reviews, cards, steps,
// links… (R2, R30). Lists nested one level inside items count too
// (e.g. features[].benefits). Mark a deliberately fixed list with a
// "cms-fixed-list: reason" comment on its key.
function listRules(ast, source, report) {
    const arrays = new Map(); // const name -> ArrayExpression
    visit(ast.program, (node) => {
        if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init?.type === "ArrayExpression") arrays.set(node.id.name, node.init);
    });
    const defaultsNames = new Set();
    visit(ast.program, (node) => {
        if (node.type === "CallExpression" && node.callee?.name === "useCms" && node.arguments[1]?.type === "Identifier") defaultsNames.add(node.arguments[1].name);
    });
    visit(ast.program, (node) => {
        if (node.type !== "VariableDeclarator" || !defaultsNames.has(node.id?.name) || node.init?.type !== "ObjectExpression") return;
        for (const prop of node.init.properties) {
            if (prop.type !== "ObjectProperty") continue;
            const key = prop.key?.name || prop.key?.value;
            const arr = prop.value.type === "ArrayExpression" ? prop.value : prop.value.type === "Identifier" ? arrays.get(prop.value.name) : null;
            if (!key || !arr || !arr.elements.length) continue;
            const comments = [...(prop.leadingComments || []), ...(prop.trailingComments || [])].map((c) => c.value).join(" ");
            const line = source.slice(0, prop.start).split("\n").length;
            const prevLine = source.split("\n")[line - 2] || "";
            if (/cms-fixed-list/.test(comments) || /cms-fixed-list/.test(prevLine)) continue;
            const pathRe = (tool) => new RegExp(`(?:\\bE|data\\.E)\\.${tool}\\b[^>]*path=(?:"${key}"|\\{\\s*["'\`]${key}["'\`]\\s*\\})`);
            if (!pathRe("Item").test(source)) report(line, `list “${key}” has no <E.Item path="${key}" …/> — items can't be moved, hidden or removed`);
            if (!pathRe("Add").test(source)) report(line, `list “${key}” has no <E.Add path="${key}" /> — items can't be added`);
            // One level down: arrays inside the list's object items.
            const sample = arr.elements.find((el) => el?.type === "ObjectExpression");
            for (const inner of sample?.properties || []) {
                const innerKey = inner.key?.name || inner.key?.value;
                if (inner.value?.type !== "ArrayExpression" || !inner.value.elements.length) continue;
                const innerComments = (inner.leadingComments || []).map((c) => c.value).join(" ");
                if (/cms-fixed-list/.test(innerComments)) continue;
                const nested = (tool) => new RegExp(`(?:\\bE|data\\.E)\\.${tool}\\b[^>]*path=\\{\\s*\`${key}\\.\\$\\{[^}]+\\}\\.${innerKey}\`\\s*\\}`);
                if (!nested("Item").test(source) || !nested("Add").test(source)) {
                    report(line, `nested list “${key}[].${innerKey}” needs E.Item and E.Add (path={\`${key}.\${i}.${innerKey}\`})`);
                }
            }
        }
    });
}

let problems = 0;
let scanned = 0;
for (const file of files) {
    const source = readFileSync(file, "utf8");
    const relativePath = relative(process.cwd(), file);
    {
        const lines = source.split("\n");
        siteWideRules(file, source, lines, (line, message) => {
            problems++;
            console.log(`${relativePath}:${line}  ${message}`);
        });
        contractRules(file, source, lines, (line, message) => {
            problems++;
            console.log(`${relativePath}:${line}  ${message}`);
        });
        formRules(file, source, lines, (line, message) => {
            problems++;
            console.log(`${relativePath}:${line}  ${message}`);
        });
    }
    if (!/\.(jsx|tsx)$/.test(file)) continue;
    const usesCms = /import\s*\{[^}]*\buseCms\b[^}]*\}\s*from/.test(source);
    const usesSectionEdit = /from\s+["']@\/components\/dynamic\/edit-context["']/.test(source);
    if (!usesCms && !usesSectionEdit) continue;
    scanned++;
    const lines = source.split("\n");
    const ast = parser.parse(source, {
        sourceType: "module",
        plugins: ["jsx", ...(file.endsWith(".tsx") ? ["typescript"] : [])],
    });
    listRules(ast, source, (line, message) => {
        problems++;
        console.log(`${relative(process.cwd(), file)}:${line}  ${message}`);
    });
    editButtonRule(ast, source, (line) => {
        problems++;
        console.log(`${relative(process.cwd(), file)}:${line}  CMS block renders no {editButton} — put it first inside the block's root (admin tools R30, tracking marker R31)`);
    });
    hiddenGuard(ast, source, (line) => {
        problems++;
        console.log(`${relative(process.cwd(), file)}:${line}  CMS component ignores \`hidden\` — add  if (hidden) return null;  before its final return`);
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
    console.log("Lists → every list a block owns needs <E.Item> (on each item) and <E.Add> (after the list), or a cms-fixed-list comment.");
    console.log("Forms → submitForm() from @/lib/forms. Tracking → track() from @/lib/track. Hide → if (hidden) return null.");
    process.exit(1);
}
console.log(`check-inline: OK — ${scanned} CMS component file(s): no hard-coded copy, no text-derived list keys, hidden honoured; forms and tracking use their helpers; no unsafe HTML, client secrets, prompt text or stored tokens.`);
