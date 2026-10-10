# Upgrade Notes — run-gates: one definition of done, three enforced passes

**What's new**
- **`frontend-kit/acceptance/run-gates.mjs`** is the definition of done. It
  runs every gate against the production build:
  - kit-verbatim, check-inline, check-sections;
  - production-build (the served build id must match `.next/BUILD_ID`);
  - visual, acceptance, tracking-edge, verify-tracking, site-audit;
  - report.

  It maps every result to R1–R33 through `rules-map.json`, and enforces P8's
  three passes:
  - pass 2 needs a green pass 1 on identical files and a fresh build;
  - pass 3 needs a green pass 2 on identical files plus `CMS_REPORT.md`.
    The report must tick every rule with evidence, quote the pass-2
    fingerprint, confirm the §11 sweep, and list Defaults taken and Needs
    from the owner.

  It prints `ALL GATES GREEN — 3 of 3 passes`.
- **The "(review)" rules now have gates:**
  - R1 kit-verbatim: CORE files and gate scripts byte-identical; only the
    `cms.css` theme block may differ;
  - R9 `visual.mjs`: P0 baseline vs every later pass, 390/1280px,
    pixelmatch ≤0.5%;
  - R11 check-inline: every rendered image field has an `<E.Image>`;
  - R12 the report gate.
- **The spec** opens with a "READ THIS FIRST" block (five non-negotiables)
  and ends with a FINAL CHECK. The done-line appears at the top, in P8, §12,
  §13 and the FINAL CHECK. P0 now takes the visual baseline, and §13 gives
  the exact `CMS_REPORT.md` format. AGENTS.md, README and MANIFEST say the
  same.
- **`IntegrationSpecTests`** fails if:
  - a rule lacks `rules-map.json` evidence;
  - a mapped gate isn't run by run-gates;
  - a rule is proven by "review" only;
  - the done-line is missing from the first screen, §12 or the closing
    FINAL CHECK.

**Fixes found while running it**
- The tracking checker's test bookings hit the 5-a-minute form limit.
  Submissions with a valid, signed verification token now skip it; forged
  or expired tokens don't.
- The build id is read from the RSC payload, so revalidating (non-static)
  pages work too.
- `cms.css`: only the theme block may differ from the kit.

---

# Upgrade Notes — tracking edge-case pass

New gates: `api/tests_tracking_edge.py` (100 backend edge cases) and
`frontend-kit/acceptance/tracking-edge.mjs` (67 browser checks across every
tracking, consent and contacts use case). Bugs they found, all fixed:

**Correctness**
- A page that merely shows the enquiry form (About, FAQ, legal…) was typed
  "contact" and became a booking-click target. Specific page types now win;
  CTA targets are the pages that *are* the contact/booking page. The scanner
  follows the same rule.
