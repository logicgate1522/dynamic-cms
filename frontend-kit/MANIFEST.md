# frontend-kit — manifest

The Next.js (App Router) half of dynamic-cms. Copy `src/**` into the app's
`src/` (alias `@/` → `src/`). It needs only `next`, `react`, and Tailwind
(already in the app). The contract it implements is
`../FRONTEND_INTEGRATION_PROMPT.md`.

- **CORE** files are copied verbatim and never edited per site. If one needs
  to change, change it upstream (in the reference frontend), then re-sync.
- **ADAPT** files each have one site hook. Change only what is listed for them
  here.
- `lib/brand.js` is the only per-site constant.

## CORE

| Area | Files | What it does |
|---|---|---|
| Styles + theme | `app/cms.css` | The theme block at the top — five `--cms-*` colours (site palette, ≥4.5:1 with white, R17) and `--cms-first-section-tools-top` (fixed header height + 8px, R15) — is the only part you change, editable outlines, hover-only edit tools. Import it in the root layout after `globals.css`. |
| Cache | `app/api/revalidate/route.js` | Verifies the backend's HMAC webhook and calls `revalidateTag` for `cms*` tags. |
| API | `lib/api.js` | Session + CSRF client: `apiFetch`, `apiRequest`, `getSession`, `login`, `logout`, `uploadImage`, `mediaUrl`, `getPath`/`setPath`, `mergeDefaults`. |
| Redirects | `middleware.js` | CMS redirects, matched from a list cached for a minute. Sends `X-CMS-Frontend` like `lib/cms.js`. |
| Server reads | `lib/cms.js` | Tagged ISR reads (`getContent(s)`, `getSiteSettings`, `resolveSeo`, `getBlogPost(s)`, `getContentPage(s)`, `getPageSeoList`). |
| SEO | `lib/seo.js`, `components/seo/*` | `pageMetadata`, `metadataFromResolved`, `pageJsonLd`, `<PageSeo>`, `<JsonLd>`, `<Analytics>`. |
| Backgrounds | `lib/bgImage.js` | `bgImage(src)` — CSS background images through the Next image optimiser (AVIF/WebP, resized). |
| Visibility | `lib/visibility.js` | `_hidden` flag helpers (`isHidden`, `stripHidden`). `useCms` returns `hidden` and strips hidden items for visitors (R23). |
| Forms | `lib/forms.js` | `submitForm(name, payload, { honeypotField })` — the only submit path: stores in the CMS inbox (with the `_cms` tracking envelope: event id, consent, intent profile), emails Settings → Form notifications via FormSubmit.co with the interest summary, tracks `generate_lead` with the server-matched conversions and the same event id as the server copy (R24, R31). Duplicates aren't counted twice; verification runs send no email. `sendFormEmail` powers the Settings test button. Give every `<form>` `data-cms-form="<name>"`. |
| Tracking | `lib/track.js`, `lib/trackCapture.js`, `lib/intentProfile.js`, `components/seo/Analytics.jsx`, `components/seo/AnalyticsEvents.jsx` | Tags from Settings → Tracking (GTM, GA4, Ads, Meta, TikTok, LinkedIn, Clarity, Hotjar, data layer variables). `track(name, params)` is the only event API: it matches the approved plan's conversions (GET `tracking/config/`), sends each tool its own vocabulary (one Meta event per action carrying every conversion id; GA4 `cv_<id>`), and beacons conversion-level events to `events/`. Capture is automatic: page views, CTA clicks, section views, scroll depth, engaged service views, FAQ opens, form start/error/abandon, outbound links, downloads, contact clicks — attributed to the block via the hidden `{editButton}` marker (R25, R31). `<Analytics>` fetches the tracking config itself; render it inside `<AdminProvider>`. |
| Consent | `lib/consent.js`, `components/seo/ConsentBanner.jsx`, `components/seo/ConsentedTags.jsx` | Consent Mode v2 defaults by region; non-Google tags load only with consent; editable banner (Accept / Reject equally prominent / Choose); `<CookieSettingsLink>` or `data-cms-consent-open` re-opens it; nothing stored on the device without consent (R32). Theme with `--consent-*` CSS variables. |
| Tracking admin | `app/admin/tracking/page.jsx`, `components/admin/tracking/*`, `lib/siteScan.js`, `components/seo/VerifyHarness.jsx` | Site tools → Tracking: Scan site, Build from library, Ask AI, diff, Approve; plan editor with "Pick on page"; tools ("use it for…"), connections, sync, GTM container; Checks (trigger → sent → received in hidden iframes, run history). `VerifyHarness` is inert unless a page is opened with a signed run token (R31). |
| Contacts | `app/admin/contacts/page.jsx`, `components/admin/contacts/ContactsPanel.jsx` | Site tools → Contacts: list and filters, contact detail (interests, stage, source, notes, status, export, erase, merge), groups with a rule builder and Meta sync, retention / pipeline / webhook settings, audit log (R33). |
| Keywords | `lib/keywords.js` | Keyword matching, mirroring `api/keywords.py`. Used by the coverage badge. |
| SEO checks | `lib/seoChecks.js` | The 18 SEO rules (id, tab, field, fix), mirroring `api/prompts.py#seo_rule_checks`. Used by the SEO panel and the whole-page assist. |
| Admin state | `components/cms/AdminProvider.jsx` | Session, edit mode, editables registry, drafts, publish/discard (flushes pending saves first), panels. |
| Inline editing | `components/cms/useCms.jsx`, `components/cms/inline.jsx` | `useCms(name, defaults, options)` → `{data, hidden, setHidden, E, editButton}` (every caller does `if (hidden) return null`, R23), with draft autosave; `E.Text/Image/Item/Add/Link`. |
| Admin bar | `components/cms/AdminBar.jsx`, `SiteTools.jsx`, `Drawer.jsx` | Floating dock plus Site tools (it embeds the `/admin/*` pages). |
| Floating tools | `components/cms/floating.jsx` | The admin layer (end of `<body>`, immune to site zoom) and `useFloating` / `FloatingTools` / `usePopoverPosition`. Every edit tool, the admin bar, its menus and panels render here, so editing never moves, covers or crowds the page (R30). |
| Block editor | `components/cms/SectionEditor.jsx`, `FieldEditor.jsx` | All fields, AI assist, JSON, History. |
| AI | `components/cms/ai.jsx`, `PageAssist.jsx`, `SeoEditPanel.jsx` | Prompt/paste UI. Every prompt comes from the backend; every paste goes through `ai/normalize`. The SEO panel opens on Ask AI; the whole-page assist builds on open and shows live coverage + SEO rules. |
| Collections | `components/cms/CollectionPanel.jsx` | "＋ New <item>" on a collection's index page, entry settings / AI rewrite on its entries. Driven by `SiteSettings.collections`. |
| One-off pages | `components/cms/CreatePage.jsx` | Brief → prompt → paste form, used only by Dashboard → Pages. |
| SSR data | `components/cms/CmsSection.jsx`, `CmsDataProvider.jsx` | Server-fetches published blocks so visitors need no client fetch. |
| Dynamic pages | `components/dynamic/*` (except DynamicContentPage) | Renderer, registry, section adapters (`sections.jsx`, `interactive.jsx`), admin wrapper, per-section tools. |
| Full admin | `app/admin/**`, `components/admin/*` | Dashboard, login, pages, blog, SEO, images, settings, sitemap, redirects, submissions, tracking, contacts. |

