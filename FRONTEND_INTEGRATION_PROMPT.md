# Frontend Integration Spec — dynamic-cms (v3)

You are the frontend integration agent for this CMS. This file is the whole
contract. Follow it exactly. Do not invent endpoints, fields, flows or UI
patterns that are not here, and do not "simplify" any rule. If something here
conflicts with your habits, with the site's existing code or with older docs,
this file wins.

## How to use this file

1. **Read all of it before writing code.** Every rule below exists because it
   was missed once and broke a real site.
2. **There are 30 rules, R1–R30 (§0).** Each rule is stated five times, on
   purpose. A test (`IntegrationSpecTests`) fails the CMS build if any copy is
   missing:
   - the **rule index** (§0.1): one line, its gate, its phase
   - the **rule card** (§0.2): **Must**, **Never**, **Proven by**
   - the **phase** that builds it (§2)
   - the **anti-pattern** that breaks it (§11)
   - the **final checklist** line you tick in your report (§13)
3. **Work in the order of §2** (phases P0–P8). Each phase lists the rules it
   builds, so nothing is left for "later".
4. **Rely on the gates, not memory.** Most rules have an automatic gate. Where
   a rule says "(review)", you check it by hand and say how in your report.
5. **Audit at three levels, not once at the end:**
   - **every change:** after each component, `npm run check:inline` and a
     visual comparison (P3);
   - **every phase:** each phase ends with an **Exit check**. Don't start the
     next phase until it passes;
   - **at the end:** P8 runs three passes: fix until green, a clean
     re-verification with no code changes, then a rule-by-rule audit against
     §13 and §11. Only Pass 2 output counts.

**Definition of done (no exceptions).** All five gates pass against the
running **production build** (`next build && next start`, never `next dev`):

| Gate | Command | Proves |
|---|---|---|
| 1. Build | `next build` | compiles, prerenders, no server/client import mistakes |
| 2. Inline | `npm run check:inline` | no hard-coded copy, index keys, `hidden` guard, no raw `url(`, forms only via `submitForm`, tracking only via `track`, no `dangerouslySetInnerHTML`, no secret / `X-CMS-Frontend` in browser code, no prompt wording, no token in browser storage |
| 3. Sections | `npm run check:sections` (backend running) | renderer registry = backend section types |
| 4. Acceptance | `node frontend-kit/acceptance/acceptance.mjs` | editing, drafts, AI, SEO panel, collections, focus, hover tools, responsive, hide, forms, tracking, auth |
| 5. Site audit | `node frontend-kit/acceptance/site-audit.mjs` → **0 failures** | SEO on every page, links, contact consistency, placeholders, forms end to end |

Until all five are green the work is not finished. Do not report success
early, and never weaken a gate to make it pass.

**Definition of launched.** Additionally, `LAUNCH=1 node site-audit.mjs`
passes, i.e. `GET launch-check/` has no blockers (R22). Blockers that need
real business data are listed for the owner, never invented.

---

## §0 — The rules

Every rule is a MUST. Rule numbers are referenced throughout this file.

### §0.1 Rule index

| # | Area | Rule | Proven by | Built in |
|---|---|---|---|---|
| R1 | Foundation | Install the kit verbatim; change only ADAPT files and the theme block | review, `check:sections` | P1 |
| R2 | Editing | Inline editing first: `E.Text` / `E.Image` / `E.Item` + `E.Add` / `E.Link` | `check:inline`, acceptance | P3 |
| R3 | Editing | Every edit is a draft; only Publish goes live | acceptance | P3 |
| R4 | Foundation | Session cookie + CSRF auth only | `check:inline`, acceptance | P1 |
| R5 | AI | The backend owns every AI prompt | `check:inline`, acceptance | P1, P8 |
| R6 | AI | Every pasted AI/JSON reply goes through `ai/normalize` | acceptance | P1, P8 |
| R7 | Foundation | The signed backend webhook refreshes caches | acceptance | P1 |
| R8 | Foundation | Visitors get zero CMS UI and zero CMS cost | acceptance | P1, P3 |
| R9 | Editing | Defaults = the original copy, verbatim | review (screenshots) | P3 |
| R10 | Editing | Plain text only; no `dangerouslySetInnerHTML` for CMS text | `check:inline` | P3 |
| R11 | Editing | Images are uploaded, never typed | review | P3 |
| R12 | Process | No clarifying questions; take the stated default | report | P0–P8 |
| R13 | Pages | Only collections are buildable from the site | acceptance | P5 |
| R14 | Pages | New entries look exactly like their siblings | acceptance | P5 |
| R15 | Editing | Edit tools never cover the page | acceptance | P1, P3 |
| R16 | AI | SEO panel and whole-page assist are the kit's, unchanged | acceptance | P2, P8 |
| R17 | Look | Admin UI themed via `--cms-*`, never restyled; ≥4.5:1 contrast | acceptance (axe) | P1 |
| R18 | Editing | Typing never loses focus: lists keyed by index | `check:inline`, acceptance | P3 |
| R19 | Foundation | The site's server sends `X-CMS-Frontend` | `check:inline`, acceptance | P1 |
| R20 | Look | Responsive at 390 / 768 / 1280 / 1920px, admin included | acceptance | P3 |
| R21 | Quality | Every page passes the site audit | site-audit | P2, P6, P7 |
| R22 | Launch | No launch-check blockers; never invent business details | `LAUNCH=1` site-audit | P7, P8 |
| R23 | Editing | Blocks, items and sections can be hidden; hidden = gone for visitors | `check:inline`, acceptance | P3, P5 |
| R24 | Leads | Forms use `submitForm()`; email via FormSubmit to Settings address | `check:inline`, acceptance | P4, P7 |
| R25 | Tracking | Tracking configured in Site tools; events via `track()` | `check:inline`, acceptance | P1, P7 |
| R26 | Truth | Every claim is true: no invented stats, ratings, reviews, credentials or price promises | launch-check, site-audit | P0, P3, P7 |
| R27 | Identity | Brand and contact details come from one place, and only what the owner publishes | `check:inline`, site-audit | P0, P3, P7 |
| R28 | Pages | What the business sells is its real list, each a complete, linked page | site-audit, acceptance | P5 |
| R29 | Structure | One primary action, an honest pricing story, keyword-led headings | site-audit, review | P3, P4 |
| R30 | Editing | Edit mode never changes, hides or crowds the page; every list is editable | `check:inline`, acceptance | P1, P3 |

### §0.2 Rule cards

#### R1 — Install the kit verbatim
- **Must:** copy `frontend-kit/src/**` into the app's `src/` unchanged. Edit
  only (a) the ADAPT files listed in `frontend-kit/MANIFEST.md`, as it says,
  (b) the theme block at the top of `app/cms.css` (R17, R15), and (c) the
  classes (never the hooks) of the section adapters `sections.jsx` /
  `interactive.jsx` (§9).