- An unknown trigger condition (e.g. a typo'd `optoin`) was silently
  dropped, broadening a per-service conversion to every lead. It's now an
  error.

**Contacts**
- Erasing one person blocked everyone sharing their phone number for 30
  days. Tombstones now identify by email (phone only when there's no email).
- Group rules with "before/after <date>" crashed (naive vs aware dates).

**Capture**
- Reading with the mouse/wheel (no clicks) stopped the engaged-reading clock.
  `pointermove` and `wheel` now count as activity.
- The cookie banner could miss its first-load setup when tracking rendered
  later (Suspense). The banner configures consent itself, and late
  configuration notifies listeners.

**Endpoints**
- The headless runner endpoint shared the visitor throttle; it now uses
  `verify`.
- The panel's check frames were `visibility:hidden`, so section views never
  fired. They now render invisibly.
- **Panel race:** "Pick on page" added a conversion, then the panel's plan load
  overwrote it. Unsaved edits are now tracked synchronously, and a load never
  replaces them.

---

# Upgrade Notes — business-aware tracking, consent and contacts (R31–R33)

Implements TRACKING_IMPLEMENTATION_PLAN.md. New rules **R31** (tracking plan
from the business, automatic events, checks), **R32** (consent first) and
**R33** (privacy-safe contacts), each in its five places.

**Backend**
- Models and migrations `0011_tracking` and `0012_tracking_jobs`:
  - tracking: `TrackingScan`, `TrackingConnection`, `TrackingSyncItem`,
    `EventOutbox`, `TrackingDaily`, `VerificationRun` + `VerificationResult`,
    `TrackingAlert`, `TrackingJob`;
  - contacts and audit: `Contact`, `ContactEvent`, `ContactGroup`,
    `ErasureTombstone`, `ConsentLog`, `AdminAuditLog`;
  - `FormSubmission` gains `event_id`, `profile`, `consent`, `is_test`,
    location and `contact`.
- Modules:
  - `tracking_vocab` (event vocabulary + PII scrubber, served to the kit);
  - `site_facts` (DB + rendered-site scan);
  - `tracking_library` (base set, business packs, page-type rules, stage
    detectors);
  - `tracking_plan` (validation incl. dangling triggers and caps, runtime
    config, lead matching, values, diff, test compilation);
  - `tracking_leads`, `tracking_dispatch` + `tracking_adapters/` (Meta CAPI,
    GA4 MP, TikTok, LinkedIn, Google Ads, GTM; Google service-account JWT
    without client libraries);
  - `tracking_sync`, `tracking_verify`, `contacts`, `crypto`, `geo`.
- Endpoints: `tracking/*`, `ai/tracking-plan/*`, `events/`,
  `events/forget/` and `contacts/*` (spec §6.2). The public settings
  response no longer includes `analytics.plan` or `contacts`, and a settings
  save never overwrites them.
- `submitForm` envelope (`_cms`) popped before validation. Answers include
  `event_id`, matched `conversions`, `summary`, `intent`, `segment`. A
  same-email duplicate answers `duplicate: true`.
- Launch check: tracking plan missing / draft / stale / dangling, checks
  never run or failing, connections needing re-auth, missing
  `TRACKING_SECRET_KEY` (blocker), worker not running, quiet conversions.
- `consent_marketing` form field type: always optional, boolean.
- New dependency: `cryptography`. New settings: `TRACKING_SECRET_KEY`,
  `TRACKING_ALERT_EMAIL`/`WEBHOOK`, `TRACKING_INLINE_DELIVERY`,
  `TRUST_GEO_HEADERS`, `GEOIP_DB_PATH`, throttles `events`/`verify`. CORS
  allows `X-CMS-Verify`.
- Commands: `manage.py tracking_worker [--once]`,
  `manage.py tracking_rotate_key`.
- Tests: `api/tests_tracking.py` (64).

**Kit (CORE)**
- New `lib/consent.js`, `lib/intentProfile.js`, `lib/trackCapture.js` and
  `lib/siteScan.js`; `lib/track.js` rewritten.
- New `components/seo/{ConsentBanner,ConsentedTags,VerifyHarness}.jsx`.
- New admin screens: `app/admin/{tracking,contacts}` and
  `components/admin/{tracking,contacts}/*`. Site tools gains Tracking and
  Contacts tabs.
- `useCms`'s `{editButton}` renders a hidden block marker for visitors, and
  `E.Item` an item marker. CMS-page sections are wrapped in
  `[data-track-block]`.
- `<Analytics>` fetches `tracking/config/` itself. **Render it inside
  `<AdminProvider>`** (layout change in the spec).
- `AdminProvider` treats `?cms-verify` pages as a visitor.
- check-inline: every block renders `{editButton}`; forms that use
  `submitForm` have `data-cms-form`; no visitor storage outside the
  consent/profile modules; opt-in never pre-ticked.
- Acceptance:
  - `tracking:`, `consent:` and `contacts:` checks;
  - `verify-tracking.mjs` (headless checks) and a GitHub workflow template;
  - site-audit tracking/consent/contacts checks.

**Upgrading an existing site**
1. Sync the kit.
2. Move `<Analytics>` inside `<AdminProvider>`.
3. Make sure every block renders `{editButton}` first inside its root, and
   that every form has `data-cms-form`.
4. Give FAQ toggles `aria-expanded`.
5. Add `TRACKING_SECRET_KEY`, run migrations, start the worker.
6. In Site tools → Tracking: Scan → Build → Approve → Run checks.
7. Update the privacy page (LAUNCH_GUIDE.md §6).

---

# Upgrade Notes — launch guide, search verification, analytics warnings

- **New `LAUNCH_GUIDE.md`** (generic, owner-facing). It covers:
  - the domain and Site URL;
  - FormSubmit activation and alias;
  - Google Search Console (DNS or HTML tag, submit the sitemap);
  - Bing (import from Search Console);
  - GTM + GA4 setup for the kit's events (`page_view`, `generate_lead`,
    `contact_click`), with no double counting;
  - cookie consent.

  The P8 report and AGENTS point the owner to it. `IntegrationSpecTests`
  checks that it covers every launch warning.
- **Launch check:** new warnings:
  - `search-verification`: no Google or Bing code;
  - `analytics`: no tracking ID;
  - `consent`: tracking on, but the consent default is not chosen.
- **Settings API:** `verification` codes are validated. A pasted
  `<meta … content="…">` is reduced to its code (`normalize_site_settings`).
- **Settings page (kit):**
  - New "Search engine verification" card under Tracking. It has help for
    each engine, accepts the whole tag, and shows the sitemap URL to submit.
  - Generic defaults: `Organization`, `en_US`, no country, no theme colour.
  - More `organizationType` options.
- **site-audit (R25):** fails when a verification code set in Settings is
  missing from the home page `<head>`. Warns when none is set.
- **Acceptance:** `frontend-kit/acceptance/package.json`. Run
  `npm run setup` once in that folder to install playwright, axe-core and
  chromium, then use the npm scripts.
- **Spec:**
  - R25 now covers verification.
  - R22 mentions the warnings and the guide.
  - The `launch-check/` contract row lists the real fields (`label`, `fix`,
    `where`).

---

# Upgrade Notes — fresh-install test, keyword H1 check, touch check

- **New `frontend-kit/acceptance/fresh-install.mjs`.** It scaffolds a blank
  Next app, installs the kit verbatim, applies the MANIFEST ADAPT steps, adds
  the spec's layout and a §3 section, then runs `check-inline` and
  `next build` with the CMS unreachable. Run it after every kit change
  (AGENTS.md).
- **MANIFEST.** `DraftPreview` also imports `RelatedArticles`, and the
  "no legacy article components" adaptation is now spelled out.
- **site-audit (R29).** An H1 that shares no keyword with the page title
  fails. The brand phrase is ignored when comparing.
- **Acceptance.**
  - New check: tapping a block on a touch device shows its tools.
  - Scrolling is instant, so smooth-scroll sites can't skew the checks.
  - Keyword leftovers from killed runs are ignored when recording originals.
- The "new page" form's placeholders are generic.

---

# Upgrade Notes — R20 tightened: readable and nothing off-screen

- site-audit now also loads every page at `RESPONSIVE_WIDTHS` (default
  390,1024), after letting in-view animations finish. It fails visible text
  under 11px and text pushed past the screen edge.
- R20 now covers 1024px (laptops), and requires the following: no text under
  11px; fixed or absolute cards that scale (`clamp()`, `%`) and stay inside
  their container; decorative images never on top of copy.

---

# Upgrade Notes — R30: edit mode never changes, hides or crowds the page

- **New `components/cms/floating.jsx` (CORE).** One admin layer at the end of
  `<body>`. It cancels any zoom or scale the site applies to the page, sits
  above every site element and lets clicks through.
  - Every edit tool is now a floating tool there: block pill and Hide, item
    tools, "+ Add", 🔗, "Replace image", section toolbar/label/notices.
  - In the page each tool leaves only a hidden zero-size anchor, so turning
    editing on moves nothing.
  - Tools appear for the hovered, focused or tapped target, stay on screen,
    below the fixed header, clear of the admin bar and outside small targets,
    and re-attach if their target re-mounts.
- **Admin bar.** Always one line: actions that don't fit move into "More" and
  are never dropped. Menus render in the layer, clamped to the screen. The bar
  and drawers are unaffected by site zoom.
- **`check-inline`.** Every list in a block's defaults (and one level of
  nested lists) needs `E.Item` + `E.Add`, or a `cms-fixed-list: reason`
  comment.
