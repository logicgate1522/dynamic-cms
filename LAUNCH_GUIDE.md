# Launch guide (for the site owner)

The steps that happen **outside** the code when a site built on dynamic-cms
goes live: the domain, leads, Search Console, analytics and consent. Every
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

## 5. Analytics: measure visits and leads

The site sends these events by itself. Never paste tracking code into page
content.

| Event | When it fires |
|---|---|
| `page_view` | On every in-site navigation. The tag records the first load itself. |
| `generate_lead` | When a form submission is stored. |
| `contact_click` | When a phone or email link is clicked. |

**Recommended: Google Tag Manager (GTM) + Google Analytics 4 (GA4).**

1. Create a **GA4 property** at <https://analytics.google.com>. Copy the
   measurement ID, `G-XXXXXXX`.
2. Create a **GTM container** (Web) at <https://tagmanager.google.com>. Copy
   the container ID, `GTM-XXXXXXX`.
3. Paste only the GTM ID into **Settings → Tracking & analytics → Google Tag
   Manager container**. Leave the GA4 field empty when you use GTM.
   Otherwise every event is counted twice.
4. Set up GTM:
   1. **Tag:** *Google tag*, with your `G-` ID as the tag ID. Trigger:
      *Initialization – All Pages*.
   2. **Trigger:** *Custom Event*. Event name
      `page_view|generate_lead|contact_click`, with **Use regex matching**
      ticked.
   3. **Tag:** *Google Analytics: GA4 Event*. Measurement ID: your `G-` ID.
      Event name: `{{Event}}`. Fire it on the trigger from step 2.
   4. **Submit → Publish.**
5. **In GA4:**
   - **Admin → Events:** mark `generate_lead` as a **key event**. That's
     your conversion.
   - **Admin → Data streams → Enhanced measurement:** turn off **"Page
     changes based on browser history events"**. The site already sends
     those page views, so leaving it on double-counts them.
6. **Check it works:** in GTM click **Preview**, browse the site and submit
   the form. You should see `page_view` and `generate_lead` fire. Also check
   **GA4 → Reports → Realtime**.

**Without GTM:** paste the `G-` ID into the GA4 field instead and do step 5.

**Optional extras:**
- **Google Ads:** set the `AW-` ID plus the lead conversion label. A
  conversion is counted on every stored lead.
- **Meta Pixel, TikTok, LinkedIn:** paste the ID. The standard Lead and
  Contact events are mapped for you.
- **Microsoft Clarity or Hotjar:** paste the ID to get heatmaps and session
  recordings.
- **Data layer variables:** fixed values, such as `site_section`, that are
  pushed before GTM loads, for use as GTM variables.
- **"Don't track signed-in admins":** leave it on, so your own visits aren't
  counted.

## 6. Cookie consent

If visitors are in the UK or EU, analytics and advertising cookies need
consent (UK GDPR / PECR, EU GDPR / ePrivacy).

1. **Settings → Tracking & analytics → Consent default:**
   - choose **"Denied until the visitor agrees"** where opt-in is required;
   - choose **"Granted"** only where it isn't.

   The launch check warns while tracking is on and this is still "Not set".
2. Add a **cookie banner** that updates Google Consent Mode when the visitor
   chooses. Either:
   - in GTM, add a consent-banner template from the Community Template
     Gallery (for example Cookiebot, CookieYes or Usercentrics); or
   - paste the vendor's snippet into **Settings → Tracking & analytics →
     Other tags (custom code) → In `<head>`**.
3. With "Denied" and no banner, Google receives only cookieless signals and
   your reports will be thin. Add the banner before relying on the numbers.
4. Mention analytics cookies in the site's cookie policy.

## 7. Final check

1. Run the launch check on the dashboard, or ask your developer to run
   `LAUNCH=1 node site-audit.mjs`. Aim for no blockers, and a known reason
   for any warning that remains.
2. Share a page on LinkedIn or WhatsApp and check that the preview shows the
   right title, description and image.
3. Add the site URL to your business profiles, such as LinkedIn and
   directories, so search engines find links to it.
4. Keep publishing useful content. Each new article or service entry is added
   to the sitemap and picked up by Search Console automatically.