- **Never:** rewrite, "improve", re-implement or hand-roll a kit file — no
  custom admin bar, editor modal, API client, SEO panel, form sender or
  tracking loader. If a kit file seems wrong, report it; don't fork it.
- **Proven by:** review against `MANIFEST.md`; `check:sections`.

#### R2 — Inline editing is the primary way to edit
- **Must:** every visible string in a CMS-wired component is
  `<E.Text path="…" />` (`multiline` for line breaks). Every image has
  `<E.Image>`, every list item `<E.Item>`, every list ends with `<E.Add>`,
  every link's URL has `<E.Link>` right after its text. Panels (All fields,
  AI, JSON, History) are secondary. Subcomponents receive
  `data={{ ...data, E }}` and use `data.E.Text`. CSS background images use
  `bgImage(data.x)` from `lib/bgImage.js`.
- **Never:** a "click Edit → modal form → Save/Cancel" flow as the main path;
  literal copy left in JSX (except `{/* cms-static: reason */}` for units,
  legal marks, the honeypot label, the staff-login link); a bare `E` in a
  function that didn't receive it; a raw `url('/file.png')`; a client-only
  helper imported into a server component (prerender crashes).
- **Proven by:** `check:inline`; acceptance "page has a visible top-level
  inline-editable text", "public data unchanged before publish".

#### R3 — Drafts, then Publish
- **Must:** every edit — inline, panel, AI paste, JSON paste, hide/show,
  section change — autosaves as a draft (`?mode=draft`). Visitors see only
  what was published from the admin bar's Publish menu.
- **Never:** an editor that writes live data; a component with its own Save
  button.
- **Proven by:** acceptance "public data unchanged before publish", "publish
  copies the draft live", "discard drops the draft".

#### R4 — Session cookie + CSRF auth only
- **Must:** `isAdmin` comes from `GET auth/session/`. Every admin fetch goes
  through `apiRequest` / `apiFetch` in `lib/api.js` (`credentials: "include"`
  + `X-CSRFToken`). Host the API on the same site, or set
  `SESSION_COOKIE_SAMESITE=None` + `Secure` (§6.1).
- **Never:** a token in `localStorage` / `sessionStorage` / a cookie you set;
  `isAdmin` derived from client storage; token login in the browser.
- **Proven by:** `check:inline` (no auth token written to browser storage);
  acceptance "session cookie is httpOnly; nothing token-like in web
  storage", "sign out ends the server session".

#### R5 — The backend owns every AI prompt
- **Must:** prompts come from `ai/*-prompt/`, `content/<key>/build-prompt/`
  and `collections/…/prompt/`, shown in the kit's `<PromptBox>`. Site context
  goes into `SiteSettings.ai` (seeded in P7), not into frontend strings.
  Every backend prompt ends with its FINAL CHECK.
- **Never:** prompt wording in the frontend; a prompt without a FINAL CHECK.
- **Proven by:** `check:inline` (fails on prompt wording in the frontend);
  acceptance "prompt restates its rules at the end (FINAL CHECK)".

#### R6 — Every pasted reply is normalised by the backend
- **Must:** pasted AI or JSON goes through `POST ai/normalize/` (or
  `paste-to-build` / `paste-to-edit` / `collections/…/apply/`, which
  normalise server-side) before it touches content.
- **Never:** `JSON.parse` a pasted reply yourself, or write one straight into
  content.
- **Proven by:** acceptance "AI paste normalised (prose, fences, wrapper,
  markdown link)".

#### R7 — The backend webhook refreshes caches
- **Must:** public reads use `lib/cms.js` (ISR with `cms:*` tags);
  `app/api/revalidate/route.js` verifies the HMAC webhook (§6.5).
  `REVALIDATE_SECRET` is identical on both sides; the backend has
  `FRONTEND_REVALIDATE_URL`.
- **Never:** `revalidatePath` / `revalidateTag` from the browser or an editor.
- **Proven by:** acceptance "visitor HTML updated (revalidate webhook)".

#### R8 — Visitors get zero CMS UI and zero CMS cost
- **Must:** published content is server-rendered: wrap server pages in
  `<CmsSection names={[…]}>`; CMS pages render through
  `DynamicPageRenderer`. Admin code paths load only for staff.
- **Never:** admin markup, `contentEditable` or extra client content fetches
  for visitors.
- **Proven by:** acceptance "visitor: no admin bar, no editable spans".

#### R9 — Preserve 100% of design, animation and copy
- **Must:** the current hard-coded copy becomes the module-level `defaults`,
  **verbatim**, so the page is identical before anything is saved. Keep every
  animation, provider, font and wrapper. Keep good existing metadata as the
  `pageMetadata` fallback.
- **Never:** reworded, shortened or "cleaned up" defaults; dropped styling.
- **Proven by:** review (before/after screenshots at 390px and 1280px).

#### R10 — Plain text only
- **Must:** CMS and AI text renders as text; paragraphs come from blank-line
  splits (`EditableParagraphs`).
- **Never:** `dangerouslySetInnerHTML` for CMS or AI text.
- **Proven by:** `check:inline` (fails on `dangerouslySetInnerHTML` anywhere
  but `components/seo/JsonLd.jsx`).

#### R11 — Images are uploaded, never typed
- **Must:** `<E.Image>`, `SlotUpload` or `uploadImage()`; alt text in its own
  key.
- **Never:** an image-URL text input.
- **Proven by:** review.

#### R12 — Don't ask clarifying questions
- **Must:** take the default this file states and list it in the report.
- **Never:** stop to ask about something this file decides. Exception: real
  business details (phone, email, address, company numbers, lead email,
  domain) — ask the owner, never invent them (R22).
- **Proven by:** the report's "defaults taken" list.

#### R13 — Only collections are buildable from the site
- **Must:** a *collection* is a set of pages sharing ONE section structure,
  listed on an index page (articles on /blog, services on /services). Configure
  each in `SiteSettings.collections` (§6.3). "＋ New …" appears only on a
  collection's index page. One-off pages (home, about, contact, legal…) keep a
  fixed structure: admins edit copy, never layout.
- **Never:** a free-form "new page" / "page builder" button on the site;
  section add / move / delete on one-off pages.
- **Proven by:** acceptance "no “＋ New …” on a page that is not a collection
  index", "one-off CMS page: structure is locked".

#### R14 — New entries look exactly like their siblings
- **Must:** a collection's `sections` equals, in order, the section types of
  its existing detail pages. Blank entries copy the newest published sibling's
  fields and list lengths; AI entries are fitted to the template server-side.
- **Never:** a hand-designed entry layout, or a `sections` list that differs
  from the existing pages.
- **Proven by:** acceptance "new entry follows the collection template
  exactly", "fixed template: no add/move/delete on the entry's sections".

