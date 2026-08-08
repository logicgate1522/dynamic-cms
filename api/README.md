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

| Model | Purpose |
|---|---|
| `CustomUser` | the project's user model — `AbstractUser` + optional `phone_number`. `is_staff` is the entire admin contract. |
| `ComponentData` | generic named JSON blob — inline-editable page/component content and form *definitions*. GET never 404s (upsert-safe); admin PATCH deep-merges. |
| `SiteSettings` | singleton — org identity, default SEO, injected scripts (GTM/pixels/analytics). |
| `PageSEO` | per-page SEO fields, keyed by path (supports nested paths like `services/x`). |
| `BlogPost` | slug-based, draft/published + scheduled `published_at`, block-structured `content` JSON. |
| `Redirect` | source → destination mappings; rejects self-redirects and loops on save. |
| `FormSubmission` | write side of any `ComponentData`-defined form; public submit endpoint is throttled + honeypot-protected, optionally emails `FORM_NOTIFICATION_EMAIL`. |
| `UploadedImage` | shared image upload/store for all of the above. |

## URL surface

See `api/urls.py` — every route is generic (`home/<name>/`, `seo/<path>/`,
`blog/<slug>/`, `forms/<name>/submit/`, `auth/login/`, etc.), none of it is
business-specific.

## Tests

`api/tests.py` — 38 tests covering permission gates, upsert semantics,
deep-merge behavior, scheduled publishing, redirect-loop rejection, admin
login (case-insensitivity, wrong password, non-staff rejection, token
stability), and a regression test for a throttle-scope bug found during
audit. Run with:

```
python manage.py test api
```
