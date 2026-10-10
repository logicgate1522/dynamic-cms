# Launch guide (for the site owner)

The steps that happen **outside** the code when a site built on dynamic-cms
goes live: the domain, leads, Search Console, analytics, consent and contacts. Every
setting below is in **Site tools → Settings**. You don't need a developer once
the site is deployed.

The dashboard's **launch check** (`GET launch-check/`, also run by
`LAUNCH=1 node site-audit.mjs`) tracks these items:
- **Blockers** stop a launch.
- **Warnings** are steps from this guide that aren't done yet.

Work down this list until the launch check shows no blockers and you have
dealt with every warning.

---

## 1. Domain and hosting

1. Deploy the backend and frontend as in `README.md` → *Deploying*. Use HTTPS
   on both, set `DEBUG=False`, and set the same `REVALIDATE_SECRET` on both
   sides.
2. **Settings → SEO defaults → Public site URL:** `https://your-domain`.
   Canonical URLs, the sitemap, robots.txt and social previews are all built
   from it. While it says `localhost`, the launch check blocks.
3. Check that indexing is on:
   - **Settings → SEO defaults → "Allow search engines to index the site"** is
     ticked. Turn it off only on a staging copy.
   - Open `https://your-domain/robots.txt`. It must end with
     `Sitemap: https://your-domain/sitemap.xml`.

## 2. Leads reach you

1. **Settings → Form notifications:** enter the inbox that should receive
   enquiries, then click **Send a test email**.
2. The first time, FormSubmit.co emails an **activation link** to that inbox.
   Click it.
3. FormSubmit then emails you a private **alias**, a random string. Paste it
   in place of the address and save. The alias stops your real address from
   appearing in the page's requests.
4. Submit the site's own form once and check that the email arrives. The
   enquiry is also kept in the **Form inbox**.

## 3. Google Search Console

Search Console shows whether Google has indexed your pages, which searches
show them, and any errors. It is free.

1. Go to <https://search.google.com/search-console> → **Add property**.
2. Choose a method:
   - **Domain** (recommended; it covers http/https and every subdomain):
     Google gives you a `TXT` record. Add it in your **domain registrar's**
     DNS settings. Nothing is needed in the CMS. DNS changes can take from a
     few minutes to a day.
   - **URL prefix** (`https://your-domain`): choose **HTML tag** and copy the
     tag, which looks like
     `<meta name="google-site-verification" content="AbC123…" />`.
     - Paste it into **Settings → Search engine verification → Google Search
       Console**. The whole tag is fine; only the code is kept.
     - Save, wait a minute for the page cache to refresh, then click
       **Verify**.
3. **Sitemaps** → enter `sitemap.xml` → **Submit**. New pages and articles
   are added to the sitemap automatically, so you only submit it once.
4. Optional, to speed up indexing of your main pages: **URL inspection** →
   paste each page's URL → **Request indexing**.
5. Come back after 3–7 days. **Indexing → Pages** shows what's indexed and
   why anything isn't.

> If you verify by DNS, the launch check still warns "Search Console is not
> verified", because it can't see DNS. Treat that warning as done.

## 4. Bing Webmaster Tools (also covers DuckDuckGo, Yahoo and Ecosia)

1. Go to <https://www.bing.com/webmasters>.
2. Choose **Import from Google Search Console**. This is the fastest route:
   it copies your verified sites and sitemaps.
3. Or add the site yourself: choose **HTML Meta Tag** and paste it into
   **Settings → Search engine verification → Bing Webmaster Tools**. Then
   submit `https://your-domain/sitemap.xml`.

## 5. Analytics and ads: measure visits, leads and what people want

You don't set up events, conversions or audiences inside GA4, Tag Manager,
Meta or Google Ads. The CMS does it from your **tracking plan** (Site tools →
**Tracking**) and keeps them in sync. Your part is: create the accounts,
paste their IDs, and connect each one once.