#### R15 — Edit tools never cover the page
- **Must:** block pills, item tools, 🔗 link buttons, "＋ Add", "Replace
  image" and Hide chips appear only while their own block / item is hovered,
  focused or tapped (R30 says how they are drawn). The admin bar minimises.
  Set `--cms-first-section-tools-top` in `app/cms.css` to the site's fixed
  header height + 8px, so the first section's tools are never under the
  header.
- **Never:** an always-visible overlay on content; tools a fixed header
  covers.
- **Proven by:** acceptance "edit tools are hidden until their block is
  hovered", "admin bar minimises to a small pill".

#### R16 — SEO and AI parity is fixed
- **Must:** use the kit's SEO panel and whole-page assist unchanged. The SEO
  panel opens on **✦ Ask AI** with the audit prompt built, shows the score bar
  on every tab and lists all 18 checks (`lib/seoChecks.js` ↔
  `prompts.seo_rule_checks`). The whole-page assist builds its prompt on open,
  shows KEYWORD COVERAGE (%, sentence, a chip per section) and OTHER SEO
  RULES (6 ✓/✕), stays live after Apply, and covers CMS-page sections.
  Shared blocks pass `excludeFromKeywordAudit: true`.
- **Never:** a rebuilt or "simplified" panel; Ask AI not first; fewer checks;
  coverage that is stale after Apply.
- **Proven by:** acceptance "SEO panel opens on Ask AI…", "every SEO check is
  listed (18…)", "keyword coverage card shows a percentage", "coverage updates
  live after Apply".

#### R17 — The admin UI is themed, not restyled
- **Must:** set the five `--cms-*` colour variables at the top of
  `app/cms.css` to the site's palette (accent = primary action colour, bar =
  darkest brand surface). Shades need **≥4.5:1 contrast with white**: white
  text sits on `--cms-accent`; `--cms-accent-strong` is text on white. Darken
  the brand colour if needed.
- **Never:** admin markup, layout or wording changed to "match the site";
  colours hard-coded outside the variables.
- **Proven by:** acceptance "admin panels meet WCAG AA contrast".

#### R18 — Typing never loses focus
- **Must:** every `.map` that renders editable fields uses the index as its
  key (`key={i}`).
- **Never:** a key built from the item's text or any admin-editable value
  (`key={item.title}`, `` key={`${item.name}-${i}`} ``): it changes on every
  keystroke, React re-creates the element and the cursor is gone. The kit
  restores focus as a safety net only.
- **Proven by:** `check:inline`; acceptance "typing keeps focus…" and "never
  re-created".

#### R19 — The site's server identifies itself
- **Must:** every server-side CMS request (`lib/cms.js`, `middleware.js` —
  the kit does both) sends `X-CMS-Frontend: <REVALIDATE_SECRET>`, so the one
  IP rendering every page isn't rate-limited as an anonymous visitor.
- **Never:** this header from browser code; the secret in a `NEXT_PUBLIC_`
  variable.
- **Proven by:** `check:inline` (fails on the header or secret outside
  `lib/cms.js` / `middleware.js` / the revalidate route, in a client file, or
  in a `NEXT_PUBLIC_` variable); acceptance runs without 429s.

#### R20 — Responsive on every screen
- **Must:** every converted section keeps its behaviour at 390px, 768px,
  1280px and ≥1920px. Content stays in a max-width container on large
  screens. No horizontal scroll at any width. The admin bar collapses behind
  "More" on phones and panels fit the screen.
- **Never:** a section that overflows on phones or stretches edge to edge on
  large screens.
- **Proven by:** acceptance "responsive: …" checks.

#### R21 — Every page passes the site audit
- **Must:**
  - **SEO:** every sitemap URL returns 200 and is indexable; unique title
    25–65 chars (ideal 50–60) and description 110–165 (ideal 120–160); self
    canonical; og:title/description/image; twitter:card; `<html lang>`;
    exactly one `<h1>`; no skipped heading levels; valid JSON-LD with
    BreadcrumbList (Article/BlogPosting on articles, FAQPage on FAQ pages);
    `alt` on every `<img>`; robots.txt with a Sitemap line on the canonical
    origin.
  - **Consistency:** no broken internal links; ONE phone and ONE email across
    every `tel:` / `mailto:` link and the Organization JSON-LD (all read from
    `SiteSettings.contact`); titles never repeat the brand.
  - **Data:** a default social image (`seoDefaults.defaultOgImage`, used on
    every page without its own); real meta descriptions for every page and
    article.
  - **Forms:** client validation blocks bad input, a valid submit is stored
    as a real (non-spam) submission, people never fill the honeypot.
- **Never:** two `<h1>`s (hidden mobile/desktop twins: make the hidden copy
  `<div role="heading" aria-level={1}>`); a card `<h3>` straight under the
  `<h1>`; contact details typed separately into the footer, contact page and
  JSON-LD.
- **Proven by:** site-audit (0 failures); acceptance "exactly one <h1>".

#### R22 — Nothing launches with a launch-check blocker
- **Must:** `GET launch-check/` (dashboard "Launch readiness") reports no
  blockers: no placeholder text (`[Insert …]`, `example.com` emails,
  `0000 000000`, "New section"…); `seoDefaults.siteUrl` is the live https
  domain; indexing on; lead forms email a real, activated address (R24); the
  cache webhook is configured. Anything left is listed in the report under
  "Needs from the owner".
- **Never:** invent business details to clear a blocker (this is the one
  case where R12 does not apply).
- **Proven by:** `LAUNCH=1 node site-audit.mjs`; the dashboard card.

#### R23 — Admins can hide anything; hidden means gone
- **Must:** every `useCms` block, object list item and CMS-page section can
  be hidden with the kit's **Hide** toggle (block: beside "All fields"; item:
  floating item tools; section: section toolbar). Hiding stores
  `_hidden: true` **as a draft** (R3) and goes live on Publish. `useCms`
  returns `data` with hidden items already removed for visitors
  (`stripHidden`, `lib/visibility.js`) and a `hidden` flag. **Every component
  that calls `useCms` does `if (hidden) return null;` before its markup**; a
  component rendering several blocks guards each one's JSX with its own flag.
  Admins see hidden things dimmed with "Hidden · Show". Blocks that must
  always render (a blog template) pass `{ hideable: false }`.
- **Never:** filter `_hidden` by hand, delete content to "hide" it, or add a
  separate show/hide setting.
- **Proven by:** `check:inline` (hidden guard); acceptance "“Hide” on a
  block / list item / CMS-page section…" and "a hidden … is not in the
  visitor's HTML".

#### R24 — Forms use `submitForm()` and email the address set in Site tools
- **Must:** components call only `submitForm(name, payload, { honeypotField })`
  from `lib/forms.js`. It stores the submission (`POST forms/<name>/submit/`),
  then for real leads (honeypot empty) emails it through **FormSubmit.co** to
  `forms.notifyEmail` and fires `track("generate_lead")`. The address is set
  in **Site tools → Settings → Form notifications**, the FIRST settings card,
  with **Send a test email**. FormSubmit emails an activation link on the
  first send. After activating, the owner replaces the address with
  FormSubmit's private alias before launch (launch-check warns until then); the
  address is never displayed on the site (R27).
