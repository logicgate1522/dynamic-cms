> **HISTORICAL — SUPERSEDED. Do not follow this file.** It is the original
> master task that built dynamic-cms (2026). Its paths, section numbers and
> instructions are out of date. To integrate a site, follow `AGENTS.md` and
> `FRONTEND_INTEGRATION_PROMPT.md`; done means `run-gates.mjs` prints
> `ALL GATES GREEN — 3 of 3 passes`.

# MASTER TASK — Upgrade the Universal Dynamic CMS + build a zero-instruction Frontend Integration agent

> Paste this whole file into Claude Code (or Codex) opened at
> `/Users/israkkhan/Desktop/projects/dynamic-cms`. Do not wait for further
> instructions. Read §0 (Operating rules), then execute §12 (Autonomous mode)
> phase by phase. When the user pastes a single phase heading back to you, do
> only that phase. When the user pastes a frontend file (`layout.js`,
> `page.js`, a component, a form, a blog page, a listing page) plus the
> rewritten `FRONTEND_INTEGRATION_PROMPT.md`, follow §13 (Input router) — no
> extra words needed from them.

---

## 0. Operating rules (read first, never violate)

1. **`dynamic-cms` stays generic.** No business names, no domains, no
   Logic-Gate-specific copy, routes, or seed data. Every capability must be
   configurable through the API, not hardcoded. If you catch yourself typing
   "Logic Gate", "logicgatebd", a real address, or a real phone number into
   `dynamic-cms`, stop and parameterise it.

2. **The reference project is `/Users/israkkhan/Desktop/projects/logic-gate-portfolio`.**
   Audit it deeply for *mechanisms*, port *architecture*, never copy
   *content*. It is the more sophisticated implementation; `dynamic-cms` must
   match or exceed its CMS + SEO capability while remaining reusable.

3. **The one architectural invariant that must never break:**
   `home/<name>/`, `settings/site/`, and `seo/<path>/` are name/path-keyed and
   upsert-safe. `GET` on an unknown key returns `200 {}` (never 404). The
   first `PATCH` creates the row. `PATCH` deep-merges objects key-by-key;
   arrays replace wholesale. `blog/`, `redirects/`, `images/`, and any new
   real collection use normal id/slug REST semantics. Every new endpoint you
   add must consciously pick one of these two shapes and document which.

4. **Backwards compatibility.** Existing rows, existing 38 tests, and the
   existing frontend contract must keep working. Add fields as nullable/with
   defaults. Never rename or drop an existing field without a data migration
   and a deprecation note in both READMEs.

5. **Migrations must be clean and forward-only.** One additive migration per
   phase, named descriptively. Never reset the DB. Never edit an applied
   migration. `python manage.py makemigrations --check` must be clean at the
   end of every phase.

6. **Every phase ends green.** `python manage.py test api` passes, `python
   manage.py check --deploy` has no new warnings, `makemigrations --check` is
   clean. Add tests in the same phase as the code — a phase is not done
   without them. State honestly if something is skipped or failing.

7. **No new heavy dependencies without justification.** Prefer stdlib +
   what's already in `requirements.txt`. If you add one (e.g. `bleach` for
   HTML sanitisation, `Pillow` for image dimensions), add it to
   `requirements.txt` pinned, and note why in the README. Trace every package
   to a real import.

8. **Security posture only ever tightens.** Never widen CORS, never drop a
   permission class, never make a write endpoint public. Every new write is
   `IsAdminUser`; every new public read is rate-limited.

9. **Work in a branch.** `git checkout -b cms-upgrade` before Phase 1. Commit
   at the end of each phase with a message that lists what changed. Do not
   push unless asked.

10. **When in doubt, generalise.** Ask: "if I clone this repo for a dentist,
    a SaaS, and a marketplace next week, does this still fit?" If not,
    redesign it as configuration.

---

## 1. What already exists in `dynamic-cms` (do not rebuild)

- `ComponentData` — name-keyed JSON blob, upsert, deep-merge on PATCH,
  `select_for_update` race guard. Backs every editable section + form field
  definitions.
- `SiteSettings` — singleton (pk forced to 1), org identity + default SEO +
  injected scripts.
- `PageSEO` — path-keyed SEO blob, list endpoint, upsert.
- `BlogPost` — slug, block-structured `content` JSON, draft/published,
  scheduled publishing (future `published_at` stays hidden even when
  `status="published"`).
- `Redirect` — self/loop rejection walking up to 20 hops.
- `FormSubmission` — write side of forms; honeypot (`website` field silently
  dropped); throttled `form_submit` scope (5/min); best-effort email notify
  that never fails the submission.
- `UploadedImage` — shared image store, filename slugified on save.
- `CustomUser` — `AbstractUser` + `phone_number`; `is_staff` is the entire
  admin gate.
- Auth: `POST auth/login/` → DRF Token; header is literally `Token <key>`,
  never `Bearer`.
- `utils.deep_merge()`, 38 tests, auto-registered Django admin, env-driven
  settings, Redis-optional cache.

---

## 2. What to port from `logic-gate-portfolio` (mechanisms, not content)

Audit these in the reference repo and bring the **reusable core** across:

| Reference mechanism | Where it lives (reference) | Port as |
|---|---|---|
| SEO change history | `SEOChangeHistory` model, `PageSEODetailView.patch` snapshots old→new + `changed_by` | `SEOChangeHistory` model + `GET seo/<path>/history/` (admin, last N) |
| SEO audit engine | `seo_analyzer.py` `analyze_page()`, `SEOAuditResult`, `SEOAuditView` | `seo_analyzer.py` + `SEOAuditResult` + `GET/POST seo/analyze/<path>/`; dual key names (`passed`/`pass`, `label`/`name`, `message`/`details`) so any UI reads it |
| Dynamic Page Builder | `dynamic_pages.py` `SECTION_SCHEMA`, `build_ai_prompt`, `parse_and_validate`; `DynamicSection` + `SectionMedia` models; `body_mode` on the post; `PasteToBuildView`; `DynamicPagePromptView`; the 11 renderer components + `registry.js` + `DynamicPageRenderer` | Generalised "Dynamic Page" system — see §6. This is the single biggest upgrade. |
| Structured-data builders | `buildOrganizationSchema` in `(main)/layout.js`, per-page `schema.data` raw JSON-LD, `BlogPosting`/`BreadcrumbList`/`FAQPage` `@graph` assembly in `blog/[slug]/page.js` | Server-side schema builder module — see §7 |
| Image SEO metadata | `UploadedImage` `alt_text`/`title`/`caption`/`description`, `build_seo_filename` priority chain | Extend `UploadedImage` — see §8 |
| Section media slots | `SectionMedia` (`slot`, nullable `image` FK, `image_prompt`, `required`), `SectionMediaUploadView` | Port as-is into the Dynamic Page system |
| XSS / embed hardening | AI rich text rendered as plain JSX `<p>` nodes never `dangerouslySetInnerHTML`; video URL allowlist (YouTube/Vimeo) checked backend + frontend | Bake into §6 schema validation + the frontend prompt |
| Scheduled-post visibility | `BlogPostViewSet` non-staff filter `published_at__lte=now` | Already present — verify parity, add tests |
| SEO precedence rule | PageSEO row authoritative; `BlogPost.seo_*` only fallback | Document in the frontend prompt as a hard rule |