- **Acceptance.**
  - New checks: no edit chrome in the layout; the header doesn't move when
    editing toggles; tools hidden until hovered; block tools never covered;
    bar one line at desktop, phone and 1920px; "More" fully on screen.
  - Hide steps hover first; menu items are found in the layer.
  - Cleanup restores every section on the dynamic page.
- Section toolbars carry `data-cms-section-tools="<id>"`.
- **Upgrading a site:** re-sync the kit. A site-specific carousel or overlay
  link must let the visible card take clicks while editing (see R30).

---

# Upgrade Notes — rules R26–R29: truthful claims, contact policy, services, structure

- **R26 Every claim is true.**
  - The launch check warns "Confirm these claims are true". It covers
    client counts, ratings, percentages, years of experience, "trusted by",
    "fixed fees" and credential words (certified, accredited, chartered) in
    published content,
    plus any visible testimonials.
  - site-audit flags the same in every rendered page (code defaults
    included). With `LAUNCH=1` these fail until `CLAIMS_CONFIRMED=1`.
  - The AI prompts' no-invention rule names these claim types explicitly.
- **R27 Brand and contact from one place.**
  - `check:inline` fails hard-coded `tel:`/`mailto:` links.
  - site-audit fails phones or emails that aren't in
    `SiteSettings.contact`, and fails if the form-notification address
    appears on a page.
- **R28 Services are real and complete.** site-audit fails a published
  content-collection entry that isn't linked from its index page, or that
  has fewer than `ENTRY_MIN_WORDS` (600) words.
- **R29 One primary action and keyword-led structure.** site-audit fails:
  - a first visible heading that isn't the H1
  - h1–h3 inside `<footer>`
  - a contact page with fewer than 120 words besides the form
- Organization JSON-LD resolves a site-relative `organization.logo` against `seoDefaults.siteUrl` (search engines need an absolute URL).
- acceptance: the hide-block probe ignores paths/URLs (a shared logo path is in header and footer).