- **Never:** `fetch` the submit endpoint or formsubmit.co from a component;
  `mailto:` / EmailJS / Formspree; a hard-coded or invented recipient.
- **Proven by:** `check:inline`; acceptance "a stored submission is emailed
  via FormSubmit to the Settings address", "generate_lead is pushed…", "the
  submission is also in the CMS inbox".

#### R25 — Tracking is configured in Site tools, never in code
- **Must:** GTM, GA4, Google Ads (+ lead label), Meta Pixel, TikTok, LinkedIn
  (+ lead conversion id), Clarity and Hotjar are IDs in **Site tools →
  Settings → Tracking & analytics** (validated server-side), together with
  **data layer variables** (pushed before GTM loads), the Google
  **consent-mode default**, event toggles, "Don't track signed-in admins" and
  custom head/body code. `<Analytics analytics={settings.analytics} />` in the
  root layout renders every tag. Events go through `track(name, params)` in
  `lib/track.js` only. The kit fires `page_view` (in-site navigation),
  `generate_lead` (`{form_name}`) and `contact_click` (`{method, value}`);
  with GTM present it does not also call gtag (no double counting).
- **Never:** a tag snippet or ID hard-coded in the layout; `gtag` / `fbq` /
  `dataLayer.push` called from a component; data layer variables added in code.
- **Proven by:** `check:inline`; acceptance "data layer variables are pushed
  before GTM", "the GTM container from Settings is loaded", "page_view is
  pushed on in-site navigation".

#### R26 — Every claim is true
- **Must:** publish only numbers, ratings, reviews, credentials, memberships,
  awards, guarantees and price claims the owner has confirmed. A new business
  ships with no stats. Placeholder social proof (testimonials, client logos,
  star ratings) ships **hidden** (`_hidden: true` in its defaults, R23) until
  the owner supplies real ones. Describe pricing exactly as the owner does.
  Industry or regulatory facts in the copy (thresholds, deadlines, rates) are
  current and checked against the official source.
- **Never:** invented counts ("250+ clients"), ratings ("4.9/5", ★★★★★),
  satisfaction percentages, years of experience, "trusted by …", awards,
  certifications or accreditation logos the business doesn't hold, made-up
  testimonials (fake reviews are illegal in many countries), or price
  promises ("fixed fees", "from £X") the owner didn't make.
- **Proven by:** launch-check "Confirm these claims are true" (published CMS
  content and visible testimonials) and site-audit `[claims]` on every
  rendered page (code defaults included). With `LAUNCH=1` these fail until
  the owner confirms them (`CLAIMS_CONFIRMED=1`). The report lists every claim
  kept.

#### R27 — Brand and contact details come from one place, and only what the owner publishes
- **Must:** the brand name comes from `SITE_NAME` / `organization.name`.
  Renaming a business means changing settings and brand assets (logo,
  favicon, app icon, default social image) and nothing else; no old name
  survives in code, images, alt text or metadata. Contact channels (phone,
  email, address, hours) come only from `SiteSettings.contact` (or one CMS
  block). An empty field means that channel appears **nowhere**: header,
  footer, legal page, contact page and JSON-LD. Ask the owner which channels
  are public; some businesses publish none and use a form as the only route
  in. The form-notification address (`forms.notifyEmail`) is private and never
  displayed (R24).
- **Never:** a hard-coded `tel:` / `mailto:` link or a phone/address typed
  into a component; a channel the owner didn't approve; the notification
  address on a page; a leftover old brand name or logo.
- **Proven by:** `check:inline` (hard-coded `tel:`/`mailto:`); site-audit
  (every phone/email shown must equal `SiteSettings.contact`; the
  notification address is never shown; one phone/email site-wide);
  launch-check (`formsubmit-alias`).

#### R28 — What the business sells is its real list, each a complete, linked page
- **Must:** one collection entry per service or product line the owner
  actually offers, named the way the owner names it. Every entry follows one
  template (R14) with real substance: a hero with a keyword H1 and (where it
  helps) an "at a glance" card (`highlights`), what's included, who it's
  for, how it works, what the customer needs to know or provide, 5–8 FAQs
  and a call to action — at least 600 words of real content. Each entry is
  linked from its index page (cards are links), from the main navigation
  areas (home, footer) and from related guides, and links to its related
  guide (hero `secondary_*`). Service and FAQPage JSON-LD come
  automatically (§9). Retiring an offering: unpublish or delete its page,
  add a 301 to the nearest page, and remove every link, card, FAQ and article
  that sells it.
- **Never:** a page for something the owner doesn't offer; thin entry pages;
  cards that aren't links; a renamed or removed URL without a 301.
- **Proven by:** site-audit (every published entry linked from its index;
  at least `ENTRY_MIN_WORDS`, default 600, words); acceptance (template fit).

#### R29 — One primary action, an honest pricing story, keyword-led structure
- **Must:** one primary call to action, chosen with the owner and worded
  identically everywhere (header, heroes, section CTAs, footer); secondary
  actions are outline buttons. The contact/enquiry page is a real page: its
  H1 at the top, then what happens next, what to have ready and links to the
  main offerings (at least 120 words besides the form). The form is
  definition-driven (§5.4) and asks for what the owner needs. If prices vary,
  explain what shapes a price instead of inventing one. On every page the H1
  names the topic with its keyword (slogans go in the eyebrow or subtitle),
  the H1 is the first visible heading, and footer titles are styled text,
  not headings. Put the main things (offerings, how the business works, the
  primary action) in the main places (hero, overview section, CTA, footer)
  without departing from the site's theme (R9, R17).
- **Never:** competing CTA wordings; a contact page that is only a form;
  slogan-only H1s; h1–h3 in the footer; a redesign that leaves the existing
  look.
- **Proven by:** site-audit (first visible heading is the H1; no footer
  headings; contact page has content beyond the form); review (grep the CTA
  wording across `src`).

#### R30 — Edit mode never changes, hides or crowds the page
- **Must:** every edit tool — the block pill and Hide, item tools, "＋ Add",
  🔗, "Replace image", section toolbars, labels and notices — is a kit
  floating tool (`components/cms/floating.jsx`): it leaves only a hidden
  zero-size anchor in the page and is drawn in the admin layer at the end of
  `<body>`. So turning editing on moves nothing (outlines only), no
  overlapping section or `overflow-hidden` card can cover or clip a tool, and
  tools stay inside the viewport, below the fixed header, clear of the admin
  bar and outside small targets (they never cover the text they edit or its
  neighbours). The admin bar, its menus and every panel live in the same
  layer, unaffected by any zoom/scale the site puts on the page: the bar is
  always **one line** (actions that don't fit move into "More"; none are
  dropped) and every menu opens fully on screen. **Every list a block owns is
  editable:** `<E.Item>` on each item and `<E.Add>` for the list, nested lists
  included (cards, reviews, steps, links, logos…). Interactive wrappers
  (carousels, `pointer-events-none` layers, whole-card overlay links) let an
  admin reach the editable content while editing (e.g. the visible card
  accepts clicks; overlay links render only when editing is off).
