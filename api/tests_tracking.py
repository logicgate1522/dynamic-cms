"""Tests for business-aware tracking, verification and contacts (R31–R33).
No network: every tool call goes through tracking_adapters.base.http_json,
which these tests replace."""

import json
from datetime import timedelta
from unittest import mock

from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from .models import (ComponentData, Contact, ContactGroup, ContentPage, EventOutbox, FormSubmission, PageSEO, SiteSettings,
                     TrackingConnection, TrackingDaily, TrackingScan, TrackingSyncItem, VerificationRun)

User = get_user_model()
KEY = Fernet.generate_key().decode()
ORIGIN = "https://acme.test"

FORM = {"fields": [
    {"name": "name", "type": "text", "label": "Name", "required": True},
    {"name": "email", "type": "email", "label": "Email", "required": True},
    {"name": "phone", "type": "tel", "label": "Phone"},
    {"name": "business_type", "type": "select", "label": "Business type", "required": True,
     "options": ["Limited company", "Sole trader", "Other"]},
    {"name": "services", "type": "checkboxes", "label": "Services you're interested in",
     "options": ["Monthly payroll", "Quarterly VAT returns"]},
    {"name": "updates", "type": "consent_marketing", "label": "Keep me updated"},
    {"name": "message", "type": "textarea", "label": "Message"},
]}

SCAN = {"pages": [
    {"path": "/", "title": "Home", "blocks": [{"name": "home-hero", "heading": "Accountants"}],
     "ctas": [{"label": "Book a call", "target": "/contact", "block": "home-hero"}]},
    {"path": "/services", "title": "Services", "blocks": [{"name": "services-pricing", "heading": "How pricing works"},
                                                          {"name": "services-who-we-help", "heading": "Who we help", "itemLabels": ["Contractors"]}]},
    {"path": "/contact", "title": "Book", "forms": [{"name": "quote"}]},
    {"path": "/faqs", "title": "FAQs", "faqs": [{"question": "How do I switch to you from my current accountant?", "block": "faqs"},
                                                {"question": "How much do your services cost?", "block": "faqs"}]},
]}


