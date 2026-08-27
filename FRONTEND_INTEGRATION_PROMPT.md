# Frontend Integration Prompt — Universal Dynamic CMS + SEO Backend

You are an autonomous frontend implementation agent. This file is self-contained:
every endpoint, header, field name, precedence rule, and code pattern you need is
below. Do not invent anything not in this document.

---

## §13.0 — How this document behaves

Decide your mode from what was attached alongside this file:

| Attached with… | Do this |
|---|---|
| A whole frontend repo / codebase, no other instruction | **Autonomous mode — §13.1**. Run the 10 phases in order. Stop after each phase, report, wait. |
| One or more specific files (`layout.js`, a `page.js`, a component, a form, a blog page, a listing page) | **Input router — §13.2**, once per file, in dependency order: layout → pages → sections → forms → lists → blog → redirects. |
| A natural-language request ("build this landing page", "make this editable") or pasted screenshot / markup | **Paste to Build — §13.3** (from a brief) or **Copy Structure — §13.4** (from an existing reference). |
| A single phase heading from §13.1 | Execute only that phase, end green, stop. |

**Never ask clarifying questions unless the action is destructive or irreversible.**
Prefer sensible defaults and state them in your report.

**Framework assumption:** Next.js App Router (`app/`). If the repo is Pages Router,
Vite/React, Remix, SvelteKit, etc., map the concepts (server-side metadata,
server components, route params) to that framework's equivalents and say so.

---

## §13.6 — Backend contract (verbatim, self-contained)

### Base URL & auth

- API base: `process.env.NEXT_PUBLIC_API_URL` + `/api/` (e.g. `https://cms.example.com/api/`).
- Auth header is literally **`Authorization: Token <key>`** — **never `Bearer`**.
- Get a token: `POST auth/login/` `{email, password}` → `{"key": "<token>"}`.
  Only `is_staff` accounts succeed. Throttled (`login` scope, 10/min).
- **`isAdmin` = `!!localStorage.getItem("authToken")`**, and it **must be read
  inside `useEffect` only** — never during render or SSR (hydration mismatch).
- Store the token as `localStorage.authToken` after login.

```js
// lib/api.js
export const API = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000") + "/api";

export function authHeaders() {
  const t = typeof window !== "undefined" ? localStorage.getItem("authToken") : null;
  return t ? { Authorization: `Token ${t}` } : {};
}

export async function apiGet(path, opts = {}) {
  const r = await fetch(`${API}/${path}`, { cache: "no-store", ...opts });
  if (!r.ok && r.status !== 404) throw new Error(`${path} -> ${r.status}`);
  return r.status === 404 ? {} : r.json();
}
```

### Two URL-shape rules

1. **Name/path-keyed, upsert-safe** — `home/<name>/`, `settings/site/`,
   `seo/<path>/`. `GET` on an unknown key returns **`200 {}`** (never 404).
   First `PATCH` creates the row. `PATCH` **deep-merges objects key-by-key;
   arrays replace wholesale.**
2. **Normal REST collections** — `blog/`, `redirects/`, `images/`,
   `content/pages/`, sections, form submissions. Standard `id`/`slug`
   semantics, `{count, next, previous, results}` pagination on lists.

### Full endpoint table

