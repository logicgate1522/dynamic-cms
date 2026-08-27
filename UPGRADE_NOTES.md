# Upgrade Notes — CMS + SEO upgrade (`cms-upgrade` branch)

Brings dynamic-cms to parity with (and past) the logic-gate-portfolio
reference: revisioned CMS content, a full SEO engine, server-side JSON-LD,
a generalised Dynamic Page / Section system, richer forms, images, and
redirects. Everything is additive — the original 38 tests and the existing
frontend contract still pass unchanged (now 114 tests).

## Moving an existing clone forward

```bash
git pull                       # or merge the cms-upgrade branch
pip install -r requirements.txt # no new packages; Python 3.12 recommended
python manage.py migrate        # applies 0002–0009, all additive & forward-only
python manage.py test api       # 110 pass
python manage.py check --deploy  # clean once prod env vars are set
```

No data reset. No applied migration was edited. Migration 0003 seeds 22
builtin `ComponentSchema` rows (reversible).

### New env vars (all optional, safe defaults)

`THROTTLE_RATE_LOGIN`, `THROTTLE_RATE_RESOLVE`, `SECURE_PROXY_SSL_HEADER`,
`MAX_IMAGE_BYTES`, `MAX_IMAGE_DIMENSION`, `ALLOW_SVG_UPLOAD`,
`SITEMAP_SOURCES`. See `.env.example`.

## What changed, by area

| Area | Change | Back-compat |
|---|---|---|
| Settings | `ScopedRateThrottle` added to defaults; `login`/`resolve` scopes; always-on `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy`; `URL_FORMAT_OVERRIDE=None` | login now uses `login` scope not `form_submit` |
| `ComponentData` | `+draft_data, status, schema_key, updated_by`; `ComponentRevision`, `ComponentSchema` | plain PATCH/GET byte-identical; `?mode=draft` opt-in |
| Endpoints | `home/schemas/`, `home/<name>/history/`, `publish/`, `revert/` | new |
| `SiteSettings` | canonical shape + PATCH validation; `settings/site/schema/organization/` | blob still free-form + deep-merged; only malformed canonical keys rejected |
| `PageSEO` | `SEOChangeHistory`; `seo/<path>/history/`, `revert/`; **`seo/resolve/<path>/`**; route-ordering fix (specific routes before greedy `<path:path>`) | existing GET/PATCH unchanged |
| SEO audit | `seo_analyzer.py`, `SEOAuditResult`, `seo/analyze/<path>/` + roll-up | new |
| Structured data | `schema_builders.py`, `assemble()`, `validate_schema()`, `seo/validate-schema/` | new |
| Sitemaps | `/robots.txt`, `/sitemap*.xml`, `SITEMAP_SOURCES` registry (project urls) | new |
| Dynamic pages | `ContentPage`, `DynamicSection` (generic FK), `SectionMedia`; `dynamic_pages.py`; `content/paste-to-build/`, `ai/section-schema/`, `ai/dynamic-page-prompt/`, `ai/copy-structure-prompt/`, section CRUD/reorder/media on `content/<path>/` **and** `blog/<slug>/`; publish guard | `BlogPost` kept intact; `+body_mode` (default `legacy`), slug now auto-generates when blank |
| Images | `UploadedImage +alt_text/title/caption/description/credit/license, width/height/file_size/mime_type/format, checksum, focal_x/y, usage`; dedupe; filters; `images/<id>/usage/`; magic-byte + SVG-gate validation | serializer adds `image_url` (absolute) + `duplicate`; existing fields unchanged |
| Forms | server-side validation from `home/form-<name>/`; 18 field types; `FormSubmission +is_spam/ip_hash/user_agent/referer`; `submissions/export/`, `submissions/<id>/` PATCH; configurable honeypot; 60s same-email dedupe; per-form notify override | forms with no definition behave as before (honeypot + persist + notify) |
| Redirects | `+status_code/is_active/hit_count/last_hit_at/notes/created_by/created_at`; `redirects/resolve/`, `redirects/io/`, `?broken=1` | `permanent` still honoured; `status_code` overrides it |

## Master checklist — status

**Backend — CMS:** [x] ComponentData upsert/deep-merge/race guard intact & tested ·
[x] ComponentRevision + history + revert · [x] ComponentSchema + 22 builtins + `home/schemas/` ·
[x] draft/publish + updated_by, back-compat verified · [x] optional schema validation (field-map 400, atomic)

**Backend — SiteSettings:** [x] canonical shape documented + validated · [x] locations / opening hours / geo ·
[x] analytics (GTM/GA4/Pixel/Clarity/Hotjar/LinkedIn) + custom head/body · [x] verification tags ·
[x] `settings/site/schema/organization/` · [x] injected-script fields admin-write, tested