The section adapters (`components/dynamic/sections.jsx`, `interactive.jsx`)
are CORE for behaviour but carry the reference site's look. You **may** restyle
their classes to match the site, but you must keep every `T`, `ItemTools`,
`AddItem`, `SlotUpload` and `EditableParagraphs` hook.

## ADAPT

| File | Site hook | What to do |
|---|---|---|
| `lib/brand.js` | `SITE_NAME` | Set the site name, or set `NEXT_PUBLIC_SITE_NAME`. |
| `lib/blog.js` | `ARTICLE_CATEGORIES`; `@/data/articles` (built-in articles shown when the CMS has none) | Set the site's categories. If there are no built-in articles, change the import to `const localArticles = [];`. |
| `components/cms/BlogPostEditor.jsx` | Uses `ARTICLE_CATEGORIES` | Nothing, once `lib/blog.js` is set. |
| `components/cms/DraftPreview.jsx` | `@/components/blog/ArticleHero`, `ArticleBody`, `RelatedArticles` | Point these at the site's own article components (props: `article`; `RelatedArticles` also gets `articles`). If the site has no legacy article components, remove those three imports and replace the `if (found.article) { … }` block with `if (found.article) return found.dynamic ? <DynamicPageAdmin kind="blog" hostKey={found.key} /> : children;`. |
| `components/dynamic/DynamicContentPage.jsx` | `@/data/pages` (`BUILTIN_PAGES`, `builtinSections`) | These are pages that render from code before they exist in the CMS. With none, replace the import with `const BUILTIN_PAGES = {}; const builtinSections = () => [];`. |

## Scripts and tests

