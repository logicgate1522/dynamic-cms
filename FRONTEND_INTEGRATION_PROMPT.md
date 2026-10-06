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
2. Set `SITE_NAME` in `src/lib/brand.js` (or `NEXT_PUBLIC_SITE_NAME`).
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
each one, `npm run check:inline` must pass for that file.

**P4 — Forms (§5.4).**

**P5 — CMS pages and blog.** Catch-all route for CMS pages, using
`components/dynamic/DynamicContentPage.jsx` (ADAPT), which wraps the
server-rendered `DynamicPageRenderer` in `DynamicPageAdmin`. That gives admins
inline section editing, per-section AI, and the Page builder. Dynamic blog
posts work the same way with `kind="blog"`.

**P6 — Sitemap, robots, redirects.** `app/sitemap.js` builds from static routes,
`seo/`, `blog/` and `content/pages/`, honouring `sitemap.include:false` and
`robots.index:false`. `app/robots.js` reads `settings/site/`. The middleware
calls `redirects/resolve/?path=`. Add the static routes to
`SiteSettings.sitemap.extraPaths` so the backend sitemap report covers them.

**P7 — Seed.** A `scripts/seed-cms.mjs` that fills empty CMS rows: site
settings, **including the `ai` block (§6.3)**, form definitions, per-route
`seo/<path>/`, and `sitemap.extraPaths`. It must be idempotent and skip
non-empty rows unless `--force`.

**P8 — Verify.** Run the four checks in the Definition of done. Fix and rerun
until all four are green, then report the acceptance output verbatim.

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
   inside a `relative` parent. Put alt text in its own key.
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
10. Stateful UI such as accordions, carousels and search filters must keep
    working with editing on. Clicking editable text never triggers the parent
    link or toggle, because the kit stops propagation; Cmd/Ctrl-click follows
    the link.

---

## §4 — What the admin gets (the editing contract)

The kit already provides all of this. Your job is to keep it working on every
route:

- **Floating admin bar** (bottom centre; collapses behind "More" on phones):
  - Editing toggle, plus the Publish menu (this page / everything / discard,
    with a list of pending drafts).
  - **AI assist** (whole page) with a keyword-coverage badge.
  - **SEO** (when the route has `<PageSeo>`).
  - **Page builder** (on CMS pages).
  - **+ New page**, **Site tools** (settings, images, form inbox, blog,
    redirects, sitemap — the same panels as `/admin/*`), **Dashboard**, and an
    account menu with Sign out.
- **Inline:** click text and type. Enter ends a single-line field, Esc
  reverts, and paste is plain text. Item tools (↑ ↓ ⧉ ✕) appear on hover or
  focus. Images get "Replace image". Links get 🔗.
- **"All fields" pill** per block: tabs for All fields, **AI assist** (prompt
  → paste → preview → apply as draft), **JSON** (copy / paste / validate,
  normalised), and **History** (revisions, revert).
- **SEO panel** with tabs:
  - Essentials, with a snippet preview
  - Sharing & indexing
  - Advanced
  - Checks (jump to field)
  - **AI**: an SEO audit prompt and a keyword research prompt, each pasted
    back through `ai/normalize`
  - History
- **CMS pages**: hover tools per section (move, duplicate, delete, add above or
  below with a type picker, per-section AI, fields), plus the Page builder:
  - AI tab: build-prompt, then paste-to-edit as drafts
  - Images tab: required slots
  - Page tab: title, publish/unpublish, delete
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
- Admins create posts from **+ New page** (blog kind) or `/admin/blog`.

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
| GET | `ai/section-schema/` | public | Section types (sync `SECTION_REGISTRY`) |
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

## §7 — Paste to Build (new page from a brief)

In the UI: **+ New page** → brief → **Build prompt** (`ai/new-page-prompt/`) →
copy it to any AI chat → paste the reply → **Create draft page**
(`content/paste-to-build/`). The kit then:
- navigates to the new draft page
- lists required images (Page builder → Images)
- seeds page SEO from the reply

From code (agent-driven): build JSON valid against `ai/section-schema/` in the
shape `{title, page_type, seo:{title, description, keywords?}, sections:[{type, …fields}]}`,
then POST it as `raw`. Every image gets `image_required: true` plus a concrete
`image_prompt`. The page stays `draft` until required images exist and it is
published.

## §8 — Copy Structure (from a reference)

`GET ai/copy-structure-prompt/` → paste the reference into the AI → paste the
reply into **+ New page → Copy an existing page**. The AI must:
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

## §12 — Fill-in prompt

```
Integrate this frontend with dynamic-cms. Follow FRONTEND_INTEGRATION_PROMPT.md
exactly (rules R1–R12). Kit: dynamic-cms/frontend-kit.
Backend: <NEXT_PUBLIC_API_URL>   Site: <NEXT_PUBLIC_SITE_URL>
Do: <Autonomous mode | Input router for: <files> | Paste to Build: "<brief>">
Finish only when build + check:inline + check:sections + acceptance.mjs all pass;
paste the acceptance output in the report.
```

## §13 — Final checklist

- [ ] Kit installed verbatim; only the MANIFEST ADAPT files changed (R1)
- [ ] Root layout: `cms.css`, `AdminProvider`, `AdminBar`, `Analytics`; staff login link with `?next=`
- [ ] Every route: `generateMetadata` via `pageMetadata`, plus `<PageSeo>`
- [ ] Every section uses the §3 recipe; `check:inline` passes
- [ ] Registry matches the backend; `check:sections` passes
- [ ] Forms are definition-driven, with editable copy and a honeypot
- [ ] CMS pages and dynamic blog posts render through `DynamicPageAdmin`
- [ ] Sitemap and robots honour SEO flags; redirects run in middleware; `sitemap.extraPaths` seeded
- [ ] `SiteSettings.ai` seeded (brand voice, audience, location, page kinds, rules)
- [ ] Env: `REVALIDATE_SECRET` on both sides, `FRONTEND_REVALIDATE_URL`, CORS + CSRF trusted origins
- [ ] `next build` is clean; `acceptance.mjs` passes every check (output pasted in the report)
