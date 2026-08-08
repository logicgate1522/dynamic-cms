# Universal CMS + SEO Backend

A complete, self-contained Django backend for a website that needs to be
inline-editable by an admin from the frontend, SEO-instrumented, and drop-in
portable to any Next.js (or other) frontend — no dashboard, no separate
admin app, nothing project-specific. One Django app (`api`) is the entire
backend.

**What this gives you, out of the box:**
- Inline-editable content sections (headlines, buttons, images, repeating
  cards) — an admin edits directly on the live page, no CMS dashboard
- Per-page SEO metadata (title, description, canonical, OG image, robots,
  focus keyword)
- A blog (draft/scheduled/published, block-structured content)
- Forms with admin-configurable fields and a public submit endpoint
  (throttled, honeypot-protected, optional email notification)
- Redirects (with loop detection)
- Image uploads
- Admin login (email + password → token), no third-party auth provider

**What it deliberately doesn't have:** a dashboard UI, social login, JWT,
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

python manage.py migrate
python manage.py createsuperuser  # this becomes your first admin login
python manage.py runserver
```

Verify it's alive:

```bash
curl http://127.0.0.1:8000/api/home/anything/
# -> {}  (never 404s — see "Upsert semantics" below)
```

Run the test suite (38 tests, no external services required):

```bash
python manage.py test api
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

All relative to `/api/`.

| Purpose | Method | Path | Auth |
|---|---|---|---|
| Admin login | POST | `auth/login/` | public |
| Get/set a content block | GET / PATCH / PUT / DELETE | `home/<name>/` | GET public; writes admin |
| Get/set site-wide settings | GET / PATCH | `settings/site/` | GET public; PATCH admin |
| List all page SEO rows | GET | `seo/` | public (paginated) |
| Get/set one page's SEO | GET / PATCH | `seo/<path>/` | GET public; PATCH admin |
| List/create blog posts | GET / POST | `blog/` | GET public (published only); POST admin |
| Get/update/delete one post | GET / PATCH / DELETE | `blog/<slug>/` | GET public if published; writes admin |
| List/create redirects | GET / POST | `redirects/` | GET public; POST admin |
| Update/delete a redirect | PATCH / DELETE | `redirects/<id>/` | admin |
| Submit a form | POST | `forms/<name>/submit/` | public, throttled |
| List a form's submissions | GET | `forms/<name>/submissions/` | admin |
| Upload an image | POST | `images/` | admin |
| List/get/update/delete images | GET / PATCH / DELETE | `images/`, `images/<id>/` | GET public; writes admin |

**Two different URL shapes on purpose:** `home/`, `settings/site/`, and
`seo/` are name/path-keyed and upsert-safe — never append an id to these.
`blog/`, `redirects/`, and `images/` are real REST resource collections
with their own id/slug in the URL for anything but list/create — treat
those like any normal API.

## Auth contract

```js
const isAdmin = !!localStorage.getItem("authToken");
```

That's the entire frontend admin gate. Login:

```js
const res = await fetch(`${apiUrl}/auth/login/`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const { key } = await res.json();
localStorage.setItem("authToken", key);
```

Every authenticated write:

```js
headers: { Authorization: `Token ${localStorage.getItem("authToken")}` }
```

The scheme is **`Token`**, not `Bearer` — this is DRF's `TokenAuthentication`.

## Image uploads

```js
const formData = new FormData();
formData.append("image", file);
formData.append("category", "hero-background"); // any descriptive label
const res = await fetch(`${apiUrl}/images/`, {
  method: "POST",
  headers: { Authorization: `Token ${token}` }, // no Content-Type — browser sets the multipart boundary
  body: formData,
});
const { image } = await res.json(); // absolute URL — use directly
```

## Frontend integration

See **`FRONTEND_INTEGRATION_PROMPT.md`** in this same directory — it's a
complete, self-contained prompt you (or an AI agent) can paste to turn any
static component into one wired against this backend, plus deeper patterns
for full pages (with `generateMetadata()` SEO wiring), forms, list pages,
and blog posts. It includes a recommended build order for a fresh project
(layout → sitemap/robots → pages → sections → forms → list/detail pages →
redirects).

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

## Deploying

1. Set `DEBUG=False`, `SECRET_KEY`, `ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS`,
   `CSRF_TRUSTED_ORIGINS`, and a real `DATABASE_URL`.
2. `python manage.py migrate`
3. `python manage.py collectstatic --noinput`
4. `python manage.py createsuperuser`
5. Run under `gunicorn backend.wsgi:application` (already in
   `requirements.txt`).
6. Optional: set `REDIS_URL` once you're running more than one worker.

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
5. Point your frontend's `NEXT_PUBLIC_API_URL` at it and start with
   `FRONTEND_INTEGRATION_PROMPT.md`.

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
