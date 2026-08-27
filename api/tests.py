from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from datetime import timedelta

from rest_framework import status
from rest_framework.test import APITestCase

from rest_framework.authtoken.models import Token

from .models import (
    BlogPost,
    ComponentData,
    ContentPage,
    DynamicSection,
    PageSEO,
    Redirect,
    SiteSettings,
)

User = get_user_model()


class AdminAuthMixin:
    """Gives every test case an authenticated-admin client and a plain
    anonymous client, matching the two personas every endpoint actually
    has to support."""

    def setUp(self):
        super().setUp()
        cache.clear()  # throttle counters live in cache; don't leak between tests
        self.admin = User.objects.create_user(
            username="admin", password="pass1234", is_staff=True
        )
        self.admin_client = self.client_class()
        self.admin_client.force_authenticate(user=self.admin)


# ==================== Admin login ====================
# Self-contained login introduced when coreauth's social-login/JWT stack was
# removed — this pins the exact contract the frontend's login page depends
# on: POST {email, password} -> {"key": "<token>"}.

class AdminLoginTests(APITestCase):
    def setUp(self):
        cache.clear()
        self.staff = User.objects.create_user(
            username="staffmember", email="staff@example.com",
            password="correct-horse", is_staff=True,
        )
        self.non_staff = User.objects.create_user(
            username="regularjoe", email="joe@example.com",
            password="correct-horse", is_staff=False,
        )

    def test_valid_staff_login_returns_a_token_under_key(self):
        response = self.client.post(
            "/api/auth/login/",
            {"email": "staff@example.com", "password": "correct-horse"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn("key", response.data)
        self.assertEqual(response.data["key"], Token.objects.get(user=self.staff).key)

    def test_login_is_case_insensitive_on_email(self):
        response = self.client.post(
            "/api/auth/login/",
            {"email": "STAFF@EXAMPLE.COM", "password": "correct-horse"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_wrong_password_is_rejected(self):
        response = self.client.post(
            "/api/auth/login/",
            {"email": "staff@example.com", "password": "wrong"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_unknown_email_is_rejected(self):
        response = self.client.post(
            "/api/auth/login/",
            {"email": "nobody@example.com", "password": "whatever"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_staff_account_is_rejected_even_with_correct_password(self):
        response = self.client.post(
            "/api/auth/login/",
            {"email": "joe@example.com", "password": "correct-horse"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_missing_fields_return_400(self):
        response = self.client.post("/api/auth/login/", {}, format="json")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_token_is_stable_across_repeated_logins(self):
        first = self.client.post(
            "/api/auth/login/",
            {"email": "staff@example.com", "password": "correct-horse"},
            format="json",
        ).data["key"]
        second = self.client.post(
            "/api/auth/login/",
            {"email": "staff@example.com", "password": "correct-horse"},
            format="json",
        ).data["key"]
        self.assertEqual(first, second)


# ==================== ComponentData ====================

class ComponentDataTests(AdminAuthMixin, APITestCase):
    def test_get_unseeded_name_returns_empty_200_not_404(self):
        response = self.client.get("/api/home/never-created/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, {})

    def test_patch_without_auth_is_rejected(self):
        response = self.client.patch(
            "/api/home/footer/", {"title": "x"}, format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_patch_upserts_a_row_that_did_not_exist(self):
        self.assertFalse(ComponentData.objects.filter(name="hero").exists())
        response = self.admin_client.patch(
            "/api/home/hero/", {"title": "Welcome"}, format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, {"title": "Welcome"})
        self.assertTrue(ComponentData.objects.filter(name="hero").exists())

    def test_patch_deep_merges_nested_dicts_instead_of_clobbering(self):
        ComponentData.objects.create(
            name="cta",
            data={"title": "Book now", "style": {"color": "red", "size": "lg"}},
        )
        response = self.admin_client.patch(
            "/api/home/cta/", {"style": {"color": "blue"}}, format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        # color updated, but `size` — a sibling key one level down — must survive
        self.assertEqual(response.data["style"], {"color": "blue", "size": "lg"})
        self.assertEqual(response.data["title"], "Book now")

    def test_patch_replaces_lists_wholesale_by_design(self):
        ComponentData.objects.create(name="gallery", data={"images": ["a", "b", "c"]})
        response = self.admin_client.patch(
            "/api/home/gallery/", {"images": ["x"]}, format="json"
        )
        self.assertEqual(response.data["images"], ["x"])

    def test_delete_requires_admin(self):
        ComponentData.objects.create(name="temp", data={})
        response = self.client.delete("/api/home/temp/")
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        response = self.admin_client.delete("/api/home/temp/")
        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(ComponentData.objects.filter(name="temp").exists())


class ComponentDataBackCompatTests(AdminAuthMixin, APITestCase):
    """The original contract must be byte-identical when no mode / schema_key
    is involved."""

    def test_plain_patch_writes_data_and_get_is_unchanged(self):
        r = self.admin_client.patch("/api/home/hero/", {"title": "Hi"}, format="json")
        self.assertEqual(r.data, {"title": "Hi"})
        g = self.client.get("/api/home/hero/")
        self.assertEqual(g.data, {"title": "Hi"})

    def test_plain_patch_deep_merge_still_works(self):
        ComponentData.objects.create(name="cta", data={"a": {"x": 1, "y": 2}})
        r = self.admin_client.patch("/api/home/cta/", {"a": {"x": 9}}, format="json")
        self.assertEqual(r.data["a"], {"x": 9, "y": 2})

    def test_revision_written_on_every_admin_patch(self):
        self.admin_client.patch("/api/home/hero/", {"title": "1"}, format="json")
        self.admin_client.patch("/api/home/hero/", {"title": "2"}, format="json")
        c = ComponentData.objects.get(name="hero")
        self.assertEqual(c.revisions.count(), 2)
        self.assertEqual(c.updated_by, self.admin)


class ComponentDraftPublishTests(AdminAuthMixin, APITestCase):
    def test_draft_mode_does_not_touch_public_data(self):
        self.admin_client.patch("/api/home/hero/", {"title": "live"}, format="json")
        self.admin_client.patch(
            "/api/home/hero/?mode=draft", {"title": "wip"}, format="json"
        )
        self.assertEqual(self.client.get("/api/home/hero/").data, {"title": "live"})
        self.assertEqual(
            self.admin_client.get("/api/home/hero/?mode=draft").data, {"title": "wip"}
        )

    def test_publish_promotes_draft_to_live(self):
        self.admin_client.patch("/api/home/hero/", {"title": "live"}, format="json")
        self.admin_client.patch("/api/home/hero/?mode=draft", {"title": "wip"}, format="json")
        r = self.admin_client.post("/api/home/hero/publish/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.client.get("/api/home/hero/").data, {"title": "wip"})

    def test_publish_requires_admin(self):
        ComponentData.objects.create(name="hero", data={})
        self.assertEqual(self.client.post("/api/home/hero/publish/").status_code, 401)


class ComponentHistoryRevertTests(AdminAuthMixin, APITestCase):
    def test_history_and_revert(self):
        self.admin_client.patch("/api/home/hero/", {"title": "v1"}, format="json")
        self.admin_client.patch("/api/home/hero/", {"title": "v2"}, format="json")
        hist = self.admin_client.get("/api/home/hero/history/").data
        self.assertEqual(len(hist), 2)
        first_rev = hist[-1]["id"]
        r = self.admin_client.post(f"/api/home/hero/revert/{first_rev}/")
        self.assertEqual(r.data["title"], "v1")
        # revert is non-destructive — a new revision was written
        self.assertEqual(ComponentData.objects.get(name="hero").revisions.count(), 3)

    def test_history_requires_admin(self):
        ComponentData.objects.create(name="hero", data={})
        self.assertEqual(self.client.get("/api/home/hero/history/").status_code, 401)


class ComponentSchemaTests(AdminAuthMixin, APITestCase):
    def test_builtin_catalogue_is_seeded_and_public(self):
        r = self.client.get("/api/home/schemas/")
        self.assertEqual(r.status_code, 200)
        keys = {row["key"] for row in r.data}
        self.assertTrue({"hero", "faq", "pricing", "footer"}.issubset(keys))

    def test_schema_validation_rejects_wrong_type_without_writing(self):
        self.admin_client.patch(
            "/api/home/myhero/", {"schema_key": "hero"}, format="json"
        )
        r = self.admin_client.patch(
            "/api/home/myhero/", {"heading": 123}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("heading", r.data)
        self.assertEqual(ComponentData.objects.get(name="myhero").data, {})

    def test_schema_validation_allows_valid_payload(self):
        self.admin_client.patch("/api/home/h2/", {"schema_key": "hero"}, format="json")
        r = self.admin_client.patch("/api/home/h2/", {"heading": "Hello"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["heading"], "Hello")


# ==================== Image uploads ====================

class UploadedImageTests(AdminAuthMixin, APITestCase):
    def test_list_is_public(self):
        response = self.client.get("/api/images/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_upload_without_admin_is_rejected(self):
        # Non-staff authenticated user must NOT be able to upload — this was
        # the critical permission gap found during the security audit.
        non_staff = User.objects.create_user(username="regular", password="pass1234")
        client = self.client_class()
        client.force_authenticate(user=non_staff)
        response = client.post("/api/images/", {"category": "test"}, format="multipart")
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_upload_without_any_auth_is_rejected(self):
        response = self.client.post("/api/images/", {"category": "test"}, format="multipart")
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)


# ==================== SiteSettings ====================

class SiteSettingsTests(AdminAuthMixin, APITestCase):
    def test_get_defaults_to_empty_object(self):
        response = self.client.get("/api/settings/site/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, {})

    def test_patch_creates_the_singleton_row(self):
        response = self.admin_client.patch(
            "/api/settings/site/", {"siteName": "Acme"}, format="json"
        )
        self.assertEqual(response.data["siteName"], "Acme")
        self.assertEqual(SiteSettings.objects.count(), 1)

    def test_patch_never_creates_a_second_row(self):
        self.admin_client.patch("/api/settings/site/", {"siteName": "Acme"}, format="json")
        self.admin_client.patch("/api/settings/site/", {"locale": "en_US"}, format="json")
        self.assertEqual(SiteSettings.objects.count(), 1)

    def test_patch_deep_merges_scripts_and_identity_independently(self):
        self.admin_client.patch(
            "/api/settings/site/",
            {"siteName": "Acme", "org": {"logo": "a.png", "twitter": "@acme"}},
            format="json",
        )
        response = self.admin_client.patch(
            "/api/settings/site/", {"org": {"logo": "b.png"}}, format="json"
        )
        self.assertEqual(response.data["org"], {"logo": "b.png", "twitter": "@acme"})
        self.assertEqual(response.data["siteName"], "Acme")


class SiteSettingsValidationTests(AdminAuthMixin, APITestCase):
    def test_customhead_must_be_string_array(self):
        r = self.admin_client.patch(
            "/api/settings/site/", {"analytics": {"customHead": "oops"}}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("analytics.customHead", r.data)

    def test_location_coordinates_must_be_numeric(self):
        r = self.admin_client.patch(
            "/api/settings/site/",
            {"locations": [{"name": "HQ", "latitude": "abc"}]},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_valid_canonical_shape_is_accepted(self):
        r = self.admin_client.patch(
            "/api/settings/site/",
            {
                "organization": {"name": "Acme", "sameAs": ["https://x.com/acme"]},
                "locations": [{"name": "HQ", "latitude": 1.5, "longitude": 2.0,
                               "openingHours": [{"days": ["Monday"], "opens": "09:00", "closes": "17:00"}]}],
                "analytics": {"customHead": ["<meta name='x'>"]},
            },
            format="json",
        )
        self.assertEqual(r.status_code, 200)

    def test_org_schema_endpoint_returns_jsonld(self):
        self.admin_client.patch(
            "/api/settings/site/",
            {"organization": {"name": "Acme", "logo": "/logo.png"},
             "seoDefaults": {"siteUrl": "https://acme.test"},
             "schema": {"organizationType": "LocalBusiness"},
             "locations": [{"name": "HQ", "streetAddress": "1 Main St", "latitude": 1.0, "longitude": 2.0}]},
            format="json",
        )
        r = self.client.get("/api/settings/site/schema/organization/")
        self.assertEqual(r.status_code, 200)
        graph = r.data["@graph"]
        self.assertEqual(graph[0]["@type"], "LocalBusiness")
        self.assertEqual(graph[0]["name"], "Acme")


# ==================== PageSEO ====================

class PageSEOTests(AdminAuthMixin, APITestCase):
    def test_get_unseeded_path_returns_empty_200(self):
        response = self.client.get("/api/seo/about/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, {})

    def test_nested_path_with_slashes_routes_correctly(self):
        response = self.admin_client.patch(
            "/api/seo/services/web-development/", {"seoTitle": "Web Dev"}, format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertTrue(PageSEO.objects.filter(path="services/web-development").exists())

    def test_list_endpoint_is_paginated_like_the_rest_of_the_api(self):
        PageSEO.objects.create(path="home", data={})
        PageSEO.objects.create(path="about", data={})
        response = self.client.get("/api/seo/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn("results", response.data)
        self.assertIn("count", response.data)
        self.assertEqual(response.data["count"], 2)


class PageSEOHistoryResolveTests(AdminAuthMixin, APITestCase):
    def test_greedy_route_does_not_swallow_history_segment(self):
        # Regression: seo/<path:path>/ must not capture ".../history/".
        self.admin_client.patch("/api/seo/guides/x/", {"seoTitle": "X"}, format="json")
        r = self.admin_client.get("/api/seo/guides/x/history/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data), 1)
        self.assertFalse(PageSEO.objects.filter(path="guides/x/history").exists())

    def test_history_snapshots_and_revert(self):
        self.admin_client.patch("/api/seo/about/", {"seoTitle": "v1"}, format="json")
        self.admin_client.patch("/api/seo/about/", {"seoTitle": "v2"}, format="json")
        hist = self.admin_client.get("/api/seo/about/history/").data
        self.assertEqual(len(hist), 2)
        # revert the most recent change (v1 -> v2): restores old_data = v1
        r = self.admin_client.post(f"/api/seo/about/revert/{hist[0]['id']}/")
        self.assertEqual(r.data["seoTitle"], "v1")
        self.assertEqual(PageSEO.objects.get(path="about").history.count(), 3)

    def test_history_requires_admin(self):
        PageSEO.objects.create(path="about", data={})
        self.assertEqual(self.client.get("/api/seo/about/history/").status_code, 401)

    def test_resolve_merges_page_over_site_defaults(self):
        self.admin_client.patch(
            "/api/settings/site/",
            {"seoDefaults": {"siteUrl": "https://acme.test", "titleTemplate": "%s | Acme",
                             "defaultDescription": "Default desc"}},
            format="json",
        )
        self.admin_client.patch("/api/seo/pricing/", {"seoTitle": "Pricing"}, format="json")
        r = self.client.get("/api/seo/resolve/pricing/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["fullTitle"], "Pricing | Acme")
        self.assertEqual(r.data["description"], "Default desc")
        self.assertEqual(r.data["canonical"], "https://acme.test/pricing")
        self.assertIn("@graph", r.data["jsonLd"])

    def test_resolve_unknown_path_still_200(self):
        r = self.client.get("/api/seo/resolve/nope/")
        self.assertEqual(r.status_code, 200)


class SchemaBuilderTests(AdminAuthMixin, APITestCase):
    def test_organization_and_localbusiness(self):
        from api import schema_builders as sb
        site = {
            "organization": {"name": "Acme", "logo": "/l.png", "sameAs": ["https://x.com/a"]},
            "contact": {"email": "hi@acme.test"},
            "seoDefaults": {"siteUrl": "https://acme.test"},
            "schema": {"organizationType": "LocalBusiness"},
            "locations": [{"name": "HQ", "streetAddress": "1 Main",
                           "latitude": 1.0, "longitude": 2.0,
                           "openingHours": [{"days": ["Monday"], "opens": "09:00", "closes": "17:00"}]}],
        }
        node = sb.organization(site)
        self.assertEqual(node["@type"], "LocalBusiness")
        self.assertEqual(node["contactPoint"]["email"], "hi@acme.test")
        self.assertEqual(node["location"][0]["geo"]["latitude"], 1.0)
        self.assertTrue(node["location"][0]["openingHoursSpecification"])

    def test_faq_skips_when_no_valid_pairs(self):
        from api import schema_builders as sb
        self.assertIsNone(sb.faq([{"question": "Q only"}]))
        self.assertEqual(sb.faq([{"question": "Q", "answer": "A"}])["@type"], "FAQPage")

    def test_breadcrumb_matches_depth(self):
        from api import schema_builders as sb
        bc = sb.breadcrumb("services/web", base_url="https://a.test")
        self.assertEqual(len(bc["itemListElement"]), 3)
        self.assertEqual(bc["itemListElement"][-1]["item"], "https://a.test/services/web")

    def test_escape_jsonld_neutralises_angle_bracket(self):
        from api import schema_builders as sb
        out = sb.escape_jsonld({"name": "</script><script>alert(1)"})
        self.assertNotIn("<", out["name"])

    def test_assemble_honours_full_manual_override(self):
        from api import schema_builders as sb
        raw = {"@context": "https://schema.org", "@type": "WebPage", "name": "manual"}
        out = sb.assemble("x", page_seo_data={"schema": {"data": raw}}, site_data={})
        self.assertEqual(out, raw)

    def test_validate_schema_flags_missing_required(self):
        from api import schema_builders as sb
        issues = sb.validate_schema({"@type": "Product"})
        self.assertTrue(any(i["level"] == "error" and "name" in i["message"] for i in issues))

    def test_validate_schema_endpoint(self):
        r = self.admin_client.post(
            "/api/seo/validate-schema/",
            {"schema": {"@context": "https://schema.org", "@type": "Organization", "name": "A"}},
            format="json",
        )
        self.assertTrue(r.data["valid"])
        r2 = self.admin_client.post(
            "/api/seo/validate-schema/", {"schema": "{bad json"}, format="json"
        )
        self.assertFalse(r2.data["valid"])

    def test_validate_schema_requires_admin(self):
        self.assertEqual(
            self.client.post("/api/seo/validate-schema/", {}, format="json").status_code, 401
        )


class RobotsSitemapTests(AdminAuthMixin, APITestCase):
    def test_robots_txt_has_sitemap_and_default_disallows(self):
        r = self.client.get("/robots.txt")
        self.assertEqual(r.status_code, 200)
        body = r.content.decode()
        self.assertIn("Disallow: /api/", body)
        self.assertIn("Sitemap:", body)

    def test_staging_noindex_blocks_everything(self):
        self.admin_client.patch(
            "/api/settings/site/",
            {"seoDefaults": {"robots": {"index": False}}}, format="json",
        )
        body = self.client.get("/robots.txt").content.decode()
        self.assertIn("Disallow: /", body)

    def test_sitemap_lists_published_blog_and_included_pages(self):
        BlogPost.objects.create(slug="p1", title="P1", status="published")
        BlogPost.objects.create(slug="d1", title="D1", status="draft")
        self.admin_client.patch("/api/seo/about/", {"seoTitle": "About"}, format="json")
        self.admin_client.patch(
            "/api/seo/secret/", {"sitemap": {"include": False}}, format="json"
        )
        body = self.client.get("/sitemap.xml").content.decode()
        self.assertIn("/blog/p1", body)
        self.assertNotIn("/blog/d1", body)
        self.assertIn("/about", body)
        self.assertNotIn("/secret", body)

    def test_section_sitemap_and_index(self):
        BlogPost.objects.create(slug="p1", title="P1", status="published")
        self.assertIn("/blog/p1", self.client.get("/sitemap-blog.xml").content.decode())
        self.assertEqual(self.client.get("/sitemap-nope.xml").status_code, 404)
        self.assertIn("sitemap-blog.xml", self.client.get("/sitemap-index.xml").content.decode())


class SEOAuditTests(AdminAuthMixin, APITestCase):
    def test_audit_flags_missing_metadata_and_persists(self):
        self.admin_client.patch("/api/seo/thin/", {"seoTitle": "Hi"}, format="json")
        r = self.admin_client.get("/api/seo/analyze/thin/")
        self.assertEqual(r.status_code, 200)
        ids = {c["id"]: c["passed"] for c in r.data["checks"]}
        self.assertFalse(ids["desc-present"])
        self.assertTrue(ids["title-present"])
        self.assertLess(r.data["overall"], 100)
        from .models import SEOAuditResult
        self.assertEqual(SEOAuditResult.objects.count(), 1)

    def test_audit_requires_admin(self):
        PageSEO.objects.create(path="x", data={})
        self.assertEqual(self.client.get("/api/seo/analyze/x/").status_code, 401)

    def test_post_html_adds_dom_checks(self):
        PageSEO.objects.create(path="p", data={"focusKeyword": "widgets"})
        html = "<html lang='en'><head><meta name='viewport' content='x'>" \
               "<link rel='icon' href='/f.ico'></head><body><h1>Widgets</h1>" \
               "<h2>More</h2><p>" + ("widget " * 400) + "</p>" \
               "<a href='/other'>related</a><img src='/a.png' alt='a'></body></html>"
        r = self.admin_client.post("/api/seo/analyze/p/", {"html": html}, format="json")
        ids = {c["id"]: c["passed"] for c in r.data["checks"]}
        self.assertTrue(ids["single-h1"])
        self.assertTrue(ids["viewport"])
        self.assertTrue(ids["fk-in-h1"])
        self.assertTrue(ids["internal-links"])

    def test_rollup_orders_worst_first(self):
        self.admin_client.patch("/api/seo/good/", {
            "seoTitle": "A well sized title of about fifty five characters here",
            "metaDescription": "x" * 140, "canonicalUrl": "https://a.test/good",
            "social": {"ogTitle": "t", "ogDescription": "d", "ogImage": "i", "ogImageAlt": "a"},
            "schema": {"enabled": True},
        }, format="json")
        self.admin_client.patch("/api/seo/bad/", {"seoTitle": "x"}, format="json")
        r = self.admin_client.get("/api/seo/analyze/")
        self.assertEqual(r.data["pages"][0]["path"], "bad")
        self.assertIn("average_score", r.data)


# ==================== BlogPost ====================

class BlogPostTests(AdminAuthMixin, APITestCase):
    def test_draft_is_hidden_from_anonymous_visitors(self):
        BlogPost.objects.create(slug="draft-post", title="Draft", status="draft")
        response = self.client.get("/api/blog/draft-post/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_draft_is_visible_to_admin(self):
        BlogPost.objects.create(slug="draft-post", title="Draft", status="draft")
        response = self.admin_client.get("/api/blog/draft-post/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_future_scheduled_publish_is_hidden_from_anonymous_visitors(self):
        BlogPost.objects.create(
            slug="future-post",
            title="Future",
            status="published",
            published_at=timezone.now() + timedelta(days=30),
        )
        response = self.client.get("/api/blog/future-post/")
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_future_scheduled_publish_is_visible_to_admin(self):
        BlogPost.objects.create(
            slug="future-post",
            title="Future",
            status="published",
            published_at=timezone.now() + timedelta(days=30),
        )
        response = self.admin_client.get("/api/blog/future-post/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_publishing_without_explicit_date_stamps_now_and_is_visible(self):
        post = BlogPost.objects.create(slug="live-post", title="Live", status="published")
        self.assertIsNotNone(post.published_at)
        response = self.client.get("/api/blog/live-post/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_write_requires_admin(self):
        response = self.client.post(
            "/api/blog/", {"slug": "x", "title": "X"}, format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)


import json as _json


class DynamicPageTests(AdminAuthMixin, APITestCase):
    def _payload(self, **over):
        base = {
            "page_type": "landing",
            "title": "Launch",
            "sections": [
                {"type": "hero", "heading": "Hi", "description": "There",
                 "image_required": True, "image_prompt": "a rocket launching"},
                {"type": "faq", "items": [{"question": "Q?", "answer": "A."}]},
            ],
        }
        base.update(over)
        return base

    def test_section_schema_endpoint_is_public(self):
        r = self.client.get("/api/ai/section-schema/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("hero", r.data["section_schema"])

    def test_dynamic_page_prompt_requires_admin_and_filters(self):
        self.assertEqual(self.client.get("/api/ai/dynamic-page-prompt/").status_code, 401)
        r = self.admin_client.get("/api/ai/dynamic-page-prompt/?sections=hero,faq")
        self.assertIn("hero", r.data["prompt"])

    def test_paste_to_build_happy_path(self):
        r = self.admin_client.post(
            "/api/content/paste-to-build/",
            {"raw": _json.dumps(self._payload())}, format="json",
        )
        self.assertEqual(r.status_code, 201)
        self.assertEqual(r.data["host"]["kind"], "content")
        self.assertEqual(len(r.data["pending_images"]), 1)
        page = ContentPage.objects.get(path=r.data["host"]["key"])
        self.assertEqual(page.body_mode, "dynamic")
        self.assertEqual(page.status, "draft")
        self.assertEqual(page.sections.count(), 2)

    def test_paste_to_build_article_creates_blogpost(self):
        r = self.admin_client.post(
            "/api/content/paste-to-build/",
            {"raw": _json.dumps(self._payload(page_type="article"))}, format="json",
        )
        self.assertEqual(r.data["host"]["kind"], "blog")
        self.assertTrue(BlogPost.objects.filter(slug=r.data["host"]["key"]).exists())

    def test_paste_to_build_invalid_json_rejected(self):
        r = self.admin_client.post(
            "/api/content/paste-to-build/", {"raw": "{not json"}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("errors", r.data)

    def test_paste_to_build_unknown_type_rejected_atomically(self):
        bad = self._payload(sections=[{"type": "nope", "heading": "x"}])
        r = self.admin_client.post(
            "/api/content/paste-to-build/", {"raw": _json.dumps(bad)}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.assertEqual(ContentPage.objects.count(), 0)
        self.assertEqual(DynamicSection.objects.count(), 0)

    def test_paste_to_build_image_prompt_required(self):
        bad = self._payload(sections=[
            {"type": "hero", "heading": "h", "description": "d", "image_required": True},
        ])
        r = self.admin_client.post(
            "/api/content/paste-to-build/", {"raw": _json.dumps(bad)}, format="json"
        )
        self.assertEqual(r.status_code, 400)

    def test_video_url_allowlist_enforced(self):
        bad = self._payload(sections=[{"type": "video", "video_url": "https://evil.test/x"}])
        r = self.admin_client.post(
            "/api/content/paste-to-build/", {"raw": _json.dumps(bad)}, format="json"
        )
        self.assertEqual(r.status_code, 400)

    def test_raw_html_in_content_rejected(self):
        bad = self._payload(sections=[{"type": "rich_text", "content": "<script>x</script>"}])
        r = self.admin_client.post(
            "/api/content/paste-to-build/", {"raw": _json.dumps(bad)}, format="json"
        )
        self.assertEqual(r.status_code, 400)

    def _build(self):
        r = self.admin_client.post(
            "/api/content/paste-to-build/", {"raw": _json.dumps(self._payload())}, format="json"
        )
        return r.data["host"]["key"]

    def test_sections_get_is_public_published_only(self):
        key = self._build()
        # sections are created published, but host is draft -> visible to admin,
        # the section list endpoint itself returns published sections
        r = self.client.get(f"/api/content/{key}/sections/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.data), 2)

    def test_reorder_rejects_foreign_id_set(self):
        key = self._build()
        ids = [s["id"] for s in self.admin_client.get(f"/api/content/{key}/sections/").data]
        r = self.admin_client.post(
            f"/api/content/{key}/sections/reorder/", {"order": ids[:1]}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        r2 = self.admin_client.post(
            f"/api/content/{key}/sections/reorder/", {"order": list(reversed(ids))}, format="json"
        )
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.data[0]["order"], 0)

    def test_publish_guard_blocks_until_required_image_uploaded(self):
        key = self._build()
        r = self.admin_client.patch(
            f"/api/content/pages/{key}/", {"status": "published"}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        # upload the missing hero image
        from django.core.files.uploadedfile import SimpleUploadedFile
        png = SimpleUploadedFile("h.png", b"\x89PNG\r\n\x1a\n" + b"\0" * 40, content_type="image/png")
        hero = DynamicSection.objects.get(section_type="hero")
        up = self.admin_client.post(
            f"/api/content/{key}/sections/{hero.id}/media/image/",
            {"image": png}, format="multipart",
        )
        self.assertEqual(up.status_code, 200)
        r2 = self.admin_client.patch(
            f"/api/content/pages/{key}/", {"status": "published"}, format="json"
        )
        self.assertEqual(r2.status_code, 200)

    def test_section_crud_and_delete(self):
        key = self._build()
        sid = self.admin_client.get(f"/api/content/{key}/sections/").data[1]["id"]
        p = self.admin_client.patch(
            f"/api/content/{key}/sections/{sid}/",
            {"content": {"items": [{"question": "New?", "answer": "Yes."}]}}, format="json",
        )
        self.assertEqual(p.data["content"]["items"][0]["question"], "New?")
        d = self.admin_client.delete(f"/api/content/{key}/sections/{sid}/")
        self.assertEqual(d.status_code, 204)

    def test_blog_section_subroute_mirrors_content(self):
        post = BlogPost.objects.create(title="Post", status="draft", body_mode="dynamic")
        r = self.admin_client.post(
            f"/api/blog/{post.slug}/sections/",
            [{"section_type": "rich_text", "content": {"content": "Hello world"}}],
            format="json",
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            len(self.client.get(f"/api/blog/{post.slug}/sections/").data), 1
        )


# ==================== Redirect ====================

class RedirectTests(AdminAuthMixin, APITestCase):
    def test_self_redirect_is_rejected(self):
        response = self.admin_client.post(
            "/api/redirects/",
            {"source": "/old", "destination": "/old", "permanent": True},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_direct_loop_is_rejected(self):
        Redirect.objects.create(source="/a", destination="/b")
        response = self.admin_client.post(
            "/api/redirects/",
            {"source": "/b", "destination": "/a", "permanent": True},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_longer_chain_loop_is_rejected(self):
        Redirect.objects.create(source="/a", destination="/b")
        Redirect.objects.create(source="/b", destination="/c")
        # /c -> /a would close the loop a -> b -> c -> a
        response = self.admin_client.post(
            "/api/redirects/",
            {"source": "/c", "destination": "/a", "permanent": True},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_non_looping_chain_is_allowed(self):
        Redirect.objects.create(source="/a", destination="/b")
        response = self.admin_client.post(
            "/api/redirects/",
            {"source": "/x", "destination": "/a", "permanent": True},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_list_is_public_write_requires_admin(self):
        response = self.client.get("/api/redirects/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        response = self.client.post(
            "/api/redirects/", {"source": "/a", "destination": "/b"}, format="json"
        )
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)


# ==================== FormSubmission ====================

@override_settings(FORM_NOTIFICATION_EMAIL="owner@example.com")
class FormSubmitTests(AdminAuthMixin, APITestCase):
    def test_submit_persists_and_sends_notification(self):
        mail.outbox = []
        response = self.client.post(
            "/api/forms/booking/submit/",
            {"name": "Jane", "date": "2026-09-01"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("booking", mail.outbox[0].subject)
        self.assertEqual(mail.outbox[0].to, ["owner@example.com"])

    def test_honeypot_field_is_silently_dropped_and_not_persisted(self):
        from .models import FormSubmission

        mail.outbox = []
        response = self.client.post(
            "/api/forms/contact/submit/",
            {"name": "Bot", "website": "http://spam.example"},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(FormSubmission.objects.filter(form_name="contact").exists())
        self.assertEqual(len(mail.outbox), 0)

    def test_submissions_list_requires_admin(self):
        response = self.client.get("/api/forms/booking/submissions/")
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        response = self.admin_client.get("/api/forms/booking/submissions/")
        self.assertEqual(response.status_code, status.HTTP_200_OK)


class PermissionAuditTests(APITestCase):
    """Iterate the whole API URLconf and assert every write method is either
    admin-gated or on the tiny explicit public-write allowlist. This is the
    permanent guard against the reference repo's unguarded-portal mistake."""

    # url name -> reason it may accept unauthenticated writes
    PUBLIC_WRITE_ALLOWLIST = {
        "admin-login": "credential exchange, throttled (login scope)",
        "form-submit": "public form endpoint, throttled (form_submit) + honeypot",
    }

    def _permission_instances(self, view_cls, method):
        from rest_framework.test import APIRequestFactory

        request = getattr(APIRequestFactory(), method.lower())("/")
        view = view_cls()
        view.request = request
        view.kwargs = {}
        view.format_kwarg = None
        try:
            return view.get_permissions()
        except Exception:
            return [p() for p in getattr(view_cls, "permission_classes", [])]

    def test_every_write_endpoint_is_admin_gated(self):
        from rest_framework.permissions import IsAdminUser
        from rest_framework.routers import APIRootView

        from backend.urls import urlpatterns as root_patterns

        def walk(patterns, prefix=""):
            for p in patterns:
                if hasattr(p, "url_patterns"):
                    yield from walk(p.url_patterns, prefix + str(p.pattern))
                else:
                    yield prefix + str(p.pattern), p

        offenders = []
        for full, pattern in walk(root_patterns):
            if not full.startswith("api/"):
                continue
            callback = pattern.callback
            view_cls = getattr(callback, "cls", getattr(callback, "view_class", None))
            if view_cls is None or issubclass(view_cls, APIRootView):
                continue
            name = pattern.name
            actions = getattr(callback, "actions", None)  # router viewsets
            for method in ("POST", "PUT", "PATCH", "DELETE"):
                if actions is not None:
                    if method.lower() not in actions:
                        continue
                elif not hasattr(view_cls, method.lower()):
                    continue
                perms = self._permission_instances(view_cls, method)
                has_admin = any(isinstance(x, IsAdminUser) for x in perms)
                if not has_admin and name not in self.PUBLIC_WRITE_ALLOWLIST:
                    offenders.append(f"{name or full} [{method}] -> {[type(x).__name__ for x in perms]}")

        self.assertEqual(offenders, [], f"Un-gated write endpoints: {offenders}")


class SecurityHeaderTests(APITestCase):
    def test_nosniff_and_frame_headers_present(self):
        resp = self.client.get("/api/seo/")
        self.assertEqual(resp.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(resp.headers.get("X-Frame-Options"), "DENY")


class ImageUploadValidationTests(AdminAuthMixin, APITestCase):
    def _png(self, name="ok.png"):
        from django.core.files.uploadedfile import SimpleUploadedFile

        data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
        return SimpleUploadedFile(name, data, content_type="image/png")

    def test_valid_png_is_accepted(self):
        resp = self.admin_client.post(
            "/api/images/", {"category": "x", "image": self._png()}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_201_CREATED)

    def test_disguised_non_image_is_rejected_by_magic_bytes(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        bad = SimpleUploadedFile("evil.png", b"<?php echo 1; ?>", content_type="image/png")
        resp = self.admin_client.post(
            "/api/images/", {"category": "x", "image": bad}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_svg_is_rejected_by_default(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        svg = SimpleUploadedFile("logo.svg", b"<svg></svg>", content_type="image/svg+xml")
        resp = self.admin_client.post(
            "/api/images/", {"category": "x", "image": svg}, format="multipart"
        )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_oversize_file_is_rejected(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        from django.test import override_settings

        big = SimpleUploadedFile(
            "big.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 5000, content_type="image/png"
        )
        with override_settings(MAX_IMAGE_BYTES=1000):
            resp = self.admin_client.post(
                "/api/images/", {"category": "x", "image": big}, format="multipart"
            )
        self.assertEqual(resp.status_code, status.HTTP_400_BAD_REQUEST)

    def test_checksum_dedupe_returns_existing(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        raw = b"\x89PNG\r\n\x1a\n" + b"dedupe" * 8
        a = self.admin_client.post(
            "/api/images/", {"category": "x", "image": SimpleUploadedFile("a.png", raw)},
            format="multipart",
        )
        b = self.admin_client.post(
            "/api/images/", {"category": "y", "image": SimpleUploadedFile("b.png", raw)},
            format="multipart",
        )
        self.assertEqual(a.status_code, 201)
        self.assertEqual(b.status_code, 200)
        self.assertTrue(b.data["duplicate"])
        self.assertEqual(a.data["id"], b.data["id"])

    def test_missing_alt_filter(self):
        self.admin_client.post(
            "/api/images/", {"category": "x", "image": self._png("noalt.png")}, format="multipart"
        )
        r = self.client.get("/api/images/?missing_alt=1")
        self.assertGreaterEqual(r.data["count"], 1)

    def test_usage_endpoint_scans_section_media(self):
        img = self.admin_client.post(
            "/api/images/", {"category": "x", "image": self._png("u.png")}, format="multipart"
        ).data
        r = self.admin_client.get(f"/api/images/{img['id']}/usage/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["in_use"], False)

    def test_serializer_exposes_absolute_url(self):
        self.admin_client.post(
            "/api/images/", {"category": "x", "image": self._png("abs.png")}, format="multipart"
        )
        resp = self.client.get("/api/images/")
        row = resp.data["results"][0]
        self.assertTrue(row["image_url"].startswith("http"))


class FormValidationTests(AdminAuthMixin, APITestCase):
    def _define(self, name="contact", **extra):
        definition = {
            "fields": [
                {"name": "email", "label": "Email", "type": "email", "required": True},
                {"name": "age", "label": "Age", "type": "number",
                 "validation": {"min": 18, "max": 120}},
                {"name": "topic", "label": "Topic", "type": "select",
                 "options": ["sales", "support"]},
            ],
        }
        definition.update(extra)
        self.admin_client.patch(f"/api/home/form-{name}/", definition, format="json")

    def test_missing_required_field_rejected(self):
        self._define()
        r = self.client.post("/api/forms/contact/submit/", {"age": 20}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("email", r.data["errors"])

    def test_type_and_range_validation(self):
        self._define()
        r = self.client.post(
            "/api/forms/contact/submit/",
            {"email": "bad", "age": 5}, format="json",
        )
        self.assertIn("email", r.data["errors"])
        self.assertIn("age", r.data["errors"])

    def test_option_membership_enforced(self):
        self._define()
        r = self.client.post(
            "/api/forms/contact/submit/",
            {"email": "a@b.co", "topic": "hacking"}, format="json",
        )
        self.assertIn("topic", r.data["errors"])

    def test_valid_submission_persists_with_metadata(self):
        self._define()
        r = self.client.post(
            "/api/forms/contact/submit/",
            {"email": "a@b.co", "age": 30, "topic": "sales"}, format="json",
        )
        self.assertEqual(r.status_code, 201)
        from .models import FormSubmission
        sub = FormSubmission.objects.get(form_name="contact")
        self.assertTrue(sub.ip_hash)

    def test_same_email_dedupe_within_60s(self):
        self._define()
        body = {"email": "dup@b.co", "age": 30}
        self.client.post("/api/forms/contact/submit/", body, format="json")
        self.client.post("/api/forms/contact/submit/", body, format="json")
        from .models import FormSubmission
        self.assertEqual(FormSubmission.objects.filter(form_name="contact").count(), 1)

    def test_configurable_honeypot(self):
        self._define(honeypotField="nickname")
        r = self.client.post(
            "/api/forms/contact/submit/",
            {"email": "a@b.co", "age": 30, "nickname": "bot"}, format="json",
        )
        self.assertEqual(r.status_code, 200)
        from .models import FormSubmission
        self.assertEqual(FormSubmission.objects.filter(form_name="contact").count(), 0)

    def test_submissions_filter_export_and_toggle(self):
        self._define()
        self.client.post("/api/forms/contact/submit/",
                         {"email": "x@b.co", "age": 30}, format="json")
        from .models import FormSubmission
        sub = FormSubmission.objects.get(form_name="contact")
        p = self.admin_client.patch(
            f"/api/forms/contact/submissions/{sub.id}/", {"is_spam": True}, format="json"
        )
        self.assertTrue(p.data["is_spam"])
        listed = self.admin_client.get("/api/forms/contact/submissions/?is_spam=1")
        self.assertEqual(listed.data["count"], 1)
        csv = self.admin_client.get("/api/forms/contact/submissions/export/?format=csv")
        self.assertIn("x@b.co", csv.content.decode())


class FormSubmitThrottleTests(AdminAuthMixin, APITestCase):
    def test_throttle_actually_blocks_after_the_configured_rate(self):
        # Regression test for the bug found during audit: a custom
        # ScopedRateThrottle subclass with its own `scope` attribute was
        # silently never enforced, because DRF reads `view.throttle_scope`,
        # not the throttle class's own attribute. This pins the fix.
        #
        # Uses the real project throttle rate (settings.py:
        # DEFAULT_THROTTLE_RATES['form_submit'] = '5/minute') rather than
        # override_settings — DRF's SimpleRateThrottle binds THROTTLE_RATES
        # from api_settings at class-import time, so overriding
        # REST_FRAMEWORK mid-test does not reliably change it for an
        # already-imported throttle class.
        statuses = [
            self.client.post(
                "/api/forms/throttled/submit/", {"x": i}, format="json"
            ).status_code
            for i in range(6)
        ]
        self.assertEqual(statuses[:5], [201, 201, 201, 201, 201])
        self.assertEqual(statuses[5], status.HTTP_429_TOO_MANY_REQUESTS)
