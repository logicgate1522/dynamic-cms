# Frontend Integration Spec — dynamic-cms (v2)

You are the frontend integration agent for this CMS. This file is the whole
contract. Follow it exactly. Do not invent endpoints, fields, flows or UI
patterns that are not here, and do not "simplify" any rule. If something here
conflicts with your habits or with older docs, this file wins.

**Definition of done (no exceptions):** `next build` passes,
`node scripts/check-inline.mjs src` passes, `node scripts/check-sections.mjs`
passes, and `frontend-kit/acceptance/acceptance.mjs` passes **every** check
against the running production build. Until all four are green, the work is not
finished. Do not report success early.

---

## §0 — Non-negotiable rules

Every rule is a MUST. Rule numbers are referenced from the rest of the spec.

| # | Rule |
|---|---|
| R1 | **Install the frontend kit verbatim** (`frontend-kit/src` → the app's `src/`). Do not rewrite kit files, re-implement them, or hand-roll an alternative (no custom admin bar, no custom editor modal, no custom API client). Only the 4 ADAPT files in `frontend-kit/MANIFEST.md` may be changed, and only as the manifest says. |
| R2 | **Inline editing is the primary way to edit.** Every visible string in a CMS-wired component is `<E.Text path="…" />`. Every image has `<E.Image path="…" />`, every list item has `<E.Item>`, every list ends with `<E.Add>`, and every link's URL has `<E.Link>` beside its text. Panels and modals are secondary (the "All fields" pill, AI, JSON, History). Never build a "click Edit → modal form → Save/Cancel" flow as the main editing path. |
| R3 | **Drafts, then Publish.** Every edit (inline, panel, AI paste, JSON paste) autosaves as a draft (`?mode=draft`). Visitors only see what was published from the admin bar. Never write live data from an editor. |
| R4 | **Session cookie + CSRF auth only.** No tokens in `localStorage`/`sessionStorage`/cookies you set. `isAdmin` comes from `GET auth/session/`, never from client storage. All admin fetches go through `apiRequest`/`apiFetch` in `lib/api.js` (`credentials: "include"` + `X-CSRFToken`). |
| R5 | **The backend owns every AI prompt.** The frontend never contains prompt text. It calls the `ai/*-prompt/` and `content/<key>/build-prompt/` endpoints and shows the result in `<PromptBox>`. |
| R6 | **Every pasted AI or JSON reply goes through `POST ai/normalize/`** (or `paste-to-build` / `paste-to-edit`, which normalise server-side) before it touches content. Never `JSON.parse` a pasted AI reply yourself, and never write one straight into content. |
| R7 | **The backend webhook refreshes caches.** Public reads use `lib/cms.js` (ISR with `cms:*` tags), and `app/api/revalidate/route.js` verifies the HMAC webhook. The browser never calls revalidation. |
| R8 | **Visitors get zero CMS UI and zero CMS cost.** No admin markup, no `contentEditable`, no extra client fetches for visitors. Published HTML is server-rendered from `CmsSection`/`lib/cms.js`. |
| R9 | **Preserve 100% of design, animation and copy.** Current hard-coded copy becomes the `defaults` **verbatim**, so the page looks identical before anything is saved. |
| R10 | **Plain text only.** Never `dangerouslySetInnerHTML` for CMS or AI text. Multi-line text uses `<E.Text multiline />`, and paragraphs come from blank-line splits. |
| R11 | **Images are uploaded, never typed.** Use `uploadImage()` / `<E.Image>` / `SlotUpload`. No raw image-URL text inputs. |
| R12 | **Don't ask clarifying questions** unless an action is destructive or irreversible. Pick the default given here and state it in your report. |
| R13 | **Only collections are buildable from the site.** A *collection* is a set of pages that share ONE section structure and are listed on an index page (blog articles on /blog, services on /services, projects on /projects). Configure them in `SiteSettings.collections` (§6.3). "＋ New …" appears only on a collection's index page, and every entry uses the collection template. One-off pages (home, about, contact, legal…) are NOT collections: their structure is fixed, and admins edit copy, never layout. Never add a free-form "new page" or "page builder" button to the site. |
| R14 | **New entries must look exactly like their siblings.** A collection's `sections` must equal, in order, the section types of the existing detail pages. Blank entries copy the newest published sibling's fields and list lengths; AI entries are fitted to the template server-side. Never hand-design a new entry layout. |
| R15 | **Edit tools never cover the page.** Block pills, item tools, link 🔗 buttons, "＋ Add" buttons and "Replace image" chips are `cms-hover-tools`: hidden until their own block / item is hovered or focused (always shown on touch screens). The admin bar can be minimised. Never add an always-visible overlay on top of content. |
| R16 | **SEO and AI parity is fixed.** The SEO panel opens on **✦ Ask AI** with the audit prompt already built, shows the score bar on every tab, and lists all 18 checks (`lib/seoChecks.js`, mirroring `prompts.seo_rule_checks`) with a fix for each. The whole-page AI assist builds its prompt when opened, shows KEYWORD COVERAGE (%, sentence, a chip per section) and OTHER SEO RULES (6 rules, ✓/✕), stays live after Apply, and covers CMS-page sections too. Don't rebuild these UIs; they ship in the kit. |
| R18 | **Typing never loses focus.** Every list that contains editable fields is keyed by the map **index** (`key={i}`), never by the item's own text (`key={item.title}`, `` key={`${item.name}-${i}`} ``). A text-derived key changes on every keystroke, React re-creates the element and the cursor is gone. `check:inline` fails on it, and the acceptance test types into list fields and asserts the element is never re-created. The kit also restores focus if a re-mount ever happens, but that is a safety net, not permission. |
| R19 | **The site's server identifies itself.** Every server-side request to the CMS (`lib/cms.js`, `middleware.js`; the kit does both) sends `X-CMS-Frontend: <REVALIDATE_SECRET>`, so the one IP that renders every page isn't rate-limited as a single anonymous visitor. Never send this header from browser code or expose the secret through a `NEXT_PUBLIC_` variable. Staff sessions are also exempt from the general limits; login and form-spam limits always apply. |
| R20 | **Responsive on every screen.** Converting a section must keep its behaviour at every width: phones (≈390px), tablets (≈768px), laptops (≈1280px) and large screens (≥1920px — content stays inside a max-width container, nothing stretches edge to edge, type and images scale up sensibly). No horizontal scroll at any width. The admin UI is responsive too: on phones the bar collapses behind "More" and panels fit the screen. The acceptance test checks visitors and admins at 390px and 1920px. |
| R17 | **The admin UI is themed, not restyled.** Set the five `--cms-*` variables in `app/cms.css` to the site's palette. Never change admin markup, layout or wording to "match the site". Structure stays identical on every site. Pick shades with **≥4.5:1 contrast against white** (WCAG AA): admin buttons put white text on `--cms-accent`, and `--cms-accent-strong` is text on white. Darken the brand colour if needed; the acceptance test runs an axe contrast scan on the admin panels. |

---

## §1 — Modes

| Attached with this file… | Do this |
|---|---|
| A whole frontend repo, no other instruction | **§2 Autonomous mode**: all phases, in order. Report after each phase, then continue. |
| One or more specific files | **§5 Input router**, once per file, in dependency order (layout → pages → sections → forms → lists → blog). |
| A brief, screenshot or markup for a new page | **§7 Paste to Build** (from a brief) or **§8 Copy Structure** (from a reference). |
| One phase heading from §2 | Run only that phase, end green, stop. |

Framework: Next.js App Router (`src/app`), React 18+, Tailwind. On another
framework, map each concept (server components, `generateMetadata`, route
handlers) to its equivalent and say so in the report. Kit files assume the
`@/` alias → `src/`.

---

## §2 — Autonomous mode (whole repo)

Each phase ends green: build passes, no hydration warnings, public pages
unchanged.

**P0 — Audit (no code changes).** List the framework and version, router,
styling, every route, every section component and its hard-coded copy, lists,
images, links, forms, existing SEO/metadata and analytics. Output one table:
`file → what's hard-coded → useCms name → phase`.

**P1 — Install the kit (R1).**
1. Copy `frontend-kit/src/**` into `src/`. Do not overwrite site files that
   aren't in the manifest; if a path collides, stop and report it.
2. Set `SITE_NAME` in `src/lib/brand.js` (or `NEXT_PUBLIC_SITE_NAME`), and set
   the five `--cms-*` theme variables at the top of `src/app/cms.css` to the
   site's palette: accent = the site's primary action color, bar = its darkest
   brand surface (R17).
3. Copy `frontend-kit/scripts/check-inline.mjs` and `check-sections.mjs` to
   `scripts/` and add these npm scripts:
   `"check:inline": "node scripts/check-inline.mjs src"` and
   `"check:sections": "node scripts/check-sections.mjs"`.
4. Env (`.env.local`):
   `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`, `REVALIDATE_SECRET` (the same
   value as the backend). On the backend: `FRONTEND_REVALIDATE_URL=<site>/api/revalidate`,
   plus the site origin in `CORS_ALLOWED_ORIGINS` **and** `CSRF_TRUSTED_ORIGINS`.
5. Root layout (exact shape):
   ```jsx
   import "./globals.css";
   import "./cms.css";
   import { AdminProvider } from "@/components/cms/AdminProvider";
   import AdminBar from "@/components/cms/AdminBar";
   import Analytics from "@/components/seo/Analytics";
   // …site imports…
   export default async function RootLayout({ children }) {
     const settings = await getSiteSettings();               // lib/cms.js
     return (
       <html lang={(settings.seoDefaults?.locale || "en_US").split("_")[0]}>
         <body>
           <AdminProvider>
             {children}
             <AdminBar />
           </AdminProvider>
           <Analytics analytics={settings.analytics} />
         </body>
       </html>
     );
   }
   ```
   Keep every existing provider, font and wrapper. `generateMetadata` and
   `generateViewport` come from `settings/site/`, as in §5.1.
6. Add a footer link `Staff login {/* cms-static: admin entry point */}` →
   `/admin/login?next=<current path>` with `rel="nofollow"`. Use `usePathname`;
   on `/admin*` routes, link without `next`.

**P2 — Per-route metadata.** Every route: `generateMetadata()` =
`pageMetadata("/<path>")` (from `lib/seo.js`, which reads `seo/resolve/`), and
`<PageSeo path="/<path>" />` once in the page. That emits JSON-LD and gives
the admin bar its SEO button.

**P3 — Convert every section (§3 recipe).** One component per commit. After
each one, `npm run check:inline` must pass for that file, and the section
must still work at 390px, 768px, 1280px and 1920px (R20).

**P4 — Forms (§5.4).**

**P5 — Collections, CMS pages and blog.** First decide the collections (R13).
A page type IS a collection when there is an index page listing entries AND
(two or more detail pages share one section structure, OR it is a blog/news/
projects-style list that will grow). For each one:
1. Make every detail page a CMS page (`body_mode: "dynamic"`) rendered by the
   kit's renderer at `/<pathPrefix>/<slug>`, including its existing entries
   (seed them).
2. Configure it in `SiteSettings.collections` (§6.3, seeded in P7):
   - `sections` = the existing detail pages' section types, in order
   - `allowAdd` = `[]` for fixed layouts (service, project, location pages);
     body types (`rich_text`, `image_text`, `faq`, `cta`) only for long-form
     articles
   - `fields` = whatever the listing cards show that isn't a section
     (excerpt, category with its exact options, cover image)
   - `listingNote` = where admins must link a new entry from, when the index
     page doesn't list entries automatically
3. Make the index page list entries from the CMS when the site's design
   allows it (blog index: `GET blog/`; content collections:
   `GET content/pages/` filtered by prefix). Otherwise rely on `listingNote`.
4. One-off pages stay one-off: no collection, locked structure.

Then the catch-all route for CMS pages, using
`components/dynamic/DynamicContentPage.jsx` (ADAPT), which wraps the
server-rendered `DynamicPageRenderer` in `DynamicPageAdmin`. That gives admins
inline section editing, per-section AI, and (on collection entries) the collection panel. Dynamic blog
posts work the same way with `kind="blog"`.

**P6 — Sitemap, robots, redirects.** `app/sitemap.js` builds from static routes,
`seo/`, `blog/` and `content/pages/`, honouring `sitemap.include:false` and
`robots.index:false`. `app/robots.js` reads `settings/site/`. The middleware
calls `redirects/resolve/?path=`. Add the static routes to
`SiteSettings.sitemap.extraPaths` so the backend sitemap report covers them.

**P7 — Seed.** A `scripts/seed-cms.mjs` that fills empty CMS rows: site
settings, **including the `ai` and `collections` blocks (§6.3)**, form
definitions, per-route `seo/<path>/`, and `sitemap.extraPaths`. Without
`--force` it writes only the top-level settings blocks that are still empty. It must be idempotent and skip
non-empty rows unless `--force`.

**P8 — Verify.** Run the four checks in the Definition of done. Fix and rerun
until all four are green. Then walk the §13 checklist (one line per rule,
R1–R20) and report it ticked, together with the acceptance output verbatim.

---

## §3 — Section conversion recipe (exact)

Before:

```jsx
export default function Pricing() {
  return (
    <section className="py-20">
      <p className="eyebrow">Pricing</p>
      <h2>Simple, <span className="text-accent">fixed fees</span></h2>
      <img src="/pricing.jpg" alt="Calculator" />
      <ul>
        {[["Starter", "£49"], ["Growth", "£99"]].map(([name, price]) => (
          <li key={name}><h3>{name}</h3><p>{price}</p></li>
        ))}
      </ul>
      <a href="/contact" className="btn">Get a quote</a>
    </section>
  );
}
```

After:

```jsx
"use client";
import { useCms } from "@/components/cms/useCms";

// Module-level constant. The ORIGINAL copy, verbatim (R9).
const defaults = {
  eyebrow: "Pricing",
  title: "Simple,",
  titleHighlight: "fixed fees",
  image: "/pricing.jpg",
  imageAlt: "Calculator",
  plans: [
    { name: "Starter", price: "£49" },
    { name: "Growth", price: "£99" },
  ],
  buttonText: "Get a quote",
  buttonHref: "/contact",
};

export default function Pricing() {
  const { data, E, editButton } = useCms("pricing", defaults, { label: "Pricing" });
  return (
    <section className="relative py-20">
      {editButton}
      <p className="eyebrow"><E.Text path="eyebrow" /></p>
      <h2><E.Text path="title" /> <span className="text-accent"><E.Text path="titleHighlight" /></span></h2>
      <div className="relative">
        <img src={data.image} alt={data.imageAlt} />
        <E.Image path="image" />
      </div>
      <ul>
        {data.plans.map((plan, i) => (
          <li key={i} className="relative">
            <E.Item path="plans" index={i} />
            <h3><E.Text path={`plans.${i}.name`} /></h3>
            <p><E.Text path={`plans.${i}.price`} /></p>
          </li>
        ))}
        <E.Add path="plans" label="Add plan" />
      </ul>
      <a href={data.buttonHref} className="btn"><E.Text path="buttonText" /><E.Link path="buttonHref" /></a>
    </section>
  );
}
```

Rules:

1. `useCms(name, defaults, { label })`. `name` is kebab-case, unique, and
   descriptive (`home-hero`, `services-process`, `footer`). `defaults` is
   module-level. Shared blocks (header, footer, site-wide CTA) pass
   `excludeFromKeywordAudit: true`.
2. **Every** visible string → `<E.Text path>`. Text with line breaks →
   `multiline`. Split styled fragments into separate keys (`title` +
   `titleHighlight`). Never leave literal copy in JSX. `check:inline` enforces
   this. The only exceptions are marked `{/* cms-static: reason */}` (units,
   legal marks, the honeypot label, the staff-login link).
3. Every `<img>`/`next/image` → `src={data.x}` plus `<E.Image path="x" />`
   inside a `relative` parent. Put alt text in its own key. CSS background
   images use `style={{ backgroundImage: bgImage(data.x) }}` (`lib/bgImage.js`,
   the Next image optimiser), never a raw `url('/file.png')`. `check:inline`
   flags raw `url(`.
4. Every array: `<E.Item path index>` inside each item (the item gets
   `relative`), and `<E.Add path label>` after the list. Lists of plain strings
   work too (`path={`lines.${i}`}`).
5. Every link: `href={data.xHref}`, with `<E.Link path="xHref" />` directly after
   the link's `<E.Text>`.
6. Render `{editButton}` once at the top of the section root. The root must be
   `relative`.
7. **Subcomponents:** pass `data={{ ...data, E }}` and use `data.E.Text` inside.
   Never use a bare `E` in a function that didn't receive it.
8. Wrap server pages in `<CmsSection names={["pricing", …]}>`
   (`components/cms/CmsSection.jsx`), so visitors get server-rendered published
   content with no client fetch (R8).
9. Hard-coded arrays (icons and similar) stay in code. Only the copy moves into
   `defaults`. Pick an icon by index or with a `fields` select hint
   (`options.fields["plans[].icon"] = { type: "select", options: [...] }`).
10. **Keys:** any `.map(...)` that renders editable fields uses the index as
    the key (R18). Never use the item's text or a value an admin can edit.
11. Stateful UI such as accordions, carousels and search filters must keep
    working with editing on.
12. **Responsive (R20):** after converting, check the section at 390px,
    768px, 1280px and 1920px. Same behaviour as before, no horizontal scroll,
    and content held in its max-width container on large screens. Clicking editable text never triggers the parent
    link or toggle, because the kit stops propagation; Cmd/Ctrl-click follows
    the link.

---

## §4 — What the admin gets (the editing contract)

The kit already provides all of this. Your job is to keep it working on every
route:

- **Floating admin bar** (bottom centre; collapses behind "More" on phones;
  "–" minimises it to a small "CMS" pill in the corner):
  - Editing toggle, plus the Publish menu (this page / everything / discard,
    with a list of pending drafts).
  - **✦ AI assist** (whole page) with a live keyword-coverage badge.
  - **SEO** (when the route has `<PageSeo>`).
  - **＋ New <item>**, ONLY on a collection's index page. **<Item> settings**
    ONLY on a collection entry. Nothing on one-off pages.
  - **Site tools** (settings, images, form inbox, blog, redirects, sitemap —
    the same panels as `/admin/*`), **Dashboard**, and an account menu with
    Sign out.
- **Inline:** click text and type. Enter ends a single-line field, Esc
  reverts, and paste is plain text. Hover tools (R15): item tools (↑ ↓ ⧉ ✕),
  "＋ Add", 🔗 link editor, "Replace image", and the block's "All fields" pill.
- **"All fields" pill** per block: tabs for All fields, **AI assist** (prompt
  → paste → preview → apply as draft), **JSON** (copy / paste / validate,
  normalised), and **History** (revisions, revert).
- **SEO panel** — tabs in this order:
  - **✦ Ask AI** (the default tab): the audit prompt is pre-built with every
    field, the failing checks and their fixes, and the visible page text.
    "Find keywords" switches to the keyword-research prompt. Both are pasted
    back through `ai/normalize` and saved. A button leads on to the
    whole-page AI assist.
  - Essentials (with a snippet preview), Sharing & indexing, Advanced — each
    shows its failing-check count and offers Auto-fill for empty fields.
  - Checks: the 18 rules, with failing ones first, each showing its fix and
    jumping to its field.
  - History.
  - A score bar sits above the tabs on every tab.
- **Whole-page AI assist** (layout fixed by R16):
  - KEYWORD COVERAGE card: the % pill, "“kw” appears in N of M sections
    below.", and a chip per section (✓ green = has the keyword, grey =
    missing, dashed = shared block not counted)
  - OTHER SEO RULES: 6 ✓/✕ rules, plus "Open SEO panel" when any fail
  - the prompt (built on open), Copy, the paste box, and "Apply to every
    section (as drafts)"
  - the coverage card recomputes live from the page