- **Never:** edit buttons placed in the page flow or positioned inside a
  section; z-index fights with the site; a bar that wraps or hides actions;
  menus positioned inside a transformed container; a list that can't grow or
  shrink; site markup that blocks clicks on editable text in edit mode.
- **Proven by:** `check:inline` (every list in a block's defaults has
  `E.Item` and `E.Add`, or a `cms-fixed-list: reason` comment); acceptance
  "edit tools take no layout space", "editing on/off moves nothing in the
  header", "edit tools are hidden until their block is hovered", "block tools
  are never covered", "the admin bar is one line" (desktop, phone, 1920px),
  "“More” opens fully on screen with every action clickable".

---

## §1 — Modes

| Attached with this file… | Do this |
|---|---|
| A whole frontend repo, no other instruction | **§2 Autonomous mode**: all phases, in order. Report after each phase, then continue. |
| One or more specific files | **§5 Input router**, once per file, in dependency order (layout → pages → sections → forms → lists → blog). Every rule still applies. |
| A brief, screenshot or markup for a new page | **§7** (collections / one-off pages) or **§8 Copy Structure** (from a reference). |
| One phase heading from §2 | Run only that phase, end green, stop. |

Framework: Next.js App Router (`src/app`), React 18+, Tailwind. On another
framework, map each concept (server components, `generateMetadata`, route
handlers) to its equivalent and say so in the report. Kit files assume the
`@/` alias → `src/`.

---

## §2 — Autonomous mode (whole repo)

Each phase ends green: build passes, no hydration warnings, public pages
unchanged. Each phase names the rules it builds; tick them as you go.

**P0 — Audit (no code changes). Rules: R12, R26, R27.** List the framework and
version, router, styling, every route, every section component and its
hard-coded copy, lists, images, links, forms and their submit code (R24),
tracking snippets and IDs (R25), existing SEO/metadata, the fixed-header
height (R15), and every phone number / email / address in the code (R21,
R22). List every claim on the site (numbers, ratings, testimonials,
credentials, price promises — R26), what the business actually offers (R28)
and which contact channels the owner wants public (R27). Output one table: `file → what's hard-coded → useCms name → phase`, and
a list of the business details you'll need from the owner.

**Exit check P0:** the audit table covers every file under `src/app` and `src/components` (count them); the owner-details list exists. No file changed (`git status` clean).

**P1 — Install the kit. Rules: R1, R4, R5, R6, R7, R8, R15, R17, R19, R25, R30.**
1. Copy `frontend-kit/src/**` into `src/` (R1). Do not overwrite site files
   that aren't in the manifest; if a path collides, stop and report it. The
   kit brings the API client (R4), prompt/paste UI (R5, R6), revalidate route
   (R7), server reads with `X-CMS-Frontend` (R19) and SSR data (R8).
2. Set `SITE_NAME` in `src/lib/brand.js` (or `NEXT_PUBLIC_SITE_NAME`). At the
   top of `src/app/cms.css`, set the five `--cms-*` colours to the site's
   palette at ≥4.5:1 contrast (R17) and `--cms-first-section-tools-top` to the
   fixed header height + 8px (R15).
3. Copy `frontend-kit/scripts/check-inline.mjs` and `check-sections.mjs` to
   `scripts/` and add the npm scripts
   `"check:inline": "node scripts/check-inline.mjs src"` and
   `"check:sections": "node scripts/check-sections.mjs"`.
4. Env (`.env.local`): `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`,
   `REVALIDATE_SECRET` (the same value as the backend; never `NEXT_PUBLIC_`).
   On the backend: `FRONTEND_REVALIDATE_URL=<site>/api/revalidate`, plus the
   site origin in `CORS_ALLOWED_ORIGINS` **and** `CSRF_TRUSTED_ORIGINS`.
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
   Keep every existing provider, font and wrapper. **Delete** every
   hard-coded tracking snippet (GTM, gtag, Meta Pixel, …) and note its IDs
   for P7 (R25). `generateMetadata` and `generateViewport` come from
   `settings/site/`, as in §5.1.
6. Add a footer link `Staff login {/* cms-static: admin entry point */}` →
   `/admin/login?next=<current path>` with `rel="nofollow"`. Use `usePathname`;
   on `/admin*` routes, link without `next`.

**Exit check P1:** `next build` passes; `npm run check:inline` runs (it may still list unconverted copy); `/admin/login` signs in and the admin bar appears; `grep -rn "gtag\|fbq\|GTM-" src/app` finds no hard-coded tag; the site looks unchanged.

**P2 — Per-route metadata. Rules: R16, R21.** Every route:
`generateMetadata()` = `pageMetadata("/<path>", fallback)` (from
`lib/seo.js`, which reads `seo/resolve/`), and `<PageSeo path="/<path>" />`
once in the page. That emits JSON-LD and gives the admin bar its SEO button
(R16). Fix heading structure now: one `<h1>`, no skipped levels (R21).

**Exit check P2:** every route file exports `generateMetadata` and renders `<PageSeo>` (grep both, compare counts with the route list); the SEO button opens on each route.

**P3 — Convert every section (§3 recipe). Rules: R2, R3, R8, R9, R10, R11,
R15, R18, R20, R23, R26, R27, R29, R30.** One component at a time. After each one,
`npm run check:inline` passes for it, it renders identically (R9), it
returns `null` when `hidden` (R23), its lists are index-keyed (R18), and it
works at 390px, 768px, 1280px and 1920px (R20). Contact details come from
`SiteSettings.contact` or one shared block, never typed twice, and only the
channels the owner publishes (R21, R27). Unconfirmed claims are removed and
placeholder social proof ships hidden (R26). Every CTA uses the one primary
action wording, H1s carry the keyword and footer titles are not headings
(R29). Every list gets `E.Item` + `E.Add`, and carousels / overlay links
stay editable with editing on (R30).

**Exit check P3:** `npm run check:inline` reports **0 problems** for the whole of `src`; `next build` passes; side-by-side screenshots of every page at 390px and 1280px match the originals (R9); with editing on, each converted block shows Hide and All fields on hover.

**P4 — Forms (§5.4). Rules: R24, R29.** Every form submits with `submitForm()`
from `lib/forms.js`; the recipient is `forms.notifyEmail` (Settings → Form
notifications). Delete all old submit code (fetch, `mailto:`, EmailJS,
Formspree, a hard-coded FormSubmit URL). Make the contact/enquiry page a
real page around the form: H1 first, what happens next, what to have ready,
links to the main offerings (R29).

