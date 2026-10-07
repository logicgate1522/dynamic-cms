# Universal CMS + SEO Backend

A complete, self-contained Django backend for a website that needs to be
inline-editable by an admin from the frontend, SEO-instrumented, and drop-in
portable to any Next.js (or other) frontend — no dashboard, no separate
admin app, nothing project-specific. One Django app (`api`) is the entire
backend.

**What this gives you, out of the box:**
- Inline-editable content sections with **draft/publish + revision history +
  revert**, and 22 reusable field-contract schemas an AI or frontend can discover
- Per-page SEO: canonical blob + **change history/revert**, a
  **`seo/resolve/<path>/`** endpoint that returns fully-resolved metadata +
  a composed JSON-LD `@graph` (so `generateMetadata()` is a thin mapping)
- **SEO audit engine** (`seo/analyze/`) — technical/content/metadata/schema
  checks + a site-wide roll-up
- **Server-side structured-data builders** (Organization/LocalBusiness, WebSite,
  Breadcrumb, Article, FAQ, Product, Service, Person, Event, HowTo, Video) +
  a JSON-LD validator
- **Dynamic Page / Section system** — `SECTION_SCHEMA`, AI-prompt generator,
  `content/paste-to-build/`, per-slot image upload, publish guard on missing
  images; works for `ContentPage` *and* `BlogPost`
- A blog (draft/scheduled/published, legacy blob or dynamic sections)
- Forms with **server-side validation from the field definition**, 18 field
  types, submission metadata, CSV/JSON export, spam/read toggles
- Redirects with `status_code`, hit tracking, `redirects/resolve/`, CSV import/export
- `robots.txt` + `sitemap*.xml` with a pluggable content-source registry
- Image management: dimensions, checksum dedupe, alt/SEO metadata, usage refs,
  SVG gate + magic-byte validation
- **True inline editing kit for Next.js** (`frontend-kit/`): click any text on
  the live site and type; images, list items and links are edited in place.
  A floating admin bar handles drafts → publish, whole-page AI, SEO, page
  builder and site tools
- **Collections**: the only pages admins create from the site (articles,
  services, projects…). They're configured per site, get "＋ New" on their
  index page, and use one template, so every entry looks like its siblings
  (blank or AI-written; AI replies are fitted to the template server-side)
- **Drafts → Publish** for content blocks *and* dynamic-page sections
  (`drafts/`, `drafts/publish/`, `drafts/discard/`)
- **AI assist without an API key:** the backend writes copy/paste prompts for
  any chat model (new page, edit page, one block, whole page, SEO audit,
  keyword research), injecting the site's voice (`SiteSettings.ai`) and SEO
  best practice. `ai/normalize/` cleans whatever comes back (prose, fences,
  markdown links, wrappers) and refuses replies that would lose data
- **Instant cache refresh:** every write sends a signed webhook to the frontend
  (`revalidateTag`), so edits made anywhere reach visitors immediately
- **Launch readiness** (`launch-check/`, on the dashboard): blocks going live
  with placeholder text, a localhost site URL, indexing off, or lead forms that
  notify nobody. `frontend-kit/acceptance/site-audit.mjs` audits every page's
  SEO, links, contact consistency and forms
- Images auto-optimised to WebP on upload, with usage tracking and
  delete-protection for images still in use
- Admin login: session cookie + CSRF for the browser, with token login kept for
  scripts. No third-party auth provider

See `UPGRADE_NOTES.md` for what changed and `SECURITY_AUDIT.md` for the
security posture. **`FRONTEND_INTEGRATION_PROMPT.md` is the strict integration
spec** (`AGENTS.md`/`CLAUDE.md` point agents to it): give an agent a frontend
plus this repo and it can integrate the CMS without further instructions.

