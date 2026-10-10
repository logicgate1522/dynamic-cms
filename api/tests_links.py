"""Internal-link audit (R34): api/link_audit.py, its endpoints, the launch
check, inline links in body copy and the AI prompts' INTERNAL LINKS block."""

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from .models import PageSEO, Redirect, SiteSettings, TrackingScan

User = get_user_model()


def page(path, links=(), text="", title=None, h1=""):
    return {"path": path, "title": title or f"{path.strip('/') or 'Home'} | Acme", "h1": h1, "text": text,
            "links": [{"to": to, "text": label, "area": area, "rel": rel} for to, label, area, *rest in links
                      for rel in [rest[0] if rest else ""]]}


NAV = [("/", "Home", "header"), ("/services", "Services", "header"), ("/blog", "Blog", "header"), ("/contact", "Contact", "footer"), ("/privacy", "Privacy", "footer")]


def good_site():
    """A small, well-linked site: every rule satisfied."""
    return {"pages": [
        page("/", NAV + [("/services/payroll", "Payroll services", "main"), ("/services/vat", "VAT returns", "main"),
                         ("/blog/payroll-guide", "Payroll guide for small businesses", "main")]),
        page("/services", NAV + [("/services/payroll", "Payroll services", "main"), ("/services/vat", "VAT returns", "main")]),
        page("/services/payroll", NAV + [("/blog/payroll-guide", "Payroll guide for small businesses", "main"),
                                         ("/contact", "Book a call", "main")], text="Monthly payroll for small firms."),
        page("/services/vat", NAV + [("/blog/vat-guide", "VAT guide", "main"), ("/contact", "Book a call", "main")]),
        page("/blog", NAV + [("/blog/payroll-guide", "Payroll guide for small businesses", "main"), ("/blog/vat-guide", "VAT guide", "main")]),
        page("/blog/payroll-guide", NAV + [("/services/payroll", "Payroll services", "main")],
             text="Running payroll yourself? Our VAT returns help too."),
        page("/blog/vat-guide", NAV + [("/services/vat", "VAT returns", "main")]),
        page("/contact", NAV + [("/services", "Our services", "main")]),
        page("/privacy", NAV),
    ]}


KEYWORDS = {"home": "small business accountants", "services": "accounting services", "services/payroll": "payroll services",
            "services/vat": "VAT returns", "blog": "accounting guides", "blog/payroll-guide": "payroll guide for small businesses",
            "blog/vat-guide": "VAT guide", "contact": "contact an accountant"}


def set_keywords():
    for path, kw in KEYWORDS.items():
        PageSEO.objects.update_or_create(path=path, defaults={"data": {"keywords": {"primary": kw}}})


