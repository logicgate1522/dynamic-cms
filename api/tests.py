from django.contrib.auth import get_user_model
from django.core import mail
from django.core.cache import cache
from django.test import override_settings
from django.utils import timezone
from datetime import timedelta

from rest_framework import status
from rest_framework.test import APITestCase

from rest_framework.authtoken.models import Token

from .models import BlogPost, ComponentData, PageSEO, Redirect, SiteSettings

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