**What it deliberately doesn't have:** social login, JWT,
role-based permissions beyond `is_staff`, or anything specific to one
business. All of that was audited out — see [History](#history) below.

---

## Quickstart

```bash
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env: at minimum, set SECRET_KEY if DEBUG=False.
# Defaults work as-is for local development.

./venv/bin/python manage.py migrate
./venv/bin/python manage.py createsuperuser  # this becomes your first admin login
./venv/bin/python manage.py runserver
```

> `zsh: command not found: python`? Either activate the venv first
> (`source venv/bin/activate`) or call it by path, as above
> (`./venv/bin/python …`). macOS ships only `python3`.

Verify it's alive:

```bash
curl http://127.0.0.1:8000/api/home/anything/
# -> {}  (never 404s — see "Upsert semantics" below)
```

Run the test suite (161 tests, no external services required):

```bash
./venv/bin/python manage.py test api
```

---

## Architecture in one paragraph

There is exactly one Django app, `api`, and it defines one thing that
matters more than any individual model: **content endpoints never require
anything to be pre-seeded.** `GET /home/<name>/` on a name nobody has ever
saved returns `200 {}`, not `404`. The first `PATCH` to that same URL
creates the row. This is what makes the backend genuinely drop-in — point a
brand-new frontend component at any endpoint and it works immediately,
rendering its own built-in defaults until an admin edits and saves for the
first time.

## Models

The full model list (22 models: revisions, schemas, SEO history/audit,
`ContentPage`/`DynamicSection`/`SectionMedia`, extended images/forms/redirects)
is in [`api/README.md`](api/README.md). The originals:

| Model | Purpose | Notes |
|---|---|---|
| `CustomUser` | the project's user model | `AbstractUser` + optional `phone_number`. `is_staff` is the entire admin contract — nothing else about a user matters to this backend. |
| `ComponentData` | generic named JSON blob | Backs inline-editable page/component content *and* form field definitions. `name`-keyed, not id-keyed. Upsert-safe (see above). Admin `PATCH` **deep-merges** nested objects; arrays are replaced wholesale, not merged item-by-item. |
| `SiteSettings` | singleton | Org identity, default SEO, injected `<script>` tags (analytics/GTM/pixels). Exactly one row, enforced at the model level. |
| `PageSEO` | per-page SEO fields | Keyed by `path` (supports nested paths with slashes, e.g. `services/web-development`). Same upsert-safe contract as `ComponentData`. Has a list endpoint for cross-page audits (duplicate titles, orphan detection, etc — computed client-side against this data). |
| `BlogPost` | articles | Slug-based. `status` = `draft`/`published`; a `published` post with no explicit `published_at` is auto-stamped to "now" on save. A future-dated `published_at` stays hidden from the public until that date passes — `status="published"` alone isn't enough to go live if it's scheduled. `content` is **block-structured JSON** (cover image + ordered array of text/image sections), not a flat HTML or markdown string. |
| `Redirect` | source → destination URL mappings | Rejects self-redirects and loop chains (walks up to 20 hops) at save time. |
| `FormSubmission` | write side of any form | Field *definitions* live in `ComponentData` (`form-<name>`, admin-editable, zero code changes to add/remove a field); actual submissions land here. Public submit endpoint is throttled and honeypot-protected. |
| `UploadedImage` | shared image store | Every image field anywhere in the system uploads here first, then stores the returned URL. |

## Endpoints

All relative to `/api/`. **The complete, current endpoint table (~50 routes)
lives in [`FRONTEND_INTEGRATION_PROMPT.md`](FRONTEND_INTEGRATION_PROMPT.md)
§6** — including which of the two URL shapes each one uses. The core set:

| Purpose | Method | Path | Auth |
|---|---|---|---|
| Session login / CSRF / status / logout | POST / GET / GET / POST | `auth/login/` (`session:true`), `auth/csrf/`, `auth/session/`, `auth/logout/` | public |
| Drafts: list / publish / discard | GET / POST / POST | `drafts/`, `drafts/publish/`, `drafts/discard/` | admin |
| AI prompts + reply normaliser | GET/POST | `ai/new-page-prompt/`, `ai/section-prompt/`, `ai/page-assist-prompt/`, `ai/seo-prompt/`, `ai/keyword-prompt/`, `ai/normalize/`, `content/<key>/build-prompt/`, `content/<key>/paste-to-edit/` | admin |
| Get/set a content block | GET / PATCH / PUT / DELETE | `home/<name>/` (`?mode=draft`) | GET public; writes admin |
| Component schemas / history / publish / revert | GET/POST | `home/schemas/`, `home/<name>/history/`, `.../publish/`, `.../revert/<id>/` | schemas public; rest admin |
| Get/set site-wide settings | GET / PATCH | `settings/site/` | GET public; PATCH admin |
| Computed Organization JSON-LD | GET | `settings/site/schema/organization/` | public |
| List / get / set page SEO | GET / PATCH | `seo/`, `seo/<path>/` | GET public; PATCH admin |
| Resolved metadata + JSON-LD @graph | GET | `seo/resolve/<path>/` | public (cached) |
| SEO history / revert / audit / roll-up / validate | GET/POST | `seo/<path>/history/`, `.../revert/<id>/`, `seo/analyze/<path>/`, `seo/analyze/`, `seo/validate-schema/` | admin |
| Dynamic page builder | GET/POST | `ai/section-schema/` (public), `ai/dynamic-page-prompt/`, `ai/copy-structure-prompt/`, `content/paste-to-build/` | as noted |
| Content pages + sections | GET/POST/PATCH/DELETE | `content/pages/…`, `content/<path>/sections/…`, `blog/<slug>/sections/…` | GET public; writes admin |
| Blog posts | GET / POST / PATCH / DELETE | `blog/`, `blog/<slug>/` | GET public (published only); writes admin |
| Redirects + resolve + io | GET/POST/PATCH/DELETE | `redirects/`, `redirects/<id>/`, `redirects/resolve/?path=`, `redirects/io/` | GET/resolve public; rest admin |
| Forms | POST / GET / PATCH | `forms/<name>/submit/` (public), `.../submissions/`, `.../submissions/export/`, `.../submissions/<id>/` | submit public; rest admin |
| Images | GET / POST / PATCH / DELETE | `images/?category=&unused=1&missing_alt=1`, `images/<id>/`, `images/<id>/usage/` | GET public; writes admin |
| SEO discovery files (project root) | GET | `/robots.txt`, `/sitemap.xml`, `/sitemap-index.xml`, `/sitemap-<section>.xml` | public |

**Two different URL shapes on purpose:** `home/`, `settings/site/`, and
`seo/<path>/` (plus `seo/resolve/`) are name/path-keyed and upsert-safe —
`GET` on an unknown key returns `200 {}`, never append an id. `blog/`,
`redirects/`, `images/`, `content/pages/`, sections, and submissions are
real REST collections with their own id/slug.

## Auth contract

The browser uses a **Django session cookie + CSRF**; it never holds a token.

```js
// frontend-kit/src/lib/api.js does all of this — use it, don't re-implement it.
const { csrfToken } = await (await fetch(`${API}/auth/csrf/`, { credentials: "include" })).json();
await fetch(`${API}/auth/login/`, {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json", "X-CSRFToken": csrfToken },
  body: JSON.stringify({ username: "email-or-username", password, session: true }),
});
const { authenticated } = await (await fetch(`${API}/auth/session/`, { credentials: "include" })).json();
```

`authenticated` is true only for `is_staff` users. Every admin write sends
`credentials: "include"` and `X-CSRFToken`. Cross-origin dev setups need the
frontend origin in **both** `CORS_ALLOWED_ORIGINS` and `CSRF_TRUSTED_ORIGINS`.

Scripts (seeders, CI) can still use `POST auth/login/ {email, password}` →
`{key}` and the `Authorization: Token <key>` header (the scheme is `Token`,
not `Bearer`).

## Image uploads

`POST images/` (multipart: `image`, `category`). Uploads are re-encoded to
WebP (max 2400px, quality 82; set via `IMAGE_OPTIMIZE*`) and deduplicated by
checksum. The kit's `uploadImage(file, category)` returns the absolute URL to
store. `DELETE images/<id>/` returns `409` with the usage list while the image
is referenced (`?force=1` overrides).

## Frontend integration

- **`FRONTEND_INTEGRATION_PROMPT.md`**: the strict spec, with rules R1–R29, a
  phase-by-phase procedure, the exact section-conversion recipe, the full
  backend contract and an SEO reference.
- **`frontend-kit/`**: the Next.js App Router kit to copy in.
  `frontend-kit/MANIFEST.md` lists every file and the four that need site
  hooks.
- **Gates:** `frontend-kit/scripts/check-inline.mjs` (no hard-coded copy left
  in CMS components), `check-sections.mjs` (renderer ↔ section-schema), and
  `frontend-kit/acceptance/acceptance.mjs` (end-to-end test: login, inline edit
  → draft → publish → webhook → visitor sees it, AI paste, discard, SEO AI,
  section editing, page creation, admin pages, sign out).

## Configuration

Copy `.env.example` to `.env`. Full reference is in that file's comments;
the load-bearing ones:

| Variable | Required when | Default |
|---|---|---|
| `DEBUG` | always read | `False` — production must opt **in** to debug mode, not forget to opt out |
| `SECRET_KEY` | `DEBUG=False` | dev-only fallback key when `DEBUG=True`; **hard error at startup** if unset in production |
| `ALLOWED_HOSTS` | production | `localhost,127.0.0.1` |
| `CORS_ALLOWED_ORIGINS` / `CSRF_TRUSTED_ORIGINS` | production | `localhost:3000` variants |
| `DATABASE_URL` (or `POSTGRES_*`) | production | SQLite when `DEBUG=True` |
| `REDIS_URL` | multi-worker production | in-memory cache (fine for single-worker/dev; throttle counts aren't shared across workers without Redis) |
| `FORM_NOTIFICATION_EMAIL` | if you want submission emails | unset = notifications silently skipped, submissions still save |
| `FRONTEND_REVALIDATE_URL` + `REVALIDATE_SECRET` | always, with a Next.js frontend | unset = no webhook (visitors see edits only after ISR expiry). Same secret in the frontend's env |
| `SESSION_COOKIE_AGE` | optional | 12 hours |
| `SESSION_COOKIE_SECURE` / `CSRF_COOKIE_SECURE` | production (HTTPS) | `False` |
| `SESSION_COOKIE_SAMESITE` | API on a different domain than the site | `Strict` in production (`Lax` in DEBUG); `None` needs `SESSION_COOKIE_SECURE=True` |
| `IMAGE_OPTIMIZE`, `IMAGE_OPTIMIZE_MAX_DIMENSION`, `IMAGE_OPTIMIZE_WEBP_QUALITY` | optional | `True`, `2400`, `82` |

## Deploying

1. Set `DEBUG=False`, `SECRET_KEY`, `ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`,
   `CSRF_TRUSTED_ORIGINS`, and a real `DATABASE_URL`.
2. `./venv/bin/python manage.py migrate`
3. `./venv/bin/python manage.py collectstatic --noinput`
4. `./venv/bin/python manage.py createsuperuser`
5. Set `FRONTEND_REVALIDATE_URL=https://<site>/api/revalidate` and the shared
   `REVALIDATE_SECRET`. Serve both over HTTPS and set
   `SESSION_COOKIE_SECURE=True` and `CSRF_COOKIE_SECURE=True`. Host the API on the
   same site as the frontend (e.g. `api.example.com`) so the `Strict` session
   cookie is sent. Otherwise set `SESSION_COOKIE_SAMESITE=None`.
6. Run under `gunicorn backend.wsgi:application` (already in
   `requirements.txt`).
7. Optional: set `REDIS_URL` once you're running more than one worker.

All of the above has been verified end-to-end (production-mode `check`,
`collectstatic`, cache behavior with and without `REDIS_URL`, a real
login → PATCH → persistence round trip) — not just asserted.

## Dropping this into a different project

1. Copy this entire directory.
2. `pip install -r requirements.txt` in a fresh virtualenv — verified to
   work with nothing else added (26 packages total, every one traced back
   to an actual import in this codebase).
3. `cp .env.example .env`, fill in real values.
4. `python manage.py migrate && python manage.py createsuperuser`.
5. Give your agent the frontend repo and this directory. `AGENTS.md` sends it
   to `FRONTEND_INTEGRATION_PROMPT.md` and `frontend-kit/`, and it's done when
   the acceptance test passes.

Nothing here references a specific business, domain, or dataset. Every
`home/<name>/` row, blog post, and page's SEO data is created by whoever
uses the admin login — there's nothing to strip out or rename first.

## History

This backend started life folded into a specific project's Django app,
alongside a second app (`coreauth`) that additionally handled Google social
login, JWT auth, and a customer-profile system (loyalty points, addresses,
profile pictures) — none of which the CMS itself ever needed. It went
through several rounds of: a full audit against the live code (not just a
plan) that found and fixed a throttle-configuration bug that would have
silently disabled rate limiting in production, a race condition in the
merge-on-save logic, a scheduled-blog-post visibility leak, and a broken
production cache config that would have 500'd on the first real request;
then a deliberate strip-down that removed the entire unused auth stack,
four legacy hardcoded endpoints, ~40 unused dependencies, and finally
consolidated the user model into this one app so nothing outside `api/`
is required at all. Every claim above (dependency count, test count,
"verified fresh install," etc.) was confirmed by actually running it in an
isolated environment, not asserted from reading the code.