**Do NOT port:** `Project`/`FeedbackRound`/`FeedbackItem` and the whole
client feedback portal, `blueprint`/planner app, `the-elites`, any static
seed article file, any hardcoded availability/quote logic, any real
credentials. Note in your audit report that the reference repo has (or had) a
**critical unguarded-permissions hole on the feedback portal** — call it out
so it is never reproduced here, but the portal itself is out of scope.

---

## 3. Backend upgrade — CMS core (`ComponentData` + a versioning layer)

Keep `ComponentData` name-keyed and upsert. Add a **non-breaking** history +
publishing layer:

- New fields on `ComponentData` (all with safe defaults):
  - `draft_data` `JSONField(default=dict, blank=True)` — working copy.
  - `published_data` — rename current `data`? **No** — keep `data` as the
    live/published payload the public GET returns. `draft_data` is what the
    editor PATCHes when `?mode=draft`. A `POST home/<name>/publish/` copies
    `draft_data`→`data`.
  - `status` `CharField` choices `draft|published` default `published` (so
    existing behaviour is unchanged — a plain PATCH still writes `data`).
  - `updated_by` FK `CustomUser` `SET_NULL` null.
  - `schema_key` `CharField(blank=True)` — optional pointer to a reusable
    component schema (see below).
- New `ComponentRevision` model: `component` FK, `data` JSON snapshot,
  `saved_by`, `created_at`, `note`. Write one on every admin PATCH/publish.
  `GET home/<name>/history/` (admin) lists last 20; `POST
  home/<name>/revert/<revision_id>/` (admin) restores one (as a new
  revision, never destructive).
- New `ComponentSchema` model: `key` unique, `label`, `schema` JSON
  (field descriptors: type, label, repeatable, item shape, image slots,
  defaults). Powers: (a) the AI prompt generator, (b) optional server-side
  validation on PATCH when `schema_key` is set, (c) the frontend "what fields
  are editable" contract. Ship built-in schemas for: `hero`, `rich_text`,
  `image_text`, `cards`, `features`, `statistics`, `testimonials`, `faq`,
  `gallery`, `team`, `timeline`, `pricing`, `logos`, `steps`, `cta`,
  `navbar`, `footer`, `banner`, `video`, `contact_block`, `map_block`,
  `newsletter`. These are **starting-point defaults**, editable/extendable
  per project, not a fixed enum.
- `GET home/schemas/` (public) returns all `ComponentSchema` rows so a
  frontend / an AI agent can discover the contract.
- Keep deep-merge + `select_for_update`. Add: PATCH validates against
  `schema_key`'s schema when present, returning `400` with a
  `{field: message}` map (never a partial write).

Backwards-compat test: an existing `GET`/`PATCH` with no `mode`, no
`schema_key` behaves byte-identically to today.

---

## 4. Backend upgrade — `SiteSettings`

`SiteSettings.data` is a free JSON blob today. Keep it a blob (deep-merge
stays), but **document and validate a canonical shape**, and expose helper
read endpoints so frontends don't re-implement parsing:

Canonical `data` shape (all optional, deep-merged):

```jsonc
{
  "organization": {
    "name": "", "legalName": "", "logo": "", "logoAlt": "",
    "foundingDate": "", "description": "",
    "sameAs": []                       // social profile URLs
  },
  "contact": {
    "email": "", "phone": "", "contactType": "customer support",
    "availableLanguages": []
  },
  "locations": [                        // 0..n — drives LocalBusiness schema
    {
      "name": "", "streetAddress": "", "addressLocality": "",
      "addressRegion": "", "postalCode": "", "addressCountry": "",
      "latitude": null, "longitude": null,
      "openingHours": [                 // [{ "days": ["Monday"], "opens": "09:00", "closes": "17:00" }]
      ],
      "priceRange": "", "telephone": ""
    }
  ],
  "seoDefaults": {
    "titleTemplate": "%s",             // %s = page title
    "defaultTitle": "", "defaultDescription": "",
    "defaultOgImage": "", "defaultOgImageAlt": "",
    "twitterHandle": "", "twitterCard": "summary_large_image",
    "robots": { "index": true, "follow": true },
    "themeColor": "", "locale": "en_US"
  },
  "verification": { "google": "", "bing": "", "yandex": "", "pinterest": "", "facebookDomain": "" },
  "analytics": {
    "gtmId": "", "ga4Id": "", "metaPixelId": "",
    "clarityId": "", "hotjarId": "", "linkedinPartnerId": "",
    "customHead": [],                  // raw <script>/<meta> strings, admin-only, injected verbatim in <head>
    "customBodyStart": [], "customBodyEnd": []
  },
  "schema": {
    "organizationType": "Organization", // or LocalBusiness, ProfessionalService, etc.
    "enabled": true,
    "raw": null                        // full manual override JSON-LD; when set, builder is bypassed
  },
  "navigation": { "primary": [], "footer": [] },
  "brand": { "primaryColor": "", "secondaryColor": "", "fontHeading": "", "fontBody": "" }
}
```

- `GET settings/site/` public (unchanged).
- `GET settings/site/schema/organization/` (public) — returns the **computed
  Organization/LocalBusiness JSON-LD** from the builder (§7), ready to inject.
- PATCH validates `analytics.customHead` etc. are arrays of strings, `locations`
  is a list of objects, coordinates are numeric or null. Reject obviously
  malformed input with a field map.
- Security: `customHead`/`customBody*` are raw script injection — **admin
  write only, already true**; add a test that a non-admin PATCH is 401, and
  that the values are never echoed by any public endpoint except the
  documented `settings/site/` GET (which is intentionally public, same as
  today — note this in the security section).

---

## 5. Backend upgrade — SEO engine

### 5a. `PageSEO` fields (canonical `data` shape)

```jsonc
{
  "seoTitle": "", "metaDescription": "",
  "canonicalUrl": "", "canonicalSelf": true,   // when true, canonical = this path
  "focusKeyword": "",
  "keywords": { "secondary": [], "variations": [] },
  "social": {
    "ogTitle": "", "ogDescription": "", "ogImage": "", "ogImageAlt": "",
    "ogType": "website",
    "twitterTitle": "", "twitterDescription": "", "twitterImage": "", "twitterImageAlt": "",
    "twitterCard": "summary_large_image"
  },
  "robots": {
    "index": true, "follow": true,
    "noarchive": false, "nosnippet": false, "noimageindex": false,
    "maxSnippet": null, "maxImagePreview": "large", "maxVideoPreview": null,
    "unavailableAfter": ""
  },
  "schema": { "enabled": true, "type": "", "data": null, "builders": [] },
                                                // builders: ["BreadcrumbList","FAQPage",...] auto-assembled
  "sitemap": { "include": true, "changefreq": "weekly", "priority": 0.7, "lastmod": "" },
  "hreflang": [],                               // [{ "lang": "en", "href": "" }]
  "alternates": { "amp": "", "rss": "" },
  "prev": "", "next": ""                        // pagination rel
}
```