class LinkAuditTests(APITestCase):
    def setUp(self):
        self.admin = User.objects.create_user(username="admin", password="pass1234", is_staff=True)
        self.client.force_authenticate(user=self.admin)
        SiteSettings.objects.update_or_create(pk=1, defaults={"data": {
            "organization": {"name": "Acme"},
            "collections": {
                "services": {"label": "Service", "hostKind": "content", "indexPath": "services", "pathPrefix": "services", "pageType": "service"},
                "articles": {"label": "Article", "hostKind": "blog", "indexPath": "blog", "pathPrefix": "blog"},
            }}})
        PageSEO.objects.create(path="privacy", data={})
        set_keywords()

    def analyze(self, scan):
        r = self.client.post("/api/seo/links/analyze/", scan, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        return r.data

    def ids(self, result, level=None):
        return sorted({(i["id"], i["path"]) for i in result["issues"] if level in (None, i["level"])})

    def test_a_well_linked_site_has_no_failures(self):
        result = self.analyze(good_site())
        self.assertEqual(self.ids(result, "fail"), [])
        self.assertEqual(result["summary"]["pages"], 9)
        row = next(p for p in result["pages"] if p["path"] == "/services/payroll")
        self.assertTrue(row["offering"])
        self.assertEqual(row["depth"], 1)
        self.assertEqual(row["contextualInbound"], 3)  # home, index, guide

    def test_orphan_and_unreachable(self):
        scan = good_site()
        scan["pages"].append(page("/lonely"))
        scan["pages"].append(page("/island-a", [("/island-b", "Island B guide", "main")]))
        scan["pages"].append(page("/island-b", [("/island-a", "Island A guide", "main")]))
        ids = self.ids(self.analyze(scan), "fail")
        self.assertIn(("orphan", "/lonely"), ids)
        self.assertIn(("unreachable", "/island-a"), ids)
        self.assertIn(("unreachable", "/island-b"), ids)

    def test_too_deep(self):
        scan = good_site()
        chain = ["/a", "/a/b", "/a/b/c", "/a/b/c/d"]
        scan["pages"][0]["links"].append({"to": chain[0], "text": "Section A overview", "area": "main", "rel": ""})
        for here, nxt in zip(chain, chain[1:] + [None]):
            scan["pages"].append(page(here, [(nxt, f"Next: {nxt}", "main")] if nxt else []))
        ids = self.ids(self.analyze(scan), "fail")
        self.assertIn(("too-deep", "/a/b/c/d"), ids)
        self.assertNotIn(("too-deep", "/a/b/c"), ids)

    def test_menus_dont_count_as_context(self):
        scan = good_site()
        # Only the header links to /services/vat now.
        for p in scan["pages"]:
            p["links"] = [l for l in p["links"] if not (l["to"] == "/services/vat" and l["area"] == "main")]
            if p["path"] == "/":
                p["links"].append({"to": "/services/vat", "text": "VAT returns", "area": "header", "rel": ""})
        result = self.analyze(scan)
        self.assertIn(("offering-few-links", "/services/vat"), self.ids(result, "fail"))
        self.assertIn(("article-to-offering", "/blog/vat-guide"), self.ids(result, "fail"))

    def test_offering_needs_two_content_links_and_an_article(self):
        scan = good_site()
        scan["pages"][0]["links"] = [l for l in scan["pages"][0]["links"] if l["to"] != "/services/payroll"]
        for p in scan["pages"]:
            if p["path"] == "/blog/payroll-guide":
                p["links"] = [l for l in p["links"] if l["to"] != "/services/payroll"]
            if p["path"] == "/services/payroll":
                p["links"] = [l for l in p["links"] if l["to"] != "/blog/payroll-guide"]
        ids = self.ids(self.analyze(scan), "fail")
        self.assertIn(("offering-few-links", "/services/payroll"), ids)
        self.assertIn(("offering-to-article", "/services/payroll"), ids)
        self.assertIn(("article-to-offering", "/blog/payroll-guide"), ids)

    def test_article_nobody_links_from_content(self):
        scan = good_site()
        scan["pages"].append(page("/blog/new-post", [("/services/vat", "VAT returns", "main")]))
        scan["pages"][0]["links"].append({"to": "/blog/new-post", "text": "New post", "area": "footer", "rel": ""})
        self.assertIn(("article-no-links", "/blog/new-post"), self.ids(self.analyze(scan), "fail"))

    def test_anchor_text(self):
        scan = good_site()
        home = scan["pages"][0]
        home["links"] += [{"to": "/contact", "text": "Read more →", "area": "main", "rel": ""},
                          {"to": "/services", "text": "", "area": "main", "rel": ""},
                          {"to": "/blog", "text": "Click here", "area": "footer", "rel": ""}]  # menus aren't judged
        ids = self.ids(self.analyze(scan), "fail")
        self.assertIn(("generic-anchor", "/"), ids)
        self.assertIn(("empty-anchor", "/"), ids)
        # An aria-label that names the page is what the scan sends as text: fine.
        home["links"] = [l for l in home["links"] if l["text"] not in ("Read more →", "")]
        home["links"].append({"to": "/contact", "text": "Book a free call", "area": "main", "rel": ""})
        self.assertEqual(self.ids(self.analyze(scan), "fail"), [])

    def test_one_anchor_for_two_pages_is_a_warning(self):
        scan = good_site()
        scan["pages"][0]["links"].append({"to": "/services/vat", "text": "Payroll services", "area": "main", "rel": ""})
        result = self.analyze(scan)
        self.assertTrue(any(i["id"] == "mixed-anchor" and i["level"] == "warn" for i in result["issues"]))

    def test_redirected_and_nofollow_links(self):
        Redirect.objects.create(source="/old-payroll", destination="/services/payroll")
        scan = good_site()
        scan["pages"][0]["links"] += [{"to": "/old-payroll", "text": "Payroll help", "area": "main", "rel": ""},
                                      {"to": "/contact", "text": "Contact our team", "area": "main", "rel": "nofollow"}]
        result = self.analyze(scan)
        ids = self.ids(result, "fail")
        self.assertIn(("redirected-link", "/"), ids)
        self.assertIn(("nofollow-internal", "/"), ids)
        fix = next(i["fix"] for i in result["issues"] if i["id"] == "redirected-link")
        self.assertIn("/services/payroll", fix)

    def test_suggestions_come_from_the_copy(self):
        result = self.analyze(good_site())
        # The payroll guide mentions "VAT returns" without linking it.
        self.assertIn({"from": "/blog/payroll-guide", "to": "/services/vat", "anchor": "VAT returns"},
                      [{k: s[k] for k in ("from", "to", "anchor")} for s in result["suggestions"]])
        self.assertFalse([s for s in result["suggestions"] if s["from"] == s["to"]])
        self.assertFalse([s for s in result["suggestions"] if s["to"] in ("/", "/privacy")])

    def test_staff_login_link_is_not_judged_and_repeats_report_once(self):
        scan = good_site()
        for p in scan["pages"]:
            p["links"].append({"to": "/admin/login", "text": "Staff login", "area": "footer", "rel": "nofollow"})
        home = scan["pages"][0]
        home["links"] += [{"to": "/contact", "text": "Learn more", "area": "main", "rel": ""}] * 2  # mobile + desktop twins
        result = self.analyze(scan)
        self.assertFalse([i for i in result["issues"] if "/admin" in i["text"]])
        self.assertEqual(len([i for i in result["issues"] if i["id"] == "generic-anchor"]), 1)

    def test_suggestions_use_the_core_of_a_long_title(self):
        scan = good_site()
        for p in scan["pages"]:
            if p["path"] == "/services/vat":
                p["title"] = "Quarterly VAT Returns for Small Businesses | Acme"
            if p["path"] == "/blog/payroll-guide":
                p["text"] = "When your VAT returns are due, payroll gets busy too."
        result = self.analyze(scan)
        self.assertIn(("/blog/payroll-guide", "/services/vat", "VAT returns"),
                      [(x["from"], x["to"], x["anchor"]) for x in result["suggestions"]])

    def test_the_brand_is_never_a_suggested_anchor(self):
        PageSEO.objects.update_or_create(path="about", defaults={"data": {"keywords": {"primary": "Acme Ltd"}}})
        SiteSettings.objects.filter(pk=1).update(data={**SiteSettings.objects.get(pk=1).data, "organization": {"name": "Acme Ltd"}})
        scan = good_site()
        scan["pages"].append(page("/about", text="", title="About | Acme Ltd"))
        scan["pages"][0]["links"].append({"to": "/about", "text": "About Acme Ltd", "area": "main", "rel": ""})
        for p in scan["pages"]:
            p["text"] = (p.get("text") or "") + " Acme Ltd helps."
        self.assertFalse([x for x in self.analyze(scan)["suggestions"] if x["to"] == "/about"])

    def test_every_page_needs_its_own_keyword(self):
        PageSEO.objects.filter(path="services/payroll").update(data={})
        PageSEO.objects.filter(path="blog/vat-guide").update(data={"keywords": {"primary": "vat  RETURNS"}})
        result = self.analyze(good_site())
        ids = self.ids(result, "fail")
        self.assertIn(("no-keyword", "/services/payroll"), ids)
        self.assertIn(("shared-keyword", "/blog/vat-guide, /services/vat"), ids)
        self.assertNotIn(("no-keyword", "/privacy"), ids)  # legal pages don't rank for anything
        self.assertTrue(all(i["kind"] == "keywords" for i in result["issues"] if i["id"].endswith("keyword")))

    def test_endpoints_are_admin_only_and_validate(self):
        self.assertEqual(self.client.post("/api/seo/links/analyze/", {"nope": 1}, format="json").status_code, 400)
        self.client.force_authenticate(user=None)
        self.assertIn(self.client.get("/api/seo/links/").status_code, (401, 403))
        self.assertIn(self.client.post("/api/seo/links/analyze/", good_site(), format="json").status_code, (401, 403))

    def test_stored_scan_report_and_launch_check(self):
        items = {i["id"] for i in self.client.get("/api/launch-check/").data["items"]}
        self.assertIn("internal-links-unscanned", items)
        self.assertEqual(self.client.get("/api/seo/links/").data["scanned"], False)
        scan = good_site()
        scan["pages"].append(page("/lonely"))
        PageSEO.objects.create(path="lonely", data={"keywords": {"primary": "lonely page"}})
        r = self.client.post("/api/tracking/scan/", scan, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        self.assertIn("links", TrackingScan.objects.get().data["pages"][0])
        report = self.client.get("/api/seo/links/").data
        self.assertEqual(report["summary"]["fail"], 1)
        self.assertIsNotNone(report["scannedAt"])
        items = {i["id"]: i for i in self.client.get("/api/launch-check/").data["items"]}
        self.assertNotIn("internal-links-unscanned", items)
        self.assertIn("/lonely", items["internal-links"]["detail"])

    def test_scan_is_bounded(self):
        from .site_facts import clean_scan
        huge = {"pages": [{"path": "/x", "text": "w " * 10000, "links": [{"to": f"/p{i}", "text": "t" * 500, "area": "weird"} for i in range(500)]}]}
        cleaned = clean_scan(huge)["pages"][0]
        self.assertEqual(len(cleaned["links"]), 300)
        self.assertEqual(len(cleaned["links"][0]["text"]), 120)
        self.assertEqual(cleaned["links"][0]["area"], "main")
        self.assertLessEqual(len(cleaned["text"]), 6000)
        self.assertNotIn("links", clean_scan({"pages": [{"path": "/y"}]})["pages"][0])  # old scans stay link-less


class InlineLinkTests(APITestCase):
    def test_normalize_keeps_internal_links_only_in_body_copy(self):
        from .ai_normalize import strip_markdown_links
        out = strip_markdown_links({
            "heading": "See [payroll](/services/payroll)",
            "content": "Our [payroll service](/services/payroll) and [HMRC](https://www.gov.uk) and [x](//evil.test/a).",
            "items": [{"content": "Read the [VAT guide](/blog/vat-guide)."}],
            "button_href": "[/contact](/contact)",
        })
        self.assertEqual(out["heading"], "See payroll")
        self.assertEqual(out["content"], "Our [payroll service](/services/payroll) and HMRC and x.")
        self.assertEqual(out["items"][0]["content"], "Read the [VAT guide](/blog/vat-guide).")
        self.assertEqual(out["button_href"], "/contact")

    def test_prompts_list_link_targets_and_missing_links(self):
        from . import prompts
        admin = User.objects.create_user(username="a2", password="pass1234", is_staff=True)
        self.client.force_authenticate(user=admin)
        SiteSettings.objects.update_or_create(pk=1, defaults={"data": {"organization": {"name": "Acme"}, "collections": {
            "services": {"label": "Service", "hostKind": "content", "indexPath": "services", "pathPrefix": "services", "pageType": "service"},
            "articles": {"label": "Article", "hostKind": "blog", "indexPath": "blog", "pathPrefix": "blog"}}}})
        self.assertEqual(prompts.link_block("blog/payroll-guide"), "")  # never scanned: nothing invented
        set_keywords()
        self.client.post("/api/tracking/scan/", good_site(), format="json")
        block = prompts.link_block("blog/payroll-guide")
        self.assertIn("/services/vat — ", block)
        self.assertIn("[VAT returns](/services/vat)", block)
        self.assertNotIn("/blog/payroll-guide — ", block)  # never itself
        prompt, _ = prompts.page_assist_prompt(path="blog/payroll-guide", sections={"b": {"label": "Body", "content": {"content": "x"}}})
        self.assertIn("INTERNAL LINKS", prompt)
        self.assertIn("[anchor words](/path)", prompt)
