# Implementation plan: business-aware tracking, verification and contacts

Status: **implemented** (see UPGRADE_NOTES.md). Deviations from this plan, decided while building:
- without analytics consent the intent profile lives in page memory only (no `sessionStorage`), to satisfy UK PECR's storage rule;
- GA4 conversions are separate `cv_<id>` events (each can be a key event) instead of event-create rules;
- Meta gets ONE event per action carrying every matched conversion id (`conversions` = "|a|b|"), and custom conversions filter on it, so a lead is never counted twice.

Original status: plan. Scope: dynamic-cms (backend + frontend kit + spec)
first, then applied to the reference site. Everything below is generic.

---

## 0. Goals, non-goals, principles

### Goals
1. **Automatic engagement events.** CTA clicks, section views, scroll depth,
   form start, form errors, form abandonment, FAQ opens, outbound links and
   downloads are tracked with no per-site code. Each event carries the page,
   page type, CMS block, intent, segment and stage.
2. **A tracking plan derived from the business.** Intents, segments, stages,
   conversions and audiences are stored as data. AI (or the integrating
   agent) proposes the plan from the site's real pages, forms and services;
   the owner approves and edits it in a panel.
3. **One definition, every tool.** Each event reaches every connected tool
   from the browser and from the server, deduplicated, under the tool's own
   native names. Conversions, audiences and dimensions are created in the
   tools through their APIs. Nobody configures anything inside Meta Events
   Manager, GTM, GA4 or Google Ads.
4. **Automatic verification.** Every conversion is triggered, checked as
   sent, and checked as received in each tool. This runs after publish,
   after deploy, on a schedule and on demand, with alerts when something
   breaks.
5. **Contacts.** A privacy-safe, lightweight CRM built from leads, holding:
   - the intent profile;
   - approximate location and source;
   - the pipeline status;
   - automatic and custom groups;
   - export, webhook and ad-tool audience sync (opted-in contacts only).
6. **A Tracking plan panel.** It lists every tool (connected or not) with
   what to use it for, every conversion with its health, every audience with
   its purpose, and the verification results.
7. **Enforced for every future site.** New spec rules (R31–R33), each in its
   five places, plus gates in check-inline, acceptance, site-audit and the
   launch check. Fresh-install keeps passing.

### Non-goals (deliberately)
- **Identifying anonymous visitors:** no fingerprinting, no bought data, no
  "reveal who visited" tools for people. A company-level B2B lookup is an
  optional plugin hook only (§12.9).
- **Recording every click or mouse move:** Clarity and Hotjar do this. They
  are supported by ID, gated by consent.
- **Rebuilding GA4 reports inside the CMS.** The CMS keeps only daily
  aggregate counts, for health checks and "last seen".
- **Bypassing ad-platform policy** (special ad categories, audience
  restrictions). Sync reports refusals; it never works around them.

### Principles
- **Data, not code.** The plan lives in `SiteSettings.data.analytics.plan`
  and in models; kit code reads it. A site never hard-codes a conversion.
- **Privacy by default.**
  - No personal data in browser events.
  - Server events carry hashed identifiers only, and only with
    `ad_user_data` consent.
  - Linking across visits only with analytics consent.
  - Ad-tool customer lists only with explicit marketing opt-in.
- **The owner never configures events inside a tool.** The only steps left
  are creating accounts, "Connect" once, and accepting tool terms (§10.1).
- **Never silently wrong.** Every plan item has a status: draft, in sync,
  failing (with a reason), or not connected. Problems reach the dashboard,
  the launch check and the alert channel.
- **Same patterns as the rest of dynamic-cms:**
  - Prompt text lives only in `api/prompts.py`, ending with `final_check(...)`.
  - AI replies go through normalise and validate, which refuses data loss.
  - Drafts go live on publish, and everything is reversible.
  - Index keys only (no text keys), and `<E.Text>` for all visible copy.

---

## 1. Architecture

```
 ┌───────────────────────────── visitor browser ─────────────────────────────┐
 │ kit: AnalyticsEvents ─► capture layer (§4) ─► track(name, params) ──────┐ │
 │                          intent profile (§5) ◄─────────────────────────┘ │ │
 │ consent banner (§6) ── gates every adapter and every storage write       │ │
 │ browser adapters: dataLayer/GTM · gtag GA4 · fbq · ttq · lintrk · Ads    │ │
 │ verify harness (§11, only with a signed token)                           │ │
 └──────────────┬───────────────────────────────────────────┬──────────────┘ │
                │ sendBeacon /api/events/ (conversions only) │ submitForm()   │
                ▼                                            ▼
 ┌──────────────────────────── dynamic-cms backend ───────────────────────────┐
 │ events ingest ─► EventOutbox ─► dispatcher ─► server adapters (§9)         │
 │      │                                    Meta CAPI · GA4 MP · TikTok ·    │
 │      ├─► TrackingDaily (aggregate counts, last seen)   LinkedIn CAPI · Ads │
 │      └─► ContactEvent (only consented + identified)                        │
 │ form submit ─► FormSubmission (+profile, event_id, is_test) ─► Contact     │
 │ plan (SiteSettings.analytics.plan) ◄─ AI prompt/normalise (§8)             │
 │ sync engine (§10) ─► GA4 Admin · GTM · Meta Marketing · TikTok · Ads APIs  │
 │ verifier coordinator (§11) ◄─ in-browser harness / headless runner         │
 │ worker: manage.py tracking_worker (cron/systemd/GitHub Action)             │
 │ launch-check · alerts · Tracking plan + Contacts admin APIs                │
 └────────────────────────────────────────────────────────────────────────────┘
```

**New backend modules (`api/`):**

| Module | Contents |
|---|---|
| `tracking_vocab.py` | event vocabulary, parameter rules, tool name maps |
| `tracking_library.py` | base set, business packs, page-type rules, stage detectors |
| `site_facts.py` | extracts the facts the library and AI need from the DB |
| `tracking_plan.py` | plan schema, validation, trigger resolution, diff |
| `tracking_views.py` | plan CRUD, AI prompt/apply, events ingest, verify API, health |
| `tracking_dispatch.py` | outbox, retries, server adapters (`adapters/meta.py`, `ga4.py`, `tiktok.py`, `linkedin.py`, `google_ads.py`) |
| `tracking_sync.py` | reconcile engine, per-tool sync adapters |
| `tracking_verify.py` | runs, results, arrival checks, anomaly detection |
| `contacts.py`, `contact_views.py` | contacts, groups, merge, retention, export/erase, webhooks |
| `crypto.py` | Fernet encryption for credentials (new dependency: `cryptography`) |
| `geo.py` | region from proxy headers or an optional GeoLite2 file |
| `management/commands/` | `tracking_worker`, `tracking_sync`, `tracking_verify`, `contacts_purge` |

**New kit files (all CORE):**

| File | Purpose |
|---|---|
| `lib/track.js` | rewritten: adapters, consent, event_id, beacon, verify hooks |
| `lib/trackCapture.js` | automatic capture layer |
| `lib/intentProfile.js` | intent profile in the browser |
| `lib/consent.js` | consent state |
| `components/seo/ConsentBanner.jsx` | banner, editable copy via `useCms` |
| `components/seo/VerifyHarness.jsx` | verification harness |
| `components/cms/TrackingPanel.jsx` | the Tracking plan drawer |
| `app/admin/contacts/*` | Contacts pages |
| `app/admin/tracking/*` | full-page plan view |
| `acceptance/verify-tracking.mjs` | headless runner |

---

## 2. Data model

### 2.1 `SiteSettings.data.analytics.plan` (validated in `settings_validation.py`)

```jsonc
{
  "version": 3,                         // bumped on every saved change (sync uses it)
  "status": "approved",                 // draft | approved  (only approved syncs)
  "region": "uk_eu",                    // uk_eu | us | other → consent defaults (§6)
  "intents": [
    { "id": "payroll", "label": "Monthly payroll",
      "match": { "paths": ["/services/payroll"], "blocks": [], "collectionEntry": "services/payroll",
                 "faq": ["payroll", "pension", "RTI"], "formOptions": [{ "form": "quote", "field": "services", "option": "Monthly payroll" }] },
      "value": 0 }                      // optional relative value for value rules
  ],
  "segments": [
    { "id": "ltd_director", "label": "Limited company director",
      "match": { "blocks": ["services-who-we-help#items.0"], "faq": ["just me as a director"],
                 "formOptions": [{ "form": "quote", "field": "business_type", "option": "Limited company" }] } }
  ],
  "stages": [
    { "id": "switching", "label": "Switching provider", "strength": 3,
      "match": { "faq": ["switch to", "take over from"] } }
  ],
  "conversions": [
    { "id": "booked", "label": "Consultation booked", "tier": "primary",   // primary | secondary
      "trigger": { "event": "generate_lead", "where": { "form": "quote" } },
      "value": { "mode": "fixed", "amount": 0, "currency": "GBP" },       // fixed | by_option | by_intent
      "destinations": { "ga4": "key_event", "meta": "Schedule", "tiktok": "SubmitForm",
                        "linkedin": "auto", "googleAds": "import_from_ga4" },
      "enabled": true, "createdBy": "ai|library|owner", "locked": false }
  ],
  "audiences": [
    { "id": "payroll_no_booking", "label": "Payroll interest, no booking",
      "purpose": "Remind them of the free consultation and switching help",
      "include": [{ "event": "service_engaged", "intent": "payroll" }],
      "exclude": [{ "conversion": "booked" }],
      "windowDays": 30, "tools": ["meta", "ga4", "googleAds"] }
  ],
  "valueRules": [],                     // e.g. by_option map, by intent count
  "facts": { "hash": "…", "at": "…" }   // site facts the plan was derived from (stale detection)
}
```