| Method | Path | Auth | Shape | Purpose |
|---|---|---|---|---|
| POST | `auth/login/` | public | — | `{email,password}` → `{key}` |
| GET | `home/<name>/` | public | keyed | Component JSON; `{}` if unset. `?mode=draft` for the working copy (admin) |
| PATCH/PUT/DELETE | `home/<name>/` | admin | keyed | Upsert content. `?mode=draft` writes `draft_data`. Body may include `schema_key` |
| GET | `home/schemas/` | public | — | All `ComponentSchema` field contracts |
| GET | `home/<name>/history/` | admin | — | Last 20 revisions |
| POST | `home/<name>/publish/` | admin | — | Copy `draft_data` → live `data` |
| POST | `home/<name>/revert/<revId>/` | admin | — | Restore a revision (non-destructive) |
| GET | `settings/site/` | public | keyed | Site-wide identity, SEO defaults, analytics, verification |
| PATCH | `settings/site/` | admin | keyed | Deep-merged; validated (see §13.6 shape) |
| GET | `settings/site/schema/organization/` | public | — | Computed Organization/LocalBusiness + WebSite JSON-LD |
| GET | `seo/` | public | list | All `PageSEO` rows (sitemaps, audits) |
| GET/PATCH | `seo/<path>/` | public / admin | keyed | Per-page SEO blob |
| GET | `seo/<path>/history/` | admin | — | Last 20 SEO change snapshots |
| POST | `seo/<path>/revert/<histId>/` | admin | — | Restore an SEO snapshot |
| GET | `seo/resolve/<path>/` | public (cached) | — | **Fully-resolved metadata + JSON-LD @graph. Use this in `generateMetadata()`.** |
| GET/POST | `seo/analyze/<path>/` | admin | — | Run + persist an SEO audit. POST `{html, url}` adds live-DOM checks |
| GET | `seo/analyze/` | admin | — | Site-wide roll-up, worst pages first |
| POST | `seo/validate-schema/` | admin | — | `{schema}` → `{valid, issues}` for pasted JSON-LD |
| GET | `ai/section-schema/` | public | — | `SECTION_SCHEMA` — sync your `SECTION_REGISTRY` against this |
| GET | `ai/dynamic-page-prompt/?sections=hero,faq` | admin | — | Copy-paste AI prompt to generate page JSON |
| GET | `ai/copy-structure-prompt/` | admin | — | Copy-paste AI prompt to reproduce a pasted page |
| POST | `content/paste-to-build/` | admin | — | `{raw, path?, page_type?}` → creates host + sections + pending media |
| GET | `content/pages/` | public | list | Visible `ContentPage`s |
| POST | `content/pages/` | admin | REST | Create a `ContentPage` |
| GET/PATCH/DELETE | `content/pages/<path>/` | public / admin | REST | One page (+ its `sections` on GET). PATCH `status:"published"` enforces the publish guard |
| GET | `content/<path>/sections/` | public | list | Ordered published sections |
| POST | `content/<path>/sections/` | admin | — | Replace the whole section list (atomic, validated) |
| PATCH/DELETE | `content/<path>/sections/<id>/` | admin | REST | One section |
| POST | `content/<path>/sections/reorder/` | admin | — | `{order:[id,…]}` — must be exactly this page's ids |
| POST | `content/<path>/sections/<id>/media/<slot>/` | admin | multipart | Upload one image into a slot |
| GET/POST/PATCH/DELETE | `blog/` , `blog/<slug>/` | public / admin | REST | Blog posts. Drafts + future `published_at` hidden from non-admins |
| GET…POST | `blog/<slug>/sections/…` | same as `content/…/sections/` | — | Identical section surface bound to a `BlogPost` |
| GET | `images/?category=&unused=1&missing_alt=1` | public | list | Image library + SEO-cleanup filters |
| POST | `images/` | admin | multipart | Upload. Returns existing row + `duplicate:true` on checksum match |
| GET/PATCH/DELETE | `images/<id>/` | public / admin | REST | One image |
| GET | `images/<id>/usage/` | admin | — | Back-references |
| GET | `forms/<name>/submit/` … POST | public | — | Submit. Validated against `home/form-<name>/`. `{errors:{field}}` on 400 |
| GET | `forms/<name>/submissions/?is_read=&is_spam=&since=` | admin | list | Submissions |
| GET | `forms/<name>/submissions/export/?format=csv\|json` | admin | — | Export |
| PATCH | `forms/<name>/submissions/<id>/` | admin | — | Toggle `is_read` / `is_spam` |
| GET | `redirects/`, `redirects/<id>/` | public / admin | REST | Redirect rules |
| GET | `redirects/resolve/?path=/old` | public (cached) | — | `{to, status}` or 404 — call from middleware / not-found |
| GET/POST | `redirects/io/?format=csv` | admin | — | CSV export / import |
| GET | `/robots.txt`, `/sitemap.xml`, `/sitemap-index.xml`, `/sitemap-<section>.xml` | public | — | Served by the backend at its own root (proxy or link to them) |