---

# Upgrade Notes — richer service pages, automatic Service/FAQ schema

- Section adapters (pull with `sync_kit.py`):
  - `hero` gains an optional `eyebrow`, a second button
    (`secondary_text`/`secondary_href`) and an "at a glance" card
    (`highlights_title` + `highlights: [{label, value}]`).
  - `rich_text` puts the heading beside the text on large screens and takes an
    `eyebrow`.
  - `cta` gains a second button.
  - `features` lays out 3 or 6 items in rows of three.
  - Paragraph text renders lines starting with `- ` as a ticked list (still
    plain text; an intro line can share the paragraph).
- `SECTION_SCHEMA` lists the new optional fields, and adds an
  `optional_list` rule.
- `seo/resolve` adds FAQPage (from published `faq` sections) and Service (on
  `page_type: "service"` pages) automatically. Explicit PageSEO config still
  wins. Section edits now refresh the resolver cache.
- Fixed: deleting a page whose sections have image slots crashed in the
  revalidation signal.
- Acceptance and site-audit fill every field type a form can have
  (selects, checkbox/radio groups, date/time pickers that start as text).
  The focus check compares raw text, so CSS uppercase can't break it.

---

# Upgrade Notes — audits at every level

- Every phase P0–P8 ends with an **Exit check**. The next phase starts only
  when it passes.
- P8 verifies in three passes:
  1. fix until all five gates are green in one run (rerun all five after
     every fix);
  2. a clean re-verification with no code changes (rebuild, reseed, all
     gates); the reported output comes from this pass;
  3. a rule-by-rule audit against §13 with evidence, plus a sweep of §11.
- Four "review by hand" rules are now automatic in `check-inline.mjs`:
  - R4: no auth token in browser storage
  - R5: no AI prompt wording in the frontend
  - R10: no `dangerouslySetInnerHTML` outside `JsonLd`
  - R19: no secret or `X-CMS-Frontend` in browser code or a `NEXT_PUBLIC_`
    variable
- `IntegrationSpecTests` fails if any Exit check or pass is removed.

---

# Upgrade Notes — spec v3: every rule stated five times

- `FRONTEND_INTEGRATION_PROMPT.md` is restructured. "How to use this file"
  comes first, with a table of the five gates. Then come §0.1 (a rule index
  with each rule's gate and phase) and §0.2 (a card per rule with Must /
  Never / Proven by). Every §2 phase lists the rules it builds, §11 has one
  anti-pattern per rule, and §13 has one checklist line per rule, each
  ending in its gate.
- Lessons from real integrations are now explicit in the cards: the
  fixed-header offset for the first section's tools, h1 twins, contact
  details from one source, GTM double counting, FormSubmit activation, and
  never inventing business details.
- R1 now names exactly what may change: the MANIFEST ADAPT files, the
  `cms.css` theme block and the adapter classes. It used to say
  "4 ADAPT files"; there are 5.
- §12 fixes the report's shape: gate outputs, the ticked checklist, the
  defaults taken, and what the owner still needs to provide.
- `IntegrationSpecTests` enforces the structure: every copy of every rule,
  phase/index agreement, and current `R1–Rn` ranges in AGENTS, the READMEs
  and MANIFEST.

---

# Upgrade Notes — hide anything, FormSubmit emails, tracking from Site tools

**Hide blocks, list items and sections (R23)**
- A "Hide" chip sits beside every block's "All fields" pill; object list items
  get a hide button in their floating tools; CMS-page sections get "Hide" in
  their hover toolbar.
- Hiding stores `_hidden: true` as a draft and goes live on Publish. Admins see
  hidden things dimmed with "Hidden · Show".
- `useCms` returns `hidden` and strips hidden items for visitors
  (`lib/visibility.js`). **Upgrading a site:** add
  `if (hidden) return null;` to every component that calls `useCms`
  (`check-inline.mjs` now fails without it). Blocks that must always render
  pass `{ hideable: false }`.
- Launch check placeholder scan skips hidden content.

**Form emails via FormSubmit.co (R24)**
- New `SiteSettings.forms` (`notifyEmail`, `subjectPrefix`), edited in the
  first card of Site tools → Settings, with a "Send a test email" button
  (FormSubmit sends an activation link on first use; then you can use the
  alias it gives you).
- `lib/forms.js#submitForm` is the only submit path: stores in the inbox,
  emails real leads, tracks `generate_lead`. **Upgrading a site:** replace
  every form's fetch with `submitForm(name, payload, { honeypotField })`.
- Launch check: a lead address in Settings clears the email blockers; SMTP is
  only required when relying on `FORM_NOTIFICATION_EMAIL`. A plain address
  (not the alias) is a warning.