class TrackingBase(APITestCase):
    def setUp(self):
        super().setUp()
        cache.clear()
        self.admin = User.objects.create_user(username="admin", password="pass1234", is_staff=True)
        self.admin_client = self.client_class()
        self.admin_client.force_authenticate(user=self.admin)
        SiteSettings.objects.update_or_create(pk=1, defaults={"data": {
            "organization": {"name": "Acme Ltd", "description": "Accountants for small businesses"},
            "schema": {"organizationType": "AccountingService"},
            "seoDefaults": {"siteUrl": ORIGIN, "locale": "en_GB"},
            "collections": {"services": {"label": "Service", "plural": "Services", "hostKind": "content", "indexPath": "services",
                                         "pathPrefix": "services", "pageType": "service", "sections": ["hero"]}},
        }})
        ComponentData.objects.create(name="form-quote", data=FORM)
        for slug, title in (("payroll", "Monthly Payroll"), ("vat-returns", "Quarterly VAT Returns")):
            ContentPage.objects.create(path=f"services/{slug}", title=title, status="published", page_type="service")
        PageSEO.objects.create(path="faqs", data={"faqItems": [{"question": "When is the VAT deadline?", "answer": "…"}]})
        PageSEO.objects.create(path="contact", data={})
        PageSEO.objects.create(path="services", data={})

    def scan(self):
        r = self.admin_client.post("/api/tracking/scan/", SCAN, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        return r

    def approved_plan(self):
        self.scan()
        r = self.admin_client.post("/api/tracking/plan/build/")
        self.assertEqual(r.status_code, 200, r.data)
        r = self.admin_client.put("/api/tracking/plan/", {"plan": r.data["plan"]}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        r = self.admin_client.post("/api/tracking/plan/approve/")
        self.assertEqual(r.status_code, 200, r.data)
        return r.data["plan"]


# ---------------------------------------------------------------- vocab / facts

class VocabTests(APITestCase):
    def test_personal_data_is_stripped_from_every_param(self):
        from .tracking_vocab import clean_params
        out = clean_params("cta_click", {"cta_label": "Email jo@acme.test or call 07700 900123", "page_path": "/x?email=a@b.co",
                                         "secret_field": "nope", "intent": "payroll"})
        self.assertNotIn("@", json.dumps(out))
        self.assertNotIn("900123", json.dumps(out))
        self.assertNotIn("secret_field", out)
        self.assertEqual(out["page_path"], "/x")
        self.assertEqual(out["intent"], "payroll")

    def test_unknown_events_carry_nothing(self):
        from .tracking_vocab import clean_params
        self.assertEqual(clean_params("made_up", {"a": 1}), {})


class FactsTests(TrackingBase):
    def test_home_page_with_a_form_is_never_a_cta_target(self):
        scan = json.loads(json.dumps(SCAN))
        scan["pages"][0]["forms"] = [{"name": "quote"}]
        self.admin_client.post("/api/tracking/scan/", scan, format="json")
        from .site_facts import get_facts
        f = get_facts()
        self.assertIn("/", f["formPages"])
        self.assertEqual(f["ctaPages"], ["/contact"])

    def test_db_and_scan_are_merged(self):
        self.scan()
        from .site_facts import get_facts
        f = get_facts()
        paths = {p["path"]: p["type"] for p in f["pages"]}
        self.assertEqual(paths["/services/payroll"], "service")
        self.assertEqual(paths["/services"], "index")
        self.assertEqual(paths["/contact"], "contact")
        self.assertEqual(f["formPages"], ["/contact"])
        self.assertEqual(f["ctaPages"], ["/contact"])
        self.assertIn("services-pricing", f["blocks"])
        self.assertTrue(any("switch" in q["question"] for q in f["faqs"]))

    def test_facts_hash_changes_when_a_form_option_changes(self):
        from .site_facts import get_facts
        before = get_facts()["hash"]
        row = ComponentData.objects.get(name="form-quote")
        row.data["fields"][4]["options"] = ["Payroll", "Quarterly VAT returns"]
        row.save()
        self.assertNotEqual(get_facts()["hash"], before)

    def test_a_much_smaller_scan_warns(self):
        big = {"pages": [{"path": f"/p{i}"} for i in range(10)]}
        self.admin_client.post("/api/tracking/scan/", big, format="json")
        r = self.admin_client.post("/api/tracking/scan/", {"pages": [{"path": "/"}]}, format="json")
        self.assertIn("Only 1 page", r.data["warning"])

    def test_scan_input_is_bounded(self):
        from .site_facts import clean_scan
        big = {"pages": [{"path": f"/p{i}", "title": "x" * 900, "ctas": [{"label": "y" * 300}] * 500} for i in range(400)]}
        out = clean_scan(big)
        self.assertEqual(len(out["pages"]), 200)
        self.assertLessEqual(len(out["pages"][0]["title"]), 200)
        self.assertLessEqual(len(out["pages"][0]["ctas"]), 60)
        with self.assertRaises(ValueError):
            clean_scan({"nope": 1})


# --------------------------------------------------------------------- library

class LibraryTests(TrackingBase):
    def build(self):
        self.scan()
        from .site_facts import get_facts
        from .tracking_library import build_plan
        return build_plan(get_facts())

    def test_plan_fits_the_business(self):
        plan = self.build()
        self.assertEqual(plan["pack"], "professional_services")
        self.assertEqual({i["id"] for i in plan["intents"]}, {"payroll", "vat_returns"})
        payroll = next(i for i in plan["intents"] if i["id"] == "payroll")
        self.assertEqual(payroll["match"]["formOptions"], [{"form": "quote", "field": "services", "option": "Monthly payroll"}])
        self.assertEqual({s["id"] for s in plan["segments"]} >= {"limited_company", "sole_trader"}, True)
        self.assertNotIn("other", {s["id"] for s in plan["segments"]})
        self.assertIn("contractors", {s["id"] for s in plan["segments"]})
        stages = {s["id"] for s in plan["stages"]}
        self.assertIn("switching", stages)
        self.assertIn("price", stages)
        conv = {c["id"]: c for c in plan["conversions"]}
        self.assertEqual(conv["lead"]["tier"], "primary")
        self.assertEqual(conv["lead"]["destinations"]["meta"], "Lead")
        self.assertIn("lead_payroll", conv)
        self.assertEqual(conv["booking_intent"]["trigger"]["where"]["ctaTargets"], ["/contact"])
        self.assertIn("pricing_seen", conv)
        self.assertTrue(all(c["rationale"] for c in plan["conversions"] if c["tier"] == "primary"))

    def test_channels_not_shown_get_no_conversions(self):
        plan = self.build()
        ids = {c["id"] for c in plan["conversions"]}
        self.assertNotIn("call_click", ids)
        self.assertNotIn("email_click", ids)
        self.assertNotIn("download", ids)
        self.assertNotIn("guide_read", ids)  # no articles

    def test_phone_on_site_adds_a_call_conversion(self):
        scan = json.loads(json.dumps(SCAN))
        scan["pages"][0]["tel"] = True
        self.admin_client.post("/api/tracking/scan/", scan, format="json")
        from .site_facts import get_facts
        from .tracking_library import build_plan
        self.assertIn("call_click", {c["id"] for c in build_plan(get_facts())["conversions"]})

    def test_every_library_plan_validates_and_has_short_ids(self):
        from .site_facts import get_facts
        from .tracking_plan import validate
        plan = self.build()
        _, report = validate(plan, get_facts())
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["dangling"], [])
        self.assertTrue(all(len(c["id"]) <= 37 for c in plan["conversions"]))

    def test_tool_explanations_name_the_plan(self):
        from .tracking_library import explain_tool
        lines = explain_tool("meta", self.build())
        self.assertTrue(any("Retarget" in l for l in lines))


# ----------------------------------------------------------------- validation

class PlanValidationTests(TrackingBase):
    def facts(self):
        self.scan()
        from .site_facts import get_facts
        return get_facts()

    def conv(self, **where):
        return {"intents": [], "conversions": [{"id": "x_conv", "label": "X", "tier": "primary",
                                                "trigger": {"event": "generate_lead", "where": where}}]}

    def test_dangling_references_are_reported(self):
        from .tracking_plan import validate
        f = self.facts()
        for where, needle in ((dict(form="nope"), "form"), (dict(form="quote", field="nope"), "field"),
                              (dict(form="quote", field="services", option="Nope"), "option")):
            _, r = validate(self.conv(**where), f)
            self.assertTrue(any(needle in m for m in r["dangling"]), (where, r))

    def test_malformed_items_are_errors(self):
        from .tracking_plan import validate
        f = self.facts()
        bad = {"conversions": [{"id": "Bad Id", "label": "x", "trigger": {"event": "generate_lead"}},
                               {"id": "ok_id", "trigger": {"event": "made_up"}},
                               {"id": "ok_id", "trigger": {"event": "page_view"}}]}
        _, r = validate(bad, f)
        self.assertTrue(any("Bad Id" in e for e in r["errors"]))
        self.assertTrue(any("made_up" in e for e in r["errors"]))
        self.assertTrue(any("duplicate" in e for e in r["errors"]))

    def test_caps_are_enforced(self):
        from .tracking_plan import validate
        many = {"conversions": [{"id": f"c_{i}", "label": "x", "tier": "primary", "trigger": {"event": "generate_lead", "where": {"form": "quote"}}}
                                for i in range(30)]}
        _, r = validate(many, self.facts())
        self.assertTrue(any("too many primary" in e for e in r["errors"]))

    def test_meta_window_is_capped_with_a_warning(self):
        from .tracking_plan import validate
        plan = {"conversions": [{"id": "lead", "label": "Lead", "tier": "primary", "trigger": {"event": "generate_lead", "where": {"form": "quote"}}}],
                "audiences": [{"id": "aud", "label": "A", "include": [{"conversion": "lead"}], "windowDays": 400, "tools": ["meta"]}]}
        _, r = validate(plan, self.facts())
        self.assertTrue(any("180" in w for w in r["warnings"]))

    def test_cannot_approve_with_dangling_triggers(self):
        self.scan()
        r = self.admin_client.put("/api/tracking/plan/", {"plan": self.conv(form="quote", field="services", option="Gone")}, format="json")
        self.assertEqual(r.status_code, 200)
        r = self.admin_client.post("/api/tracking/plan/approve/")
        self.assertEqual(r.status_code, 400)
        self.assertTrue(r.data["report"]["dangling"])

    def test_locked_items_survive_a_rebuild(self):
        plan = self.approved_plan()
        plan["conversions"].append({"id": "my_own", "label": "Mine", "tier": "secondary", "locked": True,
                                    "trigger": {"event": "page_view", "where": {"path": "/services"}}})
        self.admin_client.put("/api/tracking/plan/", {"plan": plan}, format="json")
        r = self.admin_client.post("/api/tracking/plan/build/")
        self.assertIn("my_own", {c["id"] for c in r.data["plan"]["conversions"]})

    def test_plan_endpoints_are_admin_only_and_private(self):
        self.approved_plan()
        self.assertEqual(self.client.get("/api/tracking/plan/").status_code, 401)
        public = self.client.get("/api/settings/site/").data
        self.assertNotIn("plan", public.get("analytics") or {})
        self.assertIn("plan", self.admin_client.get("/api/settings/site/").data["analytics"])

    def test_settings_save_never_overwrites_the_plan(self):
        plan = self.approved_plan()
        self.admin_client.patch("/api/settings/site/", {"analytics": {"plan": {"conversions": []}, "gtmId": "GTM-ABC1234"}}, format="json")
        from .tracking_plan import get_plan
        self.assertEqual(len(get_plan()["conversions"]), len(plan["conversions"]))


# ------------------------------------------------------------------- runtime

class RuntimeConfigTests(TrackingBase):
    def test_config_is_public_and_has_no_audiences(self):
        self.approved_plan()
        r = self.client.get("/api/tracking/config/")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.data["approved"])
        self.assertNotIn("audiences", r.data)
        self.assertEqual(r.data["pageIntents"]["/services/payroll"], "payroll")
        self.assertEqual(r.data["pageTypes"]["/contact"], "contact")
        self.assertIn("cta_click", r.data["vocab"]["events"])
        self.assertNotIn("rationale", json.dumps(r.data))

    def test_draft_plan_sends_no_conversions(self):
        self.scan()
        plan = self.admin_client.post("/api/tracking/plan/build/").data["plan"]
        self.admin_client.put("/api/tracking/plan/", {"plan": plan}, format="json")
        self.assertEqual(self.client.get("/api/tracking/config/").data["conversions"], [])