**Exit check P4:** `grep -rn "fetch(.*submit\|formsubmit\|mailto:.*body" src --include=*.jsx` finds nothing outside `lib/forms.js`; each form submits once in the browser and the entry appears in Dashboard → Form inbox.

**P5 — Collections, CMS pages and blog. Rules: R13, R14, R23, R28.** First decide
the collections (R13). A page type IS a collection when there is an index page
listing entries AND (two or more detail pages share one section structure, OR
it is a blog/news/projects-style list that will grow). For each one:
1. Make every detail page a CMS page (`body_mode: "dynamic"`) rendered by the
   kit's renderer at `/<pathPrefix>/<slug>`, including its existing entries
   (seed them).
2. Configure it in `SiteSettings.collections` (§6.3, seeded in P7):
   - `sections` = the existing detail pages' section types, in order (R14)
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
5. Offerings (R28): one entry per service or product line the owner offers,
   each on the full template (≥600 words, keyword H1, link to its guide),
   linked from the index cards, home, footer and contact page. Retired
   offerings get a 301 and lose every link.

Then the catch-all route for CMS pages, using
`components/dynamic/DynamicContentPage.jsx` (ADAPT), which wraps the
server-rendered `DynamicPageRenderer` in `DynamicPageAdmin`. That gives admins
inline section editing, per-section AI, section Hide (R23) and (on collection
entries) the collection panel. Dynamic blog posts work the same way with
`kind="blog"`.

**Exit check P5:** `npm run check:sections` passes; `GET collections/` lists every collection with the right `count`; "＋ New …" shows only on the collection index pages; every existing detail page renders from the CMS identically.

**P6 — Sitemap, robots, redirects. Rules: R21.** `app/sitemap.js` builds
from static routes, `seo/`, `blog/` and `content/pages/`, honouring
`sitemap.include:false` and `robots.index:false`. `app/robots.js` reads
`settings/site/`. The middleware calls `redirects/resolve/?path=`. Add the
static routes to `SiteSettings.sitemap.extraPaths` so the backend sitemap
report covers them.

**Exit check P6:** `/sitemap.xml` lists every public route and no noindex page; `/robots.txt` has a Sitemap line on the canonical origin; a CMS redirect returns its status.

**P7 — Seed. Rules: R5, R21, R22, R24, R25, R26, R27.** A `scripts/seed-cms.mjs` that
fills the CMS:
- site settings, **including the `ai` block (R5) and `collections` (§6.3)**
- `seoDefaults.defaultOgImage`: a 1200×630 brand card (R21)
- `SiteSettings.contact` with ONLY the channels the owner publishes (R21,
  R27) — possibly none, if the owner wants the form to be the only route
- no invented claims; placeholder testimonials stored hidden (R26)
- form definitions
- `forms.notifyEmail` ONLY if the owner gave a real address (never invent
  one; otherwise it is a launch blocker, R22/R24)
- `analytics`: the tracking IDs removed from code in P1 (R25)
- per-route `seo/<path>/` with real meta descriptions (120–160 chars) for
  every page and article (R21)
- `sitemap.extraPaths`

It must be idempotent. Without `--force` it fills only what is still missing
(at any depth) and never overwrites an admin's edit. It never writes invented
business details (R22).

**Exit check P7:** run the seed **twice**; the second run changes nothing (idempotent); `GET settings/site/` shows `ai`, `collections`, `contact`, `seoDefaults.defaultOgImage` and the moved `analytics` IDs; no invented business detail was written.

**P8 — Verify (three passes). Rules: all, R1–R30.** One green run is not
proof: a fix for one gate can break another, and some rules have no
automatic gate. Do all three passes, in order.

1. **Pass 1 — fix until green.** Production build (`rm -rf .next && next
   build && next start`), backend running, seed applied. Run the five gates.
   Fix every failure at its cause (never by weakening a gate, skipping a
   check or deleting content), then rerun **all five**, not just the one that
   failed. Repeat until all five are green in the same run.
2. **Pass 2 — clean re-verification.** Without touching the code: delete
   `.next`, rebuild, restart, rerun the seed (it must change nothing), then run
   all five gates again from scratch. If anything fails, or you change any file
   during this pass, go back to Pass 1. The outputs you report come from this
   pass.
3. **Pass 3 — rule-by-rule audit.** Walk §13 line by line. For each rule, write
   its evidence: the gate output line that proves it, or for "(review)" lines
   what you checked and how (screenshots compared for R9, the upload path for
   R11, the MANIFEST diff for R1). Then read §11 top to bottom and confirm that
   none of the anti-patterns exist in the code (search for each one). Any gap
   sends you back to Pass 1.

Then report:
1. the five gate outputs from Pass 2, verbatim
2. the §13 checklist, one line per rule, ticked, with its evidence (Pass 3)
3. "Defaults taken" (R12)
4. "Needs from the owner": every launch-check blocker that needs real
   business data or production config (R22), plus the FormSubmit activation
   step (R24)

**Exit check P8:** Pass 2 ran with no file changes after it; every §13 line
has evidence; nothing in §11 exists in the code.

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
  const { data, hidden, E, editButton } = useCms("pricing", defaults, { label: "Pricing" });
  if (hidden) return null; // R23 — admins hid this block
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

Rules (this recipe builds R2, R8, R9, R10, R11, R18, R20 and R23 — every
step is mandatory):

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
13. **Hidden guard (R23):** destructure `hidden` from `useCms` and return
    `null` before the section's markup:
    ```jsx
    const { data, hidden, E, editButton } = useCms("pricing", defaults, { label: "Pricing" });
    if (hidden) return null;
    ```
    Hidden list items are already removed from `data` for visitors — just
    `map` over it. A component rendering several blocks guards each one
    (`{!faqHidden ? <section>…</section> : null}`). `check:inline` fails a
    component that calls `useCms` without using `hidden`.

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
  reverts, and paste is plain text. Floating hover tools (R15, R30): item tools (↑ ↓ ⧉ ✕),
  "＋ Add", 🔗 link editor, "Replace image", and the block's "All fields" pill.
- **Hide / Show (R23):** a "Hide" chip beside every block's "All fields"
  pill, a hide button in every object item's tools, and "Hide" in every
  CMS-page section toolbar. Hidden things stay visible to admins (dimmed,
  outlined, labelled "Hidden · Show") and disappear for visitors after
  Publish.
- **Site tools → Settings** opens on **Form notifications** (R24: address,
  subject, Send a test email) then **Tracking & analytics** (R25: IDs, data
  layer variables, events, consent default, custom code).
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
  or `section:<id>`) and `data-cms-path`. Hide toggles carry
  `data-cms-action="toggle-hidden" | "toggle-item-hidden" | "toggle-section-hidden"`
  and hidden things carry `data-cms-hidden`. The admin bar root has
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
- Submit with `submitForm(name, payload, { honeypotField })` from
  `lib/forms.js` — never a raw fetch (R24). It returns
  `{ ok, status, errors, message }`; show `errors[field]` under each field.
  Validate on the client for UX, but trust the server's errors.