**Tracking from Site tools (R25)**
- Settings → Tracking & analytics: GTM, GA4, Google Ads (+ lead label), Meta
  Pixel, TikTok, LinkedIn (+ lead conversion), Clarity, Hotjar — validated
  server-side — plus data layer variables, consent-mode default, event
  toggles, "Don't track signed-in admins" and custom code.
- `lib/track.js#track` is the only event API; `page_view`, `generate_lead` and
  `contact_click` fire automatically (`components/seo/AnalyticsEvents.jsx`).
- `check-inline.mjs` fails direct `gtag`/`fbq`/`dataLayer.push` calls and raw
  form submits outside the kit helpers.

**Docs:** spec rules R23–R25 in §0, recipes, §4, §5.4, §6, §11 and §13;
AGENTS.md; the spec test now also fails stale rule ranges in AGENTS/README.

---

# Upgrade Notes — site audit and launch readiness

**SEO fixes**
- Titles never repeat the brand, and the brand is dropped when it would push a
  title past 60 characters (`apply_title_template`).
- The og-image check counts the site default.
- A deleted page's SEO record and sections are removed with it.

**Launch readiness**
- New `GET launch-check/`, shown as a dashboard card. Its blockers:
  - placeholder text
  - a localhost site URL
  - indexing off
  - lead forms that notify nobody, or email that isn't really sent
- Its warnings: debug mode, the webhook off, no default social image, weak
  page SEO.

**Other changes**
- Form submissions can now be deleted (`DELETE forms/<name>/submissions/<id>/`).
- New `frontend-kit/acceptance/site-audit.mjs`: per-page SEO, links,
  contact-detail consistency, placeholders and forms end to end; it fails the
  build gate with `LAUNCH=1`.
- Spec rules R21 (site audit) and R22 (launch blockers).
- The seed fills missing keys at any depth: default og image, article
  descriptions.

---

# Upgrade Notes — focus-safe editing, rate limits that fit editors

**Typing never loses focus**
- Lists keyed by their own text (`key={item.title}`) re-created the field on
  every keystroke. All of them are now index-keyed.
- `check-inline.mjs` fails on any text-derived key.
- The inline editor restores focus and the caret if an element is ever
  re-created anyway.
- The acceptance test types into list fields across an autosave and asserts
  the element is never replaced.

**List-item tools** (↑ ↓ ⧉ ✕) now float above the hovered item (portal), so
they never cover its text and can't be clipped.

**Rate limits** (`api/throttles.py`)
- Staff are exempt from the general limits, so fast inline editing no longer
  hits 429s.
- The site's server sends `X-CMS-Frontend: <REVALIDATE_SECRET>` (`lib/cms.js`,
  `middleware.js`), so page renders and redirects aren't limited as one
  anonymous visitor.
- Login and form-spam limits are unchanged.

**Moving forward**
- Re-sync the kit (now includes `middleware.js`).
- Make sure `REVALIDATE_SECRET` is set in the frontend's server env.
- Run `check:inline` and fix any reported keys.

---

# Upgrade Notes — Prometheus parity, collections, theming

A second pass against the Prometheus editor.

**SEO panel**
- Opens on **✦ Ask AI**, with the audit prompt already built.
- A score bar shows on every tab.
- 18 checks, each with a fix and a jump to its field (single list:
  `prompts.seo_rule_checks` ↔ `lib/seoChecks.js`).
- Per-tab issue counts and Auto-fill for empty fields.

**Whole-page AI assist**
- Builds its prompt on open.
- The KEYWORD COVERAGE card shows a %, a sentence and a ✓ chip per section,
  and stays live after Apply.
- OTHER SEO RULES lists 6 rules with ✓/✕.
- Covers CMS-page sections too.

**Prompts**
- Every prompt ends with a FINAL CHECK that repeats its hard rules (enforced
  by tests).

**Collections replace the on-site page builder**
- New `SiteSettings.collections`: pages that share one template and are
  listed on an index page.