**Events the site sends by itself** (to every tool, in each tool's format):
`page_view`, `cta_click`, `section_view`, `scroll_depth`, `service_engaged`,
`faq_open`, `form_start`, `form_abandon`, `generate_lead`, `contact_click`,
`outbound_click`, `file_download` — each with the page, the section, and
what the visitor seems to want (intent), who they are (customer type) and
where they are in the decision (stage).

1. **Create the accounts:** a GA4 property (<https://analytics.google.com>)
   and, if you want ads, Meta Business (pixel + ad account), Google Ads,
   TikTok, LinkedIn. Google Tag Manager is optional.
2. **Paste the IDs** in Site tools → Settings → Tracking & analytics
   (`G-…` for GA4, `GTM-…` if you use Tag Manager, the Meta pixel id…).
3. **Build the plan:** Site tools → Tracking → **Scan site** → **Build from
   library** (or **Ask AI**) → review what's proposed and why → **Approve**.
   It lists the conversions for *your* business (for example "Booking
   request", "Lead: <your service>", "Read a guide"), the audiences to retarget and
   what to say to each.
4. **Connect each tool once** (Tracking → Tools → Connect): a Google service
   account key (add its email as Editor on GA4 and Tag Manager), a Meta
   system-user token, a TikTok Events API token. The CMS then creates GA4
   custom dimensions, key events (`generate_lead` and one `cv_…` per main
   conversion) and audiences; Meta custom conversions and audiences; and
   sends server-side copies that ad blockers can't stop. Tokens are stored
   encrypted (your developer sets `TRACKING_SECRET_KEY`).
5. **Google Ads:** in Google Ads, link your GA4 property and import the key
   events (one click). That's the only step inside a tool.
6. **Tag Manager users:** Tracking → Tools → **Download container** (import
   it in GTM) or **Push to GTM**, then publish. Leave the GA4 field empty when
   GA4 runs inside GTM, or every event is counted twice.
7. **Check it works:** Tracking → **Checks → Run checks**. Every conversion is
   triggered on the live site like a visitor would (test bookings are marked
   as tests: no email, no contact, deleted after a day) and each tool is
   checked. Run it again after big changes; your developer can schedule it
   nightly (`verify-tracking.mjs` / the GitHub Action template).
8. **Keep it current:** when you add a service or change a form, the
   dashboard says "the site changed since the plan was approved" — Scan,
   review, Approve. A conversion that stops firing raises an alert.

**Optional:** Microsoft Clarity or Hotjar IDs for recordings and heatmaps
(loaded only with consent).

## 6. Cookie consent

If visitors are in the UK or EU, analytics and advertising cookies need
consent (UK GDPR / PECR, EU GDPR / ePrivacy). The site handles it:

1. As soon as any tracking ID is set, new visitors see the **cookie banner**
   (Accept all / Reject all / Choose). Edit its words in place like any other
   text. "Cookie settings" at the bottom of every page re-opens it.
2. The plan's **region** decides the default (Tracking → plan): `uk_eu`
   (denied until the visitor agrees), `us` (allowed unless refused), or
   `other` (follows Settings → Tracking → **Consent default**).
3. Google tags start in Consent Mode "denied" and update when the visitor
   chooses; Meta, TikTok and LinkedIn don't load at all without consent;
   nothing is stored on the visitor's device without consent.
4. Your privacy/cookie policy must mention analytics cookies, enquiry
   records and how long you keep them. Suggested wording:

   > With your consent, we use analytics cookies to understand how the site
   > is used, and marketing cookies to measure our advertising and to show
   > our adverts to people who have visited. You can change your choice at any
   > time with "Cookie settings" at the bottom of every page.
   >
   > When you send an enquiry we keep a record of it, together with which of
   > our pages you looked at during that visit, how you found us and your
   > approximate location (town or region). We keep enquiry records for up to
   > 24 months after our last contact with you, unless you become a client.

## 7. Contacts

Every enquiry with an email or phone becomes a **contact** (Site tools →
Contacts): what they asked for, the pages they read, how they found you,
roughly where they are, and where they are in your pipeline (New →
Contacted → Consultation done → Client / Not proceeding).

- **Groups** are made for you (by service, customer type, stage, status) and
  you can add your own. A group can become a Meta audience — only people who
  ticked "keep me updated" are ever included, as hashed data.
- **Retention:** non-clients are erased automatically after the period in
  Contacts → Settings (default 24 months). Mark clients as "Client" to keep
  them.
- **Requests from people:** "Export data" gives them everything you hold;
  "Erase" removes them everywhere, including synced audiences.
- **Your CRM:** add a webhook (Contacts → Settings) to send each new or
  changed contact to HubSpot, Pipedrive, Zapier or Make.
- If you have legal record-keeping duties, keep client records in your
  practice software too; this list is for enquiries, not a system of record.

## 8. The tracking worker (your developer)

`./venv/bin/python manage.py tracking_worker` (as a service), or
`tracking_worker --once` from cron every minute. It retries server-side
events, syncs the tools nightly, sends contact webhooks, raises alerts and
erases expired contacts. Without it the site still works; the launch check
says what you're missing.

## 9. Final check

1. Run the launch check on the dashboard, or ask your developer to run
   `LAUNCH=1 node site-audit.mjs`. Aim for no blockers, and a known reason
   for any warning that remains.
2. Share a page on LinkedIn or WhatsApp and check that the preview shows the
   right title, description and image.
3. Add the site URL to your business profiles, such as LinkedIn and
   directories, so search engines find links to it.
4. Keep publishing useful content. Each new article or service entry is added
   to the sitemap and picked up by Search Console automatically.