- **Collection panel:**
  - **＋ New <item>**: a title, then either "Start from the template" (a blank
    draft that copies a sibling's layout) or "Write it with AI" (strict
    template prompt → paste → draft). Either way it opens the new draft.
  - **All <items>**: open, publish/unpublish, delete.
  - **This <item>** (on an entry): publish toggle, title, URL (a live rename
    adds a 301 redirect), configured fields, "Rewrite with AI" (applied as
    drafts and fitted to the template), and delete.
- **CMS pages:** inline editing, per-section ✦ AI / Fields / JSON. ↑ ↓ ＋ ✕
  appear only on collection entries whose `allowAdd` includes that section
  type.
- **Tooling hooks:** each editable span has `data-cms-block` (the useCms name,
  or `section:<id>`) and `data-cms-path`. The admin bar root has
  `data-cms-adminbar`. Don't remove them; the acceptance test depends on them.

---

## §5 — Input router

### 5.1 `layout.jsx`

Use §2 P1 step 5. `generateMetadata` reads `settings/site/`:
- `metadataBase` = `seoDefaults.siteUrl`
- `title.template` (`seoDefaults.titleTemplate`, which must contain `%s`)
- `title.default`, `description`
- `openGraph` (siteName, locale, default image 1200×630 + alt)
- `twitter`
- `robots`
- `verification`, from `verificationFrom()` in `lib/seo.js`