Keep upsert + deep-merge. `PageSEODetailView.patch` snapshots old `data`,
merges, saves, writes a `SEOChangeHistory` row (`page`, `changed_by`,
`old_data`, `new_data`, `created_at`). `GET seo/<path>/history/` admin, last
20. Add `POST seo/<path>/revert/<history_id>/` (admin).

Route ordering: `seo/<path>/history/` and `seo/analyze/<path>/` **must** be
declared before the greedy `seo/<path:path>/` catch-all (the reference repo
hit exactly this bug — replicate the fix and add a regression test).

### 5b. SEO audit engine (`seo_analyzer.py`)

Port `analyze_page(path)` and extend it. It reads the `PageSEO` row + (when
the path maps to one) the `BlogPost`, and optionally accepts a POSTed
`{ "html": "...", "url": "..." }` for live-DOM checks. Produce
`{ overall, technical_score, content_score, metadata_score, schema_score,
checks: [...], issues: [...] }`. Each check: `{ id, category, label,
passed, weight, message, fix }` (plus dual aliases `pass`/`name`/`details`
for UI compat).

**Technical checks:** title present, title 50–60 chars, description present,
description 120–160 chars, canonical present, canonical is absolute & https,
single H1, heading order has no gaps, `robots` not accidentally `noindex`,
sitemap `include` true, image `alt` coverage, `lang` set, viewport present,
no mixed content, favicon present, 404-soft detection, trailing-slash
consistency, URL length/depth sane, no `?`-heavy URLs.

**Content checks:** focus keyword set, keyword in title, keyword in
description, keyword in H1, keyword in first 100 words, keyword density
0.5–2.5%, content word count ≥ threshold (configurable, default 300 / 600
for blog), Flesch reading ease bucket, internal link count ≥ 1, external
link count, outbound links have text, image count vs word count, paragraph
length, passive-voice ratio (heuristic), duplicate-title detection across
all `PageSEO` rows, duplicate-description detection, thin-content flag,
orphan-page flag (no internal inbound link found in known content).

**Metadata / social checks:** OG title/description/image/alt all present, OG
image ≥ 1200×630 (when dimensions known via `UploadedImage`), Twitter card
valid, `og:type` sensible, hreflang well-formed & reciprocal, verification
tags present in `SiteSettings` when expected.

**Schema checks:** at least one JSON-LD block, valid JSON, `@context`
present, `@type` recognised, required props per type present
(Organization: name+url; Article: headline+datePublished+author+image;
Product: name+offers; LocalBusiness: name+address; FAQPage: ≥1
Question/acceptedAnswer; BreadcrumbList: ordered ListItems; Person:
name), no duplicate conflicting `@type`, breadcrumb matches URL depth,
Article dates ISO-8601, image URLs absolute.

Persist every run as `SEOAuditResult` (`page`, `score`, sub-scores,
`issues` JSON, `created_at`). `GET seo/analyze/<path>/` returns latest +
runs a fresh one; `GET seo/analyze/` (admin) returns a site-wide roll-up
(worst pages first, average score, count by grade). 404 cleanly when the
path has no `PageSEO` row (try/except `DoesNotExist`).

### 5c. `robots.txt` + sitemap support

- `GET robots.txt` view (project urls, not under `/api/`): built from
  `SiteSettings` (`seoDefaults.robots`, sitemap URL, any disallow list in
  `data.robotsTxt.disallow`). Sensible default when unset.
- `GET sitemap.xml` + `GET sitemap-<section>.xml` index: enumerates
  published `BlogPost` + every `PageSEO` row with `sitemap.include` true +
  any registered "content source" (see below). Respects `changefreq`,
  `priority`, `lastmod`. Excludes `noindex` pages automatically.
- **Content-source registry:** a small hook (`SITEMAP_SOURCES` setting or a
  registry function) so a cloned project can add "products", "services",
  "locations" URL sets without editing core. Ship `pages` + `blog`
  built-in; document how to add more.

### 5d. Metadata contract for the frontend

Add `GET seo/resolve/<path>/` (public, cached): returns a **fully-resolved,
frontend-ready** object merging `PageSEO` ← `SiteSettings.seoDefaults` ←
built-in fallbacks, plus the assembled JSON-LD `@graph` for that page. This
lets `generateMetadata()` be a thin mapping instead of re-implementing
precedence in every project. Document the precedence order explicitly:
`PageSEO.data` > `BlogPost.seo_*` (blog paths only) > `SiteSettings.seoDefaults`
> built-in default.

---

## 6. Backend upgrade — the Dynamic Page / Section system (biggest piece)

Port and **generalise** the reference "Dynamic Page Builder" so it is not
blog-only.

### 6a. Models

- `ContentPage` — the generic host. Fields: `path` (unique, slug-with-slashes
  ok), `title`, `page_type` (`CharField`, free-form: `article`, `landing`,
  `service`, `product`, `generic` … default `generic`), `status`
  (`draft|published`), `published_at` (scheduled-visibility rule identical to
  `BlogPost`), `seo_path` (defaults to `path`), `body_mode`
  (`legacy|dynamic`, default `dynamic` for new, `legacy` never auto-set),
  `content` JSON (legacy/free blob for `legacy` mode), `updated_by`,
  timestamps. **`BlogPost` keeps working**: either (a) make `BlogPost` a
  thin proxy/extension that reuses `DynamicSection` via a generic relation,
  or (b) leave `BlogPost` fully intact and add `ContentPage` alongside,
  sharing the section models via `content_type`/`object_id`. Pick (b) unless
  the tests prove (a) is clean — less risk.
- `DynamicSection` — `content_type` + `object_id` generic FK (so it attaches
  to `BlogPost` **or** `ContentPage` **or** a future model), `section_type`
  (validated against `SECTION_SCHEMA` keys, not a frozen DB enum),
  `order` (PositiveInteger, indexed with the parent), `content` JSON,
  `status` (`draft|published`) so a section can be staged.
- `SectionMedia` — `section` FK, `slot` (`"image"`, `"items[0].image"`, …),
  `image` FK `UploadedImage` `SET_NULL` null, `image_prompt` text,
  `required` bool, `alt_override` text. `unique_together (section, slot)`.

### 6b. `SECTION_SCHEMA` — single source of truth