| File | Run | Gate |
|---|---|---|
| `scripts/check-inline.mjs` | `node scripts/check-inline.mjs src` | Fails on: literal copy in a `useCms` component (unless `cms-static`, R2); lists keyed by their own text (focus loss, R18); raw CSS `url(` (use `bgImage`); a `useCms` component without the `hidden` guard (R23); form submits outside `lib/forms.js` (R24); a list in a block's defaults without `E.Item` + `E.Add` (R30); `gtag`/`fbq`/`dataLayer.push` outside the kit's tracking modules (R25); a block without `{editButton}` and a `<form>` without `data-cms-form` (R31); visitor storage outside `lib/consent.js` / `lib/intentProfile.js` (R32); a pre-ticked `consent_marketing` (R33); `dangerouslySetInnerHTML` outside `JsonLd` (R10); the secret / `X-CMS-Frontend` in browser code or a `NEXT_PUBLIC_` variable (R19); AI prompt wording (R5); auth tokens in browser storage (R4). |
| `scripts/check-sections.mjs` | `node scripts/check-sections.mjs` (backend running) | Fails when `registry.js` differs from `ai/section-schema/`. |
| `acceptance/package.json` | `cd frontend-kit/acceptance && npm run setup` (once) | The gates' own dependencies (playwright, axe-core, chromium). Then `npm run acceptance`, `npm run audit`, `npm run audit:launch`, `npm run fresh-install` with the env vars from each script's header. |
| `acceptance/run-gates.mjs` | `node run-gates.mjs --frontend <path> --pass 1|2|3 [--report CMS_REPORT.md]` | **The definition of done.** Runs every gate against the production build, maps results to R1–R33 via `rules-map.json`, enforces the three passes (pass 2: same files as a green pass 1 on a fresh build; pass 3: same files + the report). Prints `ALL GATES GREEN — 3 of 3 passes`. Writes `<frontend>/.gates/`. |
| `acceptance/visual.mjs` | `--baseline` in P0, then via run-gates | R9: every sitemap page at 390/1280px vs the P0 baseline (pixelmatch, ≤0.5%). |
| `acceptance/rules-map.json` | — | Rule → gate lines that prove it. Never edit it to make a run pass. |
| `acceptance/tracking-edge.mjs` | See its header (needs an approved plan) | Edge-to-edge browser checks for R31–R33: page views on navigation/back/hash, events firing once, engaged-reading time, nav/outbound/download/contact clicks without personal data, FAQ open-only, form abandon, admins and the engagement switch, consent in every region (opt-in, opt-out, Global Privacy Control, Choose, version bump, Consent Mode updates, phone layout, WCAG), the profile reaching the enquiry, every Tracking panel tab and Contacts screen, admin on a phone. Restores everything. |
| `acceptance/verify-tracking.mjs` | `RUNNER_SECRET=<REVALIDATE_SECRET> node verify-tracking.mjs [--schedule]` | Headless tracking checks: runs every conversion's test in a real browser, records real network requests, reports to the CMS (R31). Schedule it with `acceptance/tracking-checks.github-workflow.yml` or cron. |
| `acceptance/site-audit.mjs` | See its header (`LAUNCH=1` before go-live) | Every page: SEO (titles, descriptions, canonical, OG, one H1, heading order, JSON-LD, alt), search verification `<meta>` for every code set in Settings, broken links, one phone/email site-wide, placeholder text, forms end to end, plus the backend launch check. |
| `acceptance/fresh-install.mjs` | `NODE_MODULES=<a Next app>/node_modules node acceptance/fresh-install.mjs` | Kit self-containment: scaffolds an empty Next app, installs the kit verbatim, applies the ADAPT steps above, adds the spec's layout and a §3 section, then runs `check-inline` and `next build` (with the CMS unreachable). Run it whenever the kit changes. |
| `acceptance/acceptance.mjs` | See its header | End-to-end test: visitor isolation, session login, inline edit → draft → publish → webhook, AI paste normalisation, discard, typing keeps focus, SEO panel + whole-page assist, contrast, hover tools, CMS-page sections, collections, responsive, hide (block/item/section), FormSubmit email + inbox + lead event, GTM + data layer + page_view, admin pages, sign out. Cleans up after itself. |

## Refreshing the kit (maintainers)

The kit is a snapshot of a reference frontend that runs it in production:

```
python frontend-kit/sync_kit.py /path/to/reference-frontend
```

The sync copies exactly the files listed in `sync_kit.py`, writes a
placeholder `lib/brand.js`, and fails if the reference site's brand name
appears in a CORE file. Run the acceptance test against the reference site
before syncing.