# ----------------------------------------------------------------- submissions

@override_settings(TRACKING_INLINE_DELIVERY=False, TRACKING_SECRET_KEY=KEY)
class LeadTrackingTests(TrackingBase):
    def submit(self, **extra):
        body = {"name": "Jo Smith", "email": "Jo@Acme.test", "business_type": "Limited company",
                "services": ["Monthly payroll"], "_cms": {"event_id": "evt-12345678", "consent": {"analytics": True, "marketing": True},
                                                          "profile": {"visits": 2, "scores": {"intent": {"vat_returns": 2}, "stage": {"switching": 4}},
                                                                      "first": {"source": "google", "utm": {"source": "google", "medium": "cpc", "campaign": "payroll"}},
                                                                      "vid": "vid-abcdef12"}, "page": "/contact"}}
        body.update(extra)
        return self.client.post("/api/forms/quote/submit/", body, format="json", HTTP_CF_IPCOUNTRY="GB", HTTP_CF_IPCITY="Leicester")

    def test_envelope_is_not_part_of_the_form_data(self):
        self.approved_plan()
        r = self.submit()
        self.assertEqual(r.status_code, 201, r.data)
        sub = FormSubmission.objects.get()
        self.assertNotIn("_cms", sub.data)
        self.assertEqual(sub.event_id, "evt-12345678")
        self.assertEqual(sub.country, "GB")
        self.assertEqual(sub.city, "Leicester")

    def test_server_matches_conversions_and_form_answers_win(self):
        self.approved_plan()
        r = self.submit()
        ids = {c["id"] for c in r.data["conversions"]}
        self.assertEqual(ids, {"lead", "lead_payroll"})
        self.assertEqual(r.data["intent"], "payroll")  # said beats inferred VAT
        self.assertEqual(r.data["segment"], "limited_company")
        self.assertIn("Interest: Monthly Payroll", r.data["summary"])
        self.assertIn("via google / cpc", r.data["summary"])
        self.assertTrue(all(c["event_id"].startswith("evt-12345678:") for c in r.data["conversions"]))
        self.assertEqual(TrackingDaily.objects.get(name="conversion", conversion_id="lead_payroll").count, 1)

    def test_duplicate_submission_is_not_counted_twice(self):
        self.approved_plan()
        self.submit()
        r = self.submit()
        self.assertTrue(r.data.get("duplicate"))
        self.assertEqual(FormSubmission.objects.count(), 1)

    def test_test_flag_needs_a_valid_run_token(self):
        self.approved_plan()
        body = {"_cms": {"event_id": "evt-87654321", "verify": "forged-token"}}
        self.submit(**body)
        self.assertFalse(FormSubmission.objects.get().is_test)

    def test_verified_test_lead_skips_email_and_contacts(self):
        from django.core import mail

        from .tracking_verify import create_run, make_token
        self.approved_plan()
        run = create_run()
        with override_settings(FORM_NOTIFICATION_EMAIL="leads@acme.test"):
            self.submit(_cms={"event_id": "evt-test0001", "verify": make_token(run)})
        sub = FormSubmission.objects.get()
        self.assertTrue(sub.is_test)
        self.assertEqual(len(mail.outbox), 0)
        self.assertEqual(Contact.objects.count(), 0)
        self.assertEqual(TrackingDaily.objects.get(name="conversion", conversion_id="lead").test_count, 1)

    def test_old_kits_without_an_envelope_still_work(self):
        self.approved_plan()
        r = self.client.post("/api/forms/quote/submit/", {"name": "A", "email": "a@acme.test", "business_type": "Other"}, format="json")
        self.assertEqual(r.status_code, 201)
        self.assertTrue(FormSubmission.objects.get().event_id)