### Image upload snippet (the only correct way)

```js
async function uploadImage(file, category = "content") {
  const fd = new FormData();
  fd.append("image", file);
  fd.append("category", category);
  const r = await fetch(`${API}/images/`, {
    method: "POST",
    headers: authHeaders(),          // NO Content-Type — the browser sets the multipart boundary
    body: fd,
  });
  const data = await r.json();       // { id, image_url, width, height, duplicate, ... }
  return data.image_url;             // always absolute
}
```

Never give an admin a raw image-URL text field. Upload first, store the returned
`image_url`.

### `seo/resolve/<path>/` precedence — HARD RULE

```
PageSEO.data  >  BlogPost.seo_*  (blog/<slug> paths only)  >  SiteSettings.data.seoDefaults  >  built-in default
```

`generateMetadata()` must be a **thin mapping** of the resolve response — never
re-implement this precedence per project. Response shape:

```jsonc
{
  "path": "pricing",
  "fullTitle": "Pricing | Acme",        // titleTemplate already applied
  "title": "Pricing",
  "description": "...",
  "canonical": "https://acme.test/pricing",
  "robots": { "index": true, "follow": true, "maxImagePreview": "large", ... },
  "social": { "ogTitle", "ogDescription", "ogImage", "ogImageAlt", "ogType",
              "twitterCard", "twitterTitle", "twitterDescription", "twitterImage", "twitterHandle" },
  "hreflang": [{ "lang": "en", "href": "..." }],
  "alternates": { "amp": "", "rss": "" },
  "prev": "", "next": "",
  "locale": "en_US",
  "themeColor": "#0b0b0b",
  "verification": { "google": "", "bing": "", ... },
  "jsonLd": { "@context": "https://schema.org", "@graph": [ ... ] }   // '<' already escaped
}
```

### Error shapes

- Field validation: `400 { "<field>": "message" }` (settings, component schema)
  or `400 { "errors": { "<field>": "message" } }` (forms) or
  `400 { "errors": [ { "section_index": 0, "message": "…" } ] }` (paste-to-build).
- Publish guard: `400 { "detail": "...", "missing": [ { section_id, slot, image_prompt } ] }`.
- Auth: `401` (no/invalid token), `403` (valid token, not staff).

### Section schema & the publish guard

- `GET ai/section-schema/` returns `{ section_schema, single_image_types,
  per_item_image_types, recommended_sizes }`. `section_schema` maps every
  section `type` → `{ field: "required" | "optional" | "required_list" }`.
- Your `SECTION_REGISTRY` keys **must exactly equal** `Object.keys(section_schema)`.
  On build, fetch it and assert — fail loudly on drift.
- A `ContentPage`/`BlogPost` cannot be set `status:"published"` while any
  `required` `SectionMedia` slot has no image. The 400 lists the missing slots.
- Video URLs must match `^https://(www\.)?(youtube\.com/embed/|youtu\.be/|player\.vimeo\.com/video/)` — backend rejects others; your renderer must allowlist the same.
- Rich text (`rich_text`, `image_text` `content`) is **plain paragraphs split on
  blank lines**. Render as JSX `<p>` nodes. **Never `dangerouslySetInnerHTML`
  for any CMS or AI-authored text.**

### `SiteSettings.data` canonical shape