One Python dict in `dynamic_pages.py`. Both the AI-prompt generator and the
parser import it — **never duplicate it** (the reference repo flags this as
the #1 structural risk). Ship the full section catalogue from §3's
`ComponentSchema` list, each with: required/optional/`required_list` field
rules, per-field type, image-slot descriptors, and per-item image rules for
list sections (`gallery`, `cards`, `team`, `logos`, `steps`, `timeline`).

Reuse the reference validation rules verbatim:
- `image_prompt` present ⇒ `image_required` implied true.
- `image_required` true with no `image_prompt` ⇒ reject.
- `video` sections: `video_url` must match the YouTube/Vimeo embed allowlist
  regex — **backend and the emitted frontend both check**.
- Rich text (`rich_text`, `image_text` `content`): plain paragraphs split on
  blank lines. Parser strips/rejects raw HTML. Frontend renders as JSX `<p>`
  nodes, **never `dangerouslySetInnerHTML`**. If HTML is ever allowed, it
  must be `bleach`-sanitised server-side on write with a tight allowlist —
  add this as an opt-in `content_format: "html"` with sanitisation, off by
  default.

### 6c. Endpoints

```
GET   ai/section-schema/                          public — the whole SECTION_SCHEMA (frontend registry sync + discovery)
GET   ai/dynamic-page-prompt/?sections=hero,faq   admin  — copy-paste AI prompt (build_ai_prompt), filtered
POST  content/paste-to-build/                     admin  — {raw, path?, page_type?} → parse_and_validate → atomic create
GET   content/<path>/sections/                    public — ordered published sections for a ContentPage
POST  content/<path>/sections/                    admin  — replace whole list, atomic
PATCH content/<path>/sections/<id>/               admin
DELETE content/<path>/sections/<id>/              admin
POST  content/<path>/sections/reorder/            admin  — {order: [id,...]}, must be exactly this page's ids
POST  content/<path>/sections/<id>/media/<slot>/  admin  — upload one image into a slot (wraps images/)
GET   blog/<slug>/sections/  (+ same subroutes)   — identical surface bound to BlogPost, kept for compat
```

`parse_and_validate(raw)`:
- strip ```` ```json ```` fences defensively; hard-fail with a clear
  `Invalid JSON` message otherwise (no fragile "find first `{`" heuristic).
- root must be an object with non-empty `title` and non-empty `sections`
  array.
- per section: validate `type` ∈ schema, required fields, image pairing,
  video allowlist, list shapes. Collect **all** errors with
  `{section_index, message}`; never partial-create.
- on success inside `transaction.atomic()`: create the host
  (`ContentPage` or `BlogPost` per `page_type`; `article`→`BlogPost`,
  everything else→`ContentPage`), `body_mode="dynamic"`, `status="draft"`,
  slug/path via the existing unique-slug helper; one `DynamicSection` per
  validated section; one empty `SectionMedia(required=True, image=None)` per
  required image slot (incl. `gallery` per-item slots). Return
  `{ host, pending_images: [{section_id, section_type, slot, image_prompt, recommended_size}] }`.
- publish guard: block `status="published"` while any
  `SectionMedia(required=True, image=None)` remains — enforce at the
  serializer, return a clear error listing the missing slots.

### 6d. "Copy structure" prompt

`GET ai/copy-structure-prompt/` (admin) returns a prompt that instructs an
external AI to take a **pasted existing component/page** and return
`SECTION_SCHEMA`-shaped JSON that reproduces it — preserving headings, copy,
order, and flagging each image. Round-trips back through
`content/paste-to-build/`. Document both flows (generate-from-brief and
copy-from-reference) in the frontend prompt.

### 6e. Frontend renderer contract (spec only — code lives in target projects)

The rewritten `FRONTEND_INTEGRATION_PROMPT.md` must specify: a
`SECTION_REGISTRY` object (keys === `SECTION_SCHEMA` keys, fetched/verified
against `GET ai/section-schema/`), a `DynamicPageRenderer` that sorts by
`order`, renders an "Unsupported section type" dashed-box fallback for
unknown types (never drops content, never crashes the route), thin adapter
components per type, plain-JSX rich text, sandboxed allowlisted video
iframes, and an origin-normalising image URL resolver.

---

## 7. Backend upgrade — structured data / JSON-LD builder

New module `schema_builders.py`. Pure functions, no DB writes, each returns a
dict:

- `organization(site_settings)` → `Organization` **or** `LocalBusiness` /
  `ProfessionalService` / … per `schema.organizationType`; includes
  `sameAs`, `logo` `ImageObject`, `contactPoint`, and a per-location
  `LocalBusiness` node with `address`, `geo`, `openingHoursSpecification`,
  `priceRange` when `locations` present.
- `website(site_settings)` → `WebSite` + `SearchAction` (sitelinks
  searchbox) when a search URL is configured.
- `breadcrumb(path, labels)` → `BreadcrumbList` matching URL depth.
- `article(blogpost_or_contentpage, site_settings)` → `BlogPosting`/`Article`
  with `headline`, `description`, `image[]`, `datePublished`,
  `dateModified`, `author` (`Person` or falls back to `Organization`),
  `publisher`, `mainEntityOfPage`, `articleSection`, `keywords`,
  `wordCount`, `inLanguage`.
- `faq(items)` → `FAQPage` (skip when no valid Q/A pair).
- `product(data)` → `Product` + `Offer` + `AggregateRating`/`Review` when
  present.
- `service(data, site_settings)` → `Service` with `provider`, `areaServed`,
  `hasOfferCatalog`.
- `person(data)` → `Person`.
- `event`, `howto`, `videoObject` — stubs with correct required props.

`assemble(path)` builds the `@graph` for a page: always includes
`organization` + `website`; adds `breadcrumb` from the path; adds
`article`/`product`/`service`/`faq` based on `PageSEO.data.schema.builders`
+ page type; appends `PageSEO.data.schema.data` (raw manual JSON-LD) last;
if `SiteSettings.data.schema.raw` or `PageSEO...schema.data` is a full
document, honour the override. Escape `<` as `<` on emit. Exposed via
`GET seo/resolve/<path>/` (§5d) and `GET settings/site/schema/organization/`.

Add a lightweight validator (`validate_schema(obj)`) used by the audit
engine (§5b schema checks) and callable standalone at
`POST seo/validate-schema/` (admin) for pasted JSON-LD.

---

## 8. Backend upgrade — image management

Extend `UploadedImage` (all additive):
- `width`, `height` (`PositiveInteger` null) — filled on upload via `Pillow`
  if available, else null.
- `file_size` bytes, `mime_type`, `format`.
- `focal_x`, `focal_y` (0–1 floats, default 0.5) for art-directed cropping.
- `checksum` (sha256 hex, indexed) — **duplicate detection**: on upload,
  if a same-checksum row exists, return the existing one with `duplicate:
  true` instead of storing again.
- `usage` JSON (`[{type, ref}]`) — best-effort back-references written when
  a `SectionMedia`/`PageSEO`/`SiteSettings` field points at this image;
  `GET images/<id>/usage/` lists them; deleting an in-use image warns.
- `credit`, `license` text.
- Keep `build_seo_filename` priority chain (alt→title→category+rand→stem→
  random). Add: reject SVG unless `ALLOW_SVG_UPLOAD` setting is true
  (SVG = script vector); validate magic bytes match the extension; cap
  dimensions/size via settings (`MAX_IMAGE_BYTES`, default 10 MB).
- `GET images/?category=&unused=1&missing_alt=1` filters for SEO cleanup.
- Serializer exposes an absolute `image` URL always (build_absolute_uri).

Frontend contract stays: upload first via `POST images/`
(multipart, `Authorization: Token …`, **no manual Content-Type**), never let
an admin type a raw image URL.

---

## 9. Backend upgrade — forms

Field-definition shape in `home/form-<name>/` (`ComponentData`), extended:

```jsonc
{
  "title": "", "description": "", "submitLabel": "Submit",
  "successMessage": "", "errorMessage": "",
  "notify": { "email": "", "subject": "" },      // overrides FORM_NOTIFICATION_EMAIL per-form
  "redirectAfter": "",
  "fields": [
    {
      "name": "email", "label": "Email", "type": "email",
      "required": true, "placeholder": "", "help": "",
      "options": [],                              // select/radio/checkbox
      "validation": { "pattern": "", "minLength": null, "maxLength": null, "min": null, "max": null },
      "width": "full",                            // full|half
      "accept": "", "maxSizeMb": null             // file
    }
  ],
  "consent": { "required": false, "text": "" },
  "honeypotField": "website"
}
```

Field types: `text`, `textarea`, `email`, `tel`, `url`, `number`, `date`,
`time`, `datetime`, `select`, `multiselect`, `radio`, `checkbox`,
`checkboxes`, `file`, `hidden`, `rating`, `range`.

`POST forms/<name>/submit/`:
- validate submitted values **against the field definition server-side**
  (required, type, pattern, length, options membership, file size/type) —
  return `{errors: {field: msg}}` `400` on failure.
- honeypot: configured field silently 200s, never persists.
- per-IP + per-email throttle (`form_submit` scope, already 5/min); add a
  60-second same-email dedupe (reference repo has this).
- optional file upload → stored via the image/file store, value becomes the
  URL.
- best-effort email notify (per-form `notify.email` ‖ `FORM_NOTIFICATION_EMAIL`);
  never fail the submission on mail error.
- `FormSubmission` gets: `ip_hash` (hashed, not raw IP — privacy), `user_agent`,
  `referer`, `is_spam` bool, `is_read` bool, `created_at`.
- `GET forms/<name>/submissions/` admin, paginated, `?is_read=&is_spam=&since=`.
- `GET forms/<name>/submissions/export/?format=csv|json` admin.
- `PATCH forms/<name>/submissions/<id>/` admin — toggle `is_read`/`is_spam`.

---

## 10. Backend upgrade — redirects

Extend `Redirect`: `status_code` (301|302|307|308, default 301), `is_active`
bool, `hit_count`, `last_hit_at`, `notes`, `created_by`, timestamps. Keep
self/loop rejection (walk ≤20 hops). Add:
- `GET redirects/resolve/?path=/old` (public, cached) → `{to, status}` or
  `404` — frontend `middleware` / not-found handler calls this.
- increment `hit_count` + `last_hit_at` on resolve (async/best-effort, cheap).
- `GET redirects/?broken=1` admin — flags redirects whose target is itself a
  known `noindex`/missing page (best-effort).
- import/export CSV.

---

## 11. Backend upgrade — security & infra audit (do this every phase, report once)

Check and fix in `dynamic-cms`:
- every write endpoint is `IsAdminUser`; every public write is impossible;
  add explicit `permission_classes` to **every** view (no reliance on
  `DEFAULT_PERMISSION_CLASSES`). Add a test that iterates the URLconf and
  asserts each non-safe method is admin-gated.
- `DEFAULT_PERMISSION_CLASSES` value — set it to `IsAuthenticatedOrReadOnly`
  or stricter; never `AllowAny`.
- throttling actually active: `DEFAULT_THROTTLE_CLASSES` + rates set,
  `form_submit` scope present, anon + user scopes present; note the
  "throttle silently disabled if scope missing" regression from the
  reference repo and add a test.
- pagination default on all list endpoints.
- CORS: `CORS_ALLOWED_ORIGINS` explicit (never `CORS_ALLOW_ALL`), credentials
  only if needed. `CSRF_TRUSTED_ORIGINS` set.
- `SECRET_KEY` hard-errors when `DEBUG=False` and unset (already true —
  verify).
- `SECURE_*`: `SECURE_SSL_REDIRECT`, `SECURE_HSTS_SECONDS`,
  `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`, `SECURE_PROXY_SSL_HEADER`,
  `X_FRAME_OPTIONS=DENY`, `SECURE_CONTENT_TYPE_NOSNIFF` — all
  production-correct, env-gated so dev still works.
- file uploads: extension + magic-byte validation, size cap, SVG gated,
  filenames slugified, stored outside any executable path, `X-Content-Type`
  nosniff on media.
- no secrets in the repo; `.env.example` has placeholders only; `.gitignore`
  covers `.env`, `db.sqlite3`, `media/`, `logs/`.
- `injected script` fields are admin-write-only and documented as a
  deliberate trust boundary.
- SQL injection: everything is ORM; audit any `.raw()`/`.extra()`/f-string
  query (there should be none).
- `DELETE` endpoints require admin and confirm-by-id.
- rate-limit `auth/login/` (already on `form_submit` scope — verify) and add
  a lockout/backoff note.
- dependency audit: `pip list` vs actual imports; pin everything; run
  `pip-audit` if available and report.
- `python manage.py check --deploy` clean.

Produce `SECURITY_AUDIT.md` at the repo root summarising findings, severity,
and fixes.

---

## 12. AUTONOMOUS MODE — the phased plan (execute in order; each is independently pasteable)

When this file is dropped in with no other instruction, first print a short
**codebase audit** (what exists, gaps vs this spec, risks), then work the
phases. Stop after each phase, report (what changed, tests added, test
result, migration name), and wait. If the user pastes just a phase heading,
do only that phase.

- **Phase 0 — Audit & branch.** `git checkout -b cms-upgrade`. Read every
  file in `dynamic-cms` and the reference `backend/api/` + reference
  frontend CMS/SEO/blog/dynamic code. Output: gap analysis table, risk list,
  confirmation the §0 invariants are understood. No code changes.
- **Phase 1 — Security & infra hardening (§11).** Do this first so
  everything after is built on a safe base. `SECURITY_AUDIT.md`. Tests.
- **Phase 2 — CMS core: revisions, drafts, schemas (§3).** `ComponentRevision`,
  `ComponentSchema`, built-in schemas, `home/schemas/`, history/revert
  endpoints, optional schema validation. Migration. Tests. Back-compat test.
- **Phase 3 — SiteSettings canonical shape + validation + org-schema endpoint
  (§4).** Migration if fields added (or keep pure-blob + validation only).
  Tests.
- **Phase 4 — SEO engine: PageSEO shape, history, revert, resolve endpoint,
  route-ordering fix (§5a, §5d).** Migration. Tests incl. the greedy-route
  regression.
- **Phase 5 — SEO audit engine (§5b).** `seo_analyzer.py`, `SEOAuditResult`,
  analyze endpoints + site roll-up. Tests with fixture pages hitting each
  check.
- **Phase 6 — robots.txt + sitemap + content-source registry (§5c).** Tests.
- **Phase 7 — Structured-data builder module (§7).** `schema_builders.py`,
  `assemble()`, `validate_schema()`, endpoints. Tests per builder + validator.
- **Phase 8 — Dynamic Page / Section system (§6).** Models (generic FK),
  `SECTION_SCHEMA`, `build_ai_prompt`, `parse_and_validate`, all endpoints,
  publish guard, copy-structure prompt. Keep `BlogPost` intact + add its
  section subroutes. Migration. Heavy test coverage (parser happy path, every
  rejection, atomic rollback, reorder validation, media pending list,
  publish guard).
- **Phase 9 — Image management (§8).** Extend `UploadedImage`, dedupe,
  dimensions, usage refs, SVG gate, magic-byte check, filter endpoints.
  Migration. Tests.
- **Phase 10 — Forms (§9).** Server-side validation from definition, extended
  field types, submission metadata, export, read/spam toggles. Migration.
  Tests.
- **Phase 11 — Redirects (§10).** Extend model, resolve endpoint, hit
  tracking, import/export. Migration. Tests.
- **Phase 12 — Rewrite `FRONTEND_INTEGRATION_PROMPT.md` (§13).** The big
  document. No backend code.
- **Phase 13 — Docs + final verification.** Update root `README.md` and
  `api/README.md` (new models, endpoints, contracts, precedence rules,
  security boundaries). Regenerate `.env.example`. Run full suite +
  `check --deploy` + `makemigrations --check`. Fill in §14 checklist with
  real ticks. Write `UPGRADE_NOTES.md` (what changed, how to migrate an
  existing clone forward). Final commit.

Deliverables at the end: green tests (report the count, up from 38), clean
migrations, `SECURITY_AUDIT.md`, `UPGRADE_NOTES.md`, updated READMES, the
rewritten `FRONTEND_INTEGRATION_PROMPT.md`, and §14 fully ticked.

---

## 13. `FRONTEND_INTEGRATION_PROMPT.md` — rewrite specification

The rewritten file must be **self-contained** (repeat the backend contract,
auth contract, image contract inside it) and function as an **autonomous AI
implementation agent**. Structure:

### 13.0 How this document behaves
- "If you are an AI and this file was attached **with a frontend codebase and
  no other instruction** → run *Autonomous mode* (§13.1)."
- "If attached **with one or more specific files** (`layout.js`, a `page.js`,
  a component, a form, a blog page, a listing page) → run the *Input router*
  (§13.2) for each file, in dependency order (layout → pages → sections →
  forms → lists → blog → redirects)."
- "If attached with a natural-language request (\"build this landing page\",
  \"make this editable\", a pasted screenshot/markup) → run *Paste to Build*
  (§13.3) or *Copy Structure* (§13.4)."
- "Never ask clarifying questions unless a destructive or irreversible action
  is involved. Prefer sensible defaults and state them."

### 13.1 Autonomous mode (whole frontend repo)
Phased, pasteable-phase-by-phase, mirroring §12 but frontend-side:
1. **Audit** — inventory routes, components, existing data sources, existing
   SEO, framework version, styling system, i18n. Output a table: file →
   current state → target state → phase.
2. **Global wiring** — `app/layout` (§13.2 layout rules), `app/robots`,
   `app/sitemap`, analytics injection, font loading, `<html lang>`, theme
   color, the `SeoEditPanel` mount, an `AdminProvider`/`useAdmin` hook
   (`!!localStorage.authToken`, read in `useEffect` only, never during SSR).
3. **Per-page metadata** — `generateMetadata()` for every route from
   `GET seo/resolve/<path>/`, `<script type="application/ld+json">` from the
   resolved `@graph`, breadcrumbs, canonical, robots, hreflang, pagination
   rel.
4. **Section conversion** — every static section → CMS-wired editable
   component (§13.2 component rules), one per commit.
5. **Forms** — every form → dynamic definition + validated submit (§13.2).
6. **Lists & detail** — blog index / product / service lists → paginated CMS
   reads; detail pages → dynamic sections + `DynamicPageRenderer`.
7. **Dynamic Page Builder UI** — mount the "Generate AI Prompt / Paste to
   Build / Copy Structure" admin panel; wire `content/paste-to-build/`,
   `ai/dynamic-page-prompt/`, `ai/section-schema/`, per-slot media upload,
   the pending-images review screen, the publish guard.
8. **Performance** — image `sizes`/`priority`, lazy sections, `revalidate`
   tuning, font-display swap, no layout shift, Lighthouse pass.
9. **Accessibility & semantics** — one H1, heading order, alt text from
   `UploadedImage`, focus states, skip link, reduced-motion.
10. **Testing & verification** — build passes, no hydration warnings, admin
    round-trip (login → edit → save → server response reflected), public
    view unaffected, metadata visible in view-source, JSON-LD validates,
    §14 frontend checklist ticked.

### 13.2 Input router — exact behaviour per file type

**`layout.js` / `layout.jsx` / `layout.tsx`:**
- fetch `SiteSettings` server-side; build default `metadata` export
  (`title.template` from `seoDefaults.titleTemplate`, `default*`,
  `metadataBase`, `openGraph`, `twitter`, `robots`, `icons`, `themeColor`,
  `verification`).
- inject `analytics.customHead` in `<head>`, `customBodyStart` after
  `<body>`, `customBodyEnd` before `</body>`; GTM/GA4/Pixel/Clarity from
  their IDs.
- emit `Organization`/`LocalBusiness` + `WebSite` JSON-LD from
  `GET settings/site/schema/organization/` (or `seo/resolve`).
- `<html lang>` from `seoDefaults.locale`; font setup preserved; mount
  `SeoEditPanel` + admin affordance provider.
- preserve every existing provider, class, and layout wrapper.

**`page.js` for a route:**
- add/replace `generateMetadata()` reading `GET seo/resolve/<path>/` with
  documented precedence and fallbacks; never remove existing good metadata,
  merge it as fallback.
- add JSON-LD `@graph` for the page; add `<Breadcrumbs>` + `BreadcrumbList`.
- leave section components to their own conversion; render
  `<SeoEditPanel path="<path>" />` once near the end.
- for a **listing** page: paginated fetch (`{count,next,previous,results}`),
  admin "new" / "delete" controls with real REST semantics, empty state.
- for a **dynamic detail** page: branch on `body_mode === "dynamic"` →
  `<DynamicPageRenderer sections={…}>`; legacy path untouched.

**A component / section (`.jsx`):**
- keep 100% of markup, classes, animation, copy.
- `"use client"`; fetch `GET home/<NAME>/`; `{}` → render built-in
  `defaultData` (never blank/infinite-loader); choose `NAME` from the
  component's purpose (kebab-case) and state it.
- view/edit modes; edit only when `isAdmin`; `tempData` copy, never mutate
  live `data`; `structuredClone` for nested updates.
- Save → `PATCH home/<NAME>/` with `Authorization: Token …`; set `data` to
  the **server response**, not `tempData`; Cancel resets.
- every array is add/remove/**reorder**-able in edit mode, not
  editable-in-place only.
- images: upload via `POST images/` (multipart, token, no Content-Type) →
  store returned URL; per-item spinner; never a raw-URL text field.
- if the component matches a `ComponentSchema` key, follow that shape and
  register `schema_key`.
- output: full component + sample `GET home/<NAME>/` JSON + the one-line
  `NAME` note (nothing needs pre-seeding).

**A form component:**
- fetch definition from `GET home/form-<NAME>/`; render fields from it;
  submit to `POST forms/<NAME>/submit/` with the honeypot field hidden;
  client-validate then trust server `{errors:{field}}`; success/error
  states from the definition; consent checkbox when configured.
- provide the definition JSON to seed and the admin note.

**A blog / article page:**
- `GET blog/<slug>/`; `generateMetadata()` from `seo/resolve/blog/<slug>/`
  with `BlogPost.seo_*` as fallback; `BlogPosting` + `BreadcrumbList`
  (+ `FAQPage` when an FAQ section exists) `@graph`.
- `body_mode==="dynamic"` → `DynamicPageRenderer`; legacy block content →
  existing pipeline, untouched.
- related posts, reading time, TOC from sections.
- mount the Paste-to-Build / Copy-Structure admin panel on the blog index.

**A blog/list index:**
- paginated `GET blog/`; card grid preserved; admin "New post" →
  Paste-to-Build flow; sitemap inclusion noted.

### 13.3 Paste to Build
User pastes a brief or markup + this file → AI: infer sections from the
catalogue, call `GET ai/dynamic-page-prompt/` for the exact schema, produce
`SECTION_SCHEMA`-valid JSON, `POST content/paste-to-build/`, then generate
the route + `generateMetadata()` + renderer wiring, and list the images the
admin must upload.

### 13.4 Copy Structure
User pastes an existing component/page as a reference → AI: preserve exact
design/animation/responsive behaviour, extract editable fields, produce the
`ComponentSchema` (or `SECTION_SCHEMA` JSON), wire the backend, keep visuals
byte-identical.

### 13.5 Full SEO reference (must be exhaustive — fold in everything from
`AgriciDaniel/claude-seo` and standard modern SEO practice)
Cover, with concrete Next-App-Router code for each:
- **Metadata API**: `metadata` vs `generateMetadata`, `metadataBase`,
  `title.template`/`title.absolute`, `alternates` (canonical, languages,
  media, types), `robots` object (all directives + googleBot +
  `max-snippet`/`max-image-preview`/`max-video-preview`/`unavailable_after`),
  `openGraph` (type, locale, siteName, images with width/height/alt,
  article: publishedTime/modifiedTime/authors/section/tags,
  profile/book/video variants), `twitter` (card types, site, creator,
  images), `icons`/`manifest`/`appleWebApp`, `themeColor` +
  `colorScheme`, `verification`, `formatDetection`, `referrer`,
  `authors`/`creator`/`publisher`, `category`, `bookmarks`, `archives`,
  `assets`, `pagination` (`rel=prev/next` via `alternates`).
- **Canonical strategy**: self-canonical default, cross-domain, params,
  pagination, faceted nav, trailing slash, www/non-www, http/https,
  uppercase, session IDs.
- **Structured data**: every type in §7, `@graph` composition, nesting vs
  referencing by `@id`, `sameAs`, `WebSite`+`SearchAction`,
  `Organization`+`logo`, `BreadcrumbList`, Article family, Product+Offer+
  Review+AggregateRating, LocalBusiness + multi-location +
  `openingHoursSpecification` + `geo` + `areaServed`, FAQ, HowTo, Event,
  VideoObject, Person, JobPosting, Course, Recipe, SoftwareApplication,
  Service, `ImageObject`; Rich Results eligibility & policy notes;
  validation (schema.org + Google Rich Results Test); `<` escaping;
  never mark up hidden/inaccurate content.
- **robots.txt**: `app/robots.js`, allow/disallow, crawl-delay caveats,
  per-agent groups, sitemap directive, staging `noindex` via header/robots,
  `X-Robots-Tag` for non-HTML.
- **sitemaps**: `app/sitemap.js`, sitemap index, `lastModified`,
  `changeFrequency`, `priority`, images/video/news extensions, 50k/50MB
  limits, splitting, excluding noindex, hreflang in sitemap.
- **hreflang / i18n**: reciprocal tags, `x-default`, locale routing,
  per-locale metadata, `Content-Language`, currency/region.
- **Core Web Vitals / performance for SEO**: LCP (image `priority`,
  preconnect, responsive `sizes`, `next/image`, no CLS from images/fonts/
  ads), INP (minimise JS, defer, code-split, avoid long tasks), CLS
  (dimensions, `font-display: swap` + fallback metrics, reserved ad/embed
  space), TTFB (caching, `revalidate`, edge, streaming), bundle budget,
  `next/font`, `next/script` strategies (`beforeInteractive`/`afterInteractive`/
  `lazyOnload`), third-party script isolation, prefetch.
- **Rendering & indexability**: SSR/SSG/ISR/PPR trade-offs, `revalidate`,
  `dynamic`/`fetchCache`, streaming + SEO, client-only content risks,
  soft-404 avoidance, correct HTTP status (`notFound()` → 404,
  `redirect()` codes), `loading.js`/`error.js` not blocking crawl,
  pagination crawl paths, infinite scroll + crawlable links,
  faceted-nav control.
- **On-page**: one H1, logical heading outline, descriptive `<title>`
  (~50–60), meta description (~120–160, unique), semantic landmarks,
  descriptive link text, `rel="nofollow ugc sponsored"` usage, image `alt`,
  `<figure>/<figcaption>`, tables with headers, `lang`, breadcrumb UI +
  markup parity, internal linking depth ≤3, related-content blocks,
  keyword placement (title/H1/first paragraph/URL/alt) without stuffing,
  content freshness (`dateModified`), E-E-A-T signals (author bios +
  `Person` + `sameAs`, citations, `about`/`mentions`).
- **URL design**: lowercase, hyphens, shallow, stable, no dates unless
  needed, no stop-word bloat, no params for primary content, redirect on
  change.
- **Redirects**: 301 vs 302 vs 308, chains ≤1 hop, loops, update internal
  links after redirecting, `redirects/resolve/` in middleware,
  `next.config` redirects vs runtime.
- **International/analytics/verification**: GSC + Bing Webmaster property
  verification via `SiteSettings.verification`, GA4/GTM via IDs,
  consent-mode note, UTM hygiene, `referrer` policy.
- **Social/preview**: OG image spec (1200×630, <8MB, text-safe area),
  per-page OG image, `og:image:alt`, Twitter large card, Linkedin/Slack/
  Discord unfurl notes, `next/og` dynamic OG image route pattern.
- **Feeds & discovery**: RSS/Atom/JSON Feed route, `alternates.types`,
  `WebSub`/IndexNow note, Google News/Merchant feed hooks.
- **Accessibility ↔ SEO overlap**: contrast, focus order, ARIA only when
  needed, reduced motion, semantic HTML first.
- **Anti-patterns to actively remove**: keyword stuffing, hidden text,
  doorway pages, cloaking, duplicate titles/descriptions, thin/auto content
  without value, orphan pages, broken canonicals, `noindex` leaks to prod,
  render-blocking JS for primary content, layout shift, intrusive
  interstitials, mixed content, infinite redirect chains, unclosed JSON-LD,
  marking up invisible content.
- **Per-page checklist** the AI runs before declaring a page done
  (mirrors the audit engine §5b).

### 13.6 Backend contract block (verbatim, self-contained)
Full endpoint table (every endpoint from the upgraded backend), the two
URL-shape rules, auth (`Token` not `Bearer`, `isAdmin =
!!localStorage.authToken`, read in `useEffect`), image upload snippet,
`seo/resolve` precedence, section-schema sync, publish guard, error shapes.

### 13.7 The prompt template (fill-in-the-blanks) + §13.8 the comprehensive
checklist (see §14 — include it inside the doc too).

---

## 14. MASTER CHECKLIST (fill with real ticks at the end; also embed in the doc)

### Backend — CMS
- [ ] `ComponentData` upsert + deep-merge + race guard intact & tested
- [ ] `ComponentRevision` history + `home/<name>/history/` + revert
- [ ] `ComponentSchema` + built-in schema catalogue + `home/schemas/`
- [ ] draft/publish + `updated_by` on components, back-compat verified
- [ ] optional schema validation on PATCH (field-map 400, atomic)

### Backend — SiteSettings
- [ ] canonical `data` shape documented + validated
- [ ] locations / opening hours / geo
- [ ] analytics (GTM, GA4, Pixel, Clarity, Hotjar, LinkedIn) + custom head/body
- [ ] verification tags (Google, Bing, Yandex, Pinterest, FB domain)
- [ ] `settings/site/schema/organization/` computed JSON-LD endpoint
- [ ] injected-script fields admin-write-only, tested

### Backend — SEO engine
- [ ] `PageSEO` canonical shape (robots directives, social, hreflang, sitemap, pagination)
- [ ] `SEOChangeHistory` + `seo/<path>/history/` + revert
- [ ] greedy-route ordering fixed + regression test
- [ ] `seo/resolve/<path>/` resolved-metadata + `@graph` endpoint, precedence documented
- [ ] `seo_analyzer.py` — technical / content / metadata / schema checks (full list §5b)
- [ ] `SEOAuditResult` persisted; `seo/analyze/<path>/` + site roll-up
- [ ] `robots.txt` view from settings
- [ ] `sitemap.xml` + index + content-source registry (pages, blog built-in)

### Backend — structured data
- [ ] `schema_builders.py`: organization/localbusiness, website+searchaction, breadcrumb, article, faq, product, service, person (+ event/howto/video stubs)
- [ ] `assemble(path)` `@graph` composition + manual override honoured
- [ ] `validate_schema()` + `seo/validate-schema/` endpoint
- [ ] `<` escaped on emit

### Backend — Dynamic Page / Sections
- [ ] `ContentPage` (generic, page_type, body_mode, scheduled visibility)
- [ ] `DynamicSection` (generic FK) + `SectionMedia` (slots, pending, required)
- [ ] `SECTION_SCHEMA` single source of truth; full catalogue
- [ ] `build_ai_prompt` + `ai/dynamic-page-prompt/` + `ai/section-schema/`
- [ ] `parse_and_validate` — fences, all rejections, `{section_index,message}`, atomic
- [ ] `content/paste-to-build/` create host + sections + pending media
- [ ] section CRUD + reorder (id-set validation) + media upload subroutes
- [ ] `BlogPost` kept intact + given the same section subroutes
- [ ] publish guard on missing required images
- [ ] video allowlist backend + emitted frontend; rich text plain-JSX only
- [ ] `ai/copy-structure-prompt/`

### Backend — images
- [ ] alt/title/caption/description + credit/license
- [ ] width/height/size/mime/format (Pillow-optional)
- [ ] checksum dedupe (returns existing + `duplicate:true`)
- [ ] usage back-references + `images/<id>/usage/`
- [ ] SVG gated, magic-byte check, size cap
- [ ] `?category=&unused=1&missing_alt=1` filters
- [ ] absolute URLs in serializer

### Backend — forms
- [ ] extended field types + per-field validation rules
- [ ] server-side validation from definition (`{errors:{field}}` 400)
- [ ] honeypot + throttle + same-email dedupe
- [ ] file-upload fields
- [ ] submission metadata (hashed IP, UA, referer, is_read, is_spam)
- [ ] per-form notify override; mail failure never fails submit
- [ ] submissions list filters + CSV/JSON export + read/spam toggle

### Backend — redirects
- [ ] status_code + is_active + hit_count + last_hit_at
- [ ] loop/self rejection intact
- [ ] `redirects/resolve/?path=` (cached) + hit tracking
- [ ] import/export CSV; `?broken=1`

### Backend — security & infra
- [ ] explicit `permission_classes` on every view + URLconf iteration test
- [ ] `DEFAULT_PERMISSION_CLASSES` never `AllowAny`
- [ ] throttling active + scope-missing regression test
- [ ] pagination on all lists
- [ ] CORS/CSRF explicit; `SECURE_*` production-correct, env-gated
- [ ] upload validation (ext + magic bytes + size + SVG gate)
- [ ] no secrets in repo; `.gitignore` complete; `.env.example` regenerated
- [ ] `check --deploy` clean; dependency audit; `SECURITY_AUDIT.md`

### Backend — quality
- [ ] test count reported (up from 38); suite green
- [ ] `makemigrations --check` clean; one additive migration per phase
- [ ] existing 38 tests + existing frontend contract still pass
- [ ] root `README.md` + `api/README.md` updated
- [ ] `UPGRADE_NOTES.md` (how to move an existing clone forward)

### FRONTEND_INTEGRATION_PROMPT.md
- [ ] self-contained (backend + auth + image contracts inline)
- [ ] behaviour selector: whole-repo / per-file / natural-language
- [ ] Autonomous mode: 10 pasteable phases
- [ ] Input router: `layout.js` behaviour fully specified
- [ ] Input router: `page.js` (route / listing / dynamic detail) specified
- [ ] Input router: component / section specified (defaults, edit, arrays reorderable, image upload, schema_key)
- [ ] Input router: form specified (definition fetch, validated submit, states)
- [ ] Input router: blog page + blog index specified
- [ ] Paste to Build flow documented end-to-end
- [ ] Copy Structure flow documented end-to-end
- [ ] Dynamic Page Builder admin panel wiring documented
- [ ] `seo/resolve` precedence + fallback order stated as a hard rule
- [ ] `SECTION_REGISTRY` ↔ `ai/section-schema/` sync documented
- [ ] exhaustive SEO reference (§13.5) — Metadata API, canonical, all schema types, robots, sitemaps, hreflang, CWV/perf, rendering/indexability, on-page, URL design, redirects, verification/analytics, social/OG, feeds, a11y overlap, anti-patterns, per-page checklist
- [ ] fold in everything from `AgriciDaniel/claude-seo` + modern practice
- [ ] `Token` not `Bearer` stated prominently; `isAdmin` read in `useEffect` only
- [ ] "never `dangerouslySetInnerHTML` for CMS/AI text"; video allowlist
- [ ] "preserve 100% of design/animation/copy" stated for every file type
- [ ] fill-in-the-blanks prompt template
- [ ] the full checklist embedded in the doc
- [ ] requires zero additional human instruction for any supported input

### End-to-end acceptance
- [ ] drop file at repo root, no instructions → audit + Phase 0 output produced
- [ ] paste one phase heading → only that phase executed, ends green
- [ ] paste `layout.js` + the doc → layout fully wired, no other words needed
- [ ] paste a `page.js` + the doc → metadata + schema + panel wired
- [ ] paste a component + the doc → CMS-wired, editable, design identical
- [ ] paste a form + the doc → dynamic + validated + notifying
- [ ] paste a blog page + the doc → CMS + schema + dynamic sections
- [ ] clone the repo fresh for a different vertical → nothing to strip/rename

---

## 15. Do not stop until

`dynamic-cms` is a generic, secure, fully-tested CMS + SEO framework whose
capability meets or exceeds `logic-gate-portfolio`, and
`FRONTEND_INTEGRATION_PROMPT.md` turns any pasted frontend file — or a whole
repo — into a fully CMS-wired, SEO-complete, structured-data-rich, design-
preserving implementation with **no further human instruction**.