# ------------------------------------------------------------------- contacts

@override_settings(TRACKING_INLINE_DELIVERY=False)
class ContactTests(TrackingBase):
    def lead(self, email="jo@acme.test", phone="", **data):
        body = {"name": "Jo", "email": email, "business_type": "Sole trader", "services": ["Quarterly VAT returns"], **data}
        if phone:
            body["phone"] = phone
        cache.clear()
        r = self.client.post("/api/forms/quote/submit/", body, format="json", HTTP_CF_IPCOUNTRY="GB")
        self.assertEqual(r.status_code, 201, r.data)
        return r

    def test_contact_created_and_updated_by_email(self):
        self.approved_plan()
        self.lead(email="Jo@Acme.test")
        FormSubmission.objects.update(created_at=timezone.now() - timedelta(minutes=5))
        self.lead(email="jo@acme.test", services=["Monthly payroll"])
        self.assertEqual(Contact.objects.count(), 1)
        c = Contact.objects.get()
        self.assertEqual(c.email_norm, "jo@acme.test")
        self.assertEqual(set(c.intents), {"vat_returns", "payroll"})
        self.assertEqual(c.segment, "sole_trader")
        self.assertEqual(c.country, "GB")
        self.assertEqual(c.submissions.count(), 2)

    def test_marketing_opt_in_only_when_ticked(self):
        self.lead(email="a@acme.test")
        self.assertFalse(Contact.objects.get(email_norm="a@acme.test").marketing_opt_in)
        self.lead(email="b@acme.test", updates="on")
        b = Contact.objects.get(email_norm="b@acme.test")
        self.assertTrue(b.marketing_opt_in)
        self.assertEqual(b.opt_in_source["label"], "Keep me updated")

    def test_shared_phone_suggests_a_merge_but_never_merges(self):
        self.lead(email="a@acme.test", phone="07700 900111")
        self.lead(email="b@acme.test", phone="+44 7700 900111")
        self.assertEqual(Contact.objects.count(), 2)
        a = Contact.objects.get(email_norm="a@acme.test")
        self.assertEqual(a.phone_e164, "447700900111")
        self.assertEqual(len(a.merge_suggestions), 1)

    def test_erase_removes_everything_and_blocks_recreation(self):
        self.lead(email="gone@acme.test")
        c = Contact.objects.get()
        r = self.admin_client.post(f"/api/contacts/{c.pk}/erase/", {"confirm": "nope"}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.admin_client.post(f"/api/contacts/{c.pk}/erase/", {"confirm": "ERASE"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(Contact.objects.count(), 0)
        self.assertEqual(FormSubmission.objects.count(), 0)
        self.lead(email="gone@acme.test")
        self.assertEqual(Contact.objects.count(), 0)  # tombstone (30 days)

    def test_erasing_one_person_doesnt_block_others_sharing_their_phone(self):
        self.lead(email="one@acme.test", phone="07700 900222")
        self.admin_client.post(f"/api/contacts/{Contact.objects.get().pk}/erase/", {"confirm": "ERASE"}, format="json")
        self.lead(email="two@acme.test", phone="07700 900222")
        self.assertEqual(list(Contact.objects.values_list("email_norm", flat=True)), ["two@acme.test"])

    def test_retention_purge_spares_clients(self):
        self.lead(email="old@acme.test")
        self.lead(email="client@acme.test")
        Contact.objects.update(last_seen=timezone.now() - timedelta(days=900), retain_until=timezone.now() - timedelta(days=1))
        client = Contact.objects.get(email_norm="client@acme.test")
        from .contacts import purge_expired, set_status
        set_status(client, "client")
        self.assertEqual(purge_expired(), 1)
        self.assertEqual(list(Contact.objects.values_list("email_norm", flat=True)), ["client@acme.test"])

    def test_groups_rules_and_opted_in_audience_rows(self):
        self.approved_plan()
        self.lead(email="a@acme.test", updates="on")
        self.lead(email="b@acme.test")
        r = self.admin_client.post("/api/contacts/groups/", {"label": "VAT people", "rule": {"all": [{"field": "intent", "op": "eq", "value": "vat_returns"}]}}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        groups = {g["key"]: g for g in self.admin_client.get("/api/contacts/groups/").data["groups"]}
        self.assertEqual(groups["vat_people"]["size"], 2)
        self.assertEqual(groups["vat_people"]["optedIn"], 1)
        self.assertEqual(groups["auto:segment:sole_trader"]["size"], 2)
        from .contacts import audience_rows
        self.assertEqual(len(audience_rows(ContactGroup.objects.get(key="vat_people").rule)), 1)
        bad = self.admin_client.post("/api/contacts/groups/", {"label": "x", "rule": {"all": [{"field": "password"}]}}, format="json")
        self.assertEqual(bad.status_code, 400)

    def test_contacts_are_admin_only_and_exports_are_logged(self):
        self.lead()
        c = Contact.objects.get()
        for url in ("/api/contacts/", f"/api/contacts/{c.pk}/", "/api/contacts/export/", f"/api/contacts/{c.pk}/export/", "/api/contacts/settings/"):
            self.assertEqual(self.client.get(url).status_code, 401, url)
        csv_text = self.admin_client.get("/api/contacts/export/").content.decode()
        self.assertIn("jo@acme.test", csv_text)
        self.assertNotIn("message", csv_text.splitlines()[0])
        from .models import AdminAuditLog
        self.assertTrue(AdminAuditLog.objects.filter(action="contacts_export").exists())
        self.assertNotIn("contacts", self.client.get("/api/settings/site/").data)

    def test_status_pipeline_and_notes(self):
        self.lead()
        c = Contact.objects.get()
        r = self.admin_client.patch(f"/api/contacts/{c.pk}/", {"status": "contacted", "note": "Called back", "tags": ["vip"]}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        c.refresh_from_db()
        self.assertEqual(c.status, "contacted")
        self.assertEqual(c.notes[0]["text"], "Called back")
        self.assertEqual(self.admin_client.patch(f"/api/contacts/{c.pk}/", {"status": "nonsense"}, format="json").status_code, 400)

    def test_webhook_settings_hide_secrets(self):
        r = self.admin_client.put("/api/contacts/settings/", {"retentionMonths": 12, "webhooks": [{"url": "https://hooks.acme.test/x", "secret": "s3cret"}]}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data["webhooks"][0]["secret"], "…")
        self.assertEqual(self.admin_client.put("/api/contacts/settings/", {"webhooks": [{"url": "http://insecure.test"}]}, format="json").status_code, 400)
        from .contacts import settings_data
        self.assertEqual(settings_data()["webhooks"][0]["secret"], "s3cret")


# --------------------------------------------------------------------- ingest

@override_settings(TRACKING_INLINE_DELIVERY=False)
class IngestTests(TrackingBase):
    def post(self, body, origin=ORIGIN, **extra):
        return self.client.generic("POST", "/api/events/", json.dumps(body), content_type="text/plain", HTTP_ORIGIN=origin, **extra)

    def test_origin_size_and_bots(self):
        ev = {"events": [{"name": "cta_click", "event_id": "e-11111111", "params": {"cta_label": "Book"}}]}
        self.assertEqual(self.post(ev, origin="https://evil.test").status_code, 403)
        self.assertEqual(self.post({"events": [{"name": "x", "event_id": "e" * 20, "params": {"p": "y" * 9000}}]}).status_code, 413)
        self.assertEqual(self.post(ev, HTTP_USER_AGENT="Googlebot/2.1").status_code, 204)
        self.assertFalse(TrackingDaily.objects.exists())

    def test_counts_conversions_once(self):
        self.approved_plan()
        ev = {"events": [{"name": "cta_click", "event_id": "e-22222222", "params": {"cta_label": "Book", "intent": "payroll"},
                          "conversions": ["booking_intent", "lead"]}]}
        self.assertEqual(self.post(ev).status_code, 204)
        self.assertEqual(self.post(ev).status_code, 204)  # replay
        self.assertEqual(TrackingDaily.objects.get(name="conversion", conversion_id="booking_intent").count, 1)
        self.assertFalse(TrackingDaily.objects.filter(conversion_id="lead").exists())  # wrong event for that conversion

    def test_consented_visitor_events_attach_to_their_contact(self):
        self.approved_plan()
        Contact.objects.create(email_norm="jo@acme.test", vid="vid-abcdef12")
        ev = {"events": [{"name": "service_engaged", "event_id": "e-33333333", "params": {"intent": "payroll"}}],
              "consent": {"analytics": True}, "profile": {"vid": "vid-abcdef12"}}
        self.post(ev)
        self.assertEqual(Contact.objects.get().events.count(), 1)
        ev["consent"] = {"analytics": False}
        ev["events"][0]["event_id"] = "e-44444444"
        self.post(ev)
        self.assertEqual(Contact.objects.get().events.count(), 1)

    def test_forget_unlinks_the_visitor(self):
        Contact.objects.create(email_norm="jo@acme.test", vid="vid-abcdef12")
        self.client.generic("POST", "/api/events/forget/", json.dumps({"vid": "vid-abcdef12"}), content_type="text/plain", HTTP_ORIGIN=ORIGIN)
        self.assertEqual(Contact.objects.get().vid, "")


# ------------------------------------------------------------------- dispatch

@override_settings(TRACKING_INLINE_DELIVERY=False, TRACKING_SECRET_KEY=KEY)
class DispatchTests(TrackingBase):
    def connect(self, tool, account, secret):
        from .crypto import encrypt
        TrackingConnection.objects.create(tool=tool, status="connected", account=account, secret=encrypt(secret))

    def lead(self, consent, ga4_loaded=True):
        self.approved_plan()
        cache.clear()
        return self.client.post("/api/forms/quote/submit/", {
            "name": "Jo", "email": "jo@acme.test", "phone": "07700 900111", "business_type": "Limited company", "services": ["Monthly payroll"],
            "_cms": {"event_id": "evt-55555555", "consent": consent, "ga4_loaded": ga4_loaded, "page": "/contact"}}, format="json")

    def test_meta_gets_one_lead_with_every_conversion_and_hashed_ids_only_with_consent(self):
        self.connect("meta", {"pixelId": "123", "adAccountId": "456"}, {"token": "tok"})
        self.lead({"analytics": True, "marketing": True, "ad_user_data": True})
        row = EventOutbox.objects.get()
        self.assertEqual(row.tools_pending, ["meta"])
        sent = []
        with mock.patch("api.tracking_adapters.base.http_json", side_effect=lambda *a, **k: (sent.append((a, k)) or (200, {"events_received": 1}))):
            from .tracking_dispatch import process_due
            process_due()
        self.assertEqual(len(sent), 1)
        body = sent[0][0][2]
        data = body["data"][0]
        self.assertEqual(data["event_name"], "Lead")
        self.assertEqual(data["event_id"], "evt-55555555")
        self.assertEqual(data["custom_data"]["conversions"], "|lead|lead_payroll|")
        self.assertEqual(len(data["user_data"]["em"][0]), 64)
        self.assertNotIn("jo@acme.test", json.dumps(body))
        row.refresh_from_db()
        self.assertEqual(row.status, "done")

    def test_no_marketing_consent_in_uk_eu_means_no_meta_copy(self):
        self.connect("meta", {"pixelId": "123"}, {"token": "tok"})
        self.lead({"analytics": True, "marketing": False})
        self.assertEqual(EventOutbox.objects.get().status, "skipped")

    def test_ga4_server_copy_only_when_the_browser_tag_did_not_load(self):
        self.connect("google", {"propertyId": "1", "measurementId": "G-ABC"}, {"mpSecret": "s"})
        self.lead({"analytics": True}, ga4_loaded=True)
        self.assertEqual(EventOutbox.objects.get().tools_pending, [])
        EventOutbox.objects.all().delete()
        FormSubmission.objects.all().delete()
        Contact.objects.all().delete()
        self.lead({"analytics": True}, ga4_loaded=False)
        self.assertEqual(EventOutbox.objects.get().tools_pending, ["ga4"])

    def test_retries_then_auth_error_flags_the_connection(self):
        from .tracking_adapters.base import AuthError, Transient
        from .tracking_dispatch import process_due
        self.connect("meta", {"pixelId": "123"}, {"token": "tok"})
        self.lead({"marketing": True, "ad_user_data": True})
        with mock.patch("api.tracking_adapters.base.http_json", side_effect=Transient("down")):
            process_due()
        row = EventOutbox.objects.get()
        self.assertEqual((row.status, row.attempts, row.tools_pending), ("pending", 1, ["meta"]))
        with mock.patch("api.tracking_adapters.base.http_json", side_effect=AuthError("expired", 401)):
            process_due(now=timezone.now() + timedelta(minutes=5))
        self.assertEqual(TrackingConnection.objects.get(tool="meta").status, "needs_reauth")
        from .models import TrackingAlert
        self.assertTrue(TrackingAlert.objects.filter(key="reauth:meta").exists())

    def test_test_events_need_a_test_code_and_never_reach_ads(self):
        from .tracking_dispatch import tools_for
        self.connect("meta", {"pixelId": "123"}, {"token": "tok"})
        self.connect("google_ads", {"customerId": "1"}, {"developerToken": "d"})
        tools = tools_for("generate_lead", {}, {"gclid": "x"}, "uk_eu", True, True)
        self.assertIn("meta", tools)
        self.assertNotIn("google_ads", tools)
        from .tracking_adapters import meta
        res = meta.send({"is_test": True, "event_id": "e", "name": "generate_lead"}, {"account": {"pixelId": "1"}, "secret": {"token": "t"}})
        self.assertTrue(res["skipped"])

    def test_old_events_are_dropped(self):
        from .tracking_dispatch import deliver
        self.connect("meta", {"pixelId": "123"}, {"token": "tok"})
        self.lead({"marketing": True})
        row = EventOutbox.objects.get()
        EventOutbox.objects.filter(pk=row.pk).update(created_at=timezone.now() - timedelta(days=8))
        self.assertEqual(deliver(row.pk).status, "dead")

    def test_phone_normalisation(self):
        from .tracking_adapters.base import norm_phone
        self.assertEqual(norm_phone("07700 900111", "GB"), "447700900111")
        self.assertEqual(norm_phone("+1 (415) 555-0100", "GB"), "14155550100")
        self.assertEqual(norm_phone("0044 7700 900111", "GB"), "447700900111")


# ----------------------------------------------------------------- connections / sync

@override_settings(TRACKING_INLINE_DELIVERY=False, TRACKING_SECRET_KEY=KEY)
class ConnectionAndSyncTests(TrackingBase):
    def test_connect_validates_and_never_returns_the_secret(self):
        with mock.patch("api.tracking_adapters.base.http_json", return_value=(200, {"id": "1", "name": "Pixel"})):
            r = self.admin_client.post("/api/tracking/connections/meta/", {"account": {"pixelId": "123", "adAccountId": "456"},
                                                                           "secret": {"token": "EAAtoken-abcdef"}}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        listing = self.admin_client.get("/api/tracking/connections/").data
        self.assertNotIn("EAAtoken", json.dumps(listing, default=str))
        self.assertEqual(listing["connections"]["meta"]["hint"], "…cdef")
        self.assertNotIn("EAAtoken", TrackingConnection.objects.get().secret)

    @override_settings(TRACKING_SECRET_KEY="")
    def test_no_key_no_secrets(self):
        with mock.patch("api.tracking_adapters.base.http_json", return_value=(200, {"id": "1"})):
            r = self.admin_client.post("/api/tracking/connections/meta/", {"account": {"pixelId": "1"}, "secret": {"token": "t" * 20}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("TRACKING_SECRET_KEY", r.data["detail"])

    def test_tool_errors_are_shown_plainly(self):
        from .tracking_adapters.base import Permanent
        with mock.patch("api.tracking_adapters.base.http_json", side_effect=Permanent("Invalid OAuth access token", 400)):
            r = self.admin_client.post("/api/tracking/connections/meta/", {"account": {"pixelId": "1"}, "secret": {"token": "t" * 20}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Invalid OAuth", r.data["detail"])

    def test_meta_sync_creates_updates_archives_and_is_idempotent(self):
        from .crypto import encrypt
        from .tracking_sync import run_sync
        plan = self.approved_plan()
        TrackingConnection.objects.create(tool="meta", status="connected", account={"pixelId": "1", "adAccountId": "2"}, secret=encrypt({"token": "t"}))
        calls = []

        def fake(method, url, body=None, **kw):
            calls.append((method, url, body))
            return 200, {"id": f"r{len(calls)}"}

        with mock.patch("api.tracking_adapters.base.http_json", side_effect=fake):
            first = run_sync()["meta"]
            self.assertGreater(first["created"], 0)
            n = len(calls)
            again = run_sync()["meta"]
            self.assertEqual(again["created"], 0)
            self.assertEqual(len(calls), n)  # nothing to do
            plan["conversions"] = [c for c in plan["conversions"] if c["id"] != "lead_payroll"]
            self.admin_client.put("/api/tracking/plan/", {"plan": plan}, format="json")
            self.admin_client.post("/api/tracking/plan/approve/")
            third = run_sync()["meta"]
        self.assertEqual(third["archived"], 1)
        self.assertEqual(TrackingSyncItem.objects.get(tool="meta", plan_id="lead_payroll").status, "orphaned")
        rule = next(json.loads(b["rule"]) for m, u, b in calls if b and "customconversions" in u)
        self.assertIn({"conversions": {"i_contains": "|lead|"}}, rule["and"])

    def test_refusals_are_recorded_not_retried_forever(self):
        from .crypto import encrypt
        from .tracking_adapters.base import Permanent
        from .tracking_sync import run_sync
        self.approved_plan()
        TrackingConnection.objects.create(tool="meta", status="connected", account={"pixelId": "1", "adAccountId": "2"}, secret=encrypt({"token": "t"}))
        with mock.patch("api.tracking_adapters.base.http_json", side_effect=Permanent("Audience not allowed for special ad category", 400)):
            run_sync()
        self.assertTrue(TrackingSyncItem.objects.filter(tool="meta", status="refused").exists())

    def test_keep_theirs_stops_managing_an_item(self):
        item = TrackingSyncItem.objects.create(tool="meta", kind="custom_conversion", plan_id="lead", remote_id="9", status="in_sync")
        self.admin_client.post(f"/api/tracking/sync/items/{item.pk}/", {"action": "keep_theirs"}, format="json")
        item.refresh_from_db()
        self.assertEqual(item.status, "unmanaged")

    def test_gtm_container_export(self):
        self.approved_plan()
        r = self.admin_client.get("/api/tracking/gtm/")
        data = json.loads(r.content)
        self.assertEqual(data["exportFormatVersion"], 2)
        names = {t["name"] for t in data["containerVersion"]["tag"]}
        self.assertIn("CMS - GA4 events", names)

    def test_google_service_account_jwt_is_signed(self):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        from .tracking_adapters.google_auth import signed_jwt
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
        jwt = signed_jwt({"client_email": "sa@p.iam.gserviceaccount.com", "private_key": pem}, ["s1"], now=1000)
        self.assertEqual(jwt.count("."), 2)


# ----------------------------------------------------------------- verification

@override_settings(TRACKING_INLINE_DELIVERY=False)
class VerificationTests(TrackingBase):
    def test_runs_compile_tests_and_take_results_by_token(self):
        self.approved_plan()
        r = self.admin_client.post("/api/tracking/verify/runs/", {}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        tests = {t["conversion"]: t for t in r.data["tests"]}
        self.assertEqual(tests["lead"]["page"], "/contact")
        self.assertEqual(tests["booking_intent"]["action"], "click_cta")
        self.assertEqual(tests["pricing_seen"]["args"]["block"], "services-pricing")
        url = f"/api/tracking/verify/runs/{r.data['id']}/results/"
        self.assertEqual(self.client.post(url, {"results": []}, format="json").status_code, 403)
        results = [{"conversion": cid, "step": "trigger", "status": "ok"} for cid in tests] + \
                  [{"conversion": "lead", "step": "sent", "tool": "ga4", "status": "fail", "detail": "no cv_lead event"}]
        res = self.client.post(url, {"results": results, "done": True}, format="json", HTTP_X_CMS_VERIFY=r.data["token"])
        self.assertEqual(res.status_code, 200, res.data)
        run = VerificationRun.objects.get()
        self.assertEqual(run.status, "failed")
        self.assertEqual(run.summary["failing"], ["lead"])
        self.assertEqual(self.client.post(url, {"results": []}, format="json", HTTP_X_CMS_VERIFY=r.data["token"]).status_code, 403)

    def test_unplaceable_tests_say_why(self):
        from .tracking_plan import compile_tests
        plan = {"stages": [], "intents": [], "conversions": [{"id": "x", "label": "X", "tier": "secondary", "enabled": True,
                                                              "trigger": {"event": "section_view", "where": {"blocks": ["gone"]}}}]}
        t = compile_tests(plan, {"pages": [], "blocks": {}})[0]
        self.assertIn("isn't on any scanned page", t["error"])

    def test_static_check_alerts_after_a_breaking_edit(self):
        from .models import TrackingAlert
        from .tracking_verify import static_check
        self.approved_plan()
        row = ComponentData.objects.get(name="form-quote")
        row.data["fields"][4]["options"] = ["Payroll", "Quarterly VAT returns"]
        row.save()
        res = static_check()
        self.assertTrue(res["dangling"])
        self.assertTrue(TrackingAlert.objects.filter(key="dangling", resolved_at__isnull=True).exists())

    def test_anomalies_ignore_low_traffic(self):
        from .tracking_verify import anomalies
        today = timezone.localdate()
        for i in range(3, 17):
            TrackingDaily.objects.create(date=today - timedelta(days=i), name="conversion", conversion_id="busy", count=5)
            TrackingDaily.objects.create(date=today - timedelta(days=i), name="conversion", conversion_id="rare", count=1 if i % 5 == 0 else 0)
        found = {a["conversion"] for a in anomalies(today)}
        self.assertIn("busy", found)
        self.assertNotIn("rare", found)

    def test_runner_endpoint_needs_the_shared_secret(self):
        self.assertEqual(self.client.get("/api/tracking/verify/pending/").status_code, 403)
        with override_settings(REVALIDATE_SECRET="shh"):
            self.approved_plan()
            r = self.client.get("/api/tracking/verify/pending/?schedule=1", HTTP_X_CMS_RUNNER="shh")
            self.assertTrue(r.data["run"]["token"])


# ----------------------------------------------------------------- launch / AI

class LaunchAndAiTests(TrackingBase):
    def test_launch_check_reports_tracking_state(self):
        from .launch_check import run_launch_check
        ids = {i["id"]: i for i in run_launch_check()["items"]}
        self.assertEqual(ids["tracking-plan"]["level"], "warning")
        self.approved_plan()
        ids = {i["id"]: i for i in run_launch_check()["items"]}
        self.assertIn("tracking-checks", ids)
        self.assertNotIn("tracking-plan", ids)

    @override_settings(TRACKING_SECRET_KEY="")
    def test_connections_without_a_key_block_launch(self):
        from .launch_check import run_launch_check
        TrackingConnection.objects.create(tool="meta", status="connected", secret="x")
        ids = {i["id"]: i for i in run_launch_check()["items"]}
        self.assertEqual(ids["tracking-key"]["level"], "blocker")

    def test_prompt_ends_with_a_final_check_and_lists_only_facts(self):
        self.scan()
        r = self.admin_client.post("/api/ai/tracking-plan/prompt/")
        self.assertEqual(r.status_code, 200)
        prompt = r.data["prompt"]
        self.assertIn("FINAL CHECK", prompt.split("\n")[-8:][0] + "\n".join(prompt.split("\n")[-10:]))
        self.assertIn("services-pricing", prompt)

    def test_apply_drops_dangling_items_and_refuses_data_loss(self):
        plan = self.approved_plan()
        reply = {k: plan[k] for k in ("intents", "segments", "stages", "audiences")}
        reply["conversions"] = plan["conversions"] + [{"id": "ghost", "label": "Ghost", "tier": "primary",
                                                        "trigger": {"event": "generate_lead", "where": {"form": "nope"}}}]
        r = self.admin_client.post("/api/ai/tracking-plan/apply/", {"raw": "```json\n" + json.dumps(reply) + "\n```"}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertIn("conversions: ghost", r.data["dropped"])
        self.assertNotIn("ghost", {c["id"] for c in r.data["plan"]["conversions"]})
        tiny = {"intents": [], "conversions": plan["conversions"][:1]}
        r = self.admin_client.post("/api/ai/tracking-plan/apply/", {"raw": json.dumps(tiny)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("replace plan", r.data["detail"])


class MarketingOptInFieldTests(APITestCase):
    def test_opt_in_is_never_required_and_is_boolean(self):
        from .form_validation import validate_submission
        definition = {"fields": [{"name": "updates", "type": "consent_marketing", "required": True}]}
        cleaned, errors = validate_submission(definition, {})
        self.assertEqual(errors, {})
        self.assertIs(cleaned["updates"], False)
        self.assertIs(validate_submission(definition, {"updates": "on"})[0]["updates"], True)