```jsonc
{
  "organization": { "name", "legalName", "logo", "logoAlt", "foundingDate", "description", "sameAs": [] },
  "contact": { "email", "phone", "contactType", "availableLanguages": [] },
  "locations": [ { "name","streetAddress","addressLocality","addressRegion","postalCode","addressCountry",
                   "latitude": null, "longitude": null,
                   "openingHours": [ { "days": ["Monday"], "opens": "09:00", "closes": "17:00" } ],
                   "priceRange", "telephone" } ],
  "seoDefaults": { "siteUrl", "titleTemplate": "%s", "defaultTitle", "defaultDescription",
                   "defaultOgImage", "defaultOgImageAlt", "twitterHandle", "twitterCard",
                   "robots": { "index": true, "follow": true }, "themeColor", "locale": "en_US",
                   "searchUrl": "https://site/search?q={query}" },
  "verification": { "google", "bing", "yandex", "pinterest", "facebookDomain" },
  "analytics": { "gtmId", "ga4Id", "metaPixelId", "clarityId", "hotjarId", "linkedinPartnerId",
                 "customHead": [], "customBodyStart": [], "customBodyEnd": [] },   // raw strings, admin-only, injected verbatim
  "schema": { "organizationType": "Organization", "enabled": true, "raw": null },
  "navigation": { "primary": [], "footer": [] },
  "brand": { "primaryColor", "secondaryColor", "fontHeading", "fontBody" },
  "robotsTxt": { "disallow": ["/api/"], "allow": [] }
}
```

---

## §13.1 — Autonomous mode (whole frontend repo)

Ten pasteable phases. Each ends green (build passes, no hydration warnings,
admin round-trip works, public view unchanged). Stop and report after each.

**Phase F0 — Audit.** Inventory: framework + version, routing style, styling
system, i18n, every route, every section/component, existing data sources,
existing SEO/metadata, existing analytics. Output one table:
`file → current state → target state → phase`. No code changes.

**Phase F1 — Global wiring.** `lib/api.js`; `AdminProvider`/`useAdmin`
(`!!localStorage.authToken`, read in `useEffect`); `app/layout` (§13.2 layout
rules); `app/robots.js` + `app/sitemap.js` (proxy or mirror the backend's, or
generate from `seo/` + `blog/` + `content/pages/`); analytics injection;
`<html lang>`; `themeColor`; mount `<SeoEditPanel>` and an admin login affordance.

**Phase F2 — Per-page metadata.** `generateMetadata()` for every route from
`GET seo/resolve/<path>/`. `<script type="application/ld+json">` from
`resolved.jsonLd`. `<Breadcrumbs>` + the `BreadcrumbList` is already in the
graph. Canonical, robots, hreflang, `rel=prev/next` from the resolve response.

**Phase F3 — Section conversion.** Every static section → CMS-wired editable
component (§13.2 component rules). One per commit. Design/animation/copy 100%
preserved.

**Phase F4 — Forms.** Every form → `GET home/form-<name>/` definition +
`POST forms/<name>/submit/` with server-trusted `{errors}` (§13.2 form rules).

**Phase F5 — Lists & detail.** Blog index / product / service lists →
paginated CMS reads. Detail pages → `body_mode` branch → `<DynamicPageRenderer>`.

**Phase F6 — Dynamic Page Builder UI.** Admin panel: "Generate AI Prompt"
(`ai/dynamic-page-prompt/`), "Paste to Build" (`content/paste-to-build/`),
"Copy Structure" (`ai/copy-structure-prompt/`), per-slot media upload, the
pending-images review screen, the publish-guard error surface.

**Phase F7 — Redirects.** `redirects/resolve/?path=` in `middleware.js` (or the
404 handler), issuing the returned `status`.

**Phase F8 — Performance.** `next/image` with real `sizes`/`priority`; lazy
non-critical sections; `next/font` with `display: swap`; reserved space for
embeds; revalidate tuning; no CLS; Lighthouse ≥ 90 mobile.

**Phase F9 — Accessibility & semantics.** One H1/route; heading order with no
gaps; alt text from `UploadedImage.alt_text`; visible focus; skip link;
`prefers-reduced-motion`; breadcrumb UI matches the markup.

