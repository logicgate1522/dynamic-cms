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

    def test_superuser_can_login_with_username(self):
        user = User.objects.create_superuser(
            username="superadmin", email="", password="super-password",
        )
        for field in ("email", "username"):
            response = self.client.post(
                "/api/auth/login/",
                {field: "superadmin", "password": "super-password"},
                format="json",
            )
            self.assertEqual(response.status_code, status.HTTP_200_OK)
            self.assertEqual(response.data["key"], Token.objects.get(user=user).key)

    def test_inactive_superuser_is_rejected(self):
        User.objects.create_superuser(
            username="inactive", password="super-password", is_active=False,
        )
        response = self.client.post(
            "/api/auth/login/",
            {"email": "inactive", "password": "super-password"}, format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_duplicate_email_is_rejected(self):
        User.objects.create_user(username="duplicate", email=self.staff.email, password="correct-horse", is_staff=True)
        response = self.client.post(
            "/api/auth/login/",
            {"email": self.staff.email, "password": "correct-horse"}, format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

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

    def test_resolve_blog_path_emits_blogposting_and_uses_post_fallback(self):
        BlogPost.objects.create(
            slug="hello", title="Hello World", status="published",
            excerpt="An intro", seo_title="", meta_description="",
        )
        self.admin_client.patch(
            "/api/settings/site/",
            {"seoDefaults": {"siteUrl": "https://acme.test"}}, format="json",
        )
        r = self.client.get("/api/seo/resolve/blog/hello/")
        self.assertEqual(r.data["title"], "Hello World")       # BlogPost.title fallback
        self.assertEqual(r.data["description"], "An intro")     # BlogPost.excerpt fallback
        types = [n.get("@type") for n in r.data["jsonLd"]["@graph"]]
        self.assertIn("BlogPosting", types)
        self.assertIn("BreadcrumbList", types)


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

    def test_section_schema_keys_match_parser_and_registry_contract(self):
        # The single-source-of-truth guarantee: the endpoint, the parser, and
        # the model-level type list must all agree.
        from .dynamic_pages import SECTION_SCHEMA, SECTION_TYPES
        r = self.client.get("/api/ai/section-schema/")
        self.assertEqual(set(r.data["section_schema"]), set(SECTION_SCHEMA))
        self.assertEqual(set(SECTION_TYPES), set(SECTION_SCHEMA))

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

    def test_resolve_returns_target_and_status_and_counts_hit(self):
        Redirect.objects.create(source="/old", destination="/new", permanent=True)
        r = self.client.get("/api/redirects/resolve/?path=/old")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data, {"to": "/new", "status": 301})
        self.assertEqual(Redirect.objects.get(source="/old").hit_count, 1)

    def test_resolve_404_for_unknown(self):
        self.assertEqual(self.client.get("/api/redirects/resolve/?path=/x").status_code, 404)

    def test_status_code_override_wins_over_permanent(self):
        Redirect.objects.create(source="/a", destination="/b", permanent=True, status_code=307)
        r = self.client.get("/api/redirects/resolve/?path=/a")
        self.assertEqual(r.data["status"], 307)

    def test_broken_filter_flags_chained_target(self):
        Redirect.objects.create(source="/a", destination="/b")
        Redirect.objects.create(source="/b", destination="/c")
        r = self.admin_client.get("/api/redirects/?broken=1")
        paths = {row["source"] for row in r.data["results"]}
        self.assertIn("/a", paths)
        self.assertNotIn("/b", paths)

    def test_csv_import_export_roundtrip(self):
        csv_body = "source,destination,status_code,is_active,notes\n/x,/y,302,true,moved\n"
        imp = self.admin_client.post("/api/redirects/io/", {"csv": csv_body}, format="json")
        self.assertEqual(imp.data["created"], 1)
        out = self.admin_client.get("/api/redirects/io/?format=csv").content.decode()
        self.assertIn("/x,/y,302", out)

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
        "auth-logout": "ends the caller's own session; a no-op when anonymous",
        "events-ingest": "tracking beacon (R31): throttled (events), origin-checked, size-capped, allowlisted names",
        "events-forget": "consent withdrawn: unlinks a visitor id; throttled + origin-checked",
        "tracking-verify-results": "verification results: authorised by a signed, short-lived run token",
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

    def test_metadata_patch_does_not_rename_stored_file(self):
        created = self.admin_client.post(
            "/api/images/", {"category": "x", "image": self._png("orig.png")}, format="multipart"
        ).data
        stored = created["image"]
        self.assertIn("uploaded_images/", stored)
        r = self.admin_client.patch(
            f"/api/images/{created['id']}/", {"alt_text": "A brand new caption"}, format="json"
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["image"], stored)          # path unchanged
        self.assertEqual(r.data["alt_text"], "A brand new caption")
        from .models import UploadedImage
        self.assertEqual(UploadedImage.objects.get(pk=created["id"]).image.name, stored.split("/media/")[-1])

    def test_dimensions_and_checksum_filled_on_upload(self):
        row = self.admin_client.post(
            "/api/images/", {"category": "x", "image": self._png("m.png")}, format="multipart"
        ).data
        self.assertEqual(len(row["checksum"]), 64)
        self.assertIsNotNone(row["file_size"])

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


class SessionAuthTests(APITestCase):
    """Browser admin flow: CSRF bootstrap -> session login -> CSRF-protected
    writes -> logout. Uses a client that enforces CSRF like a real browser."""

    def setUp(self):
        cache.clear()
        self.staff = User.objects.create_user(
            username="editor", email="editor@example.com", password="correct-horse", is_staff=True,
        )
        self.client = self.client_class(enforce_csrf_checks=True)

    def _csrf(self):
        return self.client.get("/api/auth/csrf/").data["csrfToken"]

    def test_session_status_anonymous(self):
        self.assertEqual(self.client.get("/api/auth/session/").data, {"authenticated": False})

    def test_session_login_requires_csrf(self):
        response = self.client.post(
            "/api/auth/login/",
            {"username": "editor", "password": "correct-horse", "session": True}, format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_session_login_write_and_logout(self):
        token = self._csrf()
        response = self.client.post(
            "/api/auth/login/",
            {"username": "editor", "password": "correct-horse", "session": True},
            format="json", HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertNotIn("key", response.data)  # no token handed to the browser
        self.assertTrue(response.data["authenticated"])

        status_response = self.client.get("/api/auth/session/")
        self.assertTrue(status_response.data["authenticated"])
        self.assertEqual(status_response.data["user"]["username"], "editor")

        # Login rotates the CSRF token; fetch the new one.
        token = self._csrf()
        blocked = self.client.patch("/api/home/hero/", {"title": "x"}, format="json")
        self.assertEqual(blocked.status_code, status.HTTP_403_FORBIDDEN)
        allowed = self.client.patch(
            "/api/home/hero/", {"title": "Hello"}, format="json", HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(allowed.status_code, status.HTTP_200_OK)

        self.client.post("/api/auth/logout/", HTTP_X_CSRFTOKEN=token)
        self.assertFalse(self.client.get("/api/auth/session/").data["authenticated"])

    def test_non_staff_session_is_not_admin(self):
        User.objects.create_user(username="viewer", password="viewer-pass")
        token = self._csrf()
        response = self.client.post(
            "/api/auth/login/",
            {"username": "viewer", "password": "viewer-pass", "session": True},
            format="json", HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertFalse(self.client.get("/api/auth/session/").data["authenticated"])

    def test_token_login_still_works_for_scripts(self):
        response = self.client.post(
            "/api/auth/login/", {"email": "editor@example.com", "password": "correct-horse"}, format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn("key", response.data)


@override_settings(FRONTEND_REVALIDATE_URL="http://frontend.test/api/revalidate", REVALIDATE_SECRET="s3cret")
class RevalidationWebhookTests(AdminAuthMixin, APITestCase):
    """Writes queue the right cache tags after commit; delivery is signed."""

    def capture(self, fn):
        from unittest import mock
        seen = set()
        with mock.patch("api.revalidation._enqueue", side_effect=lambda tags: seen.update(tags)):
            with self.captureOnCommitCallbacks(execute=True):
                fn()
        return seen

    def test_component_save_tags(self):
        tags = self.capture(lambda: self.admin_client.patch("/api/home/hero/", {"t": 1}, format="json"))
        self.assertIn("cms:home:hero", tags)

    def test_settings_and_seo_tags(self):
        tags = self.capture(lambda: self.admin_client.patch("/api/settings/site/", {"organization": {"name": "X"}}, format="json"))
        self.assertTrue({"cms", "cms:settings"} <= tags)
        tags = self.capture(lambda: self.admin_client.patch("/api/seo/about/", {"seoTitle": "About"}, format="json"))
        self.assertTrue({"cms:seo", "cms:seo:about"} <= tags)

    def test_blog_and_page_tags(self):
        tags = self.capture(lambda: self.admin_client.post(
            "/api/blog/", {"title": "Hello", "slug": "hello", "status": "published"}, format="json"))
        self.assertTrue({"cms:blog", "cms:blog:hello", "cms:seo:blog/hello"} <= tags)
        tags = self.capture(lambda: self.admin_client.post(
            "/api/content/pages/", {"path": "landing/x", "title": "X"}, format="json"))
        self.assertTrue({"cms:pages", "cms:page:landing/x"} <= tags)

    def test_rolled_back_write_does_not_notify(self):
        from django.db import transaction
        from unittest import mock
        seen = set()
        with mock.patch("api.revalidation._enqueue", side_effect=lambda tags: seen.update(tags)):
            with self.captureOnCommitCallbacks(execute=True):
                try:
                    with transaction.atomic():
                        ComponentData.objects.create(name="ghost", data={})
                        raise RuntimeError("rollback")
                except RuntimeError:
                    pass
        self.assertNotIn("cms:home:ghost", seen)

    def test_delivery_is_signed(self):
        from unittest import mock
        from api import revalidation
        with mock.patch("urllib.request.urlopen") as urlopen:
            revalidation._deliver({"cms:home:hero"})
        request = urlopen.call_args[0][0]
        body = request.data
        timestamp = request.get_header("X-cms-timestamp")
        self.assertEqual(request.get_header("X-cms-signature"), revalidation.sign(body, timestamp, "s3cret"))
        self.assertEqual(json_loads(body), {"tags": ["cms:home:hero"]})


def json_loads(raw):
    import json
    return json.loads(raw)


class DraftWorkflowTests(AdminAuthMixin, APITestCase):
    """Inline edits save as drafts; publish/discard across components and sections."""

    def setUp(self):
        super().setUp()
        self.admin_client.patch("/api/home/hero/", {"title": "Live"}, format="json")
        self.admin_client.post("/api/content/pages/", {"path": "landing/a", "title": "A"}, format="json")
        self.admin_client.post("/api/content/landing/a/sections/", {"sections": [
            {"section_type": "rich_text", "content": {"content": "Live body"}}]}, format="json")
        self.section_id = self.admin_client.get("/api/content/landing/a/sections/").data[0]["id"]

    def test_component_draft_is_invisible_until_published(self):
        self.admin_client.patch("/api/home/hero/?mode=draft", {"title": "Draft"}, format="json")
        self.assertEqual(self.client.get("/api/home/hero/").data["title"], "Live")
        self.assertEqual(self.admin_client.get("/api/home/hero/?mode=draft").data["title"], "Draft")
        pending = self.admin_client.get("/api/drafts/").data
        self.assertEqual([c["name"] for c in pending["components"]], ["hero"])
        self.admin_client.post("/api/drafts/publish/", {"components": ["hero"]}, format="json")
        self.assertEqual(self.client.get("/api/home/hero/").data["title"], "Draft")
        self.assertEqual(self.admin_client.get("/api/drafts/").data["total"], 0)

    def test_section_draft_publish(self):
        url = f"/api/content/landing/a/sections/{self.section_id}/?mode=draft"
        self.admin_client.patch(url, {"content": {"content": "Draft body"}}, format="json")
        sections = self.admin_client.get("/api/content/landing/a/sections/").data
        self.assertEqual(sections[0]["content"]["content"], "Live body")
        self.assertEqual(sections[0]["draft_content"]["content"], "Draft body")
        pending = self.admin_client.get("/api/drafts/").data
        self.assertEqual(pending["hosts"], [{"kind": "content", "key": "landing/a", "title": "A", "sections": 1}])
        result = self.admin_client.post("/api/drafts/publish/", {"hosts": [{"kind": "content", "key": "landing/a"}]}, format="json").data
        self.assertEqual(result["sections"], 1)
        sections = self.admin_client.get("/api/content/landing/a/sections/").data
        self.assertEqual(sections[0]["content"]["content"], "Draft body")
        self.assertIsNone(sections[0]["draft_content"])

    def test_discard_everything(self):
        self.admin_client.patch("/api/home/hero/?mode=draft", {"title": "Draft"}, format="json")
        self.admin_client.patch(f"/api/content/landing/a/sections/{self.section_id}/?mode=draft",
                                {"content": {"content": "Draft body"}}, format="json")
        result = self.admin_client.post("/api/drafts/discard/", {}, format="json").data
        self.assertEqual(result, {"components": ["hero"], "sections": 1})
        self.assertEqual(self.admin_client.get("/api/home/hero/?mode=draft").data["title"], "Live")

    def test_public_never_sees_draft_fields(self):
        self.assertNotIn("draft_content", self.client.get("/api/content/landing/a/sections/").data[0])
        self.assertEqual(self.client.get("/api/drafts/").status_code, 401)


class DraftPrivacyTests(AdminAuthMixin, APITestCase):
    def test_anonymous_cannot_read_component_draft(self):
        self.admin_client.patch("/api/home/hero/", {"title": "Live"}, format="json")
        self.admin_client.patch("/api/home/hero/?mode=draft", {"title": "Secret draft"}, format="json")
        self.assertEqual(self.client.get("/api/home/hero/?mode=draft").data["title"], "Live")


class KeywordMatchingTests(APITestCase):
    def test_connector_words_ignored_order_kept(self):
        from api.keywords import contains_keyword
        self.assertTrue(contains_keyword("Accountant for Leeds businesses", "accountant leeds"))
        self.assertTrue(contains_keyword("VAT RETURNS made simple", "vat returns"))
        self.assertFalse(contains_keyword("Leeds accountant", "accountant leeds"))
        self.assertFalse(contains_keyword("anything", ""))

    def test_section_coverage_excludes_shared_blocks(self):
        from api.keywords import section_coverage
        result = section_coverage("vat returns", {
            "hero": {"label": "Hero", "content": {"title": "VAT returns done right"}},
            "faq": {"label": "FAQ", "content": {"items": [{"q": "Fees?"}]}},
            "footer": {"label": "Footer", "content": {"t": "x"}, "excludeFromKeywordAudit": True},
        })
        self.assertEqual((result["withKeyword"], result["total"], result["percent"]), (1, 2, 50))


class AiNormalizeTests(AdminAuthMixin, APITestCase):
    def post(self, body):
        return self.admin_client.post("/api/ai/normalize/", body, format="json")

    def test_section_reply_with_prose_fences_links_and_wrapper(self):
        raw = 'Here you go:\n```json\n{"content": {"title": "New", "image": "[https://x.jpg](https://x.jpg)"}}\n```\nDone.'
        r = self.post({"kind": "section", "raw": raw, "current": {"title": "Old", "cta": "Call"}})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["content"], {"title": "New", "image": "https://x.jpg", "cta": "Call"})

    def test_links_inside_prose_keep_only_the_label(self):
        raw = '{"note": "Email [info@x.co.uk](mailto:info@x.co.uk) or see [our fees](/fees). [Keep] this."}'
        r = self.post({"kind": "section", "raw": raw, "current": {"note": ""}})
        self.assertEqual(r.data["content"]["note"], "Email info@x.co.uk or see our fees. [Keep] this.")

    def test_shrinking_list_is_refused(self):
        current = {"items": [{"q": 1}, {"q": 2}, {"q": 3}, {"q": 4}]}
        r = self.post({"kind": "section", "raw": '{"items": [{"q": 1}]}', "current": current})
        self.assertEqual(len(r.data["content"]["items"]), 4)
        self.assertTrue(r.data["warnings"])

    def test_page_assist_fanout(self):
        raw = '{"hero": {"title": "Better"}, "ghost": {"x": 1}}'
        r = self.post({"kind": "page_assist", "raw": raw, "current": {"hero": {"title": "Old", "sub": "s"}}})
        self.assertEqual(r.data["applied"], {"hero": {"title": "Better", "sub": "s"}})
        self.assertEqual(r.data["unmatched"], ["ghost"])

    def test_seo_flat_keys_map_to_pageseo_shape(self):
        raw = ('Audit text...\n```json\n{"seoTitle": "VAT Returns | Acme", "primaryKeyword": "vat returns", '
               '"secondaryKeywords": "mtd vat, vat filing", "searchIntent": "commercial", "ogTitle": "OG", '
               '"breadcrumbName": "VAT", "bogus": 1}\n```')
        r = self.post({"kind": "seo", "raw": raw, "path": "services/vat"})
        self.assertEqual(r.data["patch"], {
            "seoTitle": "VAT Returns | Acme",
            "keywords": {"primary": "vat returns", "secondary": ["mtd vat", "vat filing"]},
            "searchIntent": "commercial",
            "social": {"ogTitle": "OG"},
            "breadcrumbLabels": {"services/vat": "VAT"},
        })
        self.assertEqual(r.data["unknown"], ["bogus"])

    def test_invalid_intent_and_bad_json(self):
        r = self.post({"kind": "seo", "raw": '{"searchIntent": "buy stuff"}'})
        self.assertEqual(r.data["patch"], {})
        self.assertEqual(self.post({"kind": "section", "raw": "{not json", "current": {}}).status_code, 400)

    def test_page_kind_returns_validated_page(self):
        raw = '{"title": "T", "sections": [{"type": "rich_text", "content": "Hello"}]}'
        r = self.post({"kind": "page", "raw": raw})
        self.assertEqual(r.data["page"]["sections"][0]["section_type"], "rich_text")
        bad = self.post({"kind": "page", "raw": '{"title": "T", "sections": [{"type": "nope"}]}'})
        self.assertEqual(bad.status_code, 400)
        self.assertIn("errors", bad.data)

    def test_admin_only(self):
        self.assertEqual(self.client.post("/api/ai/normalize/", {"kind": "section", "raw": "{}"}, format="json").status_code, 401)


class AiPromptTests(AdminAuthMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.admin_client.patch("/api/settings/site/", {
            "organization": {"name": "Acme Accounts"},
            "ai": {"brandVoice": "friendly", "location": "Leeds", "pageKinds": {"vat": "VAT guide"},
                   "extraRules": ["Say 'accounts', never 'books'."]},
        }, format="json")
        self.admin_client.patch("/api/seo/services/vat/", {"keywords": {"primary": "vat returns leeds"}}, format="json")

    def test_new_page_prompt_uses_settings_and_brief(self):
        r = self.admin_client.get("/api/ai/new-page-prompt/?title=VAT&path=services/vat&keyword=vat+returns&audience=sole+traders")
        prompt = r.data["prompt"]
        for expected in ("Acme Accounts", "friendly", "Service page", "vat returns", "sole traders", "Leeds",
                         "Say 'accounts', never 'books'.", "SEO RULES", '"sections"'):
            self.assertIn(expected, prompt)

    def test_custom_page_kind(self):
        prompt = self.admin_client.get("/api/ai/new-page-prompt/?path=vat/guide").data["prompt"]
        self.assertIn("VAT guide", prompt)

    def test_build_prompt_edit_mode_includes_live_sections_and_seo_keyword(self):
        self.admin_client.post("/api/content/pages/", {"path": "services/vat", "title": "VAT"}, format="json")
        self.admin_client.post("/api/content/services/vat/sections/", {"sections": [
            {"section_type": "rich_text", "content": {"content": "Current copy here"}}]}, format="json")
        r = self.admin_client.get("/api/content/services/vat/build-prompt/?mode=edit&strategy=override&topic=add+pricing")
        prompt = r.data["prompt"]
        self.assertIn("Current copy here", prompt)
        self.assertIn("override", prompt)
        self.assertIn("add pricing", prompt)
        self.assertIn("vat returns leeds", prompt)  # pulled from the page's SEO row
        self.assertEqual(self.admin_client.get("/api/content/missing/build-prompt/").status_code, 404)

    def test_section_prompt(self):
        r = self.admin_client.post("/api/ai/section-prompt/", {
            "content": {"heading": "Hi"}, "section_type": "cta", "path": "services/vat"}, format="json")
        self.assertIn('"heading": "Hi"', r.data["prompt"])
        self.assertIn("button_text", r.data["prompt"])  # field contract from SECTION_SCHEMA
        self.assertEqual(r.data["keyword"], "vat returns leeds")

    def test_page_assist_prompt_and_audit(self):
        r = self.admin_client.post("/api/ai/page-assist-prompt/", {"path": "services/vat", "sections": {
            "hero": {"label": "Hero", "content": {"title": "VAT returns for Leeds firms"}},
            "faq": {"label": "FAQ", "content": {"items": []}},
        }}, format="json")
        self.assertEqual(r.data["audit"]["percent"], 50)
        self.assertIn("faq (FAQ)", r.data["prompt"])
        self.assertEqual(self.admin_client.post("/api/ai/page-assist-prompt/", {"sections": {}}, format="json").status_code, 400)

    def test_seo_and_keyword_prompts(self):
        r = self.admin_client.post("/api/ai/seo-prompt/", {"path": "services/vat", "page_text": "We file VAT."}, format="json")
        self.assertIn("We file VAT.", r.data["prompt"])
        self.assertIn("```json", r.data["prompt"])
        self.assertTrue(any(c["id"] == "title-keyword" for c in r.data["checks"]))
        k = self.admin_client.post("/api/ai/keyword-prompt/", {"path": "services/vat", "location": "York"}, format="json")
        self.assertIn("York", k.data["prompt"])

    def test_prompts_are_admin_only(self):
        for url in ("/api/ai/new-page-prompt/", "/api/content/x/build-prompt/"):
            self.assertEqual(self.client.get(url).status_code, 401)
        for url in ("/api/ai/section-prompt/", "/api/ai/page-assist-prompt/", "/api/ai/seo-prompt/", "/api/ai/keyword-prompt/"):
            self.assertEqual(self.client.post(url, {}, format="json").status_code, 401)

    def test_ai_settings_validation(self):
        r = self.admin_client.patch("/api/settings/site/", {"ai": {"extraRules": "nope"}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("ai.extraRules", r.data)


class PageEditToolsTests(AdminAuthMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.admin_client.post("/api/content/pages/", {"path": "landing/b", "title": "B"}, format="json")
        self.admin_client.post("/api/content/landing/b/sections/", {"sections": [
            {"section_type": "hero", "content": {"heading": "H", "description": "D"},
             "media": [{"slot": "image", "required": False}]},
            {"section_type": "rich_text", "content": {"content": "Old"}},
            {"section_type": "cta", "content": {"heading": "Go", "button_text": "Buy"}},
        ]}, format="json")

    def sections(self):
        return self.admin_client.get("/api/content/landing/b/sections/").data

    def test_add_section_at_position(self):
        r = self.admin_client.post("/api/content/landing/b/sections/add/",
                                   {"section_type": "banner", "content": {"text": "Sale"}, "position": 1}, format="json")
        self.assertEqual(r.status_code, 201)
        self.assertEqual([s["section_type"] for s in self.sections()], ["hero", "banner", "rich_text", "cta"])
        bad = self.admin_client.post("/api/content/landing/b/sections/add/", {"section_type": "nope"}, format="json")
        self.assertEqual(bad.status_code, 400)

    def test_paste_to_edit_updates_in_place_keeps_media_and_trims(self):
        hero_id = self.sections()[0]["id"]
        raw = '[{"type": "hero", "heading": "New H", "description": "New D"}, {"type": "faq", "items": [{"question": "Q", "answer": "A"}]}]'
        r = self.admin_client.post("/api/content/landing/b/paste-to-edit/", {"raw": raw}, format="json")
        self.assertEqual(r.status_code, 200)
        sections = self.sections()
        self.assertEqual([s["section_type"] for s in sections], ["hero", "faq"])
        self.assertEqual(sections[0]["id"], hero_id)  # same row, media kept
        self.assertEqual(sections[0]["content"]["heading"], "New H")
        self.assertEqual(len(sections[0]["media"]), 1)

    def test_paste_to_edit_as_draft(self):
        raw = '{"sections": [{"type": "hero", "heading": "Drafted", "description": "D"}, {"type": "rich_text", "content": "Old"}, {"type": "cta", "heading": "Go", "button_text": "Buy"}]}'
        self.admin_client.post("/api/content/landing/b/paste-to-edit/", {"raw": raw, "as_draft": True}, format="json")
        hero = self.sections()[0]
        self.assertEqual(hero["content"]["heading"], "H")
        self.assertEqual(hero["draft_content"]["heading"], "Drafted")


class HomeSeoResolveTests(AdminAuthMixin, APITestCase):
    def test_root_resolve_uses_home_row_and_root_canonical(self):
        self.admin_client.patch("/api/settings/site/", {"seoDefaults": {"siteUrl": "https://acme.test"}}, format="json")
        self.admin_client.patch("/api/seo/home/", {"seoTitle": "Acme Home"}, format="json")
        for url in ("/api/seo/resolve/", "/api/seo/resolve/home/"):
            data = self.client.get(url).data
            self.assertEqual(data["title"], "Acme Home")
            self.assertEqual(data["canonical"], "https://acme.test")
            crumbs = [n for n in data["jsonLd"]["@graph"] if n["@type"] == "BreadcrumbList"][0]
            self.assertEqual(len(crumbs["itemListElement"]), 1)

    def test_resolve_cache_refreshes_after_write(self):
        self.admin_client.patch("/api/seo/about/", {"seoTitle": "First"}, format="json")
        self.assertEqual(self.client.get("/api/seo/resolve/about/").data["title"], "First")
        self.admin_client.patch("/api/seo/about/", {"seoTitle": "Second"}, format="json")
        self.assertEqual(self.client.get("/api/seo/resolve/about/").data["title"], "Second")


class ImageOptimizeTests(AdminAuthMixin, APITestCase):
    _cache = {}

    def _png(self, size=(900, 600)):
        import io
        from PIL import Image
        from django.core.files.uploadedfile import SimpleUploadedFile
        if size not in self._cache:
            buf = io.BytesIO()
            Image.effect_noise(size, 60).convert("RGB").save(buf, format="PNG")
            self._cache[size] = buf.getvalue()
        return SimpleUploadedFile("photo.png", self._cache[size], content_type="image/png")

    def test_png_becomes_webp_and_dedupe_still_works(self):
        first = self.admin_client.post("/api/images/", {"image": self._png(), "category": "content"}, format="multipart")
        self.assertEqual(first.status_code, 201, first.data)
        self.assertTrue(first.data["image_url"].endswith(".webp"))
        self.assertEqual(first.data["format"], "WEBP")
        again = self.admin_client.post("/api/images/", {"image": self._png(), "category": "content"}, format="multipart")
        self.assertTrue(again.data.get("duplicate"))

    @override_settings(IMAGE_OPTIMIZE=False)
    def test_can_be_disabled(self):
        r = self.admin_client.post("/api/images/", {"image": self._png((300, 200)), "category": "content"}, format="multipart")
        self.assertTrue(r.data["image_url"].endswith(".png"))


class SitemapOverrideTests(AdminAuthMixin, APITestCase):
    def setUp(self):
        super().setUp()
        self.admin_client.patch("/api/settings/site/", {"seoDefaults": {"siteUrl": "https://acme.test"}}, format="json")
        self.admin_client.patch("/api/seo/home/", {"seoTitle": "Home"}, format="json")
        self.admin_client.patch("/api/seo/services/", {"seoTitle": "Services"}, format="json")

    def test_extra_paths_and_overrides(self):
        self.admin_client.patch("/api/settings/site/", {"sitemap": {
            "extraPaths": ["about", "services"],
            "overrides": {"services": {"priority": 0.9}, "about": {"include": False}},
        }}, format="json")
        xml = self.client.get("/sitemap.xml").content.decode()
        self.assertIn("<loc>https://acme.test</loc>", xml)          # home at the root, once
        self.assertEqual(xml.count("https://acme.test/services<"), 1)  # de-duplicated
        self.assertIn("<priority>0.9</priority>", xml)
        self.assertNotIn("https://acme.test/about<", xml)
        report = self.admin_client.get("/api/sitemap/report/").data
        about = [r for r in report["entries"] if r["path"] == "about"][0]
        self.assertEqual((about["source"], about["included"]), ("extra", False))
        self.assertEqual(self.client.get("/api/sitemap/report/").status_code, 401)


class PasteToBuildSeoTests(AdminAuthMixin, APITestCase):
    def test_content_page_gets_seo_from_reply(self):
        raw = ('{"title": "VAT", "seo": {"title": "VAT Returns Leeds", "description": "Desc", '
               '"keywords": ["vat returns leeds", "mtd vat"]}, "sections": [{"type": "rich_text", "content": "x"}]}')
        r = self.admin_client.post("/api/content/paste-to-build/", {"raw": raw, "path": "services/vat"}, format="json")
        self.assertEqual(r.status_code, 201)
        seo = self.admin_client.get("/api/seo/services/vat/").data
        self.assertEqual(seo["seoTitle"], "VAT Returns Leeds")
        self.assertEqual(seo["keywords"], {"primary": "vat returns leeds", "secondary": ["mtd vat"]})


class ImageUsageTests(AdminAuthMixin, APITestCase):
    def setUp(self):
        super().setUp()
        import io
        from PIL import Image
        from django.core.files.uploadedfile import SimpleUploadedFile
        buf = io.BytesIO()
        Image.new("RGB", (40, 30), (200, 10, 10)).save(buf, format="PNG")
        r = self.admin_client.post("/api/images/", {"image": SimpleUploadedFile("a.png", buf.getvalue()), "category": "content"}, format="multipart")
        self.image = r.data

    def test_reference_in_component_counts_as_used(self):
        self.assertEqual(self.admin_client.get("/api/images/?unused=1").data["count"], 1)
        self.admin_client.patch("/api/home/hero/?mode=draft", {"image": self.image["image_url"]}, format="json")
        usage = self.admin_client.get(f"/api/images/{self.image['id']}/usage/").data
        self.assertTrue(usage["in_use"])
        self.assertEqual(self.admin_client.get("/api/images/?unused=1").data["count"], 0)

    def test_delete_in_use_needs_force(self):
        self.admin_client.patch("/api/seo/about/", {"social": {"ogImage": self.image["image_url"]}}, format="json")
        blocked = self.admin_client.delete(f"/api/images/{self.image['id']}/")
        self.assertEqual(blocked.status_code, 409)
        self.assertIn("SEO for /about", blocked.data["usage"])
        self.assertEqual(self.admin_client.delete(f"/api/images/{self.image['id']}/?force=1").status_code, 204)


class CollectionTests(AdminAuthMixin, APITestCase):
    """Collections: site-specific, template-locked entry builders."""

    SERVICES = {
        "label": "Service", "plural": "Services", "hostKind": "content",
        "indexPath": "services", "pathPrefix": "services", "pageType": "service",
        "sections": ["hero", "features", "faq", "cta"], "allowAdd": [],
        "listingNote": "Link it from the home page cards.",
    }
    ARTICLES = {
        "label": "Article", "plural": "Articles", "hostKind": "blog",
        "indexPath": "resources", "pathPrefix": "blog", "pageType": "article",
        "sections": ["rich_text"], "allowAdd": ["rich_text", "image_text", "faq"],
        "fields": {"excerpt": {"label": "Excerpt", "type": "textarea"},
                   "category": {"label": "Category", "options": ["VAT", "Tax"]}},
    }

    def setUp(self):
        super().setUp()
        r = self.admin_client.patch("/api/settings/site/", {"collections": {
            "services": self.SERVICES, "articles": self.ARTICLES}}, format="json")
        self.assertEqual(r.status_code, 200, r.data)

    def _reference_service(self):
        """A published sibling with 3 features and 4 FAQs."""
        page = ContentPage.objects.create(path="services/vat", title="VAT", page_type="service",
                                          body_mode="dynamic", status="published")
        r = self.admin_client.post("/api/content/services/vat/sections/", [
            {"section_type": "hero", "content": {"eyebrow": "VAT", "heading": "VAT returns", "description": "Filed on time."}},
            {"section_type": "features", "content": {"heading": "Why us", "items": [{"title": f"F{i}", "icon": "check"} for i in range(3)]}},
            {"section_type": "faq", "content": {"heading": "FAQ", "items": [{"question": f"Q{i}", "answer": "A"} for i in range(4)]}},
            {"section_type": "cta", "content": {"heading": "Talk to us", "button_text": "Call"}},
        ], format="json")
        self.assertIn(r.status_code, (200, 201), r.data)
        return page

    def test_settings_validation_rejects_unknown_section_types(self):
        r = self.admin_client.patch("/api/settings/site/", {"collections": {"x": {"sections": ["nope"]}}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("collections.x.sections", r.data)

    def test_listing_and_path_roles(self):
        self.assertEqual({c["key"] for c in self.admin_client.get("/api/collections/").data}, {"services", "articles"})
        index = self.admin_client.get("/api/collections/for-path/?path=/services").data
        self.assertEqual((index["collection"]["key"], index["role"]), ("services", "index"))
        entry = self.admin_client.get("/api/collections/for-path/?path=/blog/some-post").data
        self.assertEqual((entry["collection"]["key"], entry["role"]), ("articles", "entry"))
        self.assertIsNone(self.admin_client.get("/api/collections/for-path/?path=/about").data["collection"])
        self.assertEqual(self.client.get("/api/collections/").status_code, 401)

    def test_blank_entry_copies_the_sibling_layout(self):
        self._reference_service()
        r = self.admin_client.post("/api/collections/services/entries/", {"title": "Payroll"}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["entry"]["href"], "/services/payroll")
        self.assertEqual(r.data["entry"]["status"], "draft")
        sections = self.admin_client.get("/api/content/services/payroll/sections/").data
        sections = sections.get("results", sections) if isinstance(sections, dict) else sections
        self.assertEqual([s["section_type"] for s in sections], ["hero", "features", "faq", "cta"])
        self.assertEqual(sections[0]["content"]["heading"], "Payroll")
        self.assertEqual(sections[0]["content"]["eyebrow"], "Eyebrow")       # sibling has one
        self.assertEqual(sections[1]["content"]["items"][0]["icon"], "Icon")  # item keys follow too
        self.assertEqual(len(sections[1]["content"]["items"]), 3)
        self.assertEqual(len(sections[2]["content"]["items"]), 4)
        # No image on the sibling's hero -> optional slot, publishing is not blocked.
        published = self.admin_client.patch("/api/collections/services/entries/payroll/", {"status": "published"}, format="json")
        self.assertEqual(published.status_code, 200, published.data)
        self.assertEqual(self.client.get("/api/content/pages/services/payroll/").status_code, 200)

    def test_messy_ai_reply_is_forced_onto_the_template(self):
        reply = "Sure! Here it is:\n```json\n" + _json.dumps({
            "title": "Payroll Services",
            "seo": {"title": "Payroll Services for Small Businesses | Acme", "description": "x" * 130,
                    "keywords": ["payroll services", "payroll leeds"]},
            "sections": [
                {"type": "cta", "heading": "Start today", "button_text": "Book"},
                {"type": "hero", "content": {"heading": "Payroll [made easy](https://x.y)", "description": "D"}},
                {"type": "statistics", "items": [{"value": "1", "label": "x"}]},
                {"type": "faq", "heading": "FAQ", "items": [{"question": "Q?", "answer": "A."}]},
            ],
        }) + "\n```\nHope that helps!"
        r = self.admin_client.post("/api/collections/services/entries/", {"raw": reply}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["entry"]["slug"], "payroll-services")
        joined = " ".join(r.data["warnings"])
        self.assertIn("features", joined)      # missing slot filled
        self.assertIn("statistics", joined)    # extra type dropped
        sections = self.admin_client.get("/api/content/services/payroll-services/sections/").data
        sections = sections.get("results", sections) if isinstance(sections, dict) else sections
        self.assertEqual([s["section_type"] for s in sections], ["hero", "features", "faq", "cta"])
        self.assertEqual(sections[0]["content"]["heading"], "Payroll made easy")
        seo = self.admin_client.get("/api/seo/services/payroll-services/").data
        self.assertEqual(seo["keywords"]["primary"], "payroll services")

    def test_blog_entries_store_fields_and_keep_flexible_order(self):
        reply = _json.dumps({
            "title": "Making Tax Digital explained",
            "fields": {"excerpt": "What MTD means for you.", "category": "VAT"},
            "sections": [
                {"type": "rich_text", "heading": "Intro", "content": "Para."},
                {"type": "faq", "heading": "FAQ", "items": [{"question": "Q?", "answer": "A."}]},
                {"type": "rich_text", "heading": "More", "content": "Para."},
                {"type": "pricing", "items": [{"name": "x"}]},
            ],
        })
        r = self.admin_client.post("/api/collections/articles/entries/", {"raw": reply}, format="json")
        self.assertEqual(r.status_code, 201, r.data)
        post = BlogPost.objects.get(slug="making-tax-digital-explained")
        self.assertEqual(post.excerpt, "What MTD means for you.")
        self.assertEqual(post.content["category"], "VAT")
        self.assertEqual(r.data["entry"]["href"], "/blog/making-tax-digital-explained")
        types = [s.section_type for s in post.dynamic_sections.order_by("order")]
        self.assertEqual(types, ["rich_text", "faq", "rich_text"])
        # An option outside the list is refused, a valid one is kept.
        self.admin_client.patch(f"/api/collections/articles/entries/{post.slug}/", {"fields": {"category": "Nope"}}, format="json")
        post.refresh_from_db()
        self.assertEqual(post.content["category"], "VAT")

    def test_prompt_is_template_strict_and_repeats_its_rules(self):
        self._reference_service()
        r = self.admin_client.get("/api/collections/services/prompt/?title=Payroll&keyword=payroll%20services")
        self.assertEqual(r.status_code, 200)
        prompt = r.data["prompt"]
        self.assertIn('exactly 4 sections, in exactly this order', prompt)
        self.assertIn('1. "hero"', prompt)
        self.assertIn("STYLE REFERENCE", prompt)
        self.assertIn("VAT returns", prompt)          # the sibling is shown
        self.assertIn("FINAL CHECK", prompt)
        self.assertIn("hero, features, faq, cta", prompt.split("FINAL CHECK")[1])
        self.assertIn("payroll services", prompt)
        blog = self.admin_client.get("/api/collections/articles/prompt/?title=MTD").data["prompt"]
        self.assertIn('exactly one of ["VAT", "Tax"]', blog)

    def test_renaming_a_published_entry_keeps_old_links(self):
        self.admin_client.post("/api/collections/services/entries/", {"title": "Payroll"}, format="json")
        self.admin_client.patch("/api/seo/services/payroll/", {"seoTitle": "Payroll"}, format="json")
        self.admin_client.patch("/api/collections/services/entries/payroll/", {"status": "published"}, format="json")
        r = self.admin_client.patch("/api/collections/services/entries/payroll/", {"slug": "payroll-bureau"}, format="json")
        self.assertEqual(r.data["href"], "/services/payroll-bureau")
        self.assertEqual(Redirect.objects.get(source="/services/payroll").destination, "/services/payroll-bureau")
        self.assertEqual(PageSEO.objects.get(path="services/payroll-bureau").data["seoTitle"], "Payroll")

    def test_renaming_back_and_forth_never_loops(self):
        self.admin_client.post("/api/collections/services/entries/", {"title": "Payroll"}, format="json")
        self.admin_client.patch("/api/collections/services/entries/payroll/", {"status": "published"}, format="json")
        self.admin_client.patch("/api/collections/services/entries/payroll/", {"slug": "payroll-bureau"}, format="json")
        self.admin_client.patch("/api/collections/services/entries/payroll-bureau/", {"slug": "payroll"}, format="json")
        self.assertFalse(Redirect.objects.filter(source="/services/payroll").exists())
        self.assertEqual(Redirect.objects.get(source="/services/payroll-bureau").destination, "/services/payroll")

    def test_option_fields_can_be_cleared(self):
        r = self.admin_client.post("/api/collections/articles/entries/", {"title": "MTD", "fields": {"category": "VAT"}}, format="json")
        slug = r.data["entry"]["slug"]
        self.admin_client.patch(f"/api/collections/articles/entries/{slug}/", {"fields": {"category": ""}}, format="json")
        self.assertEqual(BlogPost.objects.get(slug=slug).content["category"], "")

    def test_delete_removes_entry_sections_and_seo(self):
        self.admin_client.post("/api/collections/services/entries/", {"title": "Payroll"}, format="json")
        self.admin_client.patch("/api/seo/services/payroll/", {"seoTitle": "Payroll"}, format="json")
        self.assertEqual(self.admin_client.delete("/api/collections/services/entries/payroll/").status_code, 204)
        self.assertFalse(ContentPage.objects.filter(path="services/payroll").exists())
        self.assertFalse(PageSEO.objects.filter(path="services/payroll").exists())
        self.assertFalse(DynamicSection.objects.filter(object_id__isnull=False, content__heading="Payroll").exists())

    def test_ai_rewrite_is_fitted_and_saved_as_drafts(self):
        self.admin_client.post("/api/collections/services/entries/", {"title": "Payroll"}, format="json")
        self.admin_client.patch("/api/collections/services/entries/payroll/", {"status": "published"}, format="json")
        reply = _json.dumps({"sections": [
            {"type": "hero", "heading": "Payroll, sorted", "description": "Weekly or monthly."},
            {"type": "faq", "heading": "FAQ", "items": [{"question": "Q?", "answer": "A."}]},
        ]})
        r = self.admin_client.post("/api/collections/services/entries/payroll/apply/", {"raw": reply}, format="json")
        self.assertEqual(r.status_code, 200, r.data)
        types = [s["section_type"] for s in r.data["sections"]]
        self.assertEqual(types, ["hero", "features", "faq", "cta"])
        hero = r.data["sections"][0]
        self.assertEqual(hero["draft_content"]["heading"], "Payroll, sorted")
        self.assertEqual(hero["content"]["heading"], "Payroll")      # live copy untouched until Publish
        prompt = self.admin_client.get("/api/collections/services/entries/payroll/prompt/?instruction=shorter").data["prompt"]
        self.assertIn("CHANGE REQUESTED: shorter", prompt)
        self.assertIn("FINAL CHECK", prompt)


class PromptRepetitionTests(AdminAuthMixin, APITestCase):
    """Every prompt restates its hard rules at the very end."""

    def test_every_prompt_ends_with_the_final_check(self):
        from . import prompts
        checks = [
            prompts.page_prompt(None, {"mode": "create", "title": "X"}),
            prompts.section_prompt(content={"title": "x"}, label="Hero", path="about"),
            prompts.page_assist_prompt(path="about", sections={"hero": {"label": "Hero", "content": {"title": "x"}}})[0],
            prompts.seo_prompt(path="about", seo={}),
            prompts.keyword_prompt(path="about"),
            prompts.copy_structure_prompt(),
        ]
        for prompt in checks:
            tail = prompt[-2500:]
            self.assertIn("FINAL CHECK", tail)

    def test_hard_rules_are_stated_at_least_twice(self):
        """Each hard rule appears in the body AND in the FINAL CHECK."""
        import re
        from . import prompts
        json_prompts = {
            "page": prompts.page_prompt(None, {"mode": "edit", "title": "X",
                                               "existing_sections": [{"type": "hero", "content": {"heading": "x"}}]}),
            "section": prompts.section_prompt(content={"title": "x"}, label="Hero", path="about", keyword="vat"),
            "assist": prompts.page_assist_prompt(path="about", sections={"hero": {"label": "Hero", "content": {"t": "x"}}},
                                                 seo={"keywords": {"primary": "vat"}})[0],
        }
        rules = {
            "json only": r"ONLY (valid )?JSON|ONLY the JSON",
            "never drop list items": r"NEVER remove|No existing list item was removed",
            "no invented facts": r"invent",
            "plain text": r"no HTML",
            "plain URLs": r"markdown-linkified|never \"\[x\]\(x\)\"",
        }
        for name, text in json_prompts.items():
            for rule, pattern in rules.items():
                self.assertGreaterEqual(len(re.findall(pattern, text, re.I)), 2, f"{name}: '{rule}' stated fewer than twice")

    def test_seo_checks_carry_tab_field_and_fix(self):
        from . import prompts
        rules = prompts.seo_rule_checks({})
        self.assertGreaterEqual(len(rules), 18)
        for rule in rules:
            self.assertTrue(rule["fix"] and rule["field"] and rule["tab"] in ("essentials", "sharing", "advanced"), rule)
        ids = [r["id"] for r in rules]
        self.assertEqual(len(ids), len(set(ids)))
        for wanted in prompts.SEO_CHECKS_FOR_PAGE_ASSIST:
            self.assertIn(wanted, ids)


@override_settings(REVALIDATE_SECRET="site-secret", REST_FRAMEWORK={
    **__import__("django.conf").conf.settings.REST_FRAMEWORK,
    "DEFAULT_THROTTLE_RATES": {"anon": "3/minute", "user": "3/minute", "form_submit": "2/minute",
                               "login": "2/minute", "resolve": "3/minute"},
})
class ThrottleExemptionTests(AdminAuthMixin, APITestCase):
    """Staff and the site's own server are not rate-limited like visitors;
    login and form spam limits still apply to everyone."""

    def setUp(self):
        super().setUp()
        from rest_framework.settings import api_settings
        api_settings.reload()
        from rest_framework.throttling import SimpleRateThrottle
        SimpleRateThrottle.THROTTLE_RATES = api_settings.DEFAULT_THROTTLE_RATES
        cache.clear()

    def tearDown(self):
        from rest_framework.settings import api_settings
        from rest_framework.throttling import SimpleRateThrottle
        api_settings.reload()
        SimpleRateThrottle.THROTTLE_RATES = api_settings.DEFAULT_THROTTLE_RATES
        super().tearDown()

    def test_anonymous_visitors_are_limited(self):
        codes = [self.client.get("/api/home/hero/").status_code for _ in range(5)]
        self.assertIn(429, codes)

    def test_site_server_with_the_shared_secret_is_not(self):
        codes = [self.client.get("/api/home/hero/", HTTP_X_CMS_FRONTEND="site-secret").status_code for _ in range(8)]
        codes += [self.client.get("/api/seo/resolve/about/", HTTP_X_CMS_FRONTEND="site-secret").status_code for _ in range(8)]
        self.assertNotIn(429, codes)

    def test_a_wrong_secret_is_limited(self):
        codes = [self.client.get("/api/home/hero/", HTTP_X_CMS_FRONTEND="nope").status_code for _ in range(5)]
        self.assertIn(429, codes)

    def test_staff_are_not_limited_while_editing(self):
        codes = [self.admin_client.patch("/api/home/hero/?mode=draft", {"t": i}, format="json").status_code for i in range(10)]
        codes += [self.admin_client.get("/api/drafts/").status_code for _ in range(10)]
        self.assertNotIn(429, codes)

    def test_form_spam_limit_applies_even_to_the_site_server(self):
        codes = [self.client.post("/api/forms/contact/submit/", {"email": "a@b.co"}, format="json",
                                  HTTP_X_CMS_FRONTEND="site-secret").status_code for _ in range(4)]
        self.assertIn(429, codes)


class IntegrationSpecTests(APITestCase):
    """FRONTEND_INTEGRATION_PROMPT.md states every rule five times, so an
    integrating agent can't miss one: the rule index (§0.1), a rule card with
    Must / Never / Proven by (§0.2), the phase that builds it (§2), an
    anti-pattern (§11) and a checklist line with its gate (§13)."""

    def _spec(self):
        import re
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent
        spec = (root / "FRONTEND_INTEGRATION_PROMPT.md").read_text()
        sections = {p.split("\n", 1)[0][:6].strip("# ").strip(): p for p in re.split(r"\n(?=## )", spec)}
        rules = sorted({int(n) for n in re.findall(r"^\| R(\d+) \|", sections["§0"], re.M)})
        return root, spec, sections, rules

    def test_rules_are_numbered_and_counted(self):
        import re
        _, spec, sections, rules = self._spec()
        self.assertEqual(rules, list(range(1, len(rules) + 1)), "rules must be numbered R1..Rn without gaps")
        self.assertIn(f"There are {len(rules)} rules, R1–R{rules[-1]}", spec)
        self.assertIn(f"R1–R{rules[-1]}", sections["§12"], "the fill-in prompt must name every rule")
        stale = {m for m in re.findall(r"R1–R(\d+)", spec) if int(m) != rules[-1]}
        self.assertFalse(stale, f"stale rule ranges in the spec: R1–R{', R1–R'.join(sorted(stale))}")

    def test_every_rule_is_stated_five_times(self):
        import re
        _, _, sections, rules = self._spec()
        zero, phases = sections["§0"], sections["§2"]
        built = {}
        for phase, listed in re.findall(r"\*\*(P\d) — [^*]*?Rules: ([^*]+?)\.?\*\*", phases):
            built[phase] = set(range(1, rules[-1] + 1)) if listed.startswith("all") else {int(n) for n in re.findall(r"R(\d+)", listed)}
        self.assertEqual(sorted(built), [f"P{i}" for i in range(9)], "every phase P0–P8 must name the rules it builds")
        for n in rules:
            row = re.search(rf"^\| R{n} \|(.+)\|$", zero, re.M)
            self.assertEqual(len(row.group(1).split("|")), 4, f"R{n}: index row needs Area | Rule | Proven by | Built in")
            for phase in re.findall(r"P\d(?!–)", row.group(1).split("|")[-1]):
                self.assertIn(n, built[phase], f"R{n}: the index says {phase} builds it, but {phase} doesn't list it")
            card = re.search(rf"^#### R{n} — .+?(?=^#### |\Z)", zero, re.M | re.S)
            self.assertIsNotNone(card, f"R{n} has no rule card in §0.2")
            for part in ("**Must:**", "**Never:**", "**Proven by:**"):
                self.assertIn(part, card.group(0), f"R{n} card is missing {part}")
            self.assertTrue(any(n in r for p, r in built.items() if p != "P8"), f"R{n} is not built by any phase P0–P7")
            self.assertRegex(sections["§11"], rf"(?m)^- \*\*R{n}\*\* ", f"R{n} has no anti-pattern in §11")
            self.assertRegex(sections["§13"], rf"(?m)^- \[ \] \*\*R{n}\*\* .+\(.+\)$", f"R{n} has no checklist line with its gate in §13")

    def test_the_agent_audits_at_every_level(self):
        """Every phase ends with an Exit check, and P8 verifies in three passes
        (fix until green → clean re-verification → rule-by-rule audit)."""
        _, spec, sections, _ = self._spec()
        for i in range(9):
            self.assertIn(f"**Exit check P{i}:**", sections["§2"], f"P{i} has no Exit check")
        p8 = sections["§2"][sections["§2"].index("**P8 — "):]
        for marker in ("**Pass 1 — fix until green.**", "**Pass 2 — clean re-verification.**", "**Pass 3 — rule-by-rule audit.**",
                       "rerun **every gate**", "go back to Pass 1", "--pass 1", "--pass 2", "--pass 3 --report"):
            self.assertIn(marker, p8)
        self.assertIn("Audit at three levels", spec)
        self.assertIn("Pass 3", sections["§13"], "the checklist must be walked in the final audit pass")

    def test_every_rule_has_machine_evidence(self):
        """No rule is left to memory: rules-map.json maps every rule in §0.1
        to gates that run-gates.mjs runs, and no rule is "review" only."""
        import json
        import re
        root, spec, sections, rules = self._spec()
        acceptance = root / "frontend-kit" / "acceptance"
        mapping = json.loads((acceptance / "rules-map.json").read_text())
        mapping.pop("_about", None)
        self.assertEqual(sorted(mapping), sorted(f"R{n}" for n in rules), "rules-map.json must list exactly R1..Rn")
        runner = (acceptance / "run-gates.mjs").read_text()
        for rule, items in mapping.items():
            self.assertTrue(items, f"{rule} has no evidence")
            for item in items:
                self.assertIn(f'"{item["gate"]}"', runner, f"{rule}: gate {item['gate']} isn't run by run-gates.mjs")
        for n in rules:
            row = re.search(rf"^\| R{n} \|(.+)\|$", sections["§0"], re.M).group(1)
            self.assertNotIn("review", row.split("|")[-2].lower(), f"R{n} is proven only by review — give it a gate")
        self.assertNotIn("(review", sections["§13"])

    def test_the_definition_of_done_is_unmissable(self):
        root, spec, sections, rules = self._spec()
        done = "ALL GATES GREEN — 3 of 3 passes"
        self.assertIn(done, spec[:3000], "the done-line must be stated in the first screen of the spec")
        self.assertIn(done, sections["§12"])
        self.assertTrue(spec.rstrip().split("## ")[-1].startswith("FINAL CHECK"), "the spec must END with the FINAL CHECK section")
        self.assertIn(done, spec.rstrip().split("## ")[-1])
        for phrase in ("visual.mjs --baseline", "CMS_REPORT.md", "Never weaken a gate", "fingerprint"):
            self.assertIn(phrase, spec)
        self.assertIn("visual/baseline/index.json", sections["§2"], "P0 must exit with the visual baseline taken")
        runner = (root / "frontend-kit" / "acceptance" / "run-gates.mjs").read_text()
        self.assertIn(done, runner)
        for doc in ("AGENTS.md", "frontend-kit/MANIFEST.md"):
            self.assertIn("run-gates.mjs", (root / doc).read_text(), doc)

    def test_companion_docs_name_the_current_rule_range(self):
        import re
        root, _, _, rules = self._spec()
        for doc in ("AGENTS.md", "README.md", "frontend-kit/README.md", "frontend-kit/MANIFEST.md"):
            path = root / doc
            if path.exists():
                stale = {m for m in re.findall(r"R1[–-]R(\d+)", path.read_text()) if int(m) != rules[-1]}
                self.assertFalse(stale, f"{doc} names a stale rule range (rules go to R{rules[-1]})")

    def test_owner_launch_guide_covers_every_launch_warning(self):
        """Every owner step the launch check asks for is explained in LAUNCH_GUIDE.md,
        and the spec, AGENTS and README send people there."""
        root, spec, _, _ = self._spec()
        guide = (root / "LAUNCH_GUIDE.md").read_text()
        for topic in ("Public site URL", "Form notifications", "FormSubmit", "Search Console", "sitemap.xml",
                      "Search engine verification", "Bing", "Tag Manager", "GA4", "generate_lead",
                      "Consent default", "cookie banner", "launch check"):
            self.assertIn(topic, guide, f"LAUNCH_GUIDE.md must cover {topic}")
        self.assertIn("LAUNCH_GUIDE.md", spec)
        for doc in ("AGENTS.md", "README.md"):
            self.assertIn("LAUNCH_GUIDE.md", (root / doc).read_text(), doc)
        self.assertNotRegex(guide, r"(?i)zfk|accountan", "the launch guide is generic")


class TitleTemplateTests(APITestCase):
    def test_brand_is_not_doubled_and_long_titles_drop_it(self):
        from .seo_resolve import apply_title_template as t
        tpl = "%s | Acme Ltd"
        self.assertEqual(t("VAT Returns", tpl), "VAT Returns | Acme Ltd")
        self.assertEqual(t("UK Accountants | Acme Ltd", tpl), "UK Accountants | Acme Ltd")
        long = "Preparing Your Annual Accounts: Key Deadlines for 2026"
        self.assertEqual(t(long, tpl), long)
        self.assertEqual(t("Anything", "%s"), "Anything")


class DeleteCleanupTests(AdminAuthMixin, APITestCase):
    def test_deleting_a_page_or_post_removes_its_seo_and_sections(self):
        ContentPage.objects.create(path="gone", title="Gone", status="draft")
        self.admin_client.post("/api/content/gone/sections/", [{"section_type": "rich_text", "content": {"content": "x"}}], format="json")
        self.admin_client.patch("/api/seo/gone/", {"seoTitle": "Gone"}, format="json")
        post = BlogPost.objects.create(title="Old post", status="draft")
        self.admin_client.patch(f"/api/seo/blog/{post.slug}/", {"seoTitle": "Old"}, format="json")
        self.assertEqual(self.admin_client.delete("/api/content/pages/gone/").status_code, 204)
        post.delete()
        self.assertFalse(PageSEO.objects.filter(path__in=["gone", f"blog/{post.slug}"]).exists())
        self.assertFalse(DynamicSection.objects.filter(content__content="x").exists())


class LaunchCheckTests(AdminAuthMixin, APITestCase):
    def _ids(self):
        r = self.admin_client.get("/api/launch-check/")
        self.assertEqual(r.status_code, 200)
        return r.data, {i["id"]: i for i in r.data["items"]}

    @override_settings(FORM_NOTIFICATION_EMAIL="", EMAIL_BACKEND="django.core.mail.backends.console.EmailBackend")
    def test_blocks_a_site_that_is_not_ready(self):
        self.admin_client.patch("/api/settings/site/", {"seoDefaults": {"siteUrl": "http://localhost:3000"}}, format="json")
        self.admin_client.patch("/api/home/footer/", {"email": "info@example.co.uk", "regulatory": ["ICO: [Insert ICO number]"]}, format="json")
        data, ids = self._ids()
        self.assertFalse(data["ready"])
        for blocker in ("site-url", "lead-email", "placeholders"):
            self.assertEqual(ids[blocker]["level"], "blocker", blocker)
        self.assertIn("footer", ids["placeholders"]["detail"])

    @override_settings(FORM_NOTIFICATION_EMAIL="leads@acme.test", EMAIL_BACKEND="django.core.mail.backends.smtp.EmailBackend",
                       FRONTEND_REVALIDATE_URL="https://acme.test/api/revalidate", REVALIDATE_SECRET="s", DEBUG=False)
    def test_ready_when_configured(self):
        self.admin_client.patch("/api/settings/site/", {"seoDefaults": {"siteUrl": "https://acme.test", "defaultOgImage": "/og.png"}}, format="json")
        self.admin_client.patch("/api/home/footer/", {"email": "hello@acme.test"}, format="json")
        data, ids = self._ids()
        self.assertTrue(data["ready"], data)
        self.assertNotIn("og-default", ids)

    @override_settings(FORM_NOTIFICATION_EMAIL="leads@acme.test", EMAIL_BACKEND="django.core.mail.backends.console.EmailBackend")
    def test_smtp_only_setup_with_console_backend_is_blocked(self):
        _, ids = self._ids()
        self.assertEqual(ids["email-backend"]["level"], "blocker")
        self.assertNotIn("lead-email", ids)

    @override_settings(FORM_NOTIFICATION_EMAIL="", EMAIL_BACKEND="django.core.mail.backends.console.EmailBackend")
    def test_formsubmit_address_clears_the_lead_blockers(self):
        self.admin_client.patch("/api/settings/site/", {"forms": {"notifyEmail": "leads@acme.test"}}, format="json")
        _, ids = self._ids()
        self.assertNotIn("lead-email", ids)
        self.assertNotIn("email-backend", ids)
        self.assertEqual(ids["formsubmit-alias"]["level"], "warning")
        self.admin_client.patch("/api/settings/site/", {"forms": {"notifyEmail": "a1b2c3d4e5f6a7b8c9d0e1f2"}}, format="json")
        _, ids = self._ids()
        self.assertNotIn("formsubmit-alias", ids)

    def test_admin_only(self):
        self.assertEqual(self.client.get("/api/launch-check/").status_code, 401)

    def test_warns_until_search_console_and_analytics_are_set_up(self):
        _, ids = self._ids()
        self.assertEqual(ids["search-verification"]["level"], "warning")
        self.assertEqual(ids["analytics"]["level"], "warning")
        self.assertIn("LAUNCH_GUIDE.md", ids["search-verification"]["fix"])
        self.admin_client.patch("/api/settings/site/", {"verification": {"google": "abc123XYZ_-"}, "analytics": {"gtmId": "GTM-ABC1234"}}, format="json")
        _, ids = self._ids()
        self.assertNotIn("search-verification", ids)
        self.assertNotIn("analytics", ids)
        self.assertEqual(ids["consent"]["level"], "warning")
        self.admin_client.patch("/api/settings/site/", {"analytics": {"consentDefault": "denied"}}, format="json")
        _, ids = self._ids()
        self.assertNotIn("consent", ids)

    def test_bing_alone_counts_as_verified(self):
        self.admin_client.patch("/api/settings/site/", {"verification": {"bing": "0123456789ABCDEF0123456789ABCDEF"}}, format="json")
        _, ids = self._ids()
        self.assertNotIn("search-verification", ids)


class SearchVerificationSettingsTests(AdminAuthMixin, APITestCase):
    def patch(self, body):
        return self.admin_client.patch("/api/settings/site/", body, format="json")

    def test_a_pasted_meta_tag_is_reduced_to_its_code(self):
        r = self.patch({"verification": {
            "google": '<meta name="google-site-verification" content="AbC123_dEf-456" />',
            "bing": "<meta name='msvalidate.01' content='0123456789ABCDEF' >",
            "pinterest": "  abc123def456  ",
        }})
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data["verification"]["google"], "AbC123_dEf-456")
        self.assertEqual(r.data["verification"]["bing"], "0123456789ABCDEF")
        self.assertEqual(r.data["verification"]["pinterest"], "abc123def456")

    def test_garbage_is_rejected_with_a_hint(self):
        r = self.patch({"verification": {"google": "<script>alert(1)</script>", "bing": "has spaces in it"}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("verification.google", r.data)
        self.assertIn("verification.bing", r.data)
        self.assertIn("content=", r.data["verification.google"])

    def test_codes_reach_the_resolved_metadata(self):
        self.patch({"verification": {"google": "gsc-code-1"}})
        r = self.client.get("/api/seo/resolve/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["verification"]["google"], "gsc-code-1")


class SubmissionDeleteTests(AdminAuthMixin, APITestCase):
    def test_admin_can_delete_a_submission_visitors_cannot(self):
        from .models import FormSubmission
        sub = FormSubmission.objects.create(form_name="quote", data={"name": "x"})
        self.assertEqual(self.client.delete(f"/api/forms/quote/submissions/{sub.pk}/").status_code, 401)
        self.assertEqual(self.admin_client.delete(f"/api/forms/quote/submissions/{sub.pk}/").status_code, 204)
        self.assertFalse(FormSubmission.objects.filter(pk=sub.pk).exists())


class TrackingAndFormSettingsTests(AdminAuthMixin, APITestCase):
    def patch(self, body):
        return self.admin_client.patch("/api/settings/site/", body, format="json")

    def test_valid_tracking_settings_are_accepted(self):
        r = self.patch({"analytics": {"gtmId": "GTM-ABC1234", "ga4Id": "G-ABC123XYZ", "metaPixelId": "123456789012345",
                                      "googleAdsId": "AW-123456789", "googleAdsLeadLabel": "AbC-D_efG",
                                      "dataLayer": [{"key": "site_section", "value": "accounting"}, {"key": "is_uk", "value": True}],
                                      "consentDefault": "denied", "events": {"pageView": True, "lead": True, "contactClicks": False}},
                        "forms": {"notifyEmail": "leads@acme.test", "subjectPrefix": "New enquiry"}})
        self.assertEqual(r.status_code, 200, r.data)

    def test_wrong_ids_are_rejected_with_an_example(self):
        r = self.patch({"analytics": {"gtmId": "UA-12345", "ga4Id": "G-", "metaPixelId": "abc", "dataLayer": [{"key": "bad key", "value": 1}],
                                      "consentDefault": "maybe", "googleAdsLeadLabel": "AbCdEf"}})
        self.assertEqual(r.status_code, 400)
        for key in ("analytics.gtmId", "analytics.ga4Id", "analytics.metaPixelId", "analytics.dataLayer[0].key",
                    "analytics.consentDefault", "analytics.googleAdsLeadLabel"):
            self.assertIn(key, r.data)
        self.assertIn("GTM-", r.data["analytics.gtmId"])

    def test_notification_email_must_be_an_email_or_alias(self):
        self.assertEqual(self.patch({"forms": {"notifyEmail": "not an email"}}).status_code, 400)
        self.assertEqual(self.patch({"forms": {"notifyEmail": "a1b2c3d4e5f6a7b8c9d0"}}).status_code, 200)


class OrganizationLogoTests(APITestCase):
    def test_relative_logo_becomes_absolute(self):
        from .schema_builders import organization
        node = organization({"organization": {"name": "Acme", "logo": "/images/brand/logo.png"},
                             "seoDefaults": {"siteUrl": "https://acme.test/"}})
        self.assertEqual(node["logo"]["url"], "https://acme.test/images/brand/logo.png")
        node = organization({"organization": {"name": "Acme", "logo": "https://cdn.test/l.png"}, "seoDefaults": {"siteUrl": "https://acme.test"}})
        self.assertEqual(node["logo"]["url"], "https://cdn.test/l.png")


class ClaimsCheckTests(AdminAuthMixin, APITestCase):
    def _claims(self):
        items = {i["id"]: i for i in self.admin_client.get("/api/launch-check/").data["items"]}
        return items.get("claims")

    def test_invented_looking_claims_and_visible_testimonials_are_flagged(self):
        self.admin_client.put("/api/home/home-hero/", {"rating": "Trusted by 250+ UK users", "badge": "Fixed fees, no surprises"}, format="json")
        self.admin_client.put("/api/home/home-testimonials/", {"testimonials": [{"name": "Sam", "text": "Great"}]}, format="json")
        claims = self._claims()
        self.assertEqual(claims["level"], "warning")
        texts = " | ".join(f"{h['text']} @ {h['where']}" for h in claims["where"])
        self.assertIn("250+", texts)
        self.assertIn("Fixed fees", texts)
        self.assertIn("testimonials are visible", texts)

    def test_hidden_or_honest_content_is_not_flagged(self):
        self.admin_client.put("/api/home/home-hero/", {"title": "Online accountants for UK businesses", "fee": "Tailored quotes"}, format="json")
        self.admin_client.put("/api/home/home-testimonials/", {"_hidden": True, "testimonials": [{"name": "Sam", "text": "4.9/5"}]}, format="json")
        self.assertIsNone(self._claims())


class SectionOptionalFieldTests(APITestCase):
    def test_hero_highlights_and_secondary_buttons_validate(self):
        from .dynamic_pages import _validate_section_fields, SECTION_SCHEMA
        ok = {"heading": "Payroll", "description": "Run monthly.", "secondary_text": "Guide", "secondary_href": "/blog/x",
              "highlights": [{"label": "How often", "value": "Monthly"}]}
        self.assertEqual(_validate_section_fields(ok, SECTION_SCHEMA["hero"]), [])
        bad = {**ok, "highlights": "monthly"}
        self.assertTrue(_validate_section_fields(bad, SECTION_SCHEMA["hero"]))
        self.assertIn("secondary_text", SECTION_SCHEMA["cta"])


class DeletePageWithMediaTests(AdminAuthMixin, APITestCase):
    def test_deleting_a_page_whose_sections_have_media_does_not_crash(self):
        from .models import SectionMedia
        page = ContentPage.objects.create(path="gone-with-media", title="Gone", status="published")
        self.admin_client.post("/api/content/gone-with-media/sections/", {"sections": [
            {"section_type": "hero", "content": {"heading": "Hi", "description": "There"},
             "media": [{"slot": "image", "required": False, "image_prompt": "A photo"}]},
        ]}, format="json")
        self.assertTrue(SectionMedia.objects.filter(section__object_id=page.pk).exists())
        self.assertEqual(self.admin_client.delete("/api/content/pages/gone-with-media/").status_code, 204)
        self.assertFalse(ContentPage.objects.filter(path="gone-with-media").exists())


class ContentSchemaTests(AdminAuthMixin, APITestCase):
    """Service pages get Service + FAQPage structured data from their own
    published sections, with no per-page configuration."""

    def _types(self, path):
        graph = self.client.get(f"/api/seo/resolve/{path}/").data["jsonLd"]["@graph"]
        return {node.get("@type"): node for node in graph}

    def test_service_page_gets_service_and_faq_from_its_sections(self):
        ContentPage.objects.create(path="services/payroll", title="Monthly Payroll", page_type="service", status="published")
        self.admin_client.post("/api/content/services/payroll/sections/", [
            {"section_type": "hero", "content": {"heading": "Payroll", "description": "Monthly payroll, run for you."}},
            {"section_type": "faq", "content": {"items": [
                {"question": "Do you handle RTI?", "answer": "Yes, every pay run."},
                {"question": "Hidden?", "answer": "Not shown.", "_hidden": True},
            ]}},
        ], format="json")
        self.admin_client.patch("/api/seo/services/payroll/", {"metaDescription": "Payroll run monthly for UK employers."}, format="json")
        nodes = self._types("services/payroll")
        self.assertEqual(nodes["Service"]["name"], "Monthly Payroll")
        self.assertEqual(nodes["Service"]["description"], "Payroll run monthly for UK employers.")
        questions = [q["name"] for q in nodes["FAQPage"]["mainEntity"]]
        self.assertEqual(questions, ["Do you handle RTI?"])

    def test_explicit_config_wins_and_drafts_get_nothing(self):
        ContentPage.objects.create(path="services/draft", title="Draft", page_type="service", status="draft")
        self.assertNotIn("Service", self._types("services/draft"))
        ContentPage.objects.create(path="about-us", title="About", page_type="generic", status="published")
        self.assertNotIn("Service", self._types("about-us"))


class HiddenContentTests(AdminAuthMixin, APITestCase):
    @override_settings(FORM_NOTIFICATION_EMAIL="x@acme.test")
    def test_hidden_placeholders_do_not_block_launch(self):
        self.admin_client.patch("/api/home/footer/", {"regulatory": [{"text": "[Insert ICO number]", "_hidden": True}],
                                                      "promo": {"_hidden": True, "text": "lorem ipsum"}}, format="json")
        ids = {i["id"] for i in self.admin_client.get("/api/launch-check/").data["items"]}
        self.assertNotIn("placeholders", ids)