- "＋ New <item>" appears only there, as a blank draft from the template
  (copying a sibling's fields and list lengths) or written with AI using a
  strict template prompt with a sibling as style reference.
- Entry settings: publish, title, URL (live renames add a 301), fields, an
  AI rewrite as drafts, and delete.
- One-off pages can no longer be restructured from the site. The full
  builder stays in Dashboard → Pages.

**Edit tools never cover the page**
- Block pills, item tools, link and add buttons, and image chips appear on
  hover only.
- The admin bar can be minimised.

**Theming**
- The admin UI reads five `--cms-*` CSS variables (`app/cms.css`).

## Moving forward

```bash
git pull
./venv/bin/python manage.py test api        # 172 pass, no migrations
```

Frontend:
- re-sync `frontend-kit/src` (new: `CollectionPanel.jsx`, `lib/seoChecks.js`;
  removed: `PageBuilder.jsx`)
- set the `--cms-*` variables
- add `collections` to your seed and run it (it now fills any missing
  top-level settings block)
- re-run `acceptance.mjs`

New endpoints:
- `collections/…` (see `FRONTEND_INTEGRATION_PROMPT.md` §6.2)
- `starters` in `ai/section-schema/`

---

# Upgrade Notes — inline editing + AI assist (`feat/inline-editing-ai-assist`)

This brings back what the Prometheus editor had and the first dynamic-cms
port lost:
- true click-and-type inline editing (no popups)
- draft → publish
- AI prompts written by the backend, with site context and SEO practice built in
- JSON/AI paste boxes that clean messy replies
- keyword coverage
- instant cache refresh

It also adds a frontend kit, a strict integration spec and an acceptance test,
so the next integration needs no extra instructions.

## Moving an existing clone forward

```bash
git pull
./venv/bin/pip install -r requirements.txt   # no new packages
./venv/bin/python manage.py migrate          # 0010: DynamicSection.draft_content (additive)
./venv/bin/python manage.py test api         # 161 pass
```

Then on the backend `.env`:
- `FRONTEND_REVALIDATE_URL=<site>/api/revalidate`
- `REVALIDATE_SECRET=<random>` (the same value in the frontend's env)
- the site origin in both `CORS_ALLOWED_ORIGINS` and `CSRF_TRUSTED_ORIGINS`
- in production: `SESSION_COOKIE_SECURE=True`, `CSRF_COOKIE_SECURE=True`, and
  either the API on the same site as the frontend or `SESSION_COOKIE_SAMESITE=None`

## Breaking change for frontends

The browser now authenticates with a **session cookie + CSRF**
(`auth/login/` with `session: true`, `auth/csrf/`, `auth/session/`,
`auth/logout/`), not a token in `localStorage`. Token login still works for
scripts. Frontends built from the old prompt must install `frontend-kit/`
(see `FRONTEND_INTEGRATION_PROMPT.md` v2 and `frontend-kit/MANIFEST.md`).

## What changed

| Area | Change |
|---|---|
| Auth | Session + CSRF for the browser (`auth_views.py`; `CSRF_USE_SESSIONS`); login by email **or username**; real server-side logout; `SESSION_COOKIE_SAMESITE` override for cross-domain APIs. |
| Drafts | `DynamicSection.draft_content` (migration 0010); section `PATCH ?mode=draft`; `GET drafts/`, `POST drafts/publish/`, `POST drafts/discard/` (all or a scope), with revision snapshots on publish. Drafts are never served to visitors. |
| AI prompts | `prompts.py` is the single source of every prompt. It is built from `SiteSettings.data.ai` (`brandVoice`, `audience`, `location`, `pageKinds`, `extraRules`) plus shared SEO principles and exact JSON shapes. New endpoints: `ai/new-page-prompt/`, `ai/section-prompt/`, `ai/page-assist-prompt/` (whole page, with keyword audit), `ai/seo-prompt/` (with rule checks), `ai/keyword-prompt/`, `content|blog/<key>/build-prompt/` (create/edit, expand/override). `ai/dynamic-page-prompt/` is kept as an alias. |
| AI replies | `ai/normalize/` (`ai_normalize.py`) extracts JSON from prose and fences, unwraps markdown links (whole-value and inline) and `content` wrappers, refuses list shrinkage, and maps flat SEO keys to the nested shape. `content|blog/<key>/paste-to-edit/` applies a full-page reply to an existing page (`as_draft`). `paste-to-build` now seeds page SEO from the reply. |
| Sections | `content|blog/<key>/sections/add/` inserts one section at a position. |
| Keywords | `keywords.py` — coverage with stop words and contiguous phrase matching (mirrored in the kit's `lib/keywords.js`). |
| Cache | `revalidation.py`: post-commit signals send a debounced, HMAC-signed webhook with `cms:*` tags, and bump the resolver cache versions (SEO resolve and redirects stay fresh). |
| SEO | `seo/resolve/` (no path) resolves the home page (`seo/home/`). |
| Images | WebP optimisation on upload (`IMAGE_OPTIMIZE*`; the checksum stays on the original for dedupe); usage scanning across all content JSON (`image_usage.py`); `DELETE` returns 409 while in use (`?force=1`). |
| Sitemap | `sitemap.extraPaths` (static routes) and `sitemap.overrides`, validated in settings; `GET sitemap/report/` lists every URL and the reason for each exclusion. |
| Frontend kit | `frontend-kit/`: a Next.js App Router kit (inline primitives, floating admin bar, drafts, AI/JSON panels, SEO panel, page builder, site tools, `/admin`), `sync_kit.py`, `scripts/check-inline.mjs`, `scripts/check-sections.mjs`, `acceptance/acceptance.mjs`. |
| Docs | `FRONTEND_INTEGRATION_PROMPT.md` rewritten as a strict spec (R1–R12, phases, conversion recipe, contract). `AGENTS.md` + `CLAUDE.md` for coding agents. |

---

# Upgrade Notes — CMS + SEO upgrade (`cms-upgrade` branch)

Brings dynamic-cms to parity with (and past) the logic-gate-portfolio
reference: revisioned CMS content, a full SEO engine, server-side JSON-LD,
a generalised Dynamic Page / Section system, richer forms, images, and
redirects. Everything is additive — the original 38 tests and the existing
frontend contract still pass unchanged (now 114 tests).

## Moving an existing clone forward

```bash
git pull                       # or merge the cms-upgrade branch
pip install -r requirements.txt # no new packages; Python 3.12 recommended
python manage.py migrate        # applies 0002–0009, all additive & forward-only
python manage.py test api       # 110 pass
python manage.py check --deploy  # clean once prod env vars are set
```

No data reset. No applied migration was edited. Migration 0003 seeds 22
builtin `ComponentSchema` rows (reversible).

### New env vars (all optional, safe defaults)

`THROTTLE_RATE_LOGIN`, `THROTTLE_RATE_RESOLVE`, `SECURE_PROXY_SSL_HEADER`,
`MAX_IMAGE_BYTES`, `MAX_IMAGE_DIMENSION`, `ALLOW_SVG_UPLOAD`,
`SITEMAP_SOURCES`. See `.env.example`.

## What changed, by area

| Area | Change | Back-compat |
|---|---|---|
| Settings | `ScopedRateThrottle` added to defaults; `login`/`resolve` scopes; always-on `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy`; `URL_FORMAT_OVERRIDE=None` | login now uses `login` scope not `form_submit` |
| `ComponentData` | `+draft_data, status, schema_key, updated_by`; `ComponentRevision`, `ComponentSchema` | plain PATCH/GET byte-identical; `?mode=draft` opt-in |
| Endpoints | `home/schemas/`, `home/<name>/history/`, `publish/`, `revert/` | new |
| `SiteSettings` | canonical shape + PATCH validation; `settings/site/schema/organization/` | blob still free-form + deep-merged; only malformed canonical keys rejected |
| `PageSEO` | `SEOChangeHistory`; `seo/<path>/history/`, `revert/`; **`seo/resolve/<path>/`**; route-ordering fix (specific routes before greedy `<path:path>`) | existing GET/PATCH unchanged |
| SEO audit | `seo_analyzer.py`, `SEOAuditResult`, `seo/analyze/<path>/` + roll-up | new |
| Structured data | `schema_builders.py`, `assemble()`, `validate_schema()`, `seo/validate-schema/` | new |
| Sitemaps | `/robots.txt`, `/sitemap*.xml`, `SITEMAP_SOURCES` registry (project urls) | new |
| Dynamic pages | `ContentPage`, `DynamicSection` (generic FK), `SectionMedia`; `dynamic_pages.py`; `content/paste-to-build/`, `ai/section-schema/`, `ai/dynamic-page-prompt/`, `ai/copy-structure-prompt/`, section CRUD/reorder/media on `content/<path>/` **and** `blog/<slug>/`; publish guard | `BlogPost` kept intact; `+body_mode` (default `legacy`), slug now auto-generates when blank |
| Images | `UploadedImage +alt_text/title/caption/description/credit/license, width/height/file_size/mime_type/format, checksum, focal_x/y, usage`; dedupe; filters; `images/<id>/usage/`; magic-byte + SVG-gate validation | serializer adds `image_url` (absolute) + `duplicate`; existing fields unchanged |
| Forms | server-side validation from `home/form-<name>/`; 18 field types; `FormSubmission +is_spam/ip_hash/user_agent/referer`; `submissions/export/`, `submissions/<id>/` PATCH; configurable honeypot; 60s same-email dedupe; per-form notify override | forms with no definition behave as before (honeypot + persist + notify) |
| Redirects | `+status_code/is_active/hit_count/last_hit_at/notes/created_by/created_at`; `redirects/resolve/`, `redirects/io/`, `?broken=1` | `permanent` still honoured; `status_code` overrides it |

## Master checklist — status

**Backend — CMS:** [x] ComponentData upsert/deep-merge/race guard intact & tested ·
[x] ComponentRevision + history + revert · [x] ComponentSchema + 22 builtins + `home/schemas/` ·
[x] draft/publish + updated_by, back-compat verified · [x] optional schema validation (field-map 400, atomic)

**Backend — SiteSettings:** [x] canonical shape documented + validated · [x] locations / opening hours / geo ·
[x] analytics (GTM/GA4/Pixel/Clarity/Hotjar/LinkedIn) + custom head/body · [x] verification tags ·
[x] `settings/site/schema/organization/` · [x] injected-script fields admin-write, tested

**Backend — SEO engine:** [x] PageSEO canonical shape · [x] SEOChangeHistory + history + revert ·
[x] greedy-route ordering fixed + regression test · [x] `seo/resolve/<path>/` + precedence documented ·
[x] `seo_analyzer.py` technical/content/metadata/schema checks · [x] SEOAuditResult + `seo/analyze/` + roll-up ·
[x] robots.txt from settings · [x] sitemap.xml + index + content-source registry

**Backend — structured data:** [x] schema_builders (org/localbusiness, website+searchaction, breadcrumb,
article, faq, product, service, person, event/howto/video) · [x] `assemble()` + manual override ·
[x] `validate_schema()` + `seo/validate-schema/` · [x] `<` escaped on emit

**Backend — Dynamic Page / Sections:** [x] ContentPage (generic, page_type, body_mode, scheduled) ·
[x] DynamicSection (generic FK) + SectionMedia (slots, pending, required) · [x] SECTION_SCHEMA single source ·
[x] build_ai_prompt + `ai/dynamic-page-prompt/` + `ai/section-schema/` · [x] parse_and_validate (fences,
rejections, {section_index,message}, atomic) · [x] `content/paste-to-build/` · [x] section CRUD + reorder
(id-set validation) + media upload · [x] BlogPost kept intact + same subroutes · [x] publish guard ·
[x] video allowlist backend + prompt; plain-JSX rich text rule · [x] `ai/copy-structure-prompt/`

**Backend — images:** [x] alt/title/caption/description + credit/license · [x] width/height/size/mime/format
(Pillow-optional) · [x] checksum dedupe (returns existing + duplicate:true) · [x] usage refs + `images/<id>/usage/` ·
[x] SVG gated, magic-byte check, size cap · [x] `?category=&unused=1&missing_alt=1` · [x] absolute URLs

**Backend — forms:** [x] extended field types + per-field rules · [x] server-side validation ({errors:{field}} 400) ·
[x] honeypot + throttle + same-email dedupe · [~] file-upload fields — field *type* validated; the
recommended flow is upload via `POST images/` first then submit the returned URL as the field value
(same as the image contract), rather than multipart form posts · [x] submission metadata
(hashed IP, UA, referer, is_read, is_spam) · [x] per-form notify override; mail failure never fails submit ·
[x] submissions filters + CSV/JSON export + read/spam toggle

**Backend — redirects:** [x] status_code + is_active + hit_count + last_hit_at · [x] loop/self rejection intact ·
[x] `redirects/resolve/?path=` (cached) + hit tracking · [x] import/export CSV; `?broken=1`

**Backend — security & infra:** [x] explicit permission_classes on every view + URLconf iteration test ·
[x] DEFAULT_PERMISSION_CLASSES never AllowAny · [x] throttling active + scope-missing regression test ·
[x] pagination on all lists · [x] CORS/CSRF explicit; SECURE_* production-correct, env-gated ·
[x] upload validation (ext + magic bytes + size + SVG gate) · [x] no secrets in repo; .gitignore complete;
.env.example regenerated · [x] check --deploy clean; SECURITY_AUDIT.md

**Backend — quality:** [x] test count 110 (up from 38); suite green · [x] makemigrations --check clean;
one additive migration per phase · [x] existing 38 tests + frontend contract still pass ·
[x] README.md + api/README.md updated · [x] UPGRADE_NOTES.md

**FRONTEND_INTEGRATION_PROMPT.md:** [x] self-contained · [x] behaviour selector · [x] 10 autonomous phases ·
[x] input router (layout / page / component / form / blog) · [x] Paste to Build + Copy Structure ·
[x] Dynamic Page Builder panel wiring · [x] seo/resolve precedence hard rule · [x] SECTION_REGISTRY sync ·
[x] exhaustive SEO reference + per-page checklist · [x] Token-not-Bearer + isAdmin-in-useEffect ·
[x] no dangerouslySetInnerHTML rule + video allowlist · [x] preserve-design rule · [x] prompt template ·
[x] checklist embedded

## The one architectural invariant — unchanged

`home/<name>/`, `settings/site/`, `seo/<path>/` are still name/path-keyed and
upsert-safe: GET on an unknown key → `200 {}`, first PATCH creates, PATCH
deep-merges objects and replaces arrays. `blog/`, `redirects/`, `images/`,
`content/pages/`, sections, and submissions use normal id/slug REST. Every new
endpoint's shape is documented in `FRONTEND_INTEGRATION_PROMPT.md` §13.6.