- The email goes to Settings → Form notifications (`forms.notifyEmail`) via
  FormSubmit.co, and `generate_lead` is tracked — both done by `submitForm`.
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
| GET/PATCH | `settings/site/` | public / admin | Site identity, SEO defaults, `forms` (R24), `analytics` (R25), `ai`, `collections`, `sitemap` (validated) |
| GET | `launch-check/` | admin | `{ready, items:[{id, level: blocker\|warning, title, detail}]}` (R22) |
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
  // R24 — Settings → Form notifications (first card). FormSubmit.co recipient:
  // a plain email, or the FormSubmit alias (16–64 letters/digits) after activation.
  "forms": { "notifyEmail": "", "subjectPrefix": "New website enquiry" },
  // R25 — Settings → Tracking & analytics. Every ID is format-validated.
  "analytics": {
    "gtmId": "GTM-XXXXXXX", "ga4Id": "G-XXXXXXXXXX",
    "googleAdsId": "AW-123456789", "googleAdsLeadLabel": "",          // label needs googleAdsId
    "metaPixelId": "1234567890123456", "tiktokPixelId": "", "linkedinPartnerId": "",
    "linkedinLeadConversionId": "", "clarityId": "", "hotjarId": "",
    "dataLayer": [ { "key": "site_section", "value": "marketing" } ],  // pushed before GTM
    "consentDefault": "",                                             // "" | "granted" | "denied"
    "events": { "pageView": true, "lead": true, "contactClicks": true },
    "excludeAdmins": true,
    "customHead": [], "customBodyStart": [], "customBodyEnd": []
  },
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
  paragraphs (R10); lines starting `- ` render as a ticked list (still plain
  text).
- Optional fields every adapter supports (all plain text, all inline-editable):
  - `hero`: `eyebrow`, `secondary_text` / `secondary_href` (an outline button,
    e.g. to the matching guide), `highlights_title` + `highlights`
    `[{label, value}]` (an "at a glance" card beside the copy)
  - `rich_text`: `eyebrow`; the heading sits beside the text on large screens
  - `cta`: `secondary_text` / `secondary_href`
  Collection templates should use them consistently across every entry (R14):
  e.g. every service page's hero has the same four highlights.
- Service pages (`page_type: "service"`) and any page with a `faq` section get
  Service / FAQPage JSON-LD automatically from their published content —
  don't configure it by hand.

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

GSC + Bing Webmaster via `settings/site/verification`. Every tracking tag
via IDs in `analytics` (R25), rendered by `<Analytics>`, events via
`track()`. Consent: set `analytics.consentDefault` to `denied` where the
law requires opt-in, and let the consent banner/GTM update it.
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

One line per rule: the mistake that breaks it. If you catch yourself doing
any of these, stop and undo it.

- **R1** Rewriting, "improving" or re-implementing a kit file, or hand-rolling
  an admin bar, modal, API client, SEO panel, form sender or tag loader.
- **R2** A modal / "Edit → form → Save" as the main way to change copy;
  literal copy without `cms-static`; a bare `E` in a subcomponent; a raw
  `url('/big.png')`; a client-only helper imported into a server component.
- **R3** An editor that writes live data, or a component with its own Save
  button.
- **R4** A token in `localStorage`, or `isAdmin` derived from client storage.
- **R5** Prompt text written in the frontend, or a backend prompt without its
  FINAL CHECK.
- **R6** A paste box that `JSON.parse`s and writes directly.
- **R7** `revalidatePath` / `revalidateTag` called from the browser or an
  editor.
- **R8** Admin markup, `contentEditable` or extra client content fetches for
  visitors.
- **R9** Defaults that differ from the original copy, so the page changes
  before any edit.
- **R10** `dangerouslySetInnerHTML` for CMS or AI text.
- **R11** Image URLs typed into text fields instead of uploaded.
- **R12** Stopping to ask about something this spec already decides — or,
  the reverse, inventing business details instead of asking.
- **R13** A "new page" / "page builder" button on the site, or section add /
  move / delete on one-off pages.
- **R14** A collection entry whose layout differs from its siblings, or a
  `sections` list that doesn't match the existing detail pages.
- **R15** Edit chrome always visible on top of content, or a first-section
  toolbar hidden under the fixed header.
- **R16** A rebuilt or "simplified" SEO panel or whole-page assist: Ask AI
  not first, no score bar, fewer than 18 checks, coverage stale after Apply.
- **R17** Admin colours hard-coded to the site instead of the `--cms-*`
  variables, admin markup changed to match the site, or an accent too light
  for white text.
- **R18** A list keyed by its own editable text, so fields lose focus after
  one keystroke.
- **R19** Server-side CMS fetches without `X-CMS-Frontend`, or the secret in
  browser code.
- **R20** A section that overflows on phones or stretches edge to edge on
  large screens, or admin panels wider than a phone.
- **R21** Duplicate or brand-doubled titles; descriptions outside 110–165
  chars; a page without og:image; two `<h1>`s (hidden mobile/desktop twins);
  a card `<h3>` straight under the `<h1>`; broken links; a sitemap URL that
  404s or is noindex; contact details that differ between footer, contact
  page and JSON-LD; a form that sends empty data or stores real leads as
  spam.
- **R22** Launching with placeholder business details, a localhost site URL,
  indexing off, or lead forms nobody is notified about.
- **R23** A CMS component without `if (hidden) return null`; hidden content
  left in the visitor HTML; "hiding" by deleting content; a hand-rolled
  show/hide flag.
- **R24** A form posted with its own `fetch`, `mailto:`, EmailJS / Formspree
  or a hard-coded recipient instead of `submitForm()` and the Settings
  address; a lead address invented to clear the launch check.
- **R25** A tracking snippet or ID hard-coded in the layout; `gtag` / `fbq` /
  `dataLayer.push` called from a component; a data layer variable added in
  code instead of Settings → Tracking.
- **R26** Invented stats, ratings, testimonials, credentials or "fixed fees";
  placeholder reviews left visible; out-of-date industry facts.
- **R27** A hard-coded phone/email/address, a contact channel the owner
  didn't approve, the notification address on a page, or a leftover old
  brand name/logo.
- **R28** Pages for things the owner doesn't offer, thin entry pages, cards
  that don't link, or a removed URL without a 301.
- **R29** Competing CTA wordings, a contact page that is only a form, slogan-only
  H1s, headings in the footer, or a redesign that leaves the site's look.
- **R30** Edit buttons in the page flow (editing shifts the layout), tools a
  neighbouring section covers, an admin bar that wraps or hides actions, menus
  that open off-screen, a list that can't be added to or removed from, or a
  carousel / overlay link that blocks editing.