**Phase F10 — Verification.** `next build` clean, no hydration warnings; admin
round-trip (login → edit → save → server response reflected in the UI); public
view unaffected; metadata visible in view-source; JSON-LD validates
(schema.org + Google Rich Results); the per-page checklist (§13.5 end) passes
for every route.

---

## §13.2 — Input router (exact behaviour per file type)

### `layout.js` / `layout.jsx` / `layout.tsx`

1. Fetch `settings/site/` **server-side**. Build the default `metadata` export:
   `title.template` = `seoDefaults.titleTemplate`, `title.default` =
   `defaultTitle`, `metadataBase` = `new URL(seoDefaults.siteUrl)`, `description`,
   `openGraph` (siteName, locale, default image w/ 1200×630 + alt),
   `twitter` (card, site = `twitterHandle`), `robots` (from `seoDefaults.robots`),
   `icons`, `themeColor`, `verification` (google/bing/yandex/other:
   `[{name:"msvalidate.01",content:bing}, …]`).
2. Inject `analytics.customHead` strings into `<head>`; `customBodyStart` right
   after `<body>`; `customBodyEnd` before `</body>`. Build GTM/GA4/Meta
   Pixel/Clarity/Hotjar/LinkedIn tags from their IDs using
   `next/script` (`strategy="afterInteractive"`, GTM `beforeInteractive` only
   if consent model requires it).
3. Emit Organization/LocalBusiness + WebSite JSON-LD from
   `GET settings/site/schema/organization/` (or the `jsonLd` from any
   `seo/resolve`) as a single `<script type="application/ld+json">`.
4. `<html lang={seoDefaults.locale.split("_")[0]}>`. Preserve every existing
   provider, wrapper, class, font setup. Mount `<SeoEditPanel>` and the admin
   affordance provider.

### `page.js` for a route

- Add/replace `generateMetadata()` reading `GET seo/resolve/<path>/`. Merge any
  existing good metadata as fallback; never delete it.
- Emit `<script type="application/ld+json">{JSON.stringify(resolved.jsonLd)}</script>`.
- Add `<Breadcrumbs>` UI (data from `resolved.jsonLd["@graph"]` BreadcrumbList).
- Render `<SeoEditPanel path="<path>" />` once near the end (admin-only).
- Leave section components to their own conversion.
- **Listing page:** paginated fetch (`{count,next,previous,results}`), admin
  "New" / "Delete" with real REST semantics, empty state, `rel=prev/next`.
- **Dynamic detail page:** branch `body_mode === "dynamic"` →
  `<DynamicPageRenderer sections={sections} />`; legacy path untouched.

### A component / section (`.jsx`)

- Keep 100% of markup, classes, animation, copy.
- `"use client"`. Fetch `GET home/<NAME>/`. On `{}` render built-in
  `defaultData` (never blank, never an infinite loader). Choose `NAME` as the
  component's purpose in kebab-case (`hero`, `pricing-table`, `footer`) — state it.
- View/edit modes; edit only when `isAdmin`. Copy to `tempData` — never mutate
  live `data`. `structuredClone` for nested updates.
- Save → `PATCH home/<NAME>/` with `authHeaders()`. Set state to the **server
  response**, not `tempData`. Cancel resets.
- Every array is add / remove / reorder in edit mode — not edit-in-place only.
- Images: `uploadImage()` (§13.6) → store the returned URL. Per-item spinner.
- If the purpose matches a `home/schemas/` key, follow that field shape and
  include `schema_key` in the first PATCH.
- Output: the full component + a sample `GET home/<NAME>/` JSON + the one-line
  `NAME` note. Nothing needs pre-seeding.

### A form component

- Fetch the definition from `GET home/form-<NAME>/`. Render fields from
  `definition.fields` (types: text, textarea, email, tel, url, number, date,
  time, datetime, select, multiselect, radio, checkbox, checkboxes, file,
  hidden, rating, range). Honour `width`, `placeholder`, `help`, `options`,
  `validation`.