`generateViewport` returns `themeColor`. `<html lang>` comes from
`seoDefaults.locale`.

### 5.2 `page.jsx` for a route

- `export const generateMetadata = () => pageMetadata("/<path>", fallback)`,
  with the old static metadata as the fallback. Never delete good existing
  metadata.
- Render `<PageSeo path="/<path>" />` once.
- Wrap CMS sections in `<CmsSection names={[…]}>`.
- Listing pages use paginated reads (`{count,next,previous,results}`).
  CMS-page detail routes branch on `body_mode === "dynamic"` →
  `DynamicContentPage`.

### 5.3 A section component

Use the §3 recipe. Output the component, its `useCms` name, and its sample
`GET home/<name>/` shape (which equals `defaults`).

### 5.4 A form

- The definition lives in `home/form-<name>/` via `useCms`, with the default
  definition JSON as `defaults`. Fields render from `definition.fields`.
- Every visible string — headings, `submitText`, `successTitle`,
  `successMessage`, `resetText`, `privacyNote` — is `E.Text` on the definition.
- Include a hidden honeypot named `definition.honeypotField || "website"`.
- Submit with `POST forms/<name>/submit/`. Validate on the client for UX, but
  trust the server's `{errors:{field}}`.
- Seed the definition in P7.

### 5.5 Blog index / article

