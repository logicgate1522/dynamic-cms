# Instructions for coding agents (Claude, Codex, Cursor, …)

This repo is **dynamic-cms**:
- a Django backend (`api/`, `backend/`)
- a Next.js frontend kit (`frontend-kit/`)
- the contract between them (`FRONTEND_INTEGRATION_PROMPT.md`)

Decide which job you have, then follow that section exactly. Don't ask for
instructions the docs already answer.

## Job A — "Integrate this CMS into <frontend>"

1. Read `FRONTEND_INTEGRATION_PROMPT.md` in full. Rules R1–R12 are mandatory.
2. Read `frontend-kit/MANIFEST.md`. Install the kit verbatim; change only the
   ADAPT files, and only as the manifest says.
3. Run the spec's Autonomous mode, phases P0–P8, in order. Convert every
   section with the §3 recipe.
4. You are done only when all four gates pass:
   `next build`, `npm run check:inline`, `npm run check:sections` (backend
   running), and `frontend-kit/acceptance/acceptance.mjs` against the
   production build. Paste the acceptance output in your report.
5. Never:
   - put a token in browser storage
   - build modal-first editing
   - write prompt text in the frontend
   - `JSON.parse` a pasted AI reply
   - call revalidation from the browser
   - ship admin UI to visitors

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
  - Section types: `SECTION_SCHEMA` in `api/dynamic_pages.py`. Adding a type
    also needs a renderer in `frontend-kit/src/components/dynamic/registry.js`
    plus an adapter.
  - Drafts: `ComponentData.draft_data`, `DynamicSection.draft_content`, and
    `api/draft_views.py`.
  - Cache invalidation: `api/revalidation.py` (signals → signed webhook, and
    bumps resolver cache versions). Any new public model needs a tag there and
    the matching tag in `frontend-kit/src/lib/cms.js`.
  - Auth: session + CSRF (`api/auth_views.py`, `AdminLoginView` with
    `session: true`). Token login stays for scripts only.
- **Every behaviour change ships with a test** in `api/tests.py`. The
  permission-audit test fails if you add an unauthenticated write endpoint
  without adding it to `PUBLIC_WRITE_ALLOWLIST` on purpose.
- **Keep the contract in sync.** A new or changed endpoint, field or settings
  key must be updated in `FRONTEND_INTEGRATION_PROMPT.md` §6 in the same
  change. Kit behaviour changes are made in a reference frontend, verified with
  the acceptance test, then pulled in with
  `python frontend-kit/sync_kit.py <frontend>`. Never hand-edit
  `frontend-kit/src` alone.
- Record notable changes in `UPGRADE_NOTES.md`.

## Product principles (for any new feature)

- **Inline first:** click the thing to change it. Panels exist for bulk, AI,
  JSON and history.
- **Draft, then publish;** everything reversible (revisions, SEO history,
  discard).
- **AI is a copy/paste loop with any chat model:** the backend writes the
  prompt with site context, SEO best practice and an exact JSON shape, and
  `ai/normalize` turns messy replies into safe content (it refuses data loss).
- **Visitors pay nothing:** server-rendered published content, no admin code
  paths.
