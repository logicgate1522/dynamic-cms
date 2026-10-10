"""A tracking plan must cover what the site has (R31), and articles must be
filed under the site's own categories (R28). Both are enforced by the launch
check and site-audit; these tests pin the backend halves."""

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from .models import BlogPost, ComponentData, SiteSettings
from .tests_tracking import TrackingBase

User = get_user_model()


class PlanCompletenessTests(TrackingBase):
    def gaps(self):
        return self.admin_client.get("/api/tracking/plan/").data["report"]["gaps"]

    def test_empty_plan_lists_everything_the_site_has(self):
        self.scan()
        from .site_facts import get_facts
        from .tracking_plan import completeness, empty_plan
        gaps = completeness(empty_plan(), get_facts())
        text = " | ".join(gaps)
        self.assertIn("lead form “quote” has no primary generate_lead conversion", text)
        self.assertIn("offering page /services/payroll has no intent", text)
        self.assertIn("offering page /services/vat-returns has no intent", text)
        self.assertIn("booking/contact page /contact has no cta_click conversion", text)
        self.assertIn("“Limited company” (quote.business_type) has no segment", text)
        self.assertIn("“Sole trader” (quote.business_type) has no segment", text)
        self.assertNotIn("Other", text)  # "Other" is never a segment

    def test_library_plan_is_complete(self):
        self.approved_plan()
        self.assertEqual(self.gaps(), [])

    def test_removing_coverage_opens_a_gap(self):
        plan = self.approved_plan()
        plan["intents"] = [i for i in plan["intents"] if "/services/payroll" not in i["match"].get("paths", [])]
        plan["conversions"] = [c for c in plan["conversions"]
                               if c["trigger"]["event"] != "service_engaged" and c["trigger"]["where"].get("intent") != "payroll"
                               and c["trigger"]["event"] != "cta_click"]
        for c in plan["conversions"]:
            if c["trigger"]["event"] == "generate_lead":
                c["enabled"] = False  # a disabled conversion covers nothing
        plan["segments"] = [s for s in plan["segments"] if s["id"] != "sole_trader"]
        r = self.admin_client.put("/api/tracking/plan/", {"plan": plan}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        gaps = " | ".join(r.data["report"]["gaps"])
        self.assertIn("/services/payroll has no intent", gaps)
        self.assertIn("/contact has no cta_click", gaps)
        self.assertIn("“quote” has no primary generate_lead", gaps)
        self.assertIn("“Sole trader”", gaps)
        self.assertNotIn("vat-returns", gaps)

    def test_path_prefix_intent_covers_its_pages(self):
        self.scan()
        from .site_facts import get_facts
        from .tracking_plan import completeness, empty_plan
        plan = empty_plan()
        plan["intents"] = [{"id": "all", "label": "All", "match": {"paths": [], "pathPrefixes": ["/services"]}}]
        self.assertFalse([g for g in completeness(plan, get_facts()) if "has no intent" in g])

    def test_launch_check_reports_an_incomplete_approved_plan(self):
        from .tracking_plan import get_plan, save_plan
        self.approved_plan()
        plan = get_plan()
        plan["segments"] = []
        save_plan(plan)
        items = {i["id"]: i for i in self.admin_client.get("/api/launch-check/").data["items"]}
        self.assertIn("tracking-incomplete", items)
        self.assertIn("has no segment", items["tracking-incomplete"]["detail"])

    def test_same_option_on_two_forms_maps_one_segment_to_both(self):
        ComponentData.objects.create(name="form-callback", data={"fields": [
            {"name": "email", "type": "email", "label": "Email", "required": True},
            {"name": "business_type", "type": "select", "label": "Business type", "options": ["Sole trader"]}]})
        self.approved_plan()
        seg = next(s for s in self.admin_client.get("/api/tracking/plan/").data["plan"]["segments"] if s["id"] == "sole_trader")
        self.assertEqual({fo["form"] for fo in seg["match"]["formOptions"]}, {"quote", "callback"})
        self.assertEqual(self.gaps(), [])


class VerificationProvesLeadFormsTests(TrackingBase):
    def test_full_run_with_no_tests_fails(self):
        from .tracking_verify import create_run, finalise
        self.approved_plan()
        run = create_run()
        run.tests = []
        run.save()
        finalise(run)
        self.assertEqual(run.status, "failed")
        self.assertIn("no conversions were tested", run.summary["missing"])

    def test_full_run_must_prove_each_lead_form(self):
        from .tracking_verify import create_run, finalise, record_results
        self.approved_plan()
        run = create_run()
        others = [t["conversion"] for t in run.tests if not t["conversion"].startswith("lead")]
        record_results(run, {"results": [{"conversion": c, "step": "trigger", "status": "ok"} for c in others]})
        finalise(run)
        self.assertEqual(run.status, "failed")
        self.assertIn("lead form “quote”: no lead conversion was tested", run.summary["missing"])

    def test_full_run_passes_when_a_lead_conversion_fired(self):
        from .tracking_verify import create_run, finalise, record_results
        self.approved_plan()
        run = create_run()
        record_results(run, {"results": [{"conversion": t["conversion"], "step": "trigger", "status": "ok"} for t in run.tests]})
        finalise(run)
        self.assertEqual(run.summary["missing"], [])
        self.assertEqual(run.status, "passed", run.summary)

    def test_scoped_rerun_is_not_held_to_every_form(self):
        from .tracking_verify import create_run, finalise, record_results
        self.approved_plan()
        run = create_run(scope=["booking_intent"])
        record_results(run, {"results": [{"conversion": "booking_intent", "step": "trigger", "status": "ok"}]})
        finalise(run)
        self.assertEqual(run.status, "passed", run.summary)


class ArticleCategoryTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass1234", is_staff=True)
        self.client.force_authenticate(user=self.admin)

    def settings(self, options=None, blog=True):
        cols = {}
        if blog:
            fields = {} if options is None else {"category": {"label": "Category", "options": options}}
            cols["articles"] = {"label": "Article", "hostKind": "blog", "pathPrefix": "blog", "fields": fields}
        SiteSettings.objects.update_or_create(pk=1, defaults={"data": {"collections": cols}})

    def post(self, slug, category, status="published"):
        BlogPost.objects.create(slug=slug, title=slug, status=status, content={"category": category})

    def issues(self):
        from .site_collections import category_issues
        return [i["id"] for i in category_issues()]

    def launch_item(self):
        return next((i for i in self.client.get("/api/launch-check/").data["items"] if i["id"] == "article-categories"), None)

    def test_no_articles_no_issue(self):
        self.settings(None)
        self.assertEqual(self.issues(), [])

    def test_articles_without_a_blog_collection(self):
        self.settings(blog=False)
        self.post("a", "Tax")
        self.assertEqual(self.issues(), ["no-collection"])
        self.assertEqual(self.launch_item()["level"], "blocker")

    def test_missing_list(self):
        self.settings(None)
        self.post("a", "Tax")
        self.assertEqual(self.issues(), ["missing"])

    def test_kit_placeholders(self):
        for options in (["News", "Guides", "Updates"], ["guides", "news"]):
            self.settings(options)
            BlogPost.objects.all().delete()
            self.post("a", options[0])
            self.assertEqual(self.issues(), ["placeholder"], options)
        self.assertEqual(self.launch_item()["level"], "blocker")

    def test_published_article_outside_the_list(self):
        self.settings(["VAT", "Payroll"])
        self.post("a", "VAT")
        self.post("b", "Marketing")
        self.post("c", "")
        self.post("d", "Whatever", status="draft")  # drafts aren't filed yet
        self.assertEqual(self.issues(), ["unlisted", "unlisted"])
        item = self.launch_item()
        self.assertEqual(item["level"], "warning")
        self.assertIn("Marketing", item["detail"])

    def test_real_list_used_by_every_article(self):
        self.settings(["VAT", "Payroll", "News"])  # "News" alongside real topics is fine
        self.post("a", "VAT")
        self.post("b", "News")
        self.assertEqual(self.issues(), [])
        self.assertIsNone(self.launch_item())