- **Index:** paginated `GET blog/`.
- **Article:** `generateMetadata` from `seo/resolve/blog/<slug>/`, JSON-LD from
  `resolved.jsonLd`.
  - `body_mode === "dynamic"` → the dynamic renderer inside
    `DynamicPageAdmin kind="blog"`.
  - Legacy bodies keep their existing pipeline.
- Admins create posts from **＋ New article** on the blog index (the blog collection) or from `/admin/blog`.

---

## §6 — Backend contract

### 6.1 Auth (session + CSRF)

```
GET  auth/csrf/                    -> {csrfToken}          (sets the session cookie)
POST auth/login/  {username|email, password, session: true}
     headers: X-CSRFToken           -> {authenticated: true, user}
GET  auth/session/                 -> {authenticated, user?}   (staff only = true)
POST auth/logout/                  (X-CSRFToken)
```

`lib/api.js` does all of this. Every admin call is
`apiRequest(path, {method, body})`, which adds `credentials:"include"` and
`X-CSRFToken`, and refreshes the token once on a CSRF 403. Public reads on the
server go through `lib/cms.js`. Token login (`{key}`, `Authorization: Token`)
exists only for scripts such as `seed-cms.mjs`; never use it in the browser.

Deployment: in production the session cookie is `SameSite=Strict`. Host the
API on the **same site** as the frontend (`api.example.com` +
`www.example.com`). For an API on another domain, set
`SESSION_COOKIE_SAMESITE=None` + `SESSION_COOKIE_SECURE=True` (HTTPS) on the
backend. Without one of these, login appears to succeed but every admin call
returns 403.

### 6.2 Endpoints