## §12 — Fill-in prompt

```
Integrate this frontend with dynamic-cms. Follow FRONTEND_INTEGRATION_PROMPT.md
exactly — every rule R1–R30, no exceptions. Read the whole file first.
Kit: dynamic-cms/frontend-kit.
Backend: <NEXT_PUBLIC_API_URL>   Site: <NEXT_PUBLIC_SITE_URL>
Do: <Autonomous mode | Input router for: <files>>
Finish only when the five gates pass against the production build:
next build, check:inline, check:sections, acceptance.mjs (every check),
site-audit.mjs (0 failures). Then report, in this order:
  1. the five gate outputs, verbatim
  2. the §13 checklist, one line per rule, ticked, with evidence
  3. Defaults taken
  4. Needs from the owner (launch blockers, FormSubmit activation)
```

## §13 — Final checklist (every rule, one more time)

Walk this list in P8 Pass 3, after the clean re-verification. Every line
must be true and carry evidence. Each line names the
gate that proves it; a "(review)" line is yours to verify by hand — say how.

**The rules**
- [ ] **R1** The kit is installed verbatim; only MANIFEST ADAPT files, the `cms.css` theme block and adapter classes changed. (review, `check:sections`)
- [ ] **R2** Every visible string in a CMS component is `<E.Text>`; images, lists and links use `E.Image` / `E.Item` + `E.Add` / `E.Link`; backgrounds use `bgImage()`. No modal-first editing. (`check:inline`, acceptance)
- [ ] **R3** Every edit saves as a draft; only Publish makes it live. (acceptance "public data unchanged before publish")
- [ ] **R4** Session cookie + CSRF only; no token in browser storage. (`check:inline`, acceptance "session cookie…")
- [ ] **R5** No prompt text in the frontend; prompts come from the backend and end with a FINAL CHECK. (`check:inline`, acceptance "FINAL CHECK")
- [ ] **R6** Every pasted AI/JSON reply goes through `ai/normalize/` or a server paste endpoint. (acceptance "AI paste normalised")
- [ ] **R7** The webhook route is installed, and visitors see a publish without a rebuild. (acceptance "visitor HTML updated")
- [ ] **R8** Visitors get zero CMS UI and no extra content fetches. (acceptance "visitor: no admin bar")
- [ ] **R9** Defaults are the original copy, verbatim; the page looks identical before any edit. (review: screenshots)
- [ ] **R10** No `dangerouslySetInnerHTML` for CMS/AI text. (`check:inline`)
- [ ] **R11** Images are uploaded, never typed as URLs. (review)
- [ ] **R12** No clarifying questions were needed; defaults are listed in the report; no business detail was invented. (report)
- [ ] **R13** Collections are decided and seeded; "＋ New …" appears only on their index pages; one-off pages are structure-locked. (acceptance "collections…", "structure is locked")
- [ ] **R14** New entries follow the template exactly, like their siblings. (acceptance "new entry follows the collection template exactly")
- [ ] **R15** Edit tools are hover-only, never cover content or sit under the header; the bar minimises. (acceptance "edit tools are hidden…", "admin bar minimises")
- [ ] **R16** The SEO panel opens on Ask AI with its prompt built and shows 18 checks; the whole-page assist shows coverage %, chips and 6 rules, live after Apply. (acceptance SEO + AI assist checks)
- [ ] **R17** The `--cms-*` theme variables are set to the site palette, at ≥4.5:1 contrast with white. (acceptance "admin panels meet WCAG AA contrast")
- [ ] **R18** Lists with editable fields are index-keyed; typing never loses focus. (`check:inline`, acceptance "typing keeps focus")
- [ ] **R19** `lib/cms.js` and `middleware.js` send `X-CMS-Frontend`; the secret never reaches the browser. (`check:inline`; acceptance shows no 429s)
- [ ] **R20** Every page works at 390px, 768px, 1280px and 1920px with no horizontal scroll; admin panels fit a phone. (acceptance "responsive…")
- [ ] **R21** `site-audit.mjs` reports 0 failures: SEO on every page, links, one phone/email everywhere, default og:image, forms end to end. (site-audit)
- [ ] **R22** Launch readiness has no blockers, or every remaining blocker is listed under "Needs from the owner". (`LAUNCH=1` site-audit, dashboard card)
- [ ] **R23** Blocks, list items and CMS-page sections can be hidden; every `useCms` component returns `null` when `hidden`; hidden content is absent from visitor HTML after Publish. (`check:inline`, acceptance "Hide …")
- [ ] **R24** Every form uses `submitForm()`; leads are stored, emailed via FormSubmit to Settings → Form notifications (first settings card, test button works) and tracked. (`check:inline`, acceptance "emailed via FormSubmit…")
- [ ] **R25** All tracking IDs, data layer variables, consent default and custom code live in Settings → Tracking; `<Analytics>` renders them; events go through `track()` only. (`check:inline`, acceptance "GTM container…", "page_view…")
- [ ] **R26** Every claim on the site is confirmed by the owner; none invented; placeholder social proof hidden; industry facts current. (launch-check "claims", site-audit `[claims]`)
- [ ] **R27** Brand and contact details come from settings only; only owner-approved channels appear; the notification address is never shown. (`check:inline`, site-audit contact checks)
- [ ] **R28** One complete page per real offering, each ≥600 words, linked from its index, home and footer, with its guide; retired URLs 301. (site-audit collections, acceptance)
- [ ] **R29** One primary CTA wording site-wide; contact page has real content; keyword H1 first; no footer headings; pricing explained when it varies. (site-audit headings/contact page, review)
- [ ] **R30** Editing on moves nothing; tools float, never covered, inside the screen; the bar is one line at every width; every list has item tools and "+ Add". (`check:inline`, acceptance edit-mode checks)

**Also checked by the gates**
- [ ] Exactly one `<h1>` in each page's HTML. (acceptance, site-audit)
- [ ] No critical accessibility violations for visitors. (acceptance, axe)
- [ ] No uncaught page errors. (acceptance)

**Setup**
- [ ] Root layout: `cms.css`, `AdminProvider`, `AdminBar`, `Analytics`; staff login link with `?next=`
- [ ] Every route: `generateMetadata` via `pageMetadata`, plus `<PageSeo>`
- [ ] Registry matches the backend (`check:sections` passes)
- [ ] Forms are definition-driven, with editable copy and a honeypot, and submit with `submitForm()`
- [ ] CMS pages and dynamic blog posts render through `DynamicPageAdmin`
- [ ] Sitemap and robots honour SEO flags; redirects run in middleware; `sitemap.extraPaths` seeded
- [ ] `SiteSettings.ai`, `collections`, `contact`, `seoDefaults.defaultOgImage` and `analytics` seeded; seed is idempotent
- [ ] Env: `REVALIDATE_SECRET` on both sides, `FRONTEND_REVALIDATE_URL`, CORS + CSRF trusted origins
