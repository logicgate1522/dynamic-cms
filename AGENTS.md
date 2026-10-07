# Instructions for coding agents (Claude, Codex, Cursor, …)

This repo is **dynamic-cms**:
- a Django backend (`api/`, `backend/`)
- a Next.js frontend kit (`frontend-kit/`)
- the contract between them (`FRONTEND_INTEGRATION_PROMPT.md`)

Decide which job you have, then follow that section exactly. Don't ask for
instructions the docs already answer.

## Job A — "Integrate this CMS into <frontend>"

1. Read `FRONTEND_INTEGRATION_PROMPT.md` in full, starting with "How to use
   this file". Rules R1–R25 are mandatory; each has a rule card (Must / Never
   / Proven by), a phase that builds it, an anti-pattern and a checklist line.
2. Read `frontend-kit/MANIFEST.md`. Install the kit verbatim; change only the
   ADAPT files, and only as the manifest says.
3. Run the spec's Autonomous mode, phases P0–P8, in order. Convert every
   section with the §3 recipe.
4. You are done only when all five gates pass:
   `next build`, `npm run check:inline`, `npm run check:sections` (backend
   running), `frontend-kit/acceptance/acceptance.mjs` and
   `frontend-kit/acceptance/site-audit.mjs` (0 failures) against the
   production build. Every phase ends with its Exit check; P8 verifies in three
   passes (fix until green → clean re-verification with no code changes →
   rule-by-rule audit against §13 and §11). Paste the Pass 2 output in your
   report, plus any launch-check blockers that need the owner.
5. Never:
   - put a token in browser storage
   - build modal-first editing
   - write prompt text in the frontend
   - `JSON.parse` a pasted AI reply
   - call revalidation from the browser
   - ship admin UI to visitors
   - leave a `useCms` component without `if (hidden) return null` (R23)
   - submit a form any way but `submitForm()` from `lib/forms.js`, or
     hard-code / invent the recipient (R24 — it's Settings → Form notifications)
   - hard-code a tracking tag or call `gtag`/`fbq`/`dataLayer.push` outside
     `lib/track.js` (R25 — IDs live in Settings → Tracking & analytics)

## Job B — Change the backend

- **Python:** always `./venv/bin/python` (on macOS a bare `python` usually
  doesn't exist).
  - Tests: `./venv/bin/python manage.py test api`
  - Migrations: `./venv/bin/python manage.py makemigrations api && ./venv/bin/python manage.py migrate`
  - Staff user: `./venv/bin/python manage.py createsuperuser`
- **Where things live** (single sources of truth):
  - All AI prompt text: `api/prompts.py`, built from `SiteSettings.data.ai`.
    Prompt endpoints: `api/ai_views.py`.
  - Cleaning pasted AI replies: `api/ai_normalize.py` (`POST ai/normalize/`).
  - Keyword matching: `api/keywords.py`, mirrored by `frontend-kit/src/lib/keywords.js`.
    Change both together.
  - Section types: `SECTION_SCHEMA` in `api/dynamic_pages.py` (placeholder
    content: `STARTER_CONTENT`). Adding a type also needs a renderer in
    `frontend-kit/src/components/dynamic/registry.js` plus an adapter.
  - SEO rules: `prompts.seo_rule_checks`, mirrored id-for-id by
    `frontend-kit/src/lib/seoChecks.js`. Change both together.
  - Collections (the only pages admins create from the site):
    `api/site_collections.py` (config, template fitting, blank entries) and
    `api/collection_views.py`.
  - **Prompt-writing rule:** every prompt states its rules, then ends with
    `final_check(...)`, which repeats the hard constraints as the last thing
    the model reads. A new prompt without a FINAL CHECK fails
    `PromptRepetitionTests`.
  - Drafts: `ComponentData.draft_data`, `DynamicSection.draft_content`, and
    `api/draft_views.py`.
  - Cache invalidation: `api/revalidation.py` (signals → signed webhook, and
    bumps resolver cache versions). Any new public model needs a tag there and
    the matching tag in `frontend-kit/src/lib/cms.js`.
  - Auth: session + CSRF (`api/auth_views.py`, `AdminLoginView` with
    `session: true`). Token login stays for scripts only.
  - Launch readiness: `api/launch_check.py` (`GET launch-check/`). Anything
    that silently hurts a live site belongs here as a blocker or warning.
  - Cascades on delete (PageSEO and sections follow their page): `api/cleanup.py`.
  - Title assembly (brand never doubled; dropped past 60 chars):
    `seo_resolve.apply_title_template`.
  - Rate limits: `api/throttles.py`. Staff and the site's own server
    (`X-CMS-Frontend` = `REVALIDATE_SECRET`) skip the general limits;
    `login` and `form_submit` always apply. A new public endpoint with its own
    `throttle_classes` must use `SiteAwareScopedRateThrottle`.
- **Every behaviour change ships with a test** in `api/tests.py`. The
  permission-audit test fails if you add an unauthenticated write endpoint
  without adding it to `PUBLIC_WRITE_ALLOWLIST` on purpose.
- **Keep the contract in sync.** A new or changed endpoint, field or settings
  key must be updated in `FRONTEND_INTEGRATION_PROMPT.md` §6 in the same
  change. Kit behaviour changes are made in a reference frontend, verified with
  the acceptance test, then pulled in with
  `python frontend-kit/sync_kit.py <frontend>`. Never hand-edit
  `frontend-kit/src` alone.
- **Adding or changing a rule in the spec:** keep its five copies in step —
  the §0.1 index row (with its gate and phase), a §0.2 card with Must / Never
  / Proven by, the `Rules:` line of the §2 phase that builds it, a §11
  anti-pattern line and a §13 checklist line ending in its gate. Bump every
  `R1–Rn` range (spec, AGENTS, READMEs). `IntegrationSpecTests` fails on any
  gap. Prefer an automatic gate (`check-inline.mjs`, acceptance, site-audit,
  launch-check) over "(review)".
- Record notable changes in `UPGRADE_NOTES.md`.
- **Git:** this repo has one branch, `main`. Commit and push to `main`
  directly; never create feature branches or pull requests.

## Product principles (for any new feature)

- **Inline first:** click the thing to change it. Panels exist for bulk, AI,
  JSON and history. Edit tools appear on hover; nothing covers the page.
  Typing never loses focus (index keys; `check:inline` + acceptance enforce it).
- **Build only what repeats:** collections (articles, services, projects…)
  get "＋ New" on their index page, with one template. One-off pages keep
  their structure.
- **Draft, then publish;** everything reversible (revisions, SEO history,
  discard).
- **AI is a copy/paste loop with any chat model:** the backend writes the
  prompt with site context, SEO best practice and an exact JSON shape, and
  `ai/normalize` turns messy replies into safe content (it refuses data loss).
- **Everything can be hidden** (blocks, list items, sections) as a draft;
  hidden content never reaches visitors' HTML.
- **Owner-configurable, not code-configurable:** lead email recipient
  (FormSubmit.co) and every tracking ID / data layer variable live in Site
  tools → Settings, near the top, validated by `api/settings_validation.py`.
- **Visitors pay nothing:** server-rendered published content, no admin code
  paths.
