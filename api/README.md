# `api` — the entire backend, one app

This is the whole backend: a generic inline-editing CMS, per-page SEO
metadata, a blog, form submissions, redirects, image uploads, **and admin
auth (`CustomUser`)** — one Django app, nothing else. There is no second
app. `INSTALLED_APPS`'s only local entry is `'api'`.

## What this app needs to run

- `rest_framework` + `rest_framework.authtoken` (`TokenAuthentication`)
- `AUTH_USER_MODEL = 'api.CustomUser'`

`CustomUser` (in `models.py`) is a thin `AbstractUser` subclass — no social
login, no JWT, no customer-profile fields beyond an optional
`phone_number`. `POST /api/auth/login/` (`AdminLoginView` in `views.py`)
takes `{"email", "password"}`, authenticates directly against
`get_user_model()`, and returns `{"key": "<token>"}`. Every write endpoint
in this app gates on DRF's `IsAdminUser` (`is_staff`), nothing more
specific.

**Dropping this into a new project:** copy the `api/` directory, add
`'api'` + `'rest_framework'` + `'rest_framework.authtoken'` to
`INSTALLED_APPS`, set `AUTH_USER_MODEL = 'api.CustomUser'`,
`include('api.urls')` somewhere, run migrations, then:

```
python manage.py createsuperuser
```

That's the entire setup. No second app, no social login, no JWT, no
allauth/dj-rest-auth dependency chain (see `requirements.txt` — pruned to
~26 packages, verified installable and fully test-passing in a completely
fresh virtualenv with nothing else added).

## History note

This app previously coexisted with a separate `coreauth` app that owned
`CustomUser`. That app has been deleted and `CustomUser` now lives directly
in `api/models.py`. Because Django's migration system re-evaluates
`AUTH_USER_MODEL`-based foreign keys (in `django.contrib.admin` and
`rest_framework.authtoken`) live against current settings — not frozen at
migration-authoring time — moving a user model to a new app after
`admin`/`authtoken` migrations have already been applied against it turns
out to be a genuine Django limitation, not just an inconvenience: replaying
old history under the new setting breaks state reconstruction. There's a
standard fix (squash + fake-apply against the existing database), but for
this project the dev database's existing content wasn't worth preserving,
so the simpler path was taken instead: the database was reset and migration
history was regenerated from scratch as a single clean `0001_initial`
already reflecting `api.CustomUser` from the start. If you're doing this on
a database with real data you need to keep, budget for the
squash-and-fake-apply approach instead of a reset.

## Models

| Model | Key/REST | Purpose |
|---|---|---|
| `CustomUser` | — | `AbstractUser` + optional `phone_number`. `is_staff` is the entire admin contract. |
| `ComponentData` | **name-keyed, upsert** | Inline-editable content + form definitions. `data` (live), `draft_data` (working copy, `?mode=draft`), `status`, `schema_key`, `updated_by`. GET unknown → `200 {}`. PATCH deep-merges objects, replaces arrays. |
| `ComponentRevision` | REST (read) | Snapshot on every admin PATCH/PUT/publish/revert. `home/<name>/history/`. |
| `ComponentSchema` | `key`-keyed | Reusable field contract per component class. 22 builtin schemas seeded (migration 0003). `home/schemas/` (public). Optional PATCH validation when `schema_key` set. |
| `SiteSettings` | **singleton, upsert** | Canonical shape (organization / contact / locations / seoDefaults / verification / analytics / schema / navigation / brand / robotsTxt). Validated on PATCH. Injected-script fields are admin-write, public-read (deliberate trust boundary). |
| `PageSEO` | **path-keyed, upsert** | Canonical SEO blob (title, description, canonical, robots directives, social, schema builders, sitemap, hreflang, pagination). |
| `SEOChangeHistory` | REST (read) | old→new snapshot per PATCH. `seo/<path>/history/` + revert. |
| `SEOAuditResult` | REST (read) | Persisted `seo_analyzer.analyze_page` runs. |
| `BlogPost` | slug REST | draft/published + scheduled `published_at`; `body_mode` legacy/dynamic; auto-slug. |
| `ContentPage` | path REST (`content/pages/`) | Generic host: `page_type`, `body_mode`, scheduled visibility, legacy blob or dynamic sections. |
| `DynamicSection` | REST | Ordered typed section, **generic FK** to `ContentPage` OR `BlogPost`. Type validated against `dynamic_pages.SECTION_SCHEMA`. |
| `SectionMedia` | REST | Named image slot (`image`, `items[0].image`). `required` slots block publish until filled. |
| `Redirect` | source REST | `status_code` (301/302/307/308), `is_active`, `hit_count`, `last_hit_at`; loop/self rejection; `redirects/resolve/`. |
| `FormSubmission` | REST | `is_read`/`is_spam`, salted `ip_hash`, `user_agent`, `referer`. Server-validated against `home/form-<name>/`. |
| `UploadedImage` | REST | alt/title/caption/description/credit/license, width/height/size/mime/format, sha256 `checksum` (dedupe), focal point, `usage[]`. |

## Modules

- `dynamic_pages.py` — `SECTION_SCHEMA` (single source of truth), `build_ai_prompt`, `build_copy_structure_prompt`, `parse_and_validate`.
- `schema_builders.py` — pure JSON-LD builders + `assemble(path)` @graph composer + `validate_schema` + `escape_jsonld`.
- `seo_analyzer.py` — `analyze_page(path, html?)` technical/content/metadata/schema checks.
- `seo_resolve.py` — `resolve_seo(path)` — the `seo/resolve/` precedence engine.
- `sitemaps.py` — `robots.txt`, `sitemap*.xml`, `SITEMAP_SOURCES` registry.
- `settings_validation.py`, `schema_validation.py`, `form_validation.py`, `image_validation.py` — input guards.
- `builtin_schemas.py` — the 22 seeded `ComponentSchema` definitions.

## URL surface

See `api/urls.py`. Every route is generic. URL-shape rule per endpoint is
documented in `FRONTEND_INTEGRATION_PROMPT.md` §13.6 (the full endpoint table).
`/robots.txt` + `/sitemap*.xml` are served at the **project** root
(`backend/urls.py`), not under `/api/`.

## Tests

`api/tests.py` — 114 tests. Run with `python manage.py test api`.
`python manage.py makemigrations --check` is clean; migrations `0001`–`0009`
are forward-only and additive.
