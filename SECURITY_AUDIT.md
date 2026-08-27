# Security Audit — dynamic-cms

Living document. Updated at the end of every upgrade phase. Severity: **High**
(exploitable now), **Medium** (hardening / defence-in-depth), **Low** (note).

## Posture summary

- Every write endpoint is `IsAdminUser` (`is_staff`). The only unauthenticated
  writes are `auth/login/` (credential exchange) and `forms/<name>/submit/`
  (public form intake) — both throttled, the latter also honeypot-protected.
- A test (`api.tests.PermissionAuditTests`) walks the entire URLconf on every
  CI run and fails if any write method is reachable without admin, except the
  two allowlisted endpoints above. This is the permanent guard.
- Reads are public by design for the CMS contract (`home/<name>/`,
  `settings/site/`, `seo/<path>/`, `blog/`, `redirects/`, `images/`). No
  secrets are stored in those payloads — injected-script fields
  (`analytics.customHead` etc.) are admin-write and *intentionally* served
  by the public `settings/site/` GET because the frontend must inject them.
  That is a deliberate trust boundary: an admin who sets `customHead` is
  trusted to inject `<script>` into every page.

## Findings & fixes

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | Med | `ScopedRateThrottle` was not in `DEFAULT_THROTTLE_CLASSES`; a view setting `throttle_scope` without also setting `throttle_classes` would be silently un-throttled (the reference-repo regression). | **Fixed** P1 — added to defaults. Regression test: `FormSubmitThrottleTests`. |
| 2 | Med | `auth/login/` shared the `form_submit` (5/min) scope. Fine, but coupled brute-force budget to form spam budget. | **Fixed** P1 — dedicated `login` scope (10/min, env `THROTTLE_RATE_LOGIN`). |
| 3 | High | Image upload had no content validation — a `payload.php` renamed `x.png` would be stored and served from `MEDIA_ROOT`. | **Fixed** P1 — `api/image_validation.py`: size cap, extension allowlist, magic-byte sniff, dimension cap. SVG rejected unless `ALLOW_SVG_UPLOAD=True`. Tests: `ImageUploadValidationTests`. |
| 4 | Med | Missing always-on headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`. | **Fixed** P1 — `SECURE_CONTENT_TYPE_NOSNIFF=True`, `X_FRAME_OPTIONS='DENY'`, `SECURE_REFERRER_POLICY='same-origin'`. Test: `SecurityHeaderTests`. |
| 5 | Med | No `SECURE_PROXY_SSL_HEADER` — behind a TLS proxy, `SECURE_SSL_REDIRECT` / secure cookies would misbehave. | **Fixed** P1 — env-gated (`SECURE_PROXY_SSL_HEADER=True`), never assumed. |
| 6 | Low | `DEFAULT_PERMISSION_CLASSES = IsAuthenticatedOrReadOnly` — acceptable (not `AllowAny`); every view also sets explicit `permission_classes` / `get_permissions`, so defaults are belt-and-braces only. | **OK** — no change; enforced by finding #1's audit test. |
| 7 | Low | Reference repo's feedback portal (`Project`/`FeedbackRound`/`FeedbackItem` views) shipped with **no `permission_classes`**, relying on the default — public read of all client feedback and, depending on config, public write. **Out of scope here; portal not ported.** The `PermissionAuditTests` guard ensures dynamic-cms can never reproduce it. | **Noted / guarded** |
| 8 | Low | `CORS_ALLOW_ALL_ORIGINS = True` only when `DEBUG` (which defaults to `False`). Production cannot silently open. `CORS_ALLOWED_ORIGINS` / `CSRF_TRUSTED_ORIGINS` explicit and env-driven. | **OK** |
| 9 | Low | `SECRET_KEY` raises `KeyError` at startup when `DEBUG=False` and unset. | **OK** — verified. |
| 10 | Low | SQL: everything is ORM. No `.raw()`, `.extra()`, or f-string queries anywhere in `api/`. | **OK** |
| 11 | Low | `db.sqlite3`, `.env`, `media/*`, `logs/*.log`, `staticfiles/`, `.venv/` are git-ignored; `.env.example` holds placeholders only. | **OK** |

## `manage.py check --deploy`

Clean when the production env vars are set. With a dev `.env` (`DEBUG=True`)
it emits the standard `security.W00x` warnings for HSTS / SSL-redirect /
secure-cookies / DEBUG — all of which are env-gated in `settings.py` and
resolve once `SECURE_SSL_REDIRECT`, `SECURE_HSTS_SECONDS`,
`SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`, `DEBUG=False` and a real
`SECRET_KEY` are supplied by the deployment. No *new* warnings were
introduced by this upgrade.

## Dependency audit

`requirements.txt` installs cleanly on Python 3.12. Direct imports:
`django`, `djangorestframework`, `python-dotenv`, `dj-database-url`.
In `INSTALLED_APPS` / `MIDDLEWARE`: `django-cors-headers`, `django-filter`,
`whitenoise`. Deploy/runtime: `gunicorn`, `psycopg2-binary`, `redis`,
`pillow` (used from P9 for image dimensions; imported lazily). Remainder
(`asgiref`, `sqlparse`, `pytz`, `python-dateutil`, `six`, `PyYAML`,
`packaging`, `certifi`, `charset-normalizer`, `idna`, `urllib3`,
`typing_extensions`, `tzdata`, `click`) are transitive. `python-decouple`
is listed but unused (settings uses `os.getenv` + `python-dotenv`) — left
pinned to avoid churn; safe to drop.
Run `pip-audit` in CI when available.