**Backend — SEO engine:** [x] PageSEO canonical shape · [x] SEOChangeHistory + history + revert ·
[x] greedy-route ordering fixed + regression test · [x] `seo/resolve/<path>/` + precedence documented ·
[x] `seo_analyzer.py` technical/content/metadata/schema checks · [x] SEOAuditResult + `seo/analyze/` + roll-up ·
[x] robots.txt from settings · [x] sitemap.xml + index + content-source registry

**Backend — structured data:** [x] schema_builders (org/localbusiness, website+searchaction, breadcrumb,
article, faq, product, service, person, event/howto/video) · [x] `assemble()` + manual override ·
[x] `validate_schema()` + `seo/validate-schema/` · [x] `<` escaped on emit

**Backend — Dynamic Page / Sections:** [x] ContentPage (generic, page_type, body_mode, scheduled) ·
[x] DynamicSection (generic FK) + SectionMedia (slots, pending, required) · [x] SECTION_SCHEMA single source ·
[x] build_ai_prompt + `ai/dynamic-page-prompt/` + `ai/section-schema/` · [x] parse_and_validate (fences,
rejections, {section_index,message}, atomic) · [x] `content/paste-to-build/` · [x] section CRUD + reorder
(id-set validation) + media upload · [x] BlogPost kept intact + same subroutes · [x] publish guard ·
[x] video allowlist backend + prompt; plain-JSX rich text rule · [x] `ai/copy-structure-prompt/`

**Backend — images:** [x] alt/title/caption/description + credit/license · [x] width/height/size/mime/format
(Pillow-optional) · [x] checksum dedupe (returns existing + duplicate:true) · [x] usage refs + `images/<id>/usage/` ·
[x] SVG gated, magic-byte check, size cap · [x] `?category=&unused=1&missing_alt=1` · [x] absolute URLs

**Backend — forms:** [x] extended field types + per-field rules · [x] server-side validation ({errors:{field}} 400) ·
[x] honeypot + throttle + same-email dedupe · [~] file-upload fields — field *type* validated; the
recommended flow is upload via `POST images/` first then submit the returned URL as the field value
(same as the image contract), rather than multipart form posts · [x] submission metadata
(hashed IP, UA, referer, is_read, is_spam) · [x] per-form notify override; mail failure never fails submit ·
[x] submissions filters + CSV/JSON export + read/spam toggle

**Backend — redirects:** [x] status_code + is_active + hit_count + last_hit_at · [x] loop/self rejection intact ·
[x] `redirects/resolve/?path=` (cached) + hit tracking · [x] import/export CSV; `?broken=1`

**Backend — security & infra:** [x] explicit permission_classes on every view + URLconf iteration test ·
[x] DEFAULT_PERMISSION_CLASSES never AllowAny · [x] throttling active + scope-missing regression test ·
[x] pagination on all lists · [x] CORS/CSRF explicit; SECURE_* production-correct, env-gated ·
[x] upload validation (ext + magic bytes + size + SVG gate) · [x] no secrets in repo; .gitignore complete;
.env.example regenerated · [x] check --deploy clean; SECURITY_AUDIT.md

**Backend — quality:** [x] test count 110 (up from 38); suite green · [x] makemigrations --check clean;
one additive migration per phase · [x] existing 38 tests + frontend contract still pass ·
[x] README.md + api/README.md updated · [x] UPGRADE_NOTES.md

**FRONTEND_INTEGRATION_PROMPT.md:** [x] self-contained · [x] behaviour selector · [x] 10 autonomous phases ·
[x] input router (layout / page / component / form / blog) · [x] Paste to Build + Copy Structure ·
[x] Dynamic Page Builder panel wiring · [x] seo/resolve precedence hard rule · [x] SECTION_REGISTRY sync ·
[x] exhaustive SEO reference + per-page checklist · [x] Token-not-Bearer + isAdmin-in-useEffect ·
[x] no dangerouslySetInnerHTML rule + video allowlist · [x] preserve-design rule · [x] prompt template ·
[x] checklist embedded

## The one architectural invariant — unchanged

`home/<name>/`, `settings/site/`, `seo/<path>/` are still name/path-keyed and
upsert-safe: GET on an unknown key → `200 {}`, first PATCH creates, PATCH
deep-merges objects and replaces arrays. `blog/`, `redirects/`, `images/`,
`content/pages/`, sections, and submissions use normal id/slug REST. Every new
endpoint's shape is documented in `FRONTEND_INTEGRATION_PROMPT.md` §13.6.
