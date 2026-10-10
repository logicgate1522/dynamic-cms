"""Edge cases for tracking, consent and contacts (R31–R33): every branch the
happy-path tests in tests_tracking.py don't reach. No network."""

import io
import json
from datetime import timedelta
from unittest import mock

from django.core.cache import cache
from django.core.management import call_command
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import (AdminAuditLog, ComponentData, Contact, ContactEvent, ContactGroup, ErasureTombstone, EventOutbox,
                     FormSubmission, SiteSettings, TrackingAlert, TrackingConnection, TrackingDaily, TrackingJob,
                     TrackingSyncItem, VerificationRun)
from .tests_tracking import FORM, KEY, ORIGIN, SCAN, TrackingBase


def lead_body(**extra):
    body = {"name": "Jo", "email": "jo@acme.test", "business_type": "Limited company", "services": ["Monthly payroll"]}
    body.update(extra)
    return body


# =================================================================== vocab

class VocabEdgeTests(APITestCase):
    def test_values(self):
        from .tracking_vocab import clean_value
        self.assertEqual(clean_value(3), 3)
        self.assertIs(clean_value(True), True)
        self.assertIsNone(clean_value(None))
        self.assertEqual(clean_value(["a", "b"]), "a, b")
        self.assertEqual(len(clean_value("x" * 500)), 100)
        self.assertEqual(clean_value("Café ünïcode"), "Café ünïcode")
        self.assertEqual(clean_value("call +44 (0)20 7946 0958 now"), "call [number] now")
        self.assertEqual(clean_value("/p?utm_source=x&email=a@b.co"), "/p")

    def test_param_caps_and_names(self):
        from .tracking_vocab import MAX_PARAMS, clean_params
        many = {f"intent": "x", **{k: "v" for k in ("page_path", "page_type", "segment", "stage", "block", "item", "event_id",
                                                    "cms_v", "conversion_id", "content_group", "debug_mode", "traffic_type")}}
        self.assertLessEqual(len(clean_params("cta_click", {**many, "cta_label": "a", "cta_target": "/b"})), MAX_PARAMS)
        self.assertEqual(clean_params("cta_click", {"Bad Key": "x", "cta_label": ""}), {})
        self.assertEqual(clean_params("cta_click", "not a dict"), {})

    def test_tool_names(self):
        from .tracking_vocab import meta_name, tiktok_name
        self.assertEqual(meta_name("generate_lead"), "Lead")
        self.assertEqual(meta_name("generate_lead", mapping="Schedule"), "Schedule")
        self.assertEqual(meta_name("faq_open"), "FaqOpen")
        self.assertEqual(tiktok_name("faq_open"), None)
        self.assertEqual(tiktok_name("generate_lead", "Contact"), "Contact")
        self.assertEqual(tiktok_name("generate_lead", "Nonsense"), "SubmitForm")


# =================================================================== facts