**Validation and resolution rules:**
- Ids are `^[a-z][a-z0-9_]{1,39}$` and unique within their list.
- Labels are at most 60 characters.
- Every `trigger.where` reference must resolve against current site facts:
  path, form, field, option, block or collection. An unresolved reference
  is a **dangling trigger**: saving as draft is allowed, approving is
  refused, and the launch check warns.
- Per-tool caps are enforced at approval, leaving headroom for the owner's
  own items:

  | Limit | Cap used |
  |---|---|
  | GA4 key events (30) | 25 |
  | GA4 event-scoped custom dimensions (50) | 40 |
  | GA4 audiences (100) | 80 |
  | Meta custom conversions per ad account (100) | 80 |
  | Meta custom audiences (500) | 400 |

- Only GBP/EUR/USD and other ISO-4217 currencies are allowed.
- A value requires a currency.
- `by_option` value rules must name existing options.
- `locked: true` items are never changed by AI updates.

### 2.2 New models

| Model | Key fields | Notes |
|---|---|---|
| `TrackingConnection` | `tool` (unique), `status` (not_connected/connected/error/needs_reauth), `account` (ids: pixel, ad account, GA4 property, stream, GTM container…), `secret` (encrypted), `scopes`, `connected_at`, `last_ok_at`, `last_error` | Secrets are write-only through the API; responses show only `…last4`. |
| `TrackingSyncItem` | `tool`, `kind` (key_event/custom_dimension/audience/custom_conversion/gtm_tag…), `plan_id`, `remote_id`, `desired_hash`, `status` (pending/in_sync/failed/refused/orphaned), `error`, `synced_at` | Ownership record: the CMS only touches remote items it created. |
| `EventOutbox` | `event_id` (uuid), `name`, `params`, `consent`, `identifiers` (hashed), `context` (url, ua, ip_hash, fbp/fbc/gclid/ttclid/li_fat_id), `tools_pending`, `attempts`, `next_at`, `status`, `is_test`, `created_at` | Kept 14 days, then purged. Idempotent on `event_id + tool`. |
| `TrackingDaily` | `date`, `name`, `conversion_id`, `intent`, `block`, `count`, `test_count` | Aggregates only. Powers "last seen", anomaly detection and dashboard sparklines. |
| `VerificationRun` | `trigger` (manual/publish/deploy/schedule), `mode` (in_browser/headless), `status`, `started/finished`, `summary` | |
| `VerificationResult` | `run`, `conversion_id`, `tool`, `step` (trigger/sent/received), `ok`, `detail`, `evidence` (redacted payload) | |
| `Contact` | `email_norm` (unique-ish), `phone_e164`, `name`, `status`, `owner_notes`, `tags`, `marketing_opt_in` (+ `opt_in_at`, `source_form`), `region`, `country`, `first_source`, `last_source`, `intents` (scores), `segment`, `stage`, `value`, `visits`, `first_seen`, `last_seen`, `retain_until`, `is_client` | PII. Admin-only. Never cached publicly. |
| `ContactEvent` | `contact`, `at`, `name`, `params` (no PII) | Only for consented, identified visitors. Capped at 500 per contact (oldest dropped). |
| `ContactGroup` | `id`, `label`, `kind` (auto/custom), `rule` (JSON), `sync_to` (tools), `remote_ids`, `last_synced` | Automatic groups come from the plan's intents, segments, stages and audiences. |
| `ConsentLog` (optional) | `visitor_hash`, `choice`, `at`, `banner_version` | Proof of consent. Off by default; the owner can enable it. |
| `AdminAuditLog` | `user`, `action` (export/erase/view_contact/connect_tool), `target`, `at` | Accountability for PII access. |

**`FormSubmission` gains:**
- `event_id`;
- `profile` (JSON: intent scores, segment, stage, recent path, visits, source/UTM, click ids);
- `is_test`;
- `consent` (snapshot);
- `contact` (FK, nullable);
- `region`, `country`.

The migration is additive and older rows keep working.

---

## 3. Event vocabulary (`tracking_vocab.py`, mirrored in `lib/track.js`)

The vocabulary is fixed, so data looks the same on every site. GA4
recommended names are used where they exist.