**Content (upsert, name-keyed).** `GET` of an unknown key returns `200 {}`.
`PATCH` deep-merges objects and replaces arrays.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `home/<name>/` | public | Published JSON (`?mode=draft` returns the admin's working copy) |
| PATCH/PUT/DELETE | `home/<name>/` | admin | `?mode=draft` writes `draft_data`; without it, writes live (scripts only) |
| GET | `home/<name>/history/` · POST `…/revert/<id>/` | admin | Revisions |
| GET | `home/schemas/` | public | ComponentSchema field contracts |

**Collections** (R13, R14).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `collections/` | admin | Every configured collection (with entry `count`) |
| GET | `collections/for-path/?path=` | admin | `{collection, role: "index"\|"entry"\|null, entry?}` for a site path |
| GET | `collections/<key>/entries/` | admin | Entries, newest first (drafts included) |
| POST | `collections/<key>/entries/` | admin | Body `{title, slug?, fields?, raw?}`: a blank template draft, or an AI reply (`raw`) fitted to the template |
| GET | `collections/<key>/prompt/?title&topic&slug&<brief>` | admin | Strict new-entry prompt: exact structure, a sibling as STYLE REFERENCE, field options, FINAL CHECK |
| GET | `collections/<key>/entries/<slug>/prompt/?instruction&strategy` | admin | Rewrite prompt for one entry |
| POST | `collections/<key>/entries/<slug>/apply/` | admin | Body `{raw}`: AI rewrite, fitted to the template, saved as drafts |
| PATCH/DELETE | `collections/<key>/entries/<slug>/` | admin | Body `{title?, slug?, status?, fields?}` (publish guard applies; renaming a live entry adds a 301) |

**Drafts.**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `drafts/` | admin | `{components:[{name}], hosts:[{kind,key,title,sections}], total}` |
| POST | `drafts/publish/` · `drafts/discard/` | admin | Body `{}` (everything) or a scope `{components:[…], hosts:[{kind,key}]}` |

**Settings and SEO.**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET/PATCH | `settings/site/` | public / admin | Site identity, SEO defaults, analytics, `ai`, `sitemap` (validated) |
| GET | `settings/site/schema/organization/` | public | Organization + WebSite JSON-LD |
| GET | `seo/` · GET/PATCH `seo/<path>/` | public / admin | Per-page SEO blob (home = `seo/home/`) |
| GET | `seo/resolve/` · `seo/resolve/<path>/` | public | Fully resolved metadata + JSON-LD (root = home) |
| GET/POST | `seo/analyze/<path>/` · GET `seo/analyze/` | admin | SEO audits |
| POST | `seo/validate-schema/` | admin | Validate pasted JSON-LD |
| GET | `seo/<path>/history/` · POST `…/revert/<id>/` | admin | SEO history |

**AI** (R5, R6).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `ai/section-schema/` | public | Section types (sync `SECTION_REGISTRY`), plus `starters`: placeholder content per type |
| GET | `ai/new-page-prompt/?title&topic&path&page_type&host_kind&sections&<brief>` | admin | New page prompt |
| GET | `content/<key>/build-prompt/?mode=create\|edit&strategy=expand\|override&<brief>` (and `blog/<slug>/…`) | admin | Prompt for an existing page |
| POST | `ai/section-prompt/` | admin | Body `{content, section_type?, label?, path?, fields?, keyword?, strategy?, instruction?}` — prompt for one block |
| POST | `ai/page-assist-prompt/` | admin | Body `{path, sections:{id:{label,content,excludeFromKeywordAudit?}}}` → `{prompt, audit}` |
| POST | `ai/seo-prompt/` | admin | Body `{path, page_text?}` → `{prompt, checks}` |
| POST | `ai/keyword-prompt/` | admin | Body `{path, page_text?, <brief>}` → `{prompt}` |
| POST | `ai/normalize/` | admin | Body `{kind: section\|page_assist\|seo\|keywords\|page, raw, current?, path?}` |
| GET | `ai/copy-structure-prompt/` | admin | Copy-structure prompt |

`<brief>` = `keyword, intent, location, audience, supporting, cta`.

What `ai/normalize/` does to a pasted reply:
- strips prose and code fences
- unwraps markdown links (whole-value and inline)
- unwraps a stray `{"content": …}` wrapper
- maps flat SEO keys onto the nested shape
- refuses list shrinkage (returns `warnings`)

It returns `400 {detail}` when the reply can't be used.

**CMS pages and sections.**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `content/paste-to-build/` | admin | Body `{raw, path?, page_type?}` → creates a draft page + sections + page SEO |
| POST | `content/<key>/paste-to-edit/` | admin | Body `{raw, as_draft: true}` — apply to an existing page (always `as_draft` from the UI) |
| GET/POST | `content/pages/` · GET/PATCH/DELETE `content/pages/<path>/` | public / admin | Pages (publish guard on `status:"published"`) |
| GET | `content/<key>/sections/` | public | Sections (admins also get `draft_content`) |
| PATCH | `content/<key>/sections/<id>/?mode=draft` | admin | Section draft |
| POST | `content/<key>/sections/add/` | admin | Body `{section_type, content, position?}` |
| POST | `…/sections/reorder/` | admin | Body `{order:[ids]}` |
| POST | `…/sections/<id>/media/<slot>/` | admin | Multipart upload into a slot |

Blog posts mirror all of these under `blog/<slug>/…`.

**Images, forms, redirects, sitemap.**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET/POST | `images/` (`?category&unused=1&missing_alt=1`) | public / admin | Library. Upload is multipart, auto-optimised to WebP, and deduplicated by checksum |
| GET/PATCH/DELETE | `images/<id>/` (`?force=1` to delete an image in use → otherwise 409) · GET `images/<id>/usage/` | public / admin | One image |
| POST | `forms/<name>/submit/` · GET `forms/<name>/submissions/` (+ `export/`) | public / admin | Forms |
| GET | `redirects/resolve/?path=` · CRUD `redirects/` · `redirects/io/` | public / admin | Redirects |
| GET | `sitemap/report/` | admin | Every URL the backend sitemap would list, plus why pages are excluded |
| GET | `/robots.txt`, `/sitemap.xml` (backend root) | public | Optional backend-served copies |

### 6.3 `SiteSettings.data` (validated)

```jsonc
{
  "organization": { "name", "legalName", "logo", "description", "sameAs": [] },
  "contact": { "email", "phone", "contactType", "availableLanguages": [] },
  "locations": [ { "name", "streetAddress", "addressLocality", "postalCode", "addressCountry",
                   "latitude": null, "longitude": null, "openingHours": [] } ],
  "seoDefaults": { "siteUrl", "titleTemplate": "%s | Site", "defaultTitle", "defaultDescription",
                   "defaultOgImage", "defaultOgImageAlt", "twitterHandle", "twitterCard",
                   "robots": { "index": true, "follow": true }, "themeColor", "locale": "en_US" },
  "verification": { "google", "bing", "yandex", "pinterest", "facebookDomain" },
  "analytics": { "gtmId", "ga4Id", "metaPixelId", "clarityId", "hotjarId", "linkedinPartnerId",
                 "customHead": [], "customBodyStart": [], "customBodyEnd": [] },
  "schema": { "organizationType": "Organization", "enabled": true },
  // Injected into EVERY AI prompt. Seed it (P7) — prompts are generic without it.
  "ai": {
    "brandVoice": "clear, warm, plain English",
    "audience": "who the site serves",
    "location": "default service area",
    "pageKinds": { "services": "Service page", "blog": "Blog article" },   // path prefix -> label
    "extraRules": ["House style rules, one per string"]
  },
  // R13 — pages admins can create from the site. Key = lowercase-hyphen id.
  "collections": {
    "services": {
      "label": "Service", "plural": "Services",
      "hostKind": "content",                 // "content" (ContentPage) | "blog" (BlogPost, one per site)
      "indexPath": "services",               // the listing page that shows "＋ New service"
      "pathPrefix": "services",              // entries live at /services/<slug>
      "pageType": "service",
      "sections": ["hero", "features", "steps", "rich_text", "faq", "cta"],   // = existing detail pages, in order
      "allowAdd": [],                        // [] = fixed layout
      "fields": {},                          // extra entry fields (see articles)
      "listingNote": "Link new services from the home Services cards."
    },
    "articles": {
      "label": "Article", "plural": "Articles", "hostKind": "blog",
      "indexPath": "blog", "pathPrefix": "blog", "pageType": "article",
      "sections": ["rich_text", "rich_text", "faq"],
      "allowAdd": ["rich_text", "image_text", "faq", "cta"],
      "fields": {
        "excerpt": { "label": "Excerpt", "type": "textarea" },          // model field on BlogPost
        "category": { "label": "Category", "options": ["News", "Guides"] },   // stored in content.category
        "coverImage": { "label": "Cover image", "type": "image", "category": "blog" }
      }
    }
  },
  "sitemap": {
    "extraPaths": ["/", "about", "contact"],          // static routes the CMS doesn't own
    "overrides": { "about": { "priority": 0.8, "changefreq": "monthly", "include": true } }
  }
}
```

### 6.4 `seo/resolve` precedence (hard rule)

`PageSEO.data` > `BlogPost.seo_*` (blog paths) > `SiteSettings.seoDefaults` >
built-in default. `generateMetadata` is a thin mapping of the response
(`lib/seo.js#metadataFromResolved`). Never re-implement precedence.

### 6.5 Revalidation webhook (R7)

On every committed write the backend sends:

```
POST <FRONTEND_REVALIDATE_URL>
X-CMS-Timestamp: <unix seconds>
X-CMS-Signature: sha256=<hex HMAC-SHA256(REVALIDATE_SECRET, "<timestamp>.<raw body>")>
{"tags": ["cms:home:footer", "cms:seo:about", …]}
```

Tags:
- `cms` — everything
- `cms:settings`
- `cms:home:<name>`
- `cms:seo`, `cms:seo:<path>` (home = `cms:seo:home`)
- `cms:blog`, `cms:blog:<slug>`
- `cms:pages`, `cms:page:<path>`
- `cms:redirects`

Every server read in `lib/cms.js` is tagged to match. The kit's route handler
rejects bad signatures and a clock skew over 5 minutes, and only revalidates
`cms*` tags.

### 6.6 Errors

- Validation: `400 {field: msg}` (settings), `400 {errors:{field}}` (forms),
  `400 {errors:[{section_index, message}]}` (pages).
- Publish guard: `400 {detail, missing:[{section_id, slot, image_prompt}]}`.
- Auth: `401`/`403`. CSRF failure: `403 {detail: "CSRF Failed…"}` (`apiFetch`
  retries once with a fresh token).
- Image in use: `409 {detail, usage}`.

---

## §7 — New entries (collections) and one-off pages

**On the site** (admins), on a collection's index page: **＋ New <item>** →
title → "Start from the template" or "Write it with AI". The AI prompt
(`collections/<key>/prompt/`) states:
- the exact section list and order
- a published sibling as the STYLE REFERENCE (match list lengths, depth and
  tone, but not its wording)
- the entry fields with their allowed options
- the brand voice and SEO principles
- a FINAL CHECK that repeats every hard rule

`POST collections/<key>/entries/` with the reply fits it to the template:
- missing slots get placeholders
- foreign types are dropped (with warnings)
- images are required only where siblings have them
- page SEO is seeded from the reply

**From code** (agent-driven), the same endpoint: build the reply JSON
`{title, seo:{title, description, keywords}, fields:{…}, sections:[{type, …}]}`
against the collection's `sections`, and POST it as `raw`.

**One-off pages** (rare; not collections) are created only from Dashboard →
Pages (`ai/new-page-prompt/` → `content/paste-to-build/`). Never from the
site.

## §8 — Copy Structure (from a reference)

`GET ai/copy-structure-prompt/` → paste the reference into the AI → paste the
reply into Dashboard → Pages → **Copy an existing page** (one-off pages are never built from the site; see R13). The AI must:
- keep headings, copy, list items and order **verbatim**
- map each visual block to the closest section type
- flag images

If the reference is one reusable component rather than a page, convert it with
the §3 recipe instead.

## §9 — Renderer contract

- `components/dynamic/registry.js` keys must equal
  `Object.keys(ai/section-schema.section_schema)`. `check:sections` enforces
  this.
- Unknown type → a dashed fallback box. Never crash and never drop content.
- **Adapters** (`sections.jsx`, `interactive.jsx`) are where site design lives.
  Restyle them to the site, but keep their editing hooks:
  - `T` for text (with `keyOf` from `media.js` for alias fields; `media.js` stays server-safe — never import a client module's plain functions into server adapters)
  - `ItemTools` / `AddItem` for lists
  - `SlotUpload` for images
  - `EditableParagraphs` for `content`
- Video `src` is allowlisted to YouTube/Vimeo embeds. Rich text = blank-line
  paragraphs (R10).

---

## §10 — Exhaustive SEO reference

Every item below has concrete Next App Router code expectations. When you build
a page, you are responsible for all of these.

### Metadata API

- `metadata` (static) vs `generateMetadata()` (dynamic, always used here since
  data comes from `seo/resolve`).
- `metadataBase` — set once in `layout` to `seoDefaults.siteUrl`; all relative
  OG/canonical URLs resolve against it.
- `title`: `{ template: "%s | Site", default: "Site" }` in layout;
  `{ absolute: resolved.fullTitle }` per page (the backend already applied the
  template, so use `absolute`).
- `alternates`: `{ canonical: resolved.canonical, languages: fromHreflang(resolved.hreflang),
  types: { "application/rss+xml": resolved.alternates.rss } }`. `x-default` in
  `languages` when present.
- `robots`: map every directive — `index`, `follow`, `nocache`, `googleBot:
  { index, follow, "max-snippet": resolved.robots.maxSnippet,
  "max-image-preview": resolved.robots.maxImagePreview,
  "max-video-preview": resolved.robots.maxVideoPreview }`,
  `unavailable_after` from `robots.unavailableAfter`.
- `openGraph`: `type` (`website` / `article` — from `resolved.social.ogType`),
  `locale`, `siteName`, `url` = canonical, `images: [{ url, width: 1200,
  height: 630, alt }]`; for articles add `publishedTime`, `modifiedTime`,
  `authors`, `section`, `tags`.
- `twitter`: `card` (`summary_large_image`), `site`, `creator`, `images`,
  `title`, `description`.
- `icons` / `manifest` / `appleWebApp`; `themeColor` + `colorScheme`;
  `verification` (google, other for bing/yandex/pinterest); `formatDetection:
  { telephone: false }` unless a phone CTA; `referrer`; `authors`/`creator`/
  `publisher`; `category`; pagination via `alternates` `prev`/`next` (App Router:
  emit `<link rel="prev/next">` manually in the page since `metadata` has no
  first-class field — use `other` or a raw `<link>`).

### Canonical strategy

Self-canonical by default (`canonicalSelf: true` in `PageSEO.data`).
Cross-domain, param, pagination, faceted-nav, trailing-slash, www/non-www,
http/https, uppercase, session-id: all normalise to one lowercased, no-param,
trailing-slash-consistent `https://` URL. The backend's `resolved.canonical`
already does this when `seoDefaults.siteUrl` is set — just render it.

### Structured data

Use `resolved.jsonLd` (`@graph`). It already composes: Organization/
LocalBusiness (+ multi-location + `openingHoursSpecification` + `geo` +
`areaServed`), WebSite (+ `SearchAction` when `searchUrl` set), BreadcrumbList
(matching URL depth), Article/BlogPosting family, Product+Offer+Review+
AggregateRating, Service, FAQPage, HowTo, Event, VideoObject, Person, plus any
raw JSON-LD from `PageSEO.data.schema.data` appended last. Nodes reference by
`@id`. Validate with `POST seo/validate-schema/` and Google's Rich Results
Test. `<` is already escaped. **Never mark up hidden or inaccurate content.**

### robots.txt & sitemaps

The backend serves `/robots.txt`, `/sitemap.xml`, `/sitemap-index.xml`,
`/sitemap-<section>.xml`. Either reverse-proxy those paths to the backend, or
mirror them in `app/robots.js` / `app/sitemap.js` from `seo/` + `blog/` +
`content/pages/`. `noindex` / `sitemap.include:false` pages are auto-excluded
by the backend. Respect the 50k-URL / 50MB split via the index. Staging: set
`seoDefaults.robots.index:false` → backend returns a full `Disallow: /`.
`X-Robots-Tag` header for non-HTML assets you control.

### hreflang / i18n

Reciprocal tags on every locale + `x-default`. Per-locale `generateMetadata`.
`Content-Language` header. Locale-prefixed routes. `resolved.hreflang` feeds
`alternates.languages`.

### Core Web Vitals

- **LCP**: `next/image` with `priority` on the hero, explicit `sizes`,
  `preconnect` to the image origin, no CLS from late images/fonts.
- **INP**: minimise client JS, `next/dynamic` for below-fold sections, avoid
  long tasks, defer third-party scripts (`strategy="lazyOnload"`).
- **CLS**: width/height on every image, `next/font` `display:"swap"` with a
  matched fallback, reserved height for embeds/ads/banners.
- **TTFB**: ISR (`revalidate`), edge where possible, streaming.
- Bundle budget; `next/font` self-hosting; `next/script` strategies
  (`beforeInteractive` / `afterInteractive` / `lazyOnload`).

### Rendering & indexability

SSG/ISR by default; `revalidate` per content type (site settings ~1h, pages
~5m, blog ~5m). `notFound()` → real 404. `redirect()` with the right code.
`loading.js` / `error.js` must not block the crawler from primary content.
Infinite scroll must have crawlable paginated `<a>` links underneath. Avoid
soft-404s (a "not found" body with a 200 status).

### On-page

One H1; logical heading outline, no skipped levels; `<title>` ~50–60;
meta description ~120–160, unique per page; semantic landmarks
(`<header><nav><main><footer>`); descriptive link text;
`rel="nofollow ugc sponsored"` where appropriate; `alt` on every content
image; `<figure>/<figcaption>`; tables with `<th scope>`; `lang`;
breadcrumb UI parity with the markup; internal-link depth ≤ 3; related-content
blocks; keyword in title/H1/first paragraph/URL/alt **without stuffing**;
`dateModified` freshness; E-E-A-T (author `Person` + `sameAs`, citations,
about/contact pages).

### URL design

Lowercase, hyphenated, shallow, stable, no dates unless semantically needed,
no params for primary content. On any URL change, add a `Redirect` row.

### Redirects

301 permanent / 302–307 temporary / 308 permanent-no-method-change. Chains ≤ 1
hop (backend rejects loops, walks ≤ 20). Update internal links after
redirecting. `middleware.js` calls `redirects/resolve/?path=` and issues the
returned `status`. Prefer `next.config` `redirects()` for build-time-known
rules, the runtime resolver for CMS-managed ones.

### Verification & analytics

GSC + Bing Webmaster via `settings/site/verification`. GA4/GTM via IDs
(`analytics`). Consent-mode note: gate non-essential tags behind consent.
UTM hygiene; `referrerPolicy`.

### Social / preview

OG image 1200×630, < 8MB, text in the safe area; per-page `ogImage`;
`og:image:alt` always; Twitter large card; LinkedIn/Slack/Discord unfurl uses
OG. Dynamic OG images: `app/<route>/opengraph-image.jsx` with `next/og` (pull
title/desc from `seo/resolve`).

### Feeds & discovery

RSS/Atom/JSON Feed route from `blog/`; declare in `alternates.types`.
IndexNow / WebSub optional. Google News / Merchant feeds via extra
`SITEMAP_SOURCES` on the backend.

### Accessibility ↔ SEO overlap

Contrast, focus order, ARIA only when native HTML can't express it, reduced
motion, semantic HTML first.

### Anti-patterns to actively remove

Keyword stuffing, hidden text, doorway pages, cloaking, duplicate
titles/descriptions, thin/auto content, orphan pages, broken canonicals,
`noindex` leaking to prod, render-blocking JS for primary content, layout
shift, intrusive interstitials, mixed content, infinite redirect chains,
unclosed/invalid JSON-LD, marking up invisible content.

### Per-page checklist (run before declaring a page done — mirrors `seo/analyze/`)

- [ ] `generateMetadata()` sourced from `seo/resolve/<path>/`, no hand-rolled precedence
- [ ] `<title>` present, 50–60 chars, unique across the site
- [ ] meta description present, 120–160 chars, unique
- [ ] canonical present, absolute, `https://`, self unless intentionally cross-page
- [ ] `robots` correct — not accidentally `noindex`
- [ ] exactly one H1; heading levels have no gaps
- [ ] every content image has meaningful `alt`
- [ ] OG title/description/image(1200×630)/image:alt all present; Twitter card valid
- [ ] JSON-LD `@graph` emitted, valid (`seo/validate-schema/` + Rich Results Test), `@type` matches page
- [ ] BreadcrumbList matches URL depth; breadcrumb UI parity
- [ ] internal links present; link text descriptive
- [ ] hreflang reciprocal + `x-default` (if multilingual)
- [ ] `rel=prev/next` on paginated routes
- [ ] no mixed content; no CLS; LCP image has `priority`
- [ ] included in sitemap (or intentionally `sitemap.include:false`)
- [ ] admin round-trip works (inline edit → draft → publish → visitor sees it); public view unchanged

---

## §11 — Anti-patterns (each one fails review)

- Rewriting, "improving" or re-implementing a kit file instead of installing it
  verbatim (R1).
- Stopping to ask about something this spec already decides (R12). Pick the
  stated default and note it in the report.
- A token in `localStorage`, or `isAdmin` derived from client storage (R4).
- A modal or "Edit mode → form → Save" as the main way to change copy (R2).
- An editor that writes live data, or a component with its own Save button (R3).
- Prompt text written in the frontend, or a paste box that `JSON.parse`s and
  writes directly (R5, R6).
- `revalidatePath`/`revalidateTag` called from the browser or from an editor (R7).
- Literal copy left in a CMS component without `cms-static` (R2, `check:inline`).
- Bare `E` used in a subcomponent (it must be `data.E`), or a client-only helper
  imported into a server component (this crashes prerender).
- Defaults that differ from the original copy, so the page changes before any
  edit (R9).
- Admin UI, `contentEditable` or extra fetches present for visitors (R8).
- `dangerouslySetInnerHTML` for CMS or AI text (R10). Image URL text inputs (R11).
- A "new page" / "page builder" button on the site, or section add / move /
  delete on one-off pages (R13).
- A collection entry whose layout differs from its siblings, or a collection
  `sections` list that doesn't match the existing detail pages (R14).
- Edit chrome that is always visible on top of content (R15).
- A list keyed by its own editable text, so fields lose focus after one
  keystroke (R18).
- Server-side CMS fetches without `X-CMS-Frontend`, or the secret in browser
  code (R19).
- A section that breaks, overflows or stretches edge to edge at phone or
  large-screen widths, or admin panels wider than a phone screen (R20).
- Visitors shown any admin markup, or extra client fetches for content
  (R8). Image URLs typed into text fields instead of uploaded (R11).
- A rebuilt or "simplified" SEO panel or whole-page assist: Ask AI not first,
  no score bar, fewer than 18 checks, coverage that is stale after Apply
  (R16).
- Admin colors hard-coded to the site instead of the `--cms-*` variables, or
  admin markup changed to match the site, or an accent colour too light for
  white text (R17).
- Writing AI prompt text on the client, or a prompt that doesn't end with its
  FINAL CHECK (prompts live only in `api/prompts.py`).

## §12 — Fill-in prompt

```
Integrate this frontend with dynamic-cms. Follow FRONTEND_INTEGRATION_PROMPT.md
exactly — every rule R1–R20, no exceptions. Kit: dynamic-cms/frontend-kit.
Backend: <NEXT_PUBLIC_API_URL>   Site: <NEXT_PUBLIC_SITE_URL>
Do: <Autonomous mode | Input router for: <files>>
Finish only when build + check:inline + check:sections + acceptance.mjs all pass,
then walk the §13 checklist line by line and paste it, ticked, with the
acceptance output in your report.
```

## §13 — Final checklist (every rule, one more time)

Walk this list before reporting. Every line must be true. Each line names the
gate that proves it; a line with no automatic gate is yours to verify by hand.

**The rules**
- [ ] **R1** The kit is installed verbatim; only the MANIFEST's ADAPT files changed. (review)
- [ ] **R2** Every visible string in a CMS component is `<E.Text>`; images, lists and links use `E.Image` / `E.Item` + `E.Add` / `E.Link`. No modal-first editing. (`check:inline`, acceptance "click-and-type")
- [ ] **R3** Every edit saves as a draft; only Publish makes it live. (acceptance "public data unchanged before publish")
- [ ] **R4** Session cookie + CSRF only; no token in browser storage. (acceptance "session cookie…")
- [ ] **R5** No prompt text in the frontend; prompts come from `ai/*` endpoints. (review: grep the frontend for prompt wording)
- [ ] **R6** Every pasted AI/JSON reply goes through `ai/normalize/` or a server paste endpoint. (acceptance "AI paste normalised")
- [ ] **R7** The webhook route is installed, and visitors see a publish without a rebuild. (acceptance "visitor HTML updated")
- [ ] **R8** Visitors get zero CMS UI and no extra content fetches. (acceptance "visitor: no admin bar")
- [ ] **R9** Defaults are the original copy, verbatim; the page looks identical before any edit. (review: compare screenshots)
- [ ] **R10** No `dangerouslySetInnerHTML` for CMS/AI text. (review: grep)
- [ ] **R11** Images are uploaded, never typed as URLs. (review)
- [ ] **R12** No clarifying questions were needed; defaults are stated in the report. (report)
- [ ] **R13** Collections are decided and seeded; "＋ New …" appears only on their index pages; one-off pages are structure-locked. (acceptance "collections…", "structure is locked")
- [ ] **R14** New entries follow the template exactly, like their siblings. (acceptance "new entry follows the collection template exactly")
- [ ] **R15** Edit tools are hover-only and never cover content; the bar minimises. (acceptance "edit tools are hidden…", "admin bar minimises")
- [ ] **R16** The SEO panel opens on Ask AI with its prompt built and shows 18 checks; the whole-page assist shows coverage %, chips and 6 rules, live after Apply. (acceptance SEO + AI assist checks)
- [ ] **R17** The `--cms-*` theme variables are set to the site palette, at ≥4.5:1 contrast with white. (acceptance "admin panels meet WCAG AA contrast")
- [ ] **R18** Lists with editable fields are index-keyed; typing never loses focus. (`check:inline`, acceptance "typing keeps focus" + "never re-created")
- [ ] **R19** `lib/cms.js` and `middleware.js` send `X-CMS-Frontend`; the secret never reaches the browser. (review; acceptance shows no 429s)
- [ ] **R20** Every page works at 390px, 768px, 1280px and 1920px with no horizontal scroll; admin panels fit a phone. (acceptance "responsive…")

**Also checked by the acceptance test**
- [ ] Exactly one `<h1>` in each page's HTML. Hidden mobile/desktop twins use `<div role="heading" aria-level={1}>` for the hidden copy.
- [ ] No critical accessibility violations for visitors (axe).
- [ ] CSS background images go through `bgImage()` (`lib/bgImage.js`), never raw `url('/big.png')`.

**Setup**
- [ ] Root layout: `cms.css`, `AdminProvider`, `AdminBar`, `Analytics`; staff login link with `?next=`
- [ ] Every route: `generateMetadata` via `pageMetadata`, plus `<PageSeo>`
- [ ] Registry matches the backend (`check:sections` passes)
- [ ] Forms are definition-driven, with editable copy and a honeypot
- [ ] CMS pages and dynamic blog posts render through `DynamicPageAdmin`
- [ ] Sitemap and robots honour SEO flags; redirects run in middleware; `sitemap.extraPaths` seeded
- [ ] `SiteSettings.ai` and `SiteSettings.collections` seeded
- [ ] Env: `REVALIDATE_SECRET` on both sides, `FRONTEND_REVALIDATE_URL`, CORS + CSRF trusted origins
- [ ] `next build` is clean; `acceptance.mjs` passes every check (output pasted in the report)