class FactsEdgeTests(TrackingBase):
    def test_page_types(self):
        from .site_facts import page_type_for
        cols = [{"indexPath": "/blog-index", "pathPrefix": "/blog", "hostKind": "blog", "pageType": ""},
                {"indexPath": "/work", "pathPrefix": "/work", "hostKind": "content", "pageType": ""}]
        cases = {"/": "home", "/blog-index": "index", "/blog/x": "article", "/work/y": "entry", "/contact-us": "contact",
                 "/privacy": "legal", "/cookies": "legal", "/faq": "faq", "/about-us": "other", "/about": "about",
                 "/book": "contact", "/random": "other"}
        for path, want in cases.items():
            self.assertEqual(page_type_for(path, cols, set()), want, path)
        self.assertEqual(page_type_for("/x", cols, {"/x"}), "contact")
        self.assertEqual(page_type_for("/about", cols, {"/about"}), "about")

    def test_a_site_wide_form_doesnt_make_every_page_a_cta_target(self):
        scan = json.loads(json.dumps(SCAN))
        for page in scan["pages"]:
            page["forms"] = [{"name": "quote"}]
        scan["pages"] += [{"path": "/about", "forms": [{"name": "quote"}]}, {"path": "/faqs", "forms": [{"name": "quote"}]},
                          {"path": "/privacy", "forms": [{"name": "quote"}]}]
        self.admin_client.post("/api/tracking/scan/", scan, format="json")
        from .site_facts import get_facts
        f = get_facts()
        types = {p["path"]: p["type"] for p in f["pages"]}
        self.assertEqual((types["/about"], types["/faqs"], types["/privacy"], types["/contact"]), ("about", "faq", "legal", "contact"))
        self.assertEqual(f["ctaPages"], ["/contact"])

    def test_norm_path(self):
        from .site_facts import norm_path
        for raw, want in (("", "/"), ("home", "/"), ("/a/b/", "/a/b"), ("a?x=1#y", "/a"), (None, "/")):
            self.assertEqual(norm_path(raw), want)

    def test_object_options_and_dedupe(self):
        ComponentData.objects.filter(name="form-quote").update(data={"fields": [
            {"name": "email", "type": "email"},
            {"name": "services", "type": "checkboxes", "options": [{"value": "pay", "label": "Payroll"}, {"label": "VAT"}, "", None]}]})
        self.scan()
        from .site_facts import get_facts
        f = get_facts()
        opts = next(x for x in f["forms"][0]["fields"] if x["name"] == "services")["options"]
        self.assertEqual(opts, [{"value": "pay", "label": "Payroll"}, {"value": "VAT", "label": "VAT"}])
        questions = [q["question"].lower() for q in f["faqs"]]
        self.assertEqual(len(questions), len(set(questions)))

    def test_scan_rejects_garbage_and_survives_missing_parts(self):
        from .site_facts import clean_scan
        out = clean_scan({"pages": ["x", None, {"path": "/a", "blocks": ["bad", {"name": "ok"}], "forms": [{"fields": [{"options": ["x", {"value": "y"}]}]}]}]})
        self.assertEqual(len(out["pages"]), 1)
        self.assertEqual(out["pages"][0]["blocks"], [{"name": "ok", "heading": "", "items": 0, "itemLabels": []}])
        r = self.admin_client.post("/api/tracking/scan/", {"pages": "nope"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.post("/api/tracking/scan/", SCAN, format="json").status_code, 401)

    def test_currency_and_region_from_locale(self):
        from .site_facts import get_facts
        from .tracking_library import build_plan
        for locale, cur, region in (("en_US", "USD", "us"), ("de_DE", "EUR", "uk_eu"), ("en_AU", "AUD", "other"), ("en", "USD", "other")):
            data = SiteSettings.objects.get(pk=1).data
            data["seoDefaults"]["locale"] = locale
            SiteSettings.objects.filter(pk=1).update(data=data)
            facts = get_facts()
            plan = build_plan(facts)
            self.assertEqual((plan["currency"], plan["region"]), (cur, region), locale)


# ================================================================= library

class LibraryEdgeTests(TrackingBase):
    def facts(self, scan=None, **settings_patch):
        if settings_patch:
            data = SiteSettings.objects.get(pk=1).data
            data.update(settings_patch)
            SiteSettings.objects.filter(pk=1).update(data=data)
        self.admin_client.post("/api/tracking/scan/", scan or SCAN, format="json")
        from .site_facts import get_facts
        return get_facts()

    def test_packs(self):
        from .tracking_library import classify_business
        base = {"org": {"type": "Organization", "name": "", "description": ""}, "pages": []}
        self.assertEqual(classify_business(base), "generic")
        self.assertEqual(classify_business({**base, "org": {**base["org"], "type": "Plumber"}}), "local_trades")
        self.assertEqual(classify_business({**base, "org": {**base["org"], "description": "Web design and SEO agency studio"}}), "agency_portfolio")
        self.assertEqual(classify_business({**base, "org": {**base["org"], "type": "Restaurant", "description": "menu"}}), "restaurant_venue")

    def test_no_forms_no_lead_conversions(self):
        ComponentData.objects.filter(name="form-quote").delete()
        scan = json.loads(json.dumps(SCAN))
        scan["pages"][2]["forms"] = []
        from .tracking_library import build_plan
        plan = build_plan(self.facts(scan))
        self.assertFalse([c for c in plan["conversions"] if c["trigger"]["event"] in ("generate_lead", "form_abandon")])
        self.assertFalse([a for a in plan["audiences"] if a["id"] == "aud_converted"])

    def test_two_lead_forms_get_distinct_ids(self):
        ComponentData.objects.create(name="form-newsletter", data={"fields": [{"name": "email", "type": "email"}]})
        scan = json.loads(json.dumps(SCAN))
        scan["pages"].append({"path": "/news", "forms": [{"name": "newsletter"}]})
        from .tracking_library import build_plan
        ids = {c["id"] for c in build_plan(self.facts(scan))["conversions"]}
        self.assertTrue({"lead_quote", "lead_newsletter"} <= ids)
        self.assertNotIn("lead", ids)

    def test_more_than_six_intents_collapse_engagement(self):
        from .models import ContentPage
        for i in range(6):
            ContentPage.objects.create(path=f"services/extra-{i}", title=f"Extra {i}", status="published", page_type="service")
        from .tracking_library import build_plan
        conv = {c["id"] for c in build_plan(self.facts())["conversions"]}
        self.assertIn("engaged_offering", conv)
        self.assertFalse([c for c in conv if c.startswith("engaged_extra")])

    def test_duplicate_intent_slugs_get_suffixes(self):
        from .models import ContentPage
        ContentPage.objects.create(path="services/a/payroll", title="Payroll again", status="published", page_type="service")
        from .tracking_library import build_plan
        ids = [i["id"] for i in build_plan(self.facts())["intents"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_whatsapp_downloads_work_collection(self):
        scan = json.loads(json.dumps(SCAN))
        scan["pages"][0].update(whatsapp=True, downloads=True, mailto=True)
        from .models import ContentPage
        data = SiteSettings.objects.get(pk=1).data
        data["collections"]["projects"] = {"label": "Project", "plural": "Projects", "hostKind": "content", "indexPath": "work", "pathPrefix": "work", "sections": ["hero"]}
        SiteSettings.objects.filter(pk=1).update(data=data)
        ContentPage.objects.create(path="work/site-a", title="Site A", status="published")
        from .tracking_library import build_plan
        ids = {c["id"] for c in build_plan(self.facts(scan))["conversions"]}
        self.assertTrue({"whatsapp_click", "email_click", "download", "viewed_projects"} <= ids)

    def test_keyword_matching_is_whole_word(self):
        from .tracking_library import keyword_hits
        self.assertTrue(keyword_hits("How much does it cost?", ["cost"]))
        self.assertTrue(keyword_hits("Penalties for late filing", ["late"]))


# ============================================================== plan validation

class PlanEdgeTests(TrackingBase):
    def facts(self):
        self.scan()
        from .site_facts import get_facts
        return get_facts()

    def v(self, plan):
        from .tracking_plan import validate
        return validate(plan, self.facts())

    def conv(self, event, **where):
        return {"intents": [{"id": "payroll", "label": "Payroll", "match": {"paths": ["/services/payroll"]}}],
                "stages": [{"id": "switching", "label": "S", "match": {}}],
                "conversions": [{"id": "c_one", "label": "C", "tier": "secondary", "trigger": {"event": event, "where": where}}]}

    def test_every_where_key(self):
        cases = [
            (("cta_click",), dict(ctaTargets=["/contact"], blocks=["home-hero"]), "ok"),
            (("cta_click",), dict(ctaTargets=["/nope"]), "dangling"),
            (("section_view",), dict(blocks=["ghost"]), "dangling"),
            (("service_engaged",), dict(intent="payroll"), "ok"),
            (("service_engaged",), dict(intent="ghost"), "dangling"),
            (("faq_open",), dict(stage="switching"), "ok"),
            (("faq_open",), dict(stage="ghost"), "dangling"),
            (("page_view",), dict(path="/services"), "ok"),
            (("page_view",), dict(path="/ghost"), "dangling"),
            (("page_view",), dict(pathPrefix="/services"), "ok"),
            (("page_view",), dict(pathPrefix="/ghost"), "dangling"),
            (("scroll_depth",), dict(percent=75, pageType="article"), "ok"),
            (("scroll_depth",), dict(percent=33), "errors"),
            (("scroll_depth",), dict(pageType="weird"), "errors"),
            (("contact_click",), dict(method="fax"), "errors"),
            (("contact_click",), dict(method="phone"), "dangling"),  # no phone on the site
            (("generate_lead",), dict(field="services"), "errors"),  # field without a form
            (("generate_lead",), dict(form="quote", wat=1), "errors"),
            (("conversion",), {}, "errors"),
        ]
        for (event,), where, want in cases:
            _, report = self.v(self.conv(event, **where))
            got = "errors" if report["errors"] else "dangling" if report["dangling"] else "ok"
            self.assertEqual(got, want, (event, where, report))

    def test_unverified_blocks_before_a_scan(self):
        from .site_facts import get_facts
        from .tracking_plan import validate
        _, report = validate(self.conv("section_view", blocks=["home-hero"]), get_facts())
        self.assertTrue(report["unverified"])
        self.assertFalse(report["dangling"])

    def test_values(self):
        plan = self.conv("generate_lead", form="quote")
        plan["conversions"][0]["value"] = {"mode": "by_option", "field": "services", "map": {"Monthly payroll": 300, "Ghost": 5, "bad": "x"}}
        clean, report = self.v(plan)
        self.assertEqual(clean["conversions"][0]["value"]["map"], {"Monthly payroll": 300.0, "Ghost": 5.0})
        self.assertTrue(any("Ghost" in d for d in report["dangling"]))
        plan["conversions"][0]["value"] = {"mode": "fixed", "amount": -10}
        self.assertEqual(self.v(plan)[0]["conversions"][0]["value"]["amount"], 0)
        plan["conversions"][0]["value"] = {"mode": "made_up"}
        self.assertEqual(self.v(plan)[0]["conversions"][0]["value"], {"mode": "none"})

    def test_conversion_value_maths(self):
        from .tracking_plan import conversion_value
        plan = {"intents": [{"id": "a", "value": 100}, {"id": "b", "value": 50}]}
        self.assertEqual(conversion_value(plan, {"value": {"mode": "fixed", "amount": 9}}, {}), 9)
        self.assertEqual(conversion_value(plan, {"value": {"mode": "by_option", "field": "s", "map": {"x": 1, "y": 2}}}, {"s": ["x", "y"]}), 3)
        self.assertEqual(conversion_value(plan, {"value": {"mode": "by_option", "field": "s", "map": {"x": 1}}}, {"s": "x"}), 1)
        self.assertEqual(conversion_value(plan, {"value": {"mode": "by_intent"}}, {}, ["a", "b"]), 150)
        self.assertIsNone(conversion_value(plan, {"value": {"mode": "none"}}, {}))

    def test_destinations_and_tiers_are_sanitised(self):
        plan = self.conv("cta_click")
        plan["conversions"][0].update(tier="huge", destinations={"meta": "Hack", "tiktok": "Nope", "ga4": "x", "googleAds": "y", "linkedin": "z"})
        c = self.v(plan)[0]["conversions"][0]
        self.assertEqual(c["tier"], "secondary")
        self.assertEqual(c["destinations"], {"ga4": "event", "meta": "custom", "tiktok": None, "googleAds": None, "linkedin": None})

    def test_audience_rules(self):
        plan = self.conv("cta_click")
        plan["audiences"] = [{"id": "a_one", "label": "A", "include": [], "tools": ["meta", "myspace"]},
                             {"id": "a_two", "label": "B", "include": [{"conversion": "ghost"}, {"event": "nope"}, {"intent": "ghost"}], "windowDays": 99999}]
        clean, report = self.v(plan)
        self.assertTrue(any("needs at least one include" in e for e in report["errors"]))
        self.assertTrue(any("unknown event" in e for e in report["errors"]))
        self.assertEqual(clean["audiences"][0]["tools"], ["meta"])
        self.assertEqual(clean["audiences"][1]["windowDays"], 540)

    def test_put_rejects_errors_and_non_objects(self):
        self.scan()
        self.assertEqual(self.admin_client.put("/api/tracking/plan/", {"plan": "x"}, format="json").status_code, 400)
        r = self.admin_client.put("/api/tracking/plan/", {"plan": {"conversions": [{"id": "BAD"}]}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertTrue(r.data["report"]["errors"])

    def test_put_keeps_version_and_approval_bumps_it(self):
        plan = self.approved_plan()
        v = plan["version"]
        r = self.admin_client.put("/api/tracking/plan/", {"plan": {**plan, "version": 999, "status": "approved"}}, format="json")
        self.assertEqual((r.data["plan"]["version"], r.data["plan"]["status"]), (v, "draft"))
        self.assertEqual(self.admin_client.post("/api/tracking/plan/approve/").data["plan"]["version"], v + 1)

    def test_unlock_flag_allows_removing_locked(self):
        plan = self.approved_plan()
        plan["conversions"][0]["locked"] = True
        self.admin_client.put("/api/tracking/plan/", {"plan": plan}, format="json")
        trimmed = {**plan, "conversions": plan["conversions"][1:]}
        kept = self.admin_client.put("/api/tracking/plan/", {"plan": trimmed}, format="json").data["plan"]
        self.assertIn(plan["conversions"][0]["id"], {c["id"] for c in kept["conversions"]})
        gone = self.admin_client.put("/api/tracking/plan/?unlock=1", {"plan": trimmed}, format="json").data["plan"]
        self.assertNotIn(plan["conversions"][0]["id"], {c["id"] for c in gone["conversions"]})

    def test_diff(self):
        from .tracking_plan import diff
        a = {"conversions": [{"id": "x", "label": "X", "rationale": "r1"}, {"id": "y", "label": "Y"}]}
        b = {"conversions": [{"id": "x", "label": "X", "rationale": "r2"}, {"id": "z", "label": "Z"}]}
        d = diff(a, b)
        self.assertEqual(([c["id"] for c in d["conversions"]["added"]], [c["id"] for c in d["conversions"]["removed"]], d["conversions"]["changed"]), (["z"], ["y"], []))
        self.assertEqual(d["total"], 2)


# ============================================================ runtime & cache

class RuntimeEdgeTests(TrackingBase):
    def test_config_cache_refreshes_on_approve_and_form_change(self):
        self.assertEqual(self.client.get("/api/tracking/config/").data["conversions"], [])
        self.approved_plan()
        self.assertTrue(self.client.get("/api/tracking/config/").data["conversions"])
        row = ComponentData.objects.get(name="form-quote")
        row.data = {**row.data, "fields": row.data["fields"][:2]}
        row.save()
        cfg = self.client.get("/api/tracking/config/").data
        self.assertEqual(cfg["formPages"], ["/contact"])
        # The approved plan now points at a removed field: reported, not silently changed.
        self.assertTrue(any("services" in d for d in self.admin_client.get("/api/tracking/plan/").data["report"]["dangling"]))

    def test_disabled_conversions_are_not_sent(self):
        plan = self.approved_plan()
        for c in plan["conversions"]:
            c["enabled"] = False
        self.admin_client.put("/api/tracking/plan/", {"plan": plan}, format="json")
        self.admin_client.post("/api/tracking/plan/approve/")
        self.assertEqual(self.client.get("/api/tracking/config/").data["conversions"], [])

    def test_sync_ids_reach_the_browser(self):
        self.approved_plan()
        TrackingSyncItem.objects.create(tool="google_ads", kind="ads_conversion", plan_id="lead", status="in_sync", detail={"label": "AW-1/abc"})
        TrackingSyncItem.objects.create(tool="linkedin", kind="linkedin_conversion", plan_id="lead", remote_id="777", status="in_sync")
        cache.clear()
        lead = next(c for c in self.client.get("/api/tracking/config/").data["conversions"] if c["id"] == "lead")
        self.assertEqual((lead["adsSendTo"], lead["linkedinConversionId"]), ("AW-1/abc", "777"))


# ================================================================ leads

@override_settings(TRACKING_INLINE_DELIVERY=False)
class LeadEdgeTests(TrackingBase):
    def post(self, body, **headers):
        cache.clear()
        return self.client.post("/api/forms/quote/submit/", body, format="json", **headers)

    def test_malformed_envelopes(self):
        self.approved_plan()
        for env in ("not json", "[1,2]", {"event_id": "x"}, {"event_id": "<script>alert(1)</script>"},
                    {"profile": "x", "consent": "y"}, {"profile": {"scores": {"intent": {"BAD KEY": 5, "ok_key": "nan"}}, "path": ["x", {"p": 5}]}}):
            r = self.post(lead_body(email=f"e{abs(hash(str(env)))}@acme.test", _cms=env))
            self.assertEqual(r.status_code, 201, (env, r.data))
        for s in FormSubmission.objects.all():
            self.assertRegex(s.event_id, r"^[A-Za-z0-9:_-]{8,80}$")
            self.assertNotIn("_cms", s.data)

    def test_envelope_as_json_string_and_form_encoded(self):
        self.approved_plan()
        r = self.client.post("/api/forms/quote/submit/", {"name": "A", "email": "f@acme.test", "business_type": "Other",
                                                          "_cms": json.dumps({"event_id": "evt-form-0001"})})
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(FormSubmission.objects.get().event_id, "evt-form-0001")

    def test_huge_profile_is_bounded(self):
        self.approved_plan()
        big = {"path": [{"p": "/x" * 100, "t": 1}] * 500, "signals": ["s" * 100] * 500,
               "scores": {"intent": {f"k{i}": i for i in range(500)}}}
        self.post(lead_body(_cms={"profile": big}))
        prof = FormSubmission.objects.get().profile
        self.assertLessEqual(len(prof["path"]), 15)
        self.assertLessEqual(len(prof["scores"]["intent"]), 40)
        self.assertLess(len(json.dumps(prof)), 12000)

    def test_identifiers_only_with_consent(self):
        self.approved_plan()
        self.post(lead_body(_cms={"consent": {"marketing": False}, "profile": {"fbp": "fb.1.x", "vid": "vid-abcdef12"}}))
        prof = FormSubmission.objects.get().profile
        self.assertNotIn("fbp", prof)
        self.assertNotIn("vid", prof)

    def test_spam_and_honeypot(self):
        self.approved_plan()
        r = self.post(lead_body(website="http://spam"))
        self.assertEqual(FormSubmission.objects.count(), 0)
        self.assertNotIn("conversions", r.data)

    def test_validation_error_creates_nothing(self):
        self.approved_plan()
        r = self.post({"email": "x@acme.test"})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(TrackingDaily.objects.exists())

    def test_no_plan_still_stores_and_counts(self):
        r = self.post(lead_body())
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.data["conversions"], [])
        self.assertEqual(TrackingDaily.objects.get(name="generate_lead").count, 1)

    def test_multiple_services_fire_each_conversion_once(self):
        self.approved_plan()
        r = self.post(lead_body(services=["Monthly payroll", "Quarterly VAT returns"]))
        self.assertEqual(sorted(c["id"] for c in r.data["conversions"]), ["lead", "lead_payroll", "lead_vat_returns"])
        self.assertIn("Monthly Payroll", r.data["summary"])

    def test_by_option_value_and_currency(self):
        plan = self.approved_plan()
        for c in plan["conversions"]:
            if c["id"] == "lead":
                c["value"] = {"mode": "by_option", "field": "services", "map": {"Monthly payroll": 200, "Quarterly VAT returns": 100}}
        self.admin_client.put("/api/tracking/plan/", {"plan": plan}, format="json")
        self.admin_client.post("/api/tracking/plan/approve/")
        r = self.post(lead_body(services=["Monthly payroll", "Quarterly VAT returns"]))
        lead = next(c for c in r.data["conversions"] if c["id"] == "lead")
        self.assertEqual((lead["value"], lead["currency"]), (300.0, "GBP"))

    def test_verified_test_bookings_skip_the_form_limit_but_others_dont(self):
        from .tracking_verify import create_run, make_token
        self.approved_plan()
        token = make_token(create_run())
        cache.clear()
        codes = [self.client.post("/api/forms/quote/submit/", lead_body(email=f"t{i}@acme.test", _cms={"verify": token}), format="json").status_code
                 for i in range(8)]
        self.assertEqual(set(codes), {201})
        cache.clear()
        forged = [self.client.post("/api/forms/quote/submit/", lead_body(email=f"f{i}@acme.test", _cms={"verify": "forged"}), format="json").status_code
                  for i in range(8)]
        self.assertIn(429, forged)

    def test_expired_and_finished_tokens_are_not_tests(self):
        from django.core import signing

        from .tracking_verify import create_run, finalise, make_token
        self.approved_plan()
        run = create_run()
        token = make_token(run)
        finalise(run)
        self.post(lead_body(email="a1@acme.test", _cms={"verify": token}))
        self.assertFalse(FormSubmission.objects.get(data__email="a1@acme.test").is_test)
        run2 = create_run()
        with mock.patch("api.tracking_verify.signing.loads", side_effect=signing.SignatureExpired("old")):
            self.post(lead_body(email="a2@acme.test", _cms={"verify": make_token(run2)}))
        self.assertFalse(FormSubmission.objects.get(data__email="a2@acme.test").is_test)

    def test_location_headers(self):
        self.approved_plan()
        self.post(lead_body(email="v@acme.test"), HTTP_X_VERCEL_IP_COUNTRY="us", HTTP_X_VERCEL_IP_CITY="San%20Jos%C3%A9",
                  HTTP_X_VERCEL_IP_COUNTRY_REGION="CA")
        s = FormSubmission.objects.get()
        self.assertEqual((s.country, s.region, s.city), ("US", "CA", "San José"))
        self.post(lead_body(email="x@acme.test"), HTTP_CF_IPCOUNTRY="XX")
        self.assertEqual(FormSubmission.objects.get(data__email="x@acme.test").country, "")
        with override_settings(TRUST_GEO_HEADERS=False):
            self.post(lead_body(email="y@acme.test"), HTTP_CF_IPCOUNTRY="GB")
        self.assertEqual(FormSubmission.objects.get(data__email="y@acme.test").country, "")

    def test_old_plan_without_services_field(self):
        self.approved_plan()
        r = self.post({"name": "A", "email": "z@acme.test", "business_type": "Other"})
        self.assertEqual([c["id"] for c in r.data["conversions"]], ["lead"])


# ================================================================ dispatch

@override_settings(TRACKING_INLINE_DELIVERY=False, TRACKING_SECRET_KEY=KEY)
class DispatchEdgeTests(TrackingBase):
    def connect(self, tool, account, secret):
        from .crypto import encrypt
        TrackingConnection.objects.create(tool=tool, status="connected", account=account, secret=encrypt(secret))

    def lead(self, consent, **cms):
        self.approved_plan()
        cache.clear()
        self.client.post("/api/forms/quote/submit/", {**lead_body(phone="07700 900111"),
                                                       "_cms": {"event_id": "evt-77777777", "consent": consent, "page": "/contact", **cms}}, format="json")
        return EventOutbox.objects.get()

    def test_consent_matrix(self):
        from .tracking_dispatch import tools_for
        for t in ("google", "meta", "tiktok", "linkedin", "google_ads"):
            TrackingConnection.objects.create(tool=t, status="connected")
        full = {"analytics": True, "marketing": True, "known": True}
        self.assertEqual(tools_for("generate_lead", full, {"gclid": "g"}, "uk_eu", False, True), ["ga4", "meta", "tiktok", "linkedin", "google_ads"])
        self.assertEqual(tools_for("generate_lead", full, {"ga4_loaded": True}, "uk_eu", False, True), ["meta", "tiktok", "linkedin"])
        self.assertEqual(tools_for("generate_lead", {"known": True}, {}, "uk_eu", False, True), [])
        self.assertEqual(tools_for("generate_lead", {"known": False}, {}, "us", False, True), ["meta", "tiktok", "linkedin"])
        self.assertEqual(tools_for("generate_lead", {"known": True}, {}, "us", False, True), [])
        self.assertEqual(tools_for("service_engaged", full, {}, "uk_eu", False, False), ["ga4", "meta", "tiktok"])
        self.assertEqual(tools_for("generate_lead", {}, {"gclid": "g"}, "uk_eu", True, True), ["ga4", "meta", "tiktok"])

    def test_disconnected_or_needs_reauth_tools_get_nothing(self):
        TrackingConnection.objects.create(tool="meta", status="needs_reauth")
        self.assertEqual(self.lead({"marketing": True}).status, "skipped")

    def test_ip_and_ua_dropped_without_ad_user_data(self):
        self.connect("meta", {"pixelId": "1"}, {"token": "t"})
        row = self.lead({"marketing": True, "ad_user_data": False})
        self.assertNotIn("ip", row.context)
        self.assertEqual(row.identifiers, {})

    def test_meta_payload(self):
        from .tracking_adapters import meta
        body = meta.build_event({"event_id": "e1", "meta_name": "Schedule", "params": {"intent": "payroll", "value": 3, "currency": "GBP", "event_id": "e1"},
                                 "consent": {"ad_user_data": True}, "identifiers": {"em": "h1", "ph": "h2", "country": "GB"},
                                 "context": {"ip": "1.2.3.4", "ua": "UA", "fbp": "fb.1", "url": "https://acme.test/contact"},
                                 "at": timezone.now()}, "TEST1")
        d = body["data"][0]
        self.assertEqual((d["event_name"], d["action_source"], body["test_event_code"]), ("Schedule", "website", "TEST1"))
        self.assertEqual(d["user_data"]["em"], ["h1"])
        self.assertEqual(d["custom_data"]["content_category"], "payroll")
        self.assertNotIn("event_id", d["custom_data"])

    def test_ga4_payload_and_test_route(self):
        from .tracking_adapters import ga4
        sent = []
        conn = {"account": {"measurementId": "G-1"}, "secret": {"mpSecret": "s"}}
        ev = {"name": "generate_lead", "event_id": "e1", "params": {"form_name": "quote"}, "consent": {}, "context": {},
              "conversion_ids": ["lead"], "at": timezone.now(), "is_test": True}
        with mock.patch("api.tracking_adapters.base.http_json", side_effect=lambda *a, **k: sent.append(a) or (200, {"validationMessages": []})):
            res = ga4.send(ev, conn)
        self.assertTrue(res["ok"])
        self.assertIn("/debug/mp/collect", sent[0][1])
        names = [e["name"] for e in sent[0][2]["events"]]
        self.assertEqual(names, ["generate_lead", "cv_lead"])
        self.assertTrue(sent[0][2]["events"][0]["params"]["debug_mode"])
        self.assertTrue(ga4.send({**ev, "is_test": False}, {"account": {}, "secret": {}})["skipped"])

    def test_tiktok_linkedin_ads_skips(self):
        from .tracking_adapters import google_ads, linkedin, tiktok
        ev = {"name": "generate_lead", "event_id": "e", "params": {}, "consent": {}, "context": {}, "identifiers": {}, "at": timezone.now(), "tiktok_name": "SubmitForm"}
        self.assertTrue(tiktok.send({**ev, "is_test": True}, {"account": {"pixelCode": "P"}, "secret": {"token": "t"}})["skipped"])
        self.assertTrue(linkedin.send(ev, {"account": {}, "secret": {"token": "t"}})["skipped"])  # no rule synced
        self.assertTrue(linkedin.send({**ev, "sync": {"linkedinConversionId": "1"}}, {"account": {}, "secret": {"token": "t"}})["skipped"])  # no id
        self.assertTrue(google_ads.send(ev, {"account": {}, "secret": {}})["skipped"])  # GA4 import mode
        self.assertTrue(google_ads.send({**ev, "is_test": True}, {"account": {"customerId": "1"}, "secret": {"developerToken": "d"}})["skipped"])

    def test_retries_exhaust_to_dead(self):
        from .tracking_adapters.base import Transient
        from .tracking_dispatch import BACKOFF, deliver
        self.connect("meta", {"pixelId": "1"}, {"token": "t"})
        row = self.lead({"marketing": True})
        now = timezone.now()
        with mock.patch("api.tracking_adapters.base.http_json", side_effect=Transient("down")):
            for i in range(len(BACKOFF) + 1):
                now += timedelta(hours=7)
                EventOutbox.objects.filter(pk=row.pk).update(created_at=now - timedelta(hours=1))
                deliver(row.pk, now)
        row.refresh_from_db()
        self.assertEqual(row.status, "dead")

    def test_permanent_errors_are_not_retried(self):
        from .tracking_adapters.base import Permanent
        from .tracking_dispatch import process_due
        self.connect("meta", {"pixelId": "1"}, {"token": "t"})
        row = self.lead({"marketing": True})
        with mock.patch("api.tracking_adapters.base.http_json", side_effect=Permanent("bad param", 400)):
            process_due()
        row.refresh_from_db()
        self.assertEqual((row.status, row.tools_pending), ("done", []))
        self.assertFalse(row.results["meta"]["ok"])

    def test_adapter_bug_doesnt_lose_the_event(self):
        from .tracking_dispatch import process_due
        self.connect("meta", {"pixelId": "1"}, {"token": "t"})
        row = self.lead({"marketing": True})
        with mock.patch("api.tracking_adapters.meta.send", side_effect=KeyError("boom")):
            process_due()
        row.refresh_from_db()
        self.assertEqual((row.status, row.tools_pending), ("pending", ["meta"]))

    def test_claim_is_exclusive(self):
        from .tracking_dispatch import deliver
        self.connect("meta", {"pixelId": "1"}, {"token": "t"})
        row = self.lead({"marketing": True})
        EventOutbox.objects.filter(pk=row.pk).update(locked_until=timezone.now() + timedelta(seconds=30))
        self.assertIsNone(deliver(row.pk))

    def test_circuit_breaker(self):
        from .tracking_dispatch import CIRCUIT_LIMIT, _circuit, _circuit_open
        for _ in range(CIRCUIT_LIMIT):
            _circuit("meta", False)
        self.assertTrue(_circuit_open("meta"))
        self.assertTrue(TrackingAlert.objects.filter(key="circuit:meta").exists())
        _circuit("meta", True)
        self.assertFalse(_circuit_open("meta"))

    def test_corrupt_secret_means_not_connected(self):
        TrackingConnection.objects.create(tool="meta", status="connected", secret="garbage")
        from .tracking_dispatch import load_connection
        self.assertIsNone(load_connection("meta"))

    def test_inline_delivery_runs_after_commit(self):
        self.connect("meta", {"pixelId": "1"}, {"token": "t"})
        with override_settings(TRACKING_INLINE_DELIVERY=True), mock.patch("api.tracking_dispatch.transaction.on_commit") as on_commit:
            self.lead({"marketing": True})
        self.assertTrue(on_commit.called)


# ================================================================ ingest

@override_settings(TRACKING_INLINE_DELIVERY=False)
class IngestEdgeTests(TrackingBase):
    def post(self, body, raw=None, **extra):
        return self.client.generic("POST", "/api/events/", raw if raw is not None else json.dumps(body), content_type="text/plain",
                                   HTTP_ORIGIN=extra.pop("origin", ORIGIN), **extra)

    def test_bad_inputs(self):
        self.assertEqual(self.post(None, raw="{not json").status_code, 400)
        self.assertEqual(self.post({"events": "x"}).status_code, 400)
        self.assertEqual(self.post({}, origin="").status_code, 403)
        self.assertEqual(self.post({"events": [None, 5, {"name": "nope", "event_id": "x" * 10}, {"name": "cta_click", "event_id": "short"}]}).status_code, 204)
        self.assertFalse(TrackingDaily.objects.exists())

    def test_www_and_site_url_origins(self):
        ok = {"events": [{"name": "cta_click", "event_id": "e-11111111"}]}
        self.assertEqual(self.post(ok, origin="https://www.acme.test").status_code, 204)
        self.assertEqual(self.post(ok, origin="https://evil.acme.test").status_code, 403)

    def test_only_twenty_events_per_beacon(self):
        evs = [{"name": "cta_click", "event_id": f"e-{i:08d}"} for i in range(40)]
        self.post({"events": evs})
        self.assertEqual(TrackingDaily.objects.get(name="cta_click").count, 20)

    def test_test_traffic_counts_separately(self):
        from .tracking_verify import create_run, make_token
        self.approved_plan()
        token = make_token(create_run())
        self.post({"events": [{"name": "cta_click", "event_id": "e-22222222", "conversions": ["booking_intent"]}], "verify": token,
                   "webdriver": True}, HTTP_USER_AGENT="HeadlessChrome")
        row = TrackingDaily.objects.get(name="conversion", conversion_id="booking_intent")
        self.assertEqual((row.count, row.test_count), (0, 1))

    def test_server_copy_only_for_server_events_or_primary(self):
        from .crypto import encrypt
        self.approved_plan()
        with override_settings(TRACKING_SECRET_KEY=KEY):
            TrackingConnection.objects.create(tool="meta", status="connected", account={"pixelId": "1"}, secret=encrypt({"token": "t"}))
            consent = {"analytics": True, "marketing": True}
            self.post({"events": [{"name": "cta_click", "event_id": "e-33333333", "conversions": ["booking_intent"]}], "consent": consent})
            self.assertFalse(EventOutbox.objects.exists())
            self.post({"events": [{"name": "service_engaged", "event_id": "e-44444444", "params": {"intent": "payroll"},
                                   "conversions": ["engaged_payroll"]}], "consent": consent})
            row = EventOutbox.objects.get()
            self.assertEqual((row.name, row.tools_pending), ("service_engaged", ["meta"]))

    def test_contact_events_are_capped(self):
        c = Contact.objects.create(email_norm="a@acme.test", vid="vid-cap00001")
        for i in range(505):
            ContactEvent.objects.create(contact=c, name="x")
        self.post({"events": [{"name": "faq_open", "event_id": "e-55555555"}], "consent": {"analytics": True}, "profile": {"vid": "vid-cap00001"}})
        self.assertEqual(c.events.count(), 500)


# ================================================================ sync

@override_settings(TRACKING_SECRET_KEY=KEY, TRACKING_INLINE_DELIVERY=False)
class SyncEdgeTests(TrackingBase):
    def google(self):
        from .crypto import encrypt
        TrackingConnection.objects.create(tool="google", status="connected", account={"propertyId": "1", "measurementId": "G-1", "streamName": "properties/1/dataStreams/9"},
                                          secret=encrypt({"serviceAccount": {"client_email": "sa@x", "private_key": "k"}}))

    def fake_google(self, existing_dims=(), audience_error=False):
        calls = []

        def fake(method, url, body=None, headers=None, **kw):
            calls.append((method, url, body))
            if "customDimensions?" in url:
                return 200, {"customDimensions": [{"parameterName": p, "name": f"properties/1/customDimensions/{p}"} for p in existing_dims]}
            if "keyEvents?" in url:
                return 200, {"keyEvents": []}
            if url.endswith("measurementProtocolSecrets"):
                return 200, {"name": "secret/1", "secretValue": "SEKRET"}
            if "/v1alpha/" in url and url.endswith("/audiences"):
                if audience_error:
                    from .tracking_adapters.base import Permanent
                    raise Permanent("not found", 404)
                return 200, {"name": "aud/1"}
            return 200, {"name": f"r{len(calls)}"}
        return calls, fake

    def test_ga4_creates_adopts_stores_secret_and_falls_back(self):
        from .tracking_sync import run_sync
        self.approved_plan()
        self.google()
        calls, fake = self.fake_google(existing_dims=("intent",), audience_error=True)
        with mock.patch("api.tracking_adapters.google_auth.access_token", return_value="tok"), \
             mock.patch("api.tracking_adapters.base.http_json", side_effect=fake):
            res = run_sync()["google"]
        self.assertGreater(res["created"], 0)
        self.assertGreater(res["manual"], 0)
        intent = TrackingSyncItem.objects.get(tool="google", kind="custom_dimension", plan_id="intent")
        self.assertTrue(intent.detail.get("adopted"))
        self.assertFalse([c for c in calls if c[0] == "POST" and c[1].endswith("/customDimensions") and (c[2] or {}).get("parameterName") == "intent"])
        from .tracking_dispatch import load_connection
        self.assertEqual(load_connection("ga4")["secret"]["mpSecret"], "SEKRET")
        manual = TrackingSyncItem.objects.filter(tool="google", status="manual").first()
        self.assertIn("include", manual.detail["manual"])

    def test_deleted_in_the_tool_is_recreated(self):
        from .tracking_sync import run_sync
        self.approved_plan()
        self.google()
        TrackingSyncItem.objects.create(tool="google", kind="custom_dimension", plan_id="segment", remote_id="properties/1/customDimensions/old",
                                        status="in_sync", desired_hash="x")
        calls, fake = self.fake_google()
        with mock.patch("api.tracking_adapters.google_auth.access_token", return_value="tok"), \
             mock.patch("api.tracking_adapters.base.http_json", side_effect=fake):
            run_sync()
        self.assertTrue([c for c in calls if c[0] == "POST" and (c[2] or {}).get("parameterName") == "segment"])

    def test_auth_failure_flags_the_connection(self):
        from .tracking_adapters.base import AuthError
        from .tracking_sync import run_sync
        self.approved_plan()
        self.google()
        with mock.patch("api.tracking_adapters.google_auth.access_token", side_effect=AuthError("expired", 401)):
            res = run_sync()["google"]
        self.assertEqual(res["error"], "needs re-auth")
        self.assertEqual(TrackingConnection.objects.get(tool="google").status, "needs_reauth")

    def test_unapproved_plan_does_nothing(self):
        from .tracking_sync import run_sync
        self.assertEqual(run_sync(), {"skipped": "plan not approved"})

    def test_queue_dedupes_and_worker_runs_it(self):
        from .tracking_sync import queue_sync, run_pending_sync
        queue_sync("a")
        queue_sync("b")
        self.assertEqual(TrackingJob.objects.filter(kind="sync", status="pending").count(), 1)
        run_pending_sync()
        self.assertEqual(TrackingJob.objects.get(kind="sync").status, "done")

    def test_archive_all_skips_adopted_and_secrets(self):
        from .crypto import encrypt
        from .tracking_sync import archive_all
        TrackingConnection.objects.create(tool="meta", status="connected", account={"pixelId": "1"}, secret=encrypt({"token": "t"}))
        TrackingSyncItem.objects.create(tool="meta", kind="custom_conversion", plan_id="a", remote_id="1", status="in_sync")
        TrackingSyncItem.objects.create(tool="meta", kind="custom_conversion", plan_id="b", remote_id="2", status="in_sync", detail={"adopted": True})
        with mock.patch("api.tracking_adapters.base.http_json", return_value=(200, {})) as http:
            self.assertEqual(archive_all("meta"), 1)
        self.assertIn("[removed]", http.call_args[0][2]["name"])

    def test_disconnect_with_and_without_remote_cleanup(self):
        from .crypto import encrypt
        TrackingConnection.objects.create(tool="meta", status="connected", account={"pixelId": "1"}, secret=encrypt({"token": "t"}))
        TrackingSyncItem.objects.create(tool="meta", kind="custom_conversion", plan_id="a", remote_id="1", status="in_sync")
        with mock.patch("api.tracking_adapters.base.http_json", return_value=(200, {})) as http:
            self.assertEqual(self.admin_client.delete("/api/tracking/connections/meta/").status_code, 204)
        http.assert_not_called()
        self.assertFalse(TrackingConnection.objects.exists())
        self.assertFalse(TrackingSyncItem.objects.exists())
        self.assertTrue(AdminAuditLog.objects.filter(action="disconnect_tool").exists())

    def test_keeps_existing_secret_on_update(self):
        with mock.patch("api.tracking_adapters.base.http_json", return_value=(200, {"id": "1", "name": "P"})):
            self.admin_client.post("/api/tracking/connections/meta/", {"account": {"pixelId": "1"}, "secret": {"token": "first-token-abc"}}, format="json")
            r = self.admin_client.post("/api/tracking/connections/meta/", {"account": {"adAccountId": "5"}, "secret": {"token": ""}}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        from .tracking_dispatch import load_connection
        conn = load_connection("meta")
        self.assertEqual((conn["secret"]["token"], conn["account"]["pixelId"], conn["account"]["adAccountId"]), ("first-token-abc", "1", "5"))

    def test_bad_service_account_json(self):
        r = self.admin_client.post("/api/tracking/connections/google/", {"account": {"propertyId": "1"}, "secret": {"serviceAccount": "{bad"}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.admin_client.post("/api/tracking/connections/nope/", {}, format="json").status_code, 404)

    def test_group_audience_sync_adds_and_removes(self):
        from .crypto import encrypt
        from .tracking_sync import sync_groups
        TrackingConnection.objects.create(tool="meta", status="connected", account={"pixelId": "1", "adAccountId": "2"}, secret=encrypt({"token": "t"}))
        a = Contact.objects.create(email_norm="a@acme.test", marketing_opt_in=True, segment="x")
        Contact.objects.create(email_norm="b@acme.test", marketing_opt_in=False, segment="x")
        g = ContactGroup.objects.create(key="g", label="G", rule={"all": [{"field": "segment", "op": "eq", "value": "x"}]}, sync_to=["meta"])
        calls = []
        with mock.patch("api.tracking_adapters.base.http_json", side_effect=lambda m, u, b=None, **k: calls.append((m, u)) or (200, {"id": "aud9"})):
            sync_groups()
            g.refresh_from_db()
            self.assertEqual(g.remote["meta"]["size"], 1)
            a.marketing_opt_in = False
            a.save()
            sync_groups()
        self.assertTrue([c for c in calls if c[0] == "DELETE"])
        g.refresh_from_db()
        self.assertEqual(g.remote["meta"]["size"], 0)

    def test_rotate_key_command(self):
        from cryptography.fernet import Fernet

        from .crypto import decrypt, encrypt
        TrackingConnection.objects.create(tool="meta", status="connected", secret=encrypt({"token": "keep-me"}))
        new = Fernet.generate_key().decode()
        with override_settings(TRACKING_SECRET_KEY=new, TRACKING_SECRET_KEY_OLD=KEY):
            call_command("tracking_rotate_key", stdout=io.StringIO())
        with override_settings(TRACKING_SECRET_KEY=new, TRACKING_SECRET_KEY_OLD=""):
            self.assertEqual(decrypt(TrackingConnection.objects.get().secret)["token"], "keep-me")


# ================================================================ verify / worker

@override_settings(TRACKING_INLINE_DELIVERY=False)
class VerifyEdgeTests(TrackingBase):
    def test_token_for_another_run_is_refused(self):
        from .tracking_verify import create_run, make_token
        self.approved_plan()
        a, b = create_run(), create_run()
        r = self.client.post(f"/api/tracking/verify/runs/{b.pk}/results/", {"results": []}, format="json", HTTP_X_CMS_VERIFY=make_token(a))
        self.assertEqual(r.status_code, 403)

    def test_results_are_bounded_and_validated(self):
        from .tracking_verify import create_run, make_token, record_results
        self.approved_plan()
        run = create_run()
        n = record_results(run, {"results": [{"conversion": "x", "step": "weird", "status": "ok"}, {"conversion": "x", "step": "sent", "status": "maybe"},
                                             "junk", {"conversion": "y", "step": "sent", "status": "ok", "evidence": {"big": "z" * 10000}}]})
        self.assertEqual(n, 1)
        self.assertEqual(run.results.get().evidence, {"truncated": True})

    def test_received_step_from_outbox(self):
        from .tracking_verify import create_run, finalise
        self.approved_plan()
        run = create_run(scope=["lead"])
        EventOutbox.objects.create(event_id="e1", name="generate_lead", params={"cms_verify_run": str(run.pk), "conversion_id": "lead"},
                                   is_test=True, results={"meta": {"ok": True, "detail": "events_received=1"}, "tiktok": {"ok": False, "skipped": True}})
        finalise(run)
        steps = {(r.tool, r.status) for r in run.results.filter(step="received")}
        self.assertEqual(steps, {("meta", "ok"), ("tiktok", "skipped")})

    def test_runner_endpoint(self):
        with override_settings(REVALIDATE_SECRET="shh"):
            self.assertEqual(self.client.get("/api/tracking/verify/pending/", HTTP_X_CMS_RUNNER="nope").status_code, 403)
            first = self.client.get("/api/tracking/verify/pending/", HTTP_X_CMS_RUNNER="shh")
            self.assertEqual(first.status_code, 200, first.data)
            self.assertIsNone(first.data["run"])
            self.assertIsNone(self.client.get("/api/tracking/verify/pending/?schedule=1", HTTP_X_CMS_RUNNER="shh").data["run"])  # no plan
            self.approved_plan()
            created = self.admin_client.post("/api/tracking/verify/runs/", {"mode": "headless"}, format="json")
            got = self.client.get("/api/tracking/verify/pending/", HTTP_X_CMS_RUNNER="shh").data["run"]
            self.assertEqual(got["id"], created.data["id"])
            self.assertIsNone(self.client.get("/api/tracking/verify/pending/", HTTP_X_CMS_RUNNER="shh").data["run"])

    def test_runs_need_an_approved_plan(self):
        self.assertEqual(self.admin_client.post("/api/tracking/verify/runs/", {}, format="json").status_code, 400)

    def test_acceptance_runs_dont_count_as_checks(self):
        from .tracking_verify import create_run, finalise, latest_summary
        self.approved_plan()
        run = create_run(trigger="acceptance")
        finalise(run)
        self.assertIsNone(latest_summary())

    def test_alert_lifecycle_and_webhook(self):
        from .tracking_verify import open_alert, resolve_alert
        with override_settings(TRACKING_ALERT_WEBHOOK="https://hooks.acme.test/x"), mock.patch("urllib.request.urlopen") as urlopen:
            open_alert("k", "warning", "first")
            open_alert("k", "warning", "first")  # same, recently notified: no second send
            self.assertEqual(urlopen.call_count, 1)
            open_alert("k", "warning", "changed")
            self.assertEqual(urlopen.call_count, 2)
        resolve_alert("k")
        self.assertIsNotNone(TrackingAlert.objects.get(key="k").resolved_at)
        open_alert("k", "warning", "again")
        self.assertIsNone(TrackingAlert.objects.get(key="k").resolved_at)

    def test_nightly_and_worker_once(self):
        self.approved_plan()
        old = timezone.now() - timedelta(days=2)
        FormSubmission.objects.create(form_name="quote", data={}, is_test=True)
        FormSubmission.objects.filter(is_test=True).update(created_at=old)
        VerificationRun.objects.create(status="running")
        VerificationRun.objects.filter(status="running").update(created_at=old)
        out = io.StringIO()
        call_command("tracking_worker", "--once", stdout=out)
        self.assertIn("tracking_worker", out.getvalue())
        self.assertFalse(FormSubmission.objects.filter(is_test=True).exists())
        self.assertEqual(VerificationRun.objects.get().status, "error")
        self.assertTrue(TrackingJob.objects.filter(kind="heartbeat").exists())

    def test_after_publish_is_debounced_and_safe(self):
        from .tracking_verify import after_publish
        with mock.patch("api.tracking_verify.static_check", side_effect=RuntimeError("x")) as sc:
            after_publish()
            after_publish()
        self.assertEqual(sc.call_count, 1)

    def test_overview_and_last_seen(self):
        from .tracking_verify import count
        self.approved_plan()
        count("conversion", conversion_id="lead")
        count("conversion", conversion_id="lead", test=True)
        o = self.admin_client.get("/api/tracking/overview/").data
        lead = next(c for c in o["conversions"] if c["id"] == "lead")
        self.assertEqual((lead["total7"], lead["tests7"]), (1, 1))
        self.assertIsNotNone(lead["lastSeen"])


# ================================================================ contacts

@override_settings(TRACKING_INLINE_DELIVERY=False)
class ContactEdgeTests(TrackingBase):
    def lead(self, **data):
        cache.clear()
        return self.client.post("/api/forms/quote/submit/", {"name": "Jo", "business_type": "Sole trader", **data}, format="json")

    def test_phone_only_and_no_identity(self):
        ComponentData.objects.filter(name="form-quote").update(data={"fields": [{"name": "phone", "type": "tel"}, {"name": "message", "type": "textarea"}]})
        self.lead(phone="07700 900333")
        self.assertEqual(Contact.objects.get().phone_e164, "447700900333")
        self.lead(message="hi")
        self.assertEqual(Contact.objects.count(), 1)

    def test_disabled_contacts(self):
        data = SiteSettings.objects.get(pk=1).data
        data["contacts"] = {"enabled": False}
        SiteSettings.objects.filter(pk=1).update(data=data)
        self.lead(email="a@acme.test")
        self.assertFalse(Contact.objects.exists())

    def test_admin_name_edit_survives_new_enquiries(self):
        self.lead(email="a@acme.test", name="jo")
        c = Contact.objects.get()
        self.admin_client.patch(f"/api/contacts/{c.pk}/", {"name": "Jo Smith (director)"}, format="json")
        FormSubmission.objects.update(created_at=timezone.now() - timedelta(minutes=5))
        self.lead(email="a@acme.test", name="J")
        self.assertEqual(Contact.objects.get().name, "Jo Smith (director)")

    def test_manual_merge(self):
        self.lead(email="a@acme.test", phone="07700 900444")
        self.lead(email="b@acme.test", phone="07700 900444")
        a, b = Contact.objects.order_by("pk")
        r = self.admin_client.post(f"/api/contacts/{a.pk}/merge/", {"other": b.pk}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(Contact.objects.count(), 1)
        self.assertEqual(Contact.objects.get().submissions.count(), 2)
        self.assertEqual(self.admin_client.post(f"/api/contacts/{a.pk}/merge/", {"other": a.pk}, format="json").status_code, 400)

    def test_group_operators(self):
        from .contacts import matches
        c = Contact(email_norm="a@acme.test", intents={"payroll": 12, "vat": 3}, stages=["switching"], status="client", is_client=True, country="GB",
                    value=250, visits=4, tags=["vip"], marketing_opt_in=True, first_source={"utm": {"source": "google", "campaign": "spring"}},
                    answers={"business_type": "Limited company"}, first_seen=timezone.now() - timedelta(days=10), last_seen=timezone.now())
        ok = lambda *conds: matches(c, {"all": [dict(zip(("field", "op", "value"), x)) for x in conds]})
        self.assertTrue(ok(("intent", "eq", "payroll"), ("stage", "eq", "switching")))
        self.assertTrue(ok(("intent", "in", ["x", "vat"])))
        self.assertFalse(ok(("intent", "neq", "payroll")))
        self.assertTrue(ok(("campaign", "contains", "spr")))
        self.assertTrue(ok(("value", "gte", 200), ("visits", "lte", 4)))
        self.assertFalse(ok(("value", "gte", "abc")))
        self.assertTrue(ok(("opt_in", "eq", "true"), ("is_client", "eq", True)))
        self.assertTrue(ok(("answer.business_type", "eq", "limited company")))
        self.assertTrue(ok(("created", "before", timezone.now().date().isoformat())))
        self.assertTrue(ok(("tag", "exists", None)))
        self.assertFalse(ok(("created", "after", "not a date")))

    def test_group_validation_and_unique_keys(self):
        bad = [None, {"all": []}, {"all": [{"field": "x"}]}, {"all": [{"field": "intent", "op": "regex"}]}]
        for rule in bad:
            self.assertEqual(self.admin_client.post("/api/contacts/groups/", {"label": "G", "rule": rule}, format="json").status_code, 400, rule)
        self.assertEqual(self.admin_client.post("/api/contacts/groups/", {"label": "", "rule": {"all": [{"field": "intent"}]}}, format="json").status_code, 400)
        keys = [self.admin_client.post("/api/contacts/groups/", {"label": "VIP", "rule": {"all": [{"field": "tag", "op": "eq", "value": "vip"}]}}, format="json").data["key"]
                for _ in range(3)]
        self.assertEqual(len(set(keys)), 3)
        self.assertEqual(self.admin_client.delete(f"/api/contacts/groups/{keys[0]}/").status_code, 204)

    def test_list_filters_and_pagination(self):
        for i in range(55):
            Contact.objects.create(email_norm=f"p{i}@acme.test", status="new" if i % 2 else "client", is_client=not i % 2, marketing_opt_in=i < 5)
        data = self.admin_client.get("/api/contacts/?page=2").data
        self.assertEqual((data["count"], len(data["results"])), (55, 5))
        self.assertEqual(self.admin_client.get("/api/contacts/?status=client").data["count"], 28)
        self.assertEqual(self.admin_client.get("/api/contacts/?opt_in=1").data["count"], 5)
        self.assertEqual(self.admin_client.get("/api/contacts/?q=p54").data["count"], 1)
        self.assertEqual(self.admin_client.get("/api/contacts/?group=auto:opted_in").data["count"], 5)
        self.assertEqual(self.admin_client.get("/api/contacts/?group=ghost").data["count"], 0)

    def test_csv_with_answers_and_free_text(self):
        self.approved_plan()
        self.lead(email="a@acme.test", services=["Monthly payroll"], message="Line one, \"quoted\"\nline two")
        text = self.admin_client.get("/api/contacts/export/?free_text=1").content.decode()
        self.assertIn("answer:business_type", text.splitlines()[0])
        self.assertIn("last_message", text.splitlines()[0])
        self.assertIn('"Line one, ""quoted""', text)

    def test_access_export_has_everything(self):
        self.lead(email="a@acme.test", message="hello")
        c = Contact.objects.get()
        data = json.loads(self.admin_client.get(f"/api/contacts/{c.pk}/export/").content)
        self.assertEqual(data["submissions"][0]["data"]["message"], "hello")
        self.assertTrue(AdminAuditLog.objects.filter(action="contact_export").exists())

    def test_erase_keeps_submissions_when_configured(self):
        data = SiteSettings.objects.get(pk=1).data
        data["contacts"] = {"deleteSubmissionsOnErase": False}
        SiteSettings.objects.filter(pk=1).update(data=data)
        self.lead(email="a@acme.test")
        from .contacts import erase
        erase(Contact.objects.get())
        self.assertEqual(FormSubmission.objects.get().contact, None)
        self.assertTrue(TrackingJob.objects.filter(kind="audience_remove").exists())

    def test_tombstone_expires(self):
        self.lead(email="a@acme.test")
        from .contacts import erase
        erase(Contact.objects.get())
        ErasureTombstone.objects.update(created_at=timezone.now() - timedelta(days=31))
        FormSubmission.objects.all().delete()
        self.lead(email="a@acme.test")
        self.assertEqual(Contact.objects.count(), 1)

    def test_status_changes_retention(self):
        self.lead(email="a@acme.test")
        c = Contact.objects.get()
        self.assertIsNotNone(c.retain_until)
        self.admin_client.patch(f"/api/contacts/{c.pk}/", {"status": "client"}, format="json")
        c.refresh_from_db()
        self.assertTrue(c.is_client)
        self.assertIsNone(c.retain_until)
        self.admin_client.patch(f"/api/contacts/{c.pk}/", {"status": "not_proceeding"}, format="json")
        c.refresh_from_db()
        self.assertFalse(c.is_client)
        self.assertIsNotNone(c.retain_until)
        self.assertEqual([h["status"] for h in c.status_history], ["new", "client", "not_proceeding"])

    def test_settings_validation(self):
        put = lambda body: self.admin_client.put("/api/contacts/settings/", body, format="json")
        self.assertEqual(put({"retentionMonths": 0}).status_code, 400)
        self.assertEqual(put({"retentionMonths": "x"}).status_code, 400)
        self.assertEqual(put({"statuses": ["Bad Status"]}).status_code, 400)
        r = put({"statuses": ["qualified", "won"]})
        self.assertEqual(r.data["statuses"], ["new", "qualified", "won"])

    def test_webhooks_signed_and_retried(self):
        import hashlib
        import hmac
        put = self.admin_client.put("/api/contacts/settings/", {"webhooks": [{"url": "https://hooks.acme.test/c", "secret": "s3"}]}, format="json")
        self.assertEqual(put.status_code, 200)
        self.lead(email="a@acme.test")
        job = TrackingJob.objects.get(kind="webhook")
        sent = []

        class Res:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake(req, timeout=10):
            sent.append(req)
            return Res()

        with mock.patch("urllib.request.urlopen", side_effect=fake):
            call_command("tracking_worker", "--once", stdout=io.StringIO())
        job.refresh_from_db()
        self.assertEqual(job.status, "done")
        sig = sent[0].headers["X-cms-signature"]
        self.assertEqual(sig, "sha256=" + hmac.new(b"s3", sent[0].data, hashlib.sha256).hexdigest())
        TrackingJob.objects.create(kind="webhook", payload={**job.payload, "attempts": 4})
        with mock.patch("urllib.request.urlopen", side_effect=OSError("down")):
            call_command("tracking_worker", "--once", stdout=io.StringIO())
        self.assertTrue(TrackingJob.objects.filter(kind="webhook", status="error").exists())

    def test_public_cannot_reach_any_contact_endpoint(self):
        c = Contact.objects.create(email_norm="a@acme.test")
        for method, url in (("get", "/api/contacts/"), ("get", f"/api/contacts/{c.pk}/"), ("patch", f"/api/contacts/{c.pk}/"),
                            ("post", f"/api/contacts/{c.pk}/erase/"), ("post", f"/api/contacts/{c.pk}/merge/"), ("get", "/api/contacts/groups/"),
                            ("post", "/api/contacts/groups/"), ("get", "/api/contacts/settings/"), ("put", "/api/contacts/settings/"),
                            ("get", "/api/contacts/audit/"), ("post", "/api/contacts/webhook-test/"), ("get", "/api/contacts/export/")):
            self.assertIn(getattr(self.client, method)(url, {}, format="json").status_code, (401, 403), url)
        self.assertNotIn("a@acme.test", json.dumps(self.client.get("/api/tracking/config/").data))


# ================================================================ settings / launch

class SettingsAndLaunchEdgeTests(TrackingBase):
    def test_launch_items(self):
        from .launch_check import run_launch_check
        self.approved_plan()
        TrackingConnection.objects.create(tool="meta", status="needs_reauth", last_error="expired")
        TrackingJob.objects.create(kind="heartbeat", status="done")
        TrackingJob.objects.filter(kind="heartbeat").update(created_at=timezone.now() - timedelta(days=2))
        TrackingAlert.objects.create(key="quiet", message="lead quiet")
        ids = {i["id"] for i in run_launch_check()["items"]}
        self.assertTrue({"tracking-reauth-meta", "tracking-worker", "tracking-quiet", "tracking-checks"} <= ids)
        row = ComponentData.objects.get(name="form-quote")
        row.data["fields"][4]["options"] = ["Renamed", "Quarterly VAT returns"]
        row.save()
        ids = {i["id"] for i in run_launch_check()["items"]}
        self.assertTrue({"tracking-dangling", "tracking-stale"} <= ids)

    def test_draft_plan_warning(self):
        from .launch_check import run_launch_check
        self.scan()
        plan = self.admin_client.post("/api/tracking/plan/build/").data["plan"]
        self.admin_client.put("/api/tracking/plan/", {"plan": plan}, format="json")
        item = next(i for i in run_launch_check()["items"] if i["id"] == "tracking-plan")
        self.assertIn("draft", item["label"])

    def test_cors_allows_the_verify_header(self):
        from django.conf import settings
        self.assertIn("x-cms-verify", settings.CORS_ALLOW_HEADERS)

    def test_gtm_container_is_complete(self):
        from .tracking_adapters import gtm
        self.approved_plan()
        from .tracking_plan import get_plan
        c = gtm.container(get_plan(), "G-ABC")["containerVersion"]
        regex = c["trigger"][0]["customEventFilter"][0]["parameter"][1]["value"]
        for ev in ("cta_click", "generate_lead", "faq_open", "form_abandon"):
            self.assertIn(ev, regex)
        self.assertTrue(all(t["consentSettings"]["consentStatus"] == "NEEDED" for t in c["tag"]))
        self.assertEqual(len({v["variableId"] for v in c["variable"]}), len(c["variable"]))
        self.assertEqual(self.admin_client.post("/api/tracking/gtm/").status_code, 400)  # not connected

    def test_ai_apply_variants(self):
        plan = self.approved_plan()
        reply = {k: plan[k] for k in ("intents", "segments", "stages", "conversions", "audiences")}
        post = lambda raw, **kw: self.admin_client.post("/api/ai/tracking-plan/apply/", {"raw": raw, **kw}, format="json")
        self.assertEqual(post("Here you go:\n" + json.dumps({"plan": reply}) + "\nThanks!").status_code, 200)
        self.assertEqual(post("not json at all").status_code, 400)
        self.assertEqual(post(json.dumps({"hello": 1})).status_code, 400)
        tiny = {"intents": [], "conversions": plan["conversions"][:1]}
        self.assertEqual(post(json.dumps(tiny), replace=True).status_code, 200)
        r = post(json.dumps({**reply, "conversions": reply["conversions"] + [{"id": "ai_new", "label": "New", "tier": "secondary",
                                                                                "trigger": {"event": "page_view", "where": {"path": "/services"}}}]}))
        new = next(c for c in r.data["plan"]["conversions"] if c["id"] == "ai_new")
        self.assertEqual(new["createdBy"], "ai")
        self.assertEqual(self.client.post("/api/ai/tracking-plan/apply/", {"raw": "{}"}, format="json").status_code, 401)