| Event | Fired when | Key params |
|---|---|---|
| `page_view` | first load (by the tags) and in-site navigation | `page_type`, `intent?` |
| `cta_click` | a link or button marked as a CTA, or pointing at a FORM_PAGE or booking path | `cta_label`, `block`, `intent?`, `cta_target` |
| `nav_click` | header, footer or menu navigation | `nav_area` (header/footer/menu), `nav_label`, `intent?` |
| `section_view` | a CMS block at least 50% visible for 2 seconds or more, once per page view | `block`, `intent?` |
| `scroll_depth` | 25/50/75/90% of the main content, on article and entry pages | `percent` |
| `service_engaged` | a page with an intent, viewed for 30 seconds or more **or** scrolled 50% | `intent` |
| `faq_open` | an FAQ item opened | `faq_id` (block#index), `faq_topic` (category), `intent?`, `stage?` |
| `form_start` | first interaction with a form | `form_name` |
| `form_error` | client or server validation error | `form_name`, `field` (name only) |
| `form_abandon` | page hidden or navigated away after `form_start` with no submit | `form_name`, `last_field` |
| `generate_lead` | submission stored (not spam, not test) | `form_name`, `intent`, `segment`, `stage`, `services` (option labels only) |
| `contact_click` | `tel:`/`mailto:`/WhatsApp link | `method` (the **value is dropped**: it is PII-adjacent and adds nothing) |
| `outbound_click` | a link to another domain | `link_domain` |
| `file_download` | a link to a PDF or other document | `file_ext`, `file_name` |
| `search` | the site search, if there is one | `search_term` (truncated to 100 characters, emails and numbers redacted) |
| `conversion` (internal) | a plan conversion matched | `conversion_id`, `tier`, `value`, `currency` |

**Common params on every event:**
- `page_path`, `page_type` (home/service/article/entry/index/contact/legal/other), `content_group`;
- `intent`, `segment`, `stage` (from the live profile, when known);
- `event_id`, `cms_v` (kit version);
- `debug_mode`, `cms_verify_run` (verification only).

**Tool name mapping** (the dispatcher and browser adapters share this table):

| CMS | GA4 | Meta | TikTok | LinkedIn | Google Ads |
|---|---|---|---|---|---|
| `generate_lead` | `generate_lead` | `Lead` (or `Schedule` when the plan says booking) | `SubmitForm` | conversion id from sync | conversion via GA4 import or label |
| `cta_click` | `cta_click` | custom `CtaClick` | `ClickButton` | — | — |
| `service_engaged` | `service_engaged` | `ViewContent` (`content_category` = intent) | `ViewContent` | — | — |
| `contact_click` | `contact_click` | `Contact` | `Contact` | — | — |
| `file_download` | `file_download` | custom `Download` | `Download` | — | — |
| others | same name | custom, PascalCase (only if `meta.custom` is on) | — | — | — |

**Parameter hygiene (enforced in both copies):**
- GA4: event names at most 40 characters; parameter names at most 40 and
  values at most 100 characters; at most 25 parameters.
- Meta: custom event names at most 50 characters, letters and digits only.
- Values are stripped of emails, phone-like digit runs (7 or more digits)
  and URL query strings (except the UTM allowlist).
- `cta_label` comes from the visible text, truncated to 60 characters.
  Editable text is the label, so a renamed button keeps tracking under its
  new label, and verification flags the change (§11.6).

**Volume control:**
- The server copy is sent only for conversion-level events: `generate_lead`,
  plan conversions, and `service_engaged`.
- Engagement events are browser-only.
- Per-page caps: at most 30 events, and one `section_view` per block.

---

## 4. Automatic capture layer (`lib/trackCapture.js`)

### 4.1 Knowing the block and intent for visitors
Today visitor HTML has no block markers, so they are added:
- `useCms` returns `track`: an attributes object (`data-track-block={name}`,
  plus `data-track-intent` when the plan maps the block or page). Components
  spread it on their **root element**:
  `<section {...track} className=…>`.
- **check-inline rule:** a `useCms` component must spread `track` on its
  outermost element. CMS-page sections get it automatically in
  `SectionSlot` and the dynamic renderers.
- **List items:** `E.Item` already knows `path` and `index`. In visitor mode
  it renders nothing, so the item root carries `data-track-item="items.2"`
  via a helper `trackItem(i)` that components spread. check-inline enforces
  it where `E.Item` is used.
- **Page-level intent:** `PageSeo` or the layout sets
  `<main data-track-page-type=… data-track-intent=…>`, from the plan's
  path/collection matches (resolved server-side and passed in metadata, so
  no client lookup is needed).
- **Size:** about 40 bytes per block; negligible.

### 4.2 Rules per event

| Event | Detection |
|---|---|
| `cta_click` | **(a)** the element or its ancestor has `data-track-cta` (set by `E.Link` when the hint `cta: true` is on, or by the sections' primary/secondary buttons); **(b)** any link whose path is a FORM_PAGE or a configured booking path. Label = visible text; block = nearest `data-track-block`. Middle-click and Ctrl/Cmd-click also count. Keyboard Enter counts via the click event. |
| `nav_click` | links inside `header`, `footer` or `[data-track-nav]`. The header dropdown already exposes children. |
| `section_view` | one shared IntersectionObserver (threshold 0.5). A 2-second timer is cancelled on exit, paused while the tab is hidden, and fires once per page view per block. Blocks shorter than 120px fire at 100% visibility. Hidden blocks don't exist for visitors, so they never fire. |
| `scroll_depth` | only on `page_type` article or entry. Measured on `<main>` (or `[data-track-content]`), not the document, so tall footers don't skew it. Thresholds fire once. Short pages (≤ 1.2 viewport heights) fire 100% immediately and no 25–90%. |
| `service_engaged` | visible-time accumulator (pauses when hidden or after 30 seconds idle with no input or scroll) reaching 30 seconds, OR 50% scroll, on a page with an intent. Once per page view. |
| `faq_open` | the kit FAQ section and site accordions mark items with `data-track-faq="block#index"` and `data-track-faq-topic`. One delegated listener handles `<details>` `toggle` (open only) and `[aria-expanded]` changes via click. check-inline flags accordion components lacking the attribute (heuristic: `aria-expanded` in a `useCms` component with a list). |
| `form_start` | the first `input`/`change` in a `form[data-cms-form]`. `submitForm` already knows the form name, and the kit form component adds the attribute. |
| `form_error` | emitted by `submitForm` on server errors, and by the kit form on client validation (field names only). |
| `form_abandon` | on `pagehide` or SPA navigation, if started and not submitted; sent by beacon. Not sent if the form was submitted, or after a reset. |
| `outbound_click` | any `a[href]` with a different origin (ignoring `tel:`/`mailto:`). Same-site subdomains count as internal (configurable allowlist). |
| `file_download` | extensions pdf, docx, xlsx, csv, zip, pptx, or a `download` attribute. |
| `contact_click` | as today, minus the value. |

### 4.3 Exclusions and correctness
- **Never tracked:**
  - signed-in admins (when "Don't track admins" is on; default on);
  - draft preview;
  - edit mode;
  - pages with `noindex` and `robots: none` (admin, preview);
  - `navigator.webdriver`, unless a signed verify token is present;
  - prerender and prefetch (`document.prerendering`): wait for
    `prerenderingchange`.
- **Back/forward cache:** on `pageshow` with `persisted`, a new page view
  is fired and per-page dedupe state is reset.
- **SPA navigation:** state resets on pathname change, not on hash or
  search-only changes, except for `?page=`-style pagination (configurable).
- **Double events:** one delegated listener per type at the document level,
  with listener re-registration guarded (React strict mode and HMR).
- **Performance:**
  - passive listeners;
  - work deferred with `requestIdleCallback` (falling back to `setTimeout`);
  - no `getBoundingClientRect` in scroll handlers (observers only);
  - bundle budget for capture, profile and consent: ≤ 6 KB gzip (asserted in
    fresh-install).
- **Errors:** capture is wrapped so a failure never breaks the page. A
  `window.__cmsTrackErrors` counter is exposed to the verifier.

---

## 5. Intent profile (`lib/intentProfile.js`)

### 5.1 What it holds

```jsonc
{ "v": 1, "vid": "uuid (only with analytics consent)", "visits": 3,
  "first": { "at": "...", "source": "google / organic", "landing": "/services/payroll",
             "utm": { "source": "google", "medium": "cpc", "campaign": "payroll" } },
  "last":  { "source": "...", "at": "..." },
  "click": { "gclid": "...", "fbclid": "...", "ttclid": "...", "li_fat_id": "...", "msclkid": "..." },
  "scores": { "intent": { "payroll": 6.5, "annual_accounts": 3 },
              "segment": { "ltd_director": 4 }, "stage": { "switching": 3 } },
  "path": [ { "p": "/services/payroll", "t": 47 }, "... last 15 pages" ],
  "signals": [ "faq:switching", "pricing_seen" ]
}
```

### 5.2 Scoring

| Signal | Weight |
|---|---|
| `page_view` of an intent page | +1 |
| `service_engaged` | +3 |
| `cta_click` with intent | +2 |
| `faq_open` matching an intent, segment or stage | +2 |
| intent-tagged block viewed | +0.5 |
| form option chosen | **+10, and wins ties** |

- **Decay:** × 0.8 per previous visit, so recent interest dominates.
- **Primary** is the top score, provided it is at least 1.5× the second.
  Otherwise the profile records "mixed: a, b".
- Segment and stage use the same rule. Stage keeps every stage with a score
  of 3 or more (several stages can be true at once).
- **Matching:**
  - FAQ text and FAQ topic matching is precomputed **server-side** into
    `data-track-intent` and `data-track-stage` on FAQ items. Nothing is
    matched against text in the browser, and the matching is stable across
    edits because it is recomputed on publish.

### 5.3 Storage and consent
- **No consent or denied:** `sessionStorage` only. No `vid`. Cleared when
  the tab closes. It is still attached to a lead submitted in that session:
  the visitor sends it voluntarily with the form, which is the lawful basis
  for handling the enquiry. The privacy notice must say so; site-audit
  checks it (§14).
- **Analytics consent granted:** `localStorage` (`cms_profile`, 90-day
  rolling) plus a first-party `vid`.
- **Consent withdrawn:** delete the stored profile and `vid` immediately,
  keep only the session copy, and send a beacon to unlink the `vid` from
  any Contact (§12.4).
- **Robustness:**
  - wrapped in try/catch (private mode, quota, blocked storage);
  - size cap of 8 KB (the oldest path entries are dropped);
  - schema version `v`: unknown versions are discarded.
- **Multiple tabs:** last-write-wins merge on the `storage` event. Scores
  are additive, so the merge is a max-merge per key.

### 5.4 Attaching to a lead
- `submitForm` adds `_cms` to the request: `profile`, `event_id`, `consent`,
  `fbp`/`fbc` (from cookies, only with marketing consent) and `is_test`
  (verify only).
- The backend **pops `_cms` before validation**, so form definitions never
  see it and older backends ignore it. It is stored in
  `FormSubmission.profile`.
- **Reconciliation with form answers:** if the form has fields mapped in the
  plan (`formOptions`), the chosen options override inferred scores. A
  mismatch is kept as "inferred: X, said: Y", which is useful insight.
- **The notification email** (still FormSubmit, from the browser) gets one
  summary line:
  "Interest: Payroll + Accounts · Limited company · Switching · via Google
  Ads 'payroll'". No raw path list.

---

## 6. Consent (`lib/consent.js`, `ConsentBanner.jsx`)

- **Categories:** necessary (always on), analytics, marketing. Optionally
  "functional" (off by default, unused unless the site needs it).
- **Region modes,** chosen in Settings (`plan.region`):
  - `uk_eu`: opt-in. Analytics and marketing are denied by default, and the
    banner is shown.
  - `us`: opt-out. Granted by default, with a "Do not sell/share" link.
    Global Privacy Control (GPC) is honoured as an opt-out.
  - `other`: the owner picks.

  `analytics.consentDefault` remains for back-compat and maps to these.
- **Google Consent Mode v2:** the default is set before any tag (already in
  the bootstrap). The banner choice calls `gtag('consent','update', {...})`
  with `analytics_storage`, `ad_storage`, `ad_user_data` and
  `ad_personalization`.
- **Non-Google tools load only after consent:**
  - Meta, TikTok and LinkedIn need **marketing**;
  - Clarity and Hotjar need **analytics**.

  Revoking consent stops further calls; scripts already loaded are told to
  revoke (`fbq('consent','revoke')`, `ttq.holdConsent`) and the page is
  reloaded only if needed.
- **The banner:**
  - copy is editable via `useCms("consent-banner")` (`E.Text`);
  - accessible: focus trap, Esc, keyboard, ≥ 4.5:1 contrast via
    `--cms-*` tokens;
  - responsive (≥ 11px text, no overflow);
  - never covers the primary CTA on phones (it sits at the bottom, under
    40% of the viewport height).
  - Buttons: **Accept all**, **Reject all** (equal prominence, as UK ICO
    guidance requires) and **Choose**.
  - The choice is stored in the `cms_consent` cookie (necessary category,
    6–12 months, configurable) with the banner version.
  - Changing the banner's categories bumps the version, which asks again.
- **Re-open:** a "Cookie settings" link in the footer (`data-cms-consent-open`).
  site-audit checks it exists when any tag is configured.
- **Server side:** every `/api/events/` and `_cms` payload carries the
  consent snapshot. Server adapters drop hashed identifiers without
  `ad_user_data`, and Meta gets `data_processing_options` where required.
- **No tags configured:** no banner. The site only uses necessary cookies,
  so a banner would be noise.

---

## 7. Conversion library and site facts

### 7.1 Site facts (`site_facts.py`)
Computed from the DB on demand, and cached with the "seo" version key:
- **Organisation:** `organizationType`, locale and country, contact
  channels (phone shown? email shown? WhatsApp?), and whether there is an
  address or locations.
- **Pages:** every published path with `page_type`. Collections and their
  entries (with titles, used as candidate intents). Nav items and the
  header dropdown children.
- **Forms:** names, fields (name, type, options), and which pages render
  which form (from the FORM_PAGE setting and the form block placements).
- **Content:** FAQ items (question and category) from FAQ blocks and the FAQ
  page; pricing blocks (by type or name containing "pricing"); "who we help"
  or audience lists (heuristic: a list block whose items link to or name
  customer types, confirmed by AI).
- **Downloads, outbound links, search:** whether downloadable files,
  outbound links or a site search exist.
- **Tools:** which tracking IDs and connections exist.

The facts hash is stored in `plan.facts.hash`. When it changes after a
publish (a new service, a removed form field), the plan is flagged stale.
The panel then shows "Site changed: review plan", the dangling-trigger check
runs, and an AI update is offered.

### 7.2 Library (`tracking_library.py`)
Each entry has `applies(facts) -> bool`, a template, and `rationale` text,
which is shown in the panel as "why this is tracked".

- **Base set** (any site with a form): lead (primary); booking intent (CTA
  to form page); form abandon; contact page reached; article read 75%
  (if articles exist).
- **Page-type rules:**
  - one intent per service or offering (collection entry, or nav child under
    "Services/Products/Solutions");
  - `service_engaged` per intent;
  - pricing seen (if a pricing block exists);
  - FAQ opens grouped by detected stage;
  - guide → service path (`article` page followed by an intent page in the
    same session).
- **Stage detectors** (keyword sets, multilingual-ready per locale, refined
  by AI):

  | Stage | Signals |
  |---|---|
  | switching | "switch", "move from", "take over", "transfer" |
  | urgency | "deadline", "due", "late", "penalty", "emergency", "same day", "today" |
  | price | "cost", "price", "fee", "quote", "how much" |
  | starting | "do I need", "getting started", "new business", "first time" |
  | trust or hesitation | "visit", "office", "secure", "data", "safe", "refund", "guarantee" |

- **Business packs,** keyed by `organizationType` and AI classification.
  Each lists extra conversions and audiences, plus which channels to ignore:

  | Pack | Typical additions |
  |---|---|
  | professional_services | consultation booked, lead by service, switching, deadline |
  | local_trades | call click (only if a phone is shown), directions (only if an address), emergency page, quote request |
  | clinic_health | appointment, treatment interest. Ad tools are restricted: health audiences are **disabled by default** (Meta policy) |
  | restaurant_venue | booking, menu view, opening hours |
  | ecommerce | `view_item`, `add_to_cart`, `begin_checkout`, `purchase` (needs cart hooks: out of scope for v1; exposed as the `track()` API for sites with a store) |
  | saas | pricing view, signup, demo request, docs read |
  | agency_portfolio | project/case-study viewed by category, brief submitted, budget band |
  | events | ticket click, date viewed |
  | nonprofit | donate click, volunteer form |
  | generic | base set only |

- **Applicability guards** (an edge-case killer): no phone shown means no
  call conversions; no address means no directions; no downloads means no
  download conversion; a single service means no "multi-service" signal; no
  articles means no read-depth conversion.

### 7.3 Value rules
- **Owner-entered relative values only.** The AI never guesses money. By
  default the value is 0 and the currency comes from the locale.
- **`by_option`:** maps form options (for example a budget band) to values.
- **`by_intent`:** sums the values of the chosen intents, so leads asking
  for more services are worth more.
- Values are sent as `value` and `currency` to GA4, Meta, TikTok and Ads.
  They are never shown publicly.

---

## 8. AI: deriving and updating the plan

- **Endpoint:** `POST ai/tracking-plan/prompt/` builds the prompt in
  `prompts.py` from the site facts, the library entries that apply, the
  current plan (locked items marked), the vocabulary, the caps, and the
  exact JSON shape. It ends with `final_check(...)`, repeating:
  - only reference facts that exist;
  - no personal data;
  - no prices or money values;
  - keep locked items;
  - stay under the caps.
- **Apply:** `POST ai/tracking-plan/apply/` takes the pasted reply,
  normalises it (`ai_normalize`: fences, prose, wrapper), validates it
  against the schema, resolves every trigger, and drops what doesn't
  resolve (reported as "dropped: reason").
  - It **refuses data loss:** a reply that deletes locked items or more than
    half the plan is rejected unless the owner ticks "replace plan".
  - The result is a **draft plan plus a diff:** added, changed and removed
    items, each with its rationale.
- **Approval:**
  - The owner reviews the diff in the panel and approves items one by one
    or all together.
  - Approval sets `status=approved`, bumps `version` and enqueues a sync.
  - Nothing reaches the tools while the plan is a draft.
- **Without AI:** "Build from library" produces a deterministic plan from
  the applicable library entries alone, so the feature never depends on an
  AI reply.
- **During integration (Job A):** the agent calls the same prompt
  endpoint, pastes its own reply into apply, approves, and records the plan
  in its report. R31 requires it (§14).
- **Re-run triggers:** facts changed (stale plan), a new collection entry
  published, or a form changed. The panel offers it; it never runs
  automatically.

---

## 9. Server-side events

### 9.1 Ingest: `POST /api/events/`
- **Public, but tightly guarded:**
  - throttled with `SiteAwareScopedRateThrottle` (scope `events`, 60/min/IP);
  - `Origin` must be the site URL or the dev origins;
  - body at most 8 KB;
  - only allowlisted event names;
  - parameters sanitised exactly as in §3;
  - added to `PUBLIC_WRITE_ALLOWLIST` on purpose, with a test.
- **Transport:** `navigator.sendBeacon`, falling back to
  `fetch(keepalive)`. The response is 204 and the client never waits on it.
- **Duplicates:** `event_id` is unique per (event_id, name); a replay is
  answered with 204 and does nothing.
- **Bots:**
  - user-agent denylist, plus `navigator.webdriver` (flag sent);
  - events from IPs on the spam list are dropped;
  - verification events are accepted only with a valid signed run token.
- **Lead events are created server-side:** on a stored submission, the
  outbox gets `generate_lead` plus the matching conversion events.
  - This copy carries the hashed email and phone (SHA-256 of lowercase
    trimmed email, and of the E.164 phone number with the country inferred
    from the locale), only with `ad_user_data` consent.
  - Its `event_id` is the same id the browser used.
- **Daily counts:** ingest increments `TrackingDaily` (or `test_count` for
  verification events).

### 9.2 Dispatcher (`tracking_dispatch.py`)
- **Outbox pattern:**
  - rows are written in the request transaction;
  - delivery happens in `transaction.on_commit` via a short-lived thread
    (2-second timeout per tool) for simple hosting, **and** in the
    `tracking_worker` loop (every 30 seconds) for retries.
  - Both are safe because the per-tool ledger in `tools_pending` is updated
    atomically: `SELECT … FOR UPDATE SKIP LOCKED` on Postgres, and a
    row-level lock flag on SQLite.
- **Retries:**
  - exponential backoff (30s, 2m, 10m, 1h, 6h), then dead-letter;
  - an hourly circuit breaker per tool after 20 consecutive failures, which
    raises an alert;
  - auth errors move the connection to `needs_reauth` and pause that tool.
- **Adapters:**

  | Tool | Server API | Dedupe with the browser copy |
  |---|---|---|
  | Meta | Conversions API (`/{pixel}/events`): `event_id`, `event_source_url`, `action_source=website`, `user_data` (`em`/`ph` hashed, `fbp`, `fbc`, `client_ip_address`, `client_user_agent`) only with consent; `test_event_code` for verification | **Yes,** by `event_name` + `event_id` (48h) |
  | GA4 | Measurement Protocol (`api_secret` created by sync), `client_id` from the `_ga` cookie, sent by the browser in the payload | **No,** GA4 does not deduplicate MP against gtag. Rule: send the MP copy **only when the browser reports GA4 did not load** (`ga4_loaded=false` in the beacon: blocked or consent denied). With consent denied, MP is not sent at all; Consent Mode pings cover it. |
  | TikTok | Events API: `event_id` | **Yes** |
  | LinkedIn | Conversions API: `conversion` URN from sync; hashed email only with consent | **Yes,** via `eventId` |
  | Google Ads | **v1:** import GA4 key events (no API). **v2 (optional, needs a developer token):** enhanced conversions for leads/offline upload with `gclid` | n/a |

- **Clock and timezone:** `event_time` uses server UTC. Events older than 7
  days are never sent (Meta rejects them).
- **PII audit:** the outbox `params` pass the same sanitiser. A unit test
  feeds emails and phone numbers into every param and asserts they are
  removed.

---

## 10. Tool connections and sync

### 10.1 Connecting (once per tool)

| Tool | How | What the owner does once |
|---|---|---|
| Google (GA4 Admin, GTM, GA4 Data) | **Service account JSON upload** (recommended for a self-hosted CMS: no OAuth app verification). The panel shows the service-account email to add as **Editor** on the GA4 property and the GTM container. Optional: OAuth "Connect Google" when the deployment has its own OAuth client. | Create the GA4 property/GTM container; add the service account email as a user |
| Meta | System-user access token (Business settings → System users) with `ads_management`, plus the pixel id and ad account id. The panel validates them by calling `/me` and `/{pixel}`. | Create a system user; assign the pixel and ad account; paste the token |
| TikTok | Events API access token plus the pixel code | Generate a token in Events Manager |
| LinkedIn | App client id/secret plus OAuth (needs LinkedIn Marketing API approval) | Apply for access; connect |
| Google Ads | v1: link GA4 ↔ Ads in Ads (one click). v2: developer token plus OAuth | Link accounts |

- **Security of stored secrets:**
  - encrypted with Fernet using the `TRACKING_SECRET_KEY` environment
    variable;
  - the backend refuses to store secrets if the key is missing;
  - secrets are never logged, serialised or returned (`…last4` only);
  - "Disconnect" deletes the secret and remote-ownership records **without**
    deleting anything remotely, unless "Also remove what the CMS created" is
    ticked.
- **Rotating `TRACKING_SECRET_KEY`:** a `manage.py tracking_rotate_key`
  command re-encrypts with the new key and accepts the old key once.

### 10.2 Reconcile engine (`tracking_sync.py`)
1. **Desired state:** derived from the approved plan for each connected
   tool (§10.3).
2. **Remote state:** fetched and filtered to items the CMS owns, identified
   by `TrackingSyncItem.remote_id` **and** a marker in the remote
   description/name: `[cms:<plan_id>]`.
3. **Diff** by `desired_hash`: create, update or archive.
   - Never hard-delete remote items that hold data: archive, or rename to
     `[removed] …`. GA4 custom dimensions can only be archived; Meta
     custom conversions can't be deleted with data, so they are renamed and
     disabled.
4. **Dry run:** the panel shows "will create 6, update 1, archive 0" before
   the first sync and after large plan changes.
5. **Execution:**
   - each item runs in its own try; one failure doesn't stop the rest;
   - every item records a status, error and timestamp.
   - **Refused** (policy, caps, permissions): status `refused` with the
     tool's reason, shown in plain words, with no retry loop.
6. **Idempotency:** re-running with no plan change does nothing. Remote
   drift (someone edited the item in the tool) is detected by the remote
   hash. The panel shows "changed outside the CMS" with **Keep theirs**
   (marks the item locked and stops managing it) or **Restore ours**.
7. **Rate limits:** per-tool token bucket; Google API quota errors (429)
   trigger a backoff and resume.
8. **When it runs:** on approval, on "Sync now", nightly (to detect drift),
   and after a connection is (re)made.

### 10.3 What is created per tool
- **GA4:**
  - a Measurement Protocol API secret (for §9.2);
  - **custom dimensions** (event-scoped): `intent`, `segment`, `stage`,
    `block`, `cta_label`, `page_type`, `faq_topic`, `form_name`,
    `conversion_id`;
  - **key events:** `generate_lead`, plus one per primary conversion. A
    conversion that is a filtered `generate_lead` (for example
    `services=Payroll`) becomes a derived event name `lead_payroll`, created
    via **event create rules** on the web stream, then marked as a key
    event;
  - **audiences** from `plan.audiences` (Admin API audiences, v1alpha. If
    the alpha API is unavailable, they show as "manual: copy this
    definition", which is the one honest fallback);
  - an internal-traffic rule for verification traffic and a data filter
    (in **testing** state, then active) excluding `traffic_type=internal`.
- **GTM** (only if a GTM ID is set **and** Google is connected):
  - a managed folder with variables (data layer variables for every common
    param), one regex custom-event trigger, the GA4 config, a GA4 event tag
    with `{{Event}}`, and consent settings on every tag;
  - created in a new workspace, versioned, and **published only after the
    owner clicks Publish in the panel** (GTM is shared territory: other
    tags may be there);
  - without a connection, "Download container JSON" provides the same
    content for import.
- **Meta:**
  - **custom conversions** for primary and secondary conversions (rule on
    the event plus `conversion_id`/`intent` params, with a category such as
    LEAD, CONTACT or SCHEDULE);
  - **website custom audiences** from `plan.audiences` (rule JSON with a
    retention window), checked for special-category restrictions;
  - **custom audiences from contact groups** (§12.6), only for opted-in
    contacts, hashed.
- **TikTok:** pixel events need no definitions. Custom conversions and
  audiences are created via the Business API where available; otherwise
  "manual: copy this definition".
- **LinkedIn:** conversion rules per primary conversion, once the app is
  approved.
- **Google Ads:** v1 shows the instruction to import the GA4 key events
  (one click, done once). v2 creates conversion actions and Customer Match
  lists.

---

## 11. Verification (trigger → sent → received)

### 11.1 Turning conversions into test steps
`tracking_plan.compile_tests(plan, facts)` produces a test for each enabled
conversion and audience-relevant event:

| Trigger kind | Test steps |
|---|---|
| CTA click (block + label or target) | open the page; find `[data-track-block=X] [data-track-cta]` matching the label or target; click with navigation intercepted |
| `service_engaged` on an intent | open the page; scroll to 50% (fast path) |
| `faq_open` with stage/topic | open the FAQ page; click the first item with that stage or topic |
| `generate_lead` (+ `where` option) | open FORM_PAGE; fill required fields with test data (the existing acceptance filler, moved into a shared module); choose the option the conversion needs; submit with `is_test` |
| `form_abandon` | start the form, then navigate away |
| `scroll_depth` / guide read | open the first published article; scroll to 75% |

If the target can't be found, the step fails with a precise reason: "no CTA
labelled 'Book a Free Consultation' in block services-pricing on /services
(the label changed to 'Get a quote'?)".

### 11.2 Where tests run
1. **In-browser harness ("Run checks" in the panel):**
   - opens each page in a hidden same-origin iframe with
     `?cms-verify=<run token>`;
   - the run token is HMAC-signed, valid for 10 minutes, and scoped to the
     run id;
   - `VerifyHarness` (loaded only with a valid token, verified server-side
     with a nonce) performs the steps;
   - it wraps `dataLayer.push`, `gtag`, `fbq`, `ttq`, `lintrk`,
     `sendBeacon` and `fetch` to the known collector hosts, records every
     outgoing call, and POSTs the results.
   - It needs no server-side browser, so it works on any hosting.
2. **Headless runner** (`acceptance/verify-tracking.mjs`):
   - the same harness, driven by Playwright;
   - started by `manage.py tracking_verify --headless` (if Node and the
     browser exist on the server), a cron job, or a GitHub Action
     (`workflow_dispatch` plus a schedule) calling `POST verify/runs/`;
   - polls pending runs, executes them, posts results.
   - It also captures **real network requests** to `google-analytics.com`,
     `facebook.com/tr`, `analytics.tiktok.com` and `px.ads.linkedin.com`,
     including their status codes.
3. **The browser blocks third-party tags** in the in-browser mode (an ad
   blocker in the admin's browser): the harness reports "blocked by this
   browser", not "broken", and suggests the headless run.

### 11.3 "Sent" assertions
For every expected call:
- the native event name for that tool (§3 map);
- the required params present (`conversion_id`, `intent`, `value` and
  `currency` when set);
- **no PII:** a regex scan for emails and phone numbers across all params;
- the same `event_id` on the browser copy and the server copy;
- consent respected: in a "denied" run (the harness can force the consent
  state), **no** Meta, TikTok or LinkedIn calls, and GA4 sends only
  consent-mode pings;
- admin exclusion: the harness runs as a visitor, never with the admin
  cookie (the iframe uses a separate cookie-less request, with the session
  cookie stripped by a `cms-verify` query handler in middleware).

### 11.4 "Received" assertions (server side, after the run)

| Tool | How it is confirmed | Strength |
|---|---|---|
| GA4 | MP validation server (`/debug/mp/collect`) for the server copy; Data API realtime report: count of `eventName` with `traffic_type=internal` rising within the run window | strong for the server copy; good for the browser copy |
| Meta | the CAPI response `events_received` and `fbtrace_id` for the server copy (sent with `test_event_code`); the browser copy is confirmed by a 200 from `facebook.com/tr` (headless) | strong for the server copy; network-level for the browser copy |
| TikTok | the Events API response plus `test_event_code` | strong for the server copy |
| LinkedIn | the CAPI response | strong for the server copy |
| Google Ads | conversion action status `RECORDING_CONVERSIONS` via the API (v2) or "import pending" (v1) | status only |

Meta and TikTok expose no read-back API for test events. The panel says
"accepted by Meta (server); seen leaving the browser", not something
stronger than the evidence.

### 11.5 Test data isolation
- **Browser copy:**
  - GA4 `debug_mode: true` and `traffic_type: internal` (excluded by the
    data filter created in §10.3);
  - Meta and TikTok use `test_event_code` on the server copy;
  - the browser pixel copy goes out with the harness param
    `cms_verify_run`, and **the Meta custom conversions created by sync
    exclude it** (rule: `cms_verify_run` not present).
  - Fallback where that isn't possible: browser pixel calls are stubbed in
    the in-browser mode and only the server copy (with the test code) is
    sent for real.
- **Test submissions:**
  - `is_test=True`;
  - no email notification;
  - no Contact;
  - excluded from the inbox by default (a filter shows them);
  - counted in `TrackingDaily.test_count`;
  - deleted after 24 hours by the worker.
- **Ads:** test conversions are never sent to Google Ads or LinkedIn
  conversion endpoints. Those steps are marked "skipped in test (would
  affect bidding)".

### 11.6 When verification runs
- **After publish:** a static **trigger check** runs first, cheap and
  synchronous. It uses the facts and the published HTML of affected paths,
  fetched server-side, and finds `data-track-*` targets. Then a full run
  is queued for the affected conversions only.
  - A label change on a CTA is reported as "renamed: tracking continues
    under the new label; update the plan?". It is a warning, not a failure.
- **After deploy:** the frontend's revalidate route or build hook calls
  `POST verify/runs/?trigger=deploy` (signed with `REVALIDATE_SECRET`).
- **Scheduled:** nightly full run (headless if available); a weekly
  in-browser reminder if no headless runner is configured.
- **On demand:** the "Run checks" button; per-conversion "Test".

### 11.7 Real-traffic monitoring and alerts
- **"Last seen"** per conversion and per tool comes from `TrackingDaily`
  and the dispatcher's success log.
- **Anomaly detection:** alert when a conversion had a 14-day average of at
  least 1/day and has been at zero for `max(2 days, 3 / avg)` days. Below
  that, low-traffic sites get no anomaly alerts, only "not seen in 30 days"
  as information.
- **Alert channels:**
  - dashboard banner and launch-check warning (always);
  - email via backend SMTP if configured (FormSubmit is browser-only by
    design, so it is not used for server alerts);
  - optional signed webhook (Slack, Teams or email relay URL in Settings).
- **Rate:** one alert per issue, re-alerted after 7 days if still open.
- **Auto-resolved** alerts are logged and not emailed.

---

## 12. Contacts (lightweight CRM)

### 12.1 Creating and merging contacts
- Created on a stored, non-spam, non-test submission that has an email or a
  phone field (detected by field type `email`/`tel`, or by mapping in the
  form definition).
- **Normalisation:**
  - email: lowercase and trim; plus-addressing kept, because it can be a
    different person;
  - phone: E.164, with the country from the form's locale.
- **Merge:** same normalised email → same contact. Same phone with a
  different email → a **suggested merge** shown to the admin, never
  automatic (shared office numbers).
- **Fields updated:** `name` from the newest submission, unless edited by
  an admin (admin edits win); intents, segment and stage are recomputed
  from all of that contact's submissions and profiles.
- **Without an email or phone** (anonymous feedback forms): no contact.

### 12.2 Location
In priority order:
1. trusted proxy headers (`CF-IPCountry`/`CF-IPCity`,
   `X-Vercel-IP-Country`/`City`/`Region`, Fastly);
2. an optional MaxMind GeoLite2 City database (`GEOIP_DB_PATH`; the owner
   downloads it under MaxMind's licence; not bundled);
3. none.

- Only the country, region and city are stored, never the IP. The existing
  `ip_hash` stays for spam control.
- VPN and mobile-carrier inaccuracy is noted in the UI as "approximate".

### 12.3 Pipeline and notes
- Statuses are configurable; the default is New → Contacted → Consultation
  done → Client → Not proceeding.
- Each change is logged with who changed it and when.
- Notes have timestamps and authors.
- "Client" sets `is_client` (excluded from acquisition audiences) and
  extends retention (§12.7).
- "Source → client" reporting is a simple table: clients by first source,
  campaign and intent.

### 12.4 Behaviour after the enquiry
- Only when the visitor has **analytics consent**: the `vid` from the
  profile is stored on the contact at submission.
- Later `/api/events/` beacons carrying that `vid` append `ContactEvent`
  rows: only conversion-level events and `service_engaged`, capped.
- Consent withdrawal or the "forget me" beacon unlinks the `vid`.
- Admins see a timeline: visits, intents and conversions after the enquiry.
  It is never shown anywhere public.

### 12.5 Groups
- **Automatic groups:** one per intent, segment and stage; one per plan
  audience (approximated with contacts); one per status; "Opted in to
  marketing".
- **Custom groups:** a rule builder over intent, segment, stage, status,
  region/country, source/campaign, form answers (non-free-text fields
  only), created/last-seen date ranges, value, and tags. All conditions are
  combined with AND; OR is done by creating separate groups.
- **Evaluation:** groups are evaluated on read (paginated) and cached per
  contact-version.

### 12.6 Getting contacts out
- **CSV and JSON export:**
  - per group or selection;
  - admin-only;
  - logged in `AdminAuditLog`;
  - opt-in status included;
  - free-text fields optional (unticked by default).
- **Webhooks to HubSpot, Pipedrive, Zapier or Make:**
  - contact created/updated/status-changed;
  - signed (HMAC with a per-webhook secret);
  - retried through the same outbox mechanism;
  - payload schema versioned;
  - a "Send test" button.
- **Ad-tool audiences:**
  - groups with `sync_to: [meta, google_ads]` upload **opted-in contacts
    only**, hashed (SHA-256), to Meta Custom Audiences or Google Customer
    Match (Ads v2);
  - membership changes and opt-outs are removed remotely on the next sync;
  - minimum size warnings: Meta needs about 100 for delivery, Google 1,000
    for some placements.
- **Exclusion lists:** `is_client` contacts are synced to an "Existing
  clients" audience used as an exclusion. This counts as legitimate
  interest only if the privacy notice says so; the template text covers it.

### 12.7 Retention, rights, security
- **Retention:**
  - non-clients: 24 months after `last_seen` (configurable 1–60 months);
  - clients: until unmarked, plus the configured period.
  - `contacts_purge` runs nightly and deletes everything in one cascade:
    the contact, its events, notes, the `contact` link on submissions, and
    the submissions themselves when "delete submissions too" is on (the
    default). It also removes the contact from remote audiences on the next
    sync.
- **Access request:** "Export this contact" produces a JSON file of
  everything held, including submissions and events.
- **Erasure:** "Erase" does the same cascade as the purge plus remote
  removal, logged, with a confirmation dialog. It cannot be undone.
- **Marketing opt-in field:**
  - a new form field type `consent_marketing`: a checkbox, **unticked by
    default**, with editable label text;
  - check-inline and site-audit fail if it is pre-ticked;
  - `opt_in_at`, the source form and the label text at the time are stored.
- **Security:**
  - contact endpoints are `IsAdminUser`, excluded from every public cache
    and revalidation tag, and never included in AI prompts (the prompts
    only see aggregate facts);
  - exports are throttled;
  - the permission-audit test covers every new endpoint.
- **Privacy page:** site-audit fails if tracking IDs or Contacts are in use
  and the privacy page doesn't mention analytics cookies, enquiry records
  and retention. It checks a keyword set; the wording stays the owner's.
  `LAUNCH_GUIDE.md` gives template paragraphs.

### 12.8 Inbox integration
- The Form inbox shows the profile card on each submission.
- It links to the contact.
- The existing CSV export of submissions adds profile columns (intent,
  segment, stage, source), with no raw path.

### 12.9 Optional company-level B2B lookup (plugin hook)
- `contacts.enrichers` is an empty registry by default.
- A site may add an enricher (for example a company-lookup API) under its
  own legal assessment.
- It is never on by default, and is never used for individuals.

---

## 13. Admin interface

### 13.1 Admin bar → Site tools → **Tracking**
A drawer with tabs; it opens full page at `/admin/tracking`.
- **Overview:**
  - plan status (draft/approved/stale);
  - last check result;
  - conversions in the last 7 days (sparkline from `TrackingDaily`);
  - open issues.
- **Tools:**
  - every supported tool, with its status (connected, ID only, not set,
    needs re-auth);
  - **"What it's for on this site":** text generated from the plan, e.g.
    "Meta: retarget *Payroll interest, no booking* with a free-consultation
    reminder; optimise ads for *Consultation booked*";
  - Connect, Disconnect and Sync now buttons;
  - "Download GTM container".
- **Conversions:**
  - the table from the design (trigger · sent · GA4 · Meta · Ads · last
    real);
  - add, edit, disable, lock and Test;
  - **"Pick on page":** opens the site in edit mode with a picker overlay;
    clicking an element binds the trigger by block + item path + CTA marker
    (never by text). It reuses floating-tools placement (R30).
- **Intents, Segments, Stages:** lists with match rules, editable;
  "Recompute from site".
- **Audiences:** purpose, include/exclude rules, window, tools, sync status
  per tool, and estimated size where the tool reports one.
- **Checks:** run history and per-step results with evidence; "Run checks"
  (in-browser) and "Run headless" (if a runner is configured).
- **AI:** "Update plan with AI" (prompt → paste → diff) and "Build from
  library".

### 13.2 `/admin/contacts`
- **List:** filters, a saved group selector, and column choices.
- **Contact page:** profile, timeline, submissions, notes, status, opt-in,
  Export and Erase.
- **Groups page:** automatic and custom groups, the rule builder, sync
  targets.

### 13.3 Dashboard and settings
- **Dashboard:**
  - new cards: "Tracking health" and "New contacts this week";
  - launch-check items link to the relevant tab.
- **Settings:** the Tracking card keeps the raw IDs and links to the
  Tracking panel; the consent region mode moves into it.
- **Look and feel:** the admin UI follows R17 (themed via `--cms-*`), R30
  (floating tools for the picker) and the WCAG AA contrast checks in
  acceptance.

---

## 14. Spec, rules and gates

### 14.1 New rules (each in its five places; `IntegrationSpecTests` extended to R33)
- **R31: Tracking plan from the business; automatic events; verified.**
  - **Must:**
    - derive the plan in P0 (facts → AI/library → approve);
    - spread `track` on every `useCms` root;
    - use `data-track-cta` on primary CTAs and `data-track-faq` on
      accordions;
    - `submitForm` carries `_cms`;
    - every primary conversion passes trigger and sent checks; received
      checks pass for every connected tool.
  - **Never:**
    - hard-coded events or conversions;
    - text-based triggers;
    - personal data in events;
    - telling the owner to configure inside a tool.
  - **Proven by:** check-inline (`track` spread, no direct pixel calls),
    acceptance (capture events fire, harness passes), site-audit (every
    intent page tagged, no dangling triggers), launch check (plan
    approved, no failing checks).
- **R32: Consent first.**
  - **Must:**
    - banner when any tag is configured;
    - equal Accept/Reject;
    - Consent Mode v2 default before tags;
    - non-Google tags only after consent;
    - footer "Cookie settings";
    - server events honour consent.
  - **Never:** pre-ticked choices, tags before consent in `uk_eu`, or
    hashed identifiers without `ad_user_data`.
  - **Proven by:**
    - acceptance in a denied run: no Meta/TikTok/LinkedIn requests and no
      `_fbp` cookie;
    - an accepted run: requests present;
    - site-audit: banner and footer link present, privacy page keywords.
- **R33: Contacts are privacy-safe.**
  - **Must:**
    - opt-in field unticked;
    - only opted-in contacts reach ad tools;
    - retention purge;
    - export and erase work;
    - admin-only endpoints;
    - an audit log entry for each export, erase and connect.
  - **Never:** PII in public responses or caches, or automatic merges on
    phone number.
  - **Proven by:** backend tests (permissions, purge, erase cascade, opt-in
    gate, hashing) and acceptance (contact created from the test lead and
    erased).
- **R25 updated:** tracking IDs stay in Settings. Connections and
  credentials are covered under R31.
- **R22 updated:** the launch check gains:
  - plan not approved;
  - stale plan;
  - dangling triggers;
  - failing checks;
  - tools needing re-auth;
  - consent banner missing while tags are set;
  - privacy page missing keywords (blocker when Contacts are on);
  - `TRACKING_SECRET_KEY` missing while connections exist (blocker).

### 14.2 Gate changes
- **check-inline:**
  - `track` spread on `useCms` roots;
  - `trackItem(i)` with `E.Item`;
  - accordions carry `data-track-faq`;
  - no `fbq`/`ttq`/`lintrk`/`gtag` outside `lib/track.js` (it already
    blocks some);
  - no `localStorage`/`sessionStorage` writes in site components, except
    through `lib/consent.js` and `lib/intentProfile.js`;
  - `consent_marketing` never defaults to true.
- **Acceptance (new checks):**
  - visitor clicks a CTA → `cta_click` with block and label;
  - `section_view` after 2 seconds;
  - FAQ open;
  - form start and abandon;
  - lead → `generate_lead` with intent; browser and server `event_id`
    match (outbox inspected via the admin API);
  - denied consent → no non-Google requests;
  - accept → requests appear;
  - withdraw → profile cleared;
  - test lead → no email, no contact, deleted later;
  - a real lead → contact created with profile → erase removes everything;
  - "Run checks" → all trigger and sent steps pass;
  - the panel renders and the contacts pages render;
  - no PII in any captured payload.
- **site-audit:**
  - every page whose path matches an intent carries `data-track-intent`;
  - no dangling triggers;
  - the banner and "Cookie settings" are present when tags are set;
  - privacy page keywords;
  - the opt-in checkbox is unticked.
- **fresh-install:**
  - the kit builds with the tracking files;
  - the Pricing example spreads `track`;
  - the bundle budget check (capture + profile + consent ≤ 6 KB gzip).
- **Backend tests:** about 60 new ones, covering:
  - plan validation (every edge in §2.1);
  - library applicability;
  - facts hash and stale detection;
  - AI apply (normalise, refuse data loss, drop dangling);
  - ingest guards (origin, size, allowlist, throttle, replay);
  - sanitiser;
  - outbox retries and dead-letter;
  - each adapter against recorded fixtures (no network in tests);
  - the GA4 MP-only-when-blocked rule;
  - the reconcile engine (create, update, archive, drift, refused, partial
    failure, idempotency);
  - crypto (missing key, rotate);
  - verification compile (target missing → precise reason);
  - anomaly maths (low traffic);
  - contacts (merge, suggested merge, location priority, retention purge,
    erase cascade, export content, opt-in gate, permission audit, no PII
    in public endpoints).

### 14.3 Docs
- `FRONTEND_INTEGRATION_PROMPT.md`:
  - R31–R33;
  - phase steps: P0 facts and plan, P1 kit files, P3 `track` spreads, P7
    plan seed and approve, P8 runs checks;
  - §6 contract rows for every new endpoint;
  - §9 adapter fields;
  - the §11 and §13 lines.
- `AGENTS.md`:
  - Job A never-list additions;
  - Job B "where things live" for the tracking modules.
- `MANIFEST.md`: the new CORE files and the acceptance files.
- `LAUNCH_GUIDE.md` is rewritten around **Connect**, removing all manual
  steps inside the tools except account creation and connection, and adds
  the privacy-notice template paragraphs.
- `UPGRADE_NOTES.md`, the README endpoint table and the `.env.example`
  entries (`TRACKING_SECRET_KEY`, `GEOIP_DB_PATH`, `TRACKING_ALERT_WEBHOOK`,
  `TRACKING_WORKER_*`).

---

## 15. Delivery stages

Each stage ends green on all gates (backend tests, check-inline, build,
acceptance, site-audit, fresh-install), is synced to the kit, committed to
dynamic-cms `main`, and applied to the reference site.

| Stage | Contents | Needs external accounts? |
|---|---|---|
| **1. Foundation** | vocabulary; `track` spreads + check-inline rules; capture layer; profile (session-only until consent exists); `_cms` on submit; `FormSubmission.profile/event_id/is_test`; inbox profile card; email summary line; site facts; library; plan schema + validation; "Build from library"; Tracking panel (overview, conversions, intents, segments, stages); **in-browser verify: trigger + sent**; acceptance and site-audit additions; R31 (partial) | No |
| **2. Consent** | consent lib + banner + region modes + Consent Mode update + gated loading + footer link + server consent flags + profile persistence with consent; R32; privacy-notice template; the reference site's privacy page update | No |
| **3. AI plan** | prompt + apply + diff/approve + stale detection + locked items | No |
| **4. Server events** | `/api/events/` ingest; outbox; worker; Meta CAPI + GA4 MP (blocked-only rule) + TikTok adapters with fixtures; dedupe; `TrackingDaily`; last seen; anomaly alerts; verification **received** step for server copies | Optional (fixtures cover tests; real check needs a pixel + GA4 property) |
| **5. Contacts** | models; merge; location; pipeline; notes; groups; export; webhooks; retention; erase; opt-in field type; audit log; R33 | No |
| **6. Sync: GA4 + Meta** | connections + crypto; reconcile engine; GA4 dimensions/key events/event-create rules/audiences/data filter/MP secret; Meta custom conversions + website audiences + opted-in contact audiences; drift handling; scheduled and post-publish runs; headless runner + GitHub Action template | **Yes:** a GA4 property + service account; a Meta Business test ad account + system user |
| **7. GTM + TikTok + LinkedIn + Ads v2** | GTM API workspace/publish; TikTok Business API; LinkedIn CAPI + rules; Google Ads developer-token path (Customer Match, enhanced conversions) | **Yes,** plus LinkedIn and Ads approvals |

**Rough size:**
- stages 1–3: about 4–6 working sessions;
- stages 4–5: about 4 each;
- stages 6–7: about 4–6 each, depending on API access turnaround.

---

## 16. Edge cases, by area

**Capture**
- Elements rendered after load (lazy sections, client-only blocks) are
  covered by delegated listeners and an observer on a MutationObserver
  (debounced).
- Duplicate CMS blocks with the same name on one page (the same component
  rendered twice): blocks are keyed as `name` + occurrence index.
- A CTA inside another CTA's block, or a CTA inside a link list: the nearest
  `data-track-cta` wins.
- A button that submits a form counts as `cta_click` only if marked;
  otherwise only `form_*`.
- Links opening in a new tab: tracking fires on `click`. Links that
  navigate away immediately: beacon transport, no awaiting.
- `scroll_depth` on pages with infinite or lazy content: measured against
  `<main>` at the time; thresholds never go backwards.
- Very short or very long pages: handled in §4.2.
- Right-to-left or translated sites: labels come from text, so the
  language doesn't matter; the stage keywords are locale-specific.
- Page translation by the browser (Google Translate) changes labels. The
  label comes from the CMS value (`data-track-label`, set by `E.Text`'s
  owner block), not from the DOM text, when available.

**Profile and consent**
- Storage is blocked, quota is exceeded, or storage is cleared mid-session.
- Consent is changed during a visit (upgrade or withdraw), or there are
  several tabs with different consent states (cookie truth wins, re-read on
  `visibilitychange`).
- Embedded in an iframe (third-party storage partitioning): the profile is
  session-only.
- A bot fills the form: the honeypot marks it spam, so there is no
  contact, no lead event and no conversion. The `form_start` event still
  counts, but not for bots flagged by webdriver.

**Forms**
- One page has several forms: `form_name` disambiguates, and FORM_PAGE
  CTAs point at the first.
- A form name changes: triggers dangle, are reported, and an AI or library
  re-map is offered.
- An option label is edited (for example "Monthly payroll" → "Payroll"):
  triggers bind to the option **value**, not the label. The value stays
  stable when the label changes (the field editor keeps `value` separate,
  which needs a FieldEditor tweak).
- Checkboxes with several selected: each intent gets +10, and the
  conversions for every selected option fire (`lead_payroll` **and**
  `lead_vat`). The primary `generate_lead` fires once.
- Server validation fails after `form_start`: `form_error`, then possibly
  abandon.
- Network failure on submit: no lead event; the visitor sees an error, and
  the abandon beacon is sent on leave.
- Double-click submit: the existing disable-on-submit, plus `event_id`
  idempotency on the server.

**Server and dispatch**
- Tool outage, rate limits or quota: backoff, circuit breaker, alert.
- Expired or revoked token: `needs_reauth`, outbox held for that tool for
  7 days, then dropped with a summary alert.
- Clock skew: server time is used.
- Events older than 7 days are dropped for Meta.
- SQLite in development versus Postgres in production: locking strategy per
  backend; tests run on SQLite, and a Postgres CI job is recommended.
- Several gunicorn workers: the outbox lock prevents double sends.
- No worker configured: inline thread delivery works; retries only happen
  when a worker runs. The launch check warns "retries need
  `tracking_worker`".

**Sync**
- The owner already has items with the same names: never touched without
  the `[cms:id]` marker. Names get the suffix " (CMS)" on collision.
- Cap reached: refused at approval, with the exact cap shown.
- Alpha API changes (GA4 audiences, event create rules): adapters are
  feature-detected; on a 404 or 400 they fall back to "manual: copy this
  definition" and the panel says so plainly.
- A special ad category or policy refusal: status `refused`, the reason is
  shown, and nothing retries.
- A plan item is removed while remote data exists: archived and renamed,
  never deleted.
- A tool is disconnected and reconnected to a **different** account: the
  old ownership records are detached and the new account is synced fresh.

**Verification**
- An ad blocker in the admin's browser: reported as blocked, not failing.
- Hidden block (`_hidden`): the conversion is "inactive while block hidden"
  (neutral, not failing).
- A draft-only change: the check runs against published HTML only.
- A test run during real traffic: test events are labelled and excluded;
  the realtime count uses `traffic_type=internal` only.
- A slow site: per-step timeouts (15 seconds) with "timed out"
  distinguished from "not found".
- Pages behind query params or auth: not supported for triggers, which are
  validated against public paths only.

**Contacts**
- The same person uses different emails: separate contacts; a manual merge
  tool keeps both histories.
- A shared email (office@): one contact, multiple submissions; the name
  shows "several names".
- Opt-in later withdrawn (unsubscribe link via webhook to a mailing tool,
  or by an admin): removed from audiences on the next sync.
- Erasure while a sync is in flight: an erase tombstone (hash only) blocks
  re-creation from in-flight outbox events for 30 days.
- Export of a huge group: streamed CSV, paginated, throttled.
- Accountant or solicitor sites with professional retention duties: the
  website CRM is **not** the system of record. The panel note says to keep
  client records in practice software; the retention setting is per site.

**Multi-site and versions**
- Older frontends without `_cms` or `track`: the backend accepts that, the
  features degrade gracefully, and the launch check warns "kit older than
  backend".
- The kit version is sent as `cms_v`. The backend reports a mismatch on
  the dashboard.

---

## 17. Needs from the owner (per site)

1. Accounts: GA4 (+ GTM optional), Meta Business with a pixel and ad
   account, others as wanted.
2. One-time connections: the service account added to GA4/GTM; a Meta
   system-user token.
3. `TRACKING_SECRET_KEY` in the backend `.env`. Optional: a cron or
   systemd entry for `tracking_worker`, or the GitHub Action for scheduled
   checks.
4. Approval of the AI or library plan, and any relative values.
5. Privacy notice wording reviewed (template provided); the consent region
   mode chosen.
6. Optional: a MaxMind licence key for city-level location if the host gives
   no geo headers; an alert webhook URL.

## 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Ad-platform API changes or alpha deprecations | adapters behind feature detection; fixtures; "manual definition" fallback; nightly drift check surfaces breakage |
| API access approval delays (LinkedIn, Google Ads developer token) | those are stage 7 and optional; GA4 import covers Ads conversions |
| Legal exposure from tracking | consent-first defaults, opt-in for ad-tool lists, no fingerprinting, privacy keyword gate, audit log, retention purge |
| Performance regression on visitor pages | 6 KB budget gate; observers instead of scroll handlers; idle scheduling; acceptance responsive and perf checks |
| Over-engineering for small sites | everything is off until a tool is connected; library-only plans work without AI; no worker is required for basic delivery |
| Data drift between browser and server copies | single vocabulary module mirrored id-for-id (like keywords/seoChecks), with a test comparing them |