- Hidden honeypot input named `definition.honeypotField || "website"`.
- Submit → `POST forms/<NAME>/submit/`. Client-validate for UX, then **trust
  the server** `{errors:{field}}`. Success / error text from the definition
  (`successMessage` / `errorMessage`). Consent checkbox when
  `definition.consent.required`.
- Provide the definition JSON to seed + the admin note.

### A blog / article page

- `GET blog/<slug>/`. `generateMetadata()` from `seo/resolve/blog/<slug>/`
  (BlogPost `seo_*` already folded in as fallback by the backend).
- JSON-LD: use `resolved.jsonLd` (already a `BlogPosting` + `BreadcrumbList`
  graph; `FAQPage` too if the page's `seo` config lists it).
- `body_mode === "dynamic"` → `<DynamicPageRenderer>`; legacy block content →
  existing pipeline, untouched.
- Reading time, related posts, TOC from sections.
- Mount the Paste-to-Build / Copy-Structure admin panel on the blog **index**.

### A blog / list index

- Paginated `GET blog/`. Card grid preserved. Admin "New post" → Paste-to-Build
  flow. Note sitemap inclusion is automatic (backend `sitemap-blog.xml`).

---

## §13.2 (cont.) — The renderer contract

```js
// components/dynamic/registry.js
import Hero from "./sections/Hero";
import RichText from "./sections/RichText";
// … one per section type …

export const SECTION_REGISTRY = {
  hero: Hero, rich_text: RichText, image_text: ImageText, cards: Cards,
  features: Features, statistics: Statistics, testimonials: Testimonials,
  faq: Faq, gallery: Gallery, team: Team, timeline: Timeline, pricing: Pricing,
  logos: Logos, steps: Steps, cta: Cta, banner: Banner, video: Video,
  contact_block: ContactBlock, map_block: MapBlock, newsletter: Newsletter,
};

// On build / in a test: assert Object.keys(SECTION_REGISTRY) matches
// (await fetch(`${API}/ai/section-schema/`)).section_schema keys.
```

```jsx
// components/dynamic/DynamicPageRenderer.jsx
export default function DynamicPageRenderer({ sections }) {
  return [...sections].sort((a, b) => a.order - b.order).map((s) => {
    const Cmp = SECTION_REGISTRY[s.section_type];
    if (!Cmp) {
      return (
        <div key={s.id} style={{ border: "1px dashed #c00", padding: 16, margin: 8 }}>
          Unsupported section type: <code>{s.section_type}</code>
        </div>
      );
    }
    return <Cmp key={s.id} {...s.content} media={s.media} />;
  });
}
```

Rules the renderer and its section adapters must follow:

- Unknown type → the dashed-box fallback above. **Never drop content, never
  crash the route.**
- Rich text → `content.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)`.
- Video → sandboxed iframe, `src` allowlisted to the YouTube/Vimeo embed regex;
  reject anything else (render the fallback box).
- Images: an origin-normalising resolver — if `media[i].image.url` is relative,
  prefix `NEXT_PUBLIC_API_URL`; use `alt_override || image.alt_text` for `alt`.
- Thin adapter component per type; keep all visual design in those adapters.

---

## §13.3 — Paste to Build

User pastes a brief (or markup) + this file. You:

1. Infer the sequence of sections from the catalogue in `ai/section-schema/`.
2. `GET ai/dynamic-page-prompt/?sections=<the ones you'll use>` for the exact
   schema, or build the JSON directly against `section_schema`.
3. Produce `SECTION_SCHEMA`-valid JSON: `{ page_type, title, seo, sections: [...] }`.
   Every image → `"image_required": true` + a concrete `"image_prompt"`.
4. `POST content/paste-to-build/ { raw: <that JSON as a string>, path?, page_type? }`.
5. From the response: generate the route (`app/<path>/page.jsx`),
   `generateMetadata()` from `seo/resolve`, and
   `<DynamicPageRenderer sections={...} />` wiring.
6. List `response.pending_images` for the admin — each `{ section_id, slot,
   image_prompt, recommended_size }` uploads via
   `POST content/<path>/sections/<id>/media/<slot>/`.
7. The page stays `draft` until every required image is uploaded (publish guard).

## §13.4 — Copy Structure

User pastes an existing component/page as a **reference**. You:

1. `GET ai/copy-structure-prompt/` and follow it, OR directly:
2. Walk the reference top to bottom. Emit one section per visual block,
   preserving headings, body copy, list items, order, and CTAs **verbatim**.
3. Map each block to the closest `section_schema` type. Flag every image with
   `image_required` + `image_prompt`.
4. Round-trip through `POST content/paste-to-build/`.
5. Build adapter components that reproduce the reference's **exact** design,
   animation, and responsive behaviour — visuals byte-identical.
6. If the target is a single reusable component (not a page), instead produce a
   `ComponentSchema` (`PATCH home/schemas/`… is admin; or just wire the
   component to `home/<name>/` with a matching `schema_key`).

---

## §13.5 — Exhaustive SEO reference

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
- [ ] admin round-trip works; public view unchanged

---

## §13.7 — Fill-in-the-blanks prompt template

```
You are the frontend integration agent. Attached: FRONTEND_INTEGRATION_PROMPT.md
and <FILE(S)>.

Backend base URL: <NEXT_PUBLIC_API_URL>
Framework: <Next.js App Router | other>

Do: <run Autonomous mode | run the Input router for each attached file |
Paste to Build from this brief: "<brief>" | Copy Structure from the attached reference>

Constraints: preserve 100% of existing design, animation, and copy. Token auth
(not Bearer). isAdmin read in useEffect only. Never dangerouslySetInnerHTML for
CMS/AI text. No clarifying questions unless an action is destructive.

Report per phase/file: what changed, what was assumed, test result.
```

---

## §14 — MASTER CHECKLIST (frontend)

- [ ] Self-contained (backend + auth + image contracts inline) — §13.6
- [ ] Behaviour selector: whole-repo / per-file / natural-language — §13.0
- [ ] Autonomous mode: 10 pasteable phases — §13.1
- [ ] Input router: `layout.js` fully specified — §13.2
- [ ] Input router: `page.js` (route / listing / dynamic detail) — §13.2
- [ ] Input router: component / section (defaults, edit, arrays reorderable, image upload, `schema_key`) — §13.2
- [ ] Input router: form (definition fetch, validated submit, states) — §13.2
- [ ] Input router: blog page + blog index — §13.2
- [ ] Paste to Build end-to-end — §13.3
- [ ] Copy Structure end-to-end — §13.4
- [ ] Dynamic Page Builder admin panel wiring — §13.1 F6
- [ ] `seo/resolve` precedence stated as a hard rule — §13.6
- [ ] `SECTION_REGISTRY` ↔ `ai/section-schema/` sync — §13.2 renderer
- [ ] Exhaustive SEO reference — §13.5
- [ ] Token not Bearer; `isAdmin` in `useEffect` only — §13.6
- [ ] "never `dangerouslySetInnerHTML` for CMS/AI text"; video allowlist — §13.6 / §13.2
- [ ] "preserve 100% of design/animation/copy" for every file type — throughout
- [ ] Fill-in-the-blanks prompt template — §13.7
- [ ] This checklist embedded — here

### End-to-end acceptance

- [ ] Repo + this file, no instructions → F0 audit produced
- [ ] One phase heading pasted → only that phase runs, ends green
- [ ] `layout.js` + this file → layout fully wired, nothing else asked
- [ ] `page.js` + this file → metadata + JSON-LD + panel wired
- [ ] A component + this file → CMS-wired, editable, design identical
- [ ] A form + this file → dynamic + validated + notifying
- [ ] A blog page + this file → CMS + schema + dynamic sections
- [ ] Clone for a different vertical → nothing to strip or rename
