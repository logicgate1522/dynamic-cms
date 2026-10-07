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
| Styles + theme | `app/cms.css` | The five `--cms-*` theme variables (set them to the site palette — the only styling you change), editable outlines, hover-only edit tools. Import it in the root layout after `globals.css`. |
| Cache | `app/api/revalidate/route.js` | Verifies the backend's HMAC webhook and calls `revalidateTag` for `cms*` tags. |
| API | `lib/api.js` | Session + CSRF client: `apiFetch`, `apiRequest`, `getSession`, `login`, `logout`, `uploadImage`, `mediaUrl`, `getPath`/`setPath`, `mergeDefaults`. |
| Server reads | `lib/cms.js` | Tagged ISR reads (`getContent(s)`, `getSiteSettings`, `resolveSeo`, `getBlogPost(s)`, `getContentPage(s)`, `getPageSeoList`). |
| SEO | `lib/seo.js`, `components/seo/*` | `pageMetadata`, `metadataFromResolved`, `pageJsonLd`, `<PageSeo>`, `<JsonLd>`, `<Analytics>`. |
| Keywords | `lib/keywords.js` | Keyword matching, mirroring `api/keywords.py`. Used by the coverage badge. |
| SEO checks | `lib/seoChecks.js` | The 18 SEO rules (id, tab, field, fix), mirroring `api/prompts.py#seo_rule_checks`. Used by the SEO panel and the whole-page assist. |
| Admin state | `components/cms/AdminProvider.jsx` | Session, edit mode, editables registry, drafts, publish/discard (flushes pending saves first), panels. |
| Inline editing | `components/cms/useCms.jsx`, `components/cms/inline.jsx` | `useCms(name, defaults, options)` → `{data, E, editButton}`, with draft autosave; `E.Text/Image/Item/Add/Link`. |
| Admin bar | `components/cms/AdminBar.jsx`, `SiteTools.jsx`, `Drawer.jsx` | Floating dock plus Site tools (it embeds the `/admin/*` pages). |
| Block editor | `components/cms/SectionEditor.jsx`, `FieldEditor.jsx` | All fields, AI assist, JSON, History. |
| AI | `components/cms/ai.jsx`, `PageAssist.jsx`, `SeoEditPanel.jsx` | Prompt/paste UI. Every prompt comes from the backend; every paste goes through `ai/normalize`. The SEO panel opens on Ask AI; the whole-page assist builds on open and shows live coverage + SEO rules. |
| Collections | `components/cms/CollectionPanel.jsx` | "＋ New <item>" on a collection's index page, entry settings / AI rewrite on its entries. Driven by `SiteSettings.collections`. |
| One-off pages | `components/cms/CreatePage.jsx` | Brief → prompt → paste form, used only by Dashboard → Pages. |
| SSR data | `components/cms/CmsSection.jsx`, `CmsDataProvider.jsx` | Server-fetches published blocks so visitors need no client fetch. |
| Dynamic pages | `components/dynamic/*` (except DynamicContentPage) | Renderer, registry, section adapters (`sections.jsx`, `interactive.jsx`), admin wrapper, per-section tools. |
| Full admin | `app/admin/**`, `components/admin/*` | Dashboard, login, pages, blog, SEO, images, settings, sitemap, redirects, submissions. |

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
| `components/cms/DraftPreview.jsx` | `@/components/blog/ArticleHero`, `ArticleBody` | Point these at the site's own article components (same props: `article`). If the site has no legacy article bodies, drop that branch and keep the `DynamicPageAdmin` branch. |
| `components/dynamic/DynamicContentPage.jsx` | `@/data/pages` (`BUILTIN_PAGES`, `builtinSections`) | These are pages that render from code before they exist in the CMS. With none, replace the import with `const BUILTIN_PAGES = {}; const builtinSections = () => [];`. |

## Scripts and tests

| File | Run | Gate |
|---|---|---|
| `scripts/check-inline.mjs` | `node scripts/check-inline.mjs src` | Fails on any literal copy left in a `useCms` component (unless marked `cms-static`). |
| `scripts/check-sections.mjs` | `node scripts/check-sections.mjs` (backend running) | Fails when `registry.js` differs from `ai/section-schema/`. |
| `acceptance/acceptance.mjs` | See its header | End-to-end test: visitor isolation, session login, inline edit → draft → publish → webhook, AI paste normalisation, discard, SEO AI, CMS-page section editing, create page, admin pages, sign out. Cleans up after itself. |

## Refreshing the kit (maintainers)

The kit is a snapshot of a reference frontend that runs it in production:

```
python frontend-kit/sync_kit.py /path/to/reference-frontend
```

The sync copies exactly the files listed in `sync_kit.py`, writes a
placeholder `lib/brand.js`, and fails if the reference site's brand name
appears in a CORE file. Run the acceptance test against the reference site
before syncing.
