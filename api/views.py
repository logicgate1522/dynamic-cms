from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.mail import send_mail
from django.db import transaction
from django.utils import timezone

from rest_framework import generics, permissions, status
from rest_framework.authtoken.models import Token
from rest_framework.generics import ListCreateAPIView, ListAPIView
from rest_framework.permissions import AllowAny, IsAdminUser
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
from rest_framework.viewsets import ModelViewSet

from .models import BlogPost, ComponentData, FormSubmission, PageSEO, Redirect, SiteSettings, UploadedImage
from .serializers import (
    BlogPostSerializer,
    FormSubmissionSerializer,
    PageSEOSerializer,
    RedirectSerializer,
    UploadedImageSerializer,
)
from .utils import deep_merge


# ==================== ADMIN LOGIN ====================

class AdminLoginView(APIView):
    """
    Self-contained email+password login for the CMS admin UI. Depends on
    nothing but Django's own auth (get_user_model) and DRF's built-in
    TokenAuthentication — no social login, no JWT, no third-party auth
    package. Returns {"key": "<token>"} on success, matching what the
    frontend's login page already expects (`data.key || data.token`).

    Only accounts with is_staff=True can obtain a token here — this is the
    same admin gate every write endpoint in this app checks.
    """
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'login'  # dedicated brute-force budget, separate from form_submit

    def post(self, request, *args, **kwargs):
        email = (request.data.get('email') or '').strip()
        password = request.data.get('password') or ''

        if not email or not password:
            return Response(
                {"detail": "email and password are required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        User = get_user_model()
        user = User.objects.filter(email__iexact=email).first()

        if user is None or not user.is_active or not user.check_password(password):
            return Response(
                {"detail": "Unable to log in with those credentials."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not user.is_staff:
            return Response(
                {"detail": "This account does not have admin access."},
                status=status.HTTP_403_FORBIDDEN,
            )

        token, _ = Token.objects.get_or_create(user=user)
        return Response({"key": token.key})


# ==================== COMPONENT DATA (generic CMS content) ====================

class ComponentDataView(APIView):
    """
    Generic GET/PATCH/PUT/DELETE for a named ComponentData JSON blob.

    Backs the inline-editable ("CMS") sections of the site — Footer, hero
    sections, form definitions, and other informational content. GET is
    public and never 404s: an unknown name returns an empty scaffold so a
    brand-new frontend component can render its own defaults with nothing
    preseeded. Write methods require an admin (is_staff) account and upsert
    the row (create it if it doesn't exist yet).
    """
    model_name = None

    def get_permissions(self):
        if self.request.method == 'GET':
            return [AllowAny()]
        return [IsAdminUser()]

    def _name(self):
        return self.model_name or self.kwargs.get('name')

    def get(self, request, *args, **kwargs):
        try:
            component = ComponentData.objects.get(name=self._name())
            return Response(component.data)
        except ComponentData.DoesNotExist:
            return Response({})

    def patch(self, request, *args, **kwargs):
        name = self._name()
        # select_for_update + atomic: two admins (or an admin double-clicking
        # Save) PATCHing the same name concurrently must not race on the
        # read-modify-write merge below and silently drop one edit.
        with transaction.atomic():
            component, created = ComponentData.objects.select_for_update().get_or_create(
                name=name, defaults={"data": request.data}
            )
            if not created:
                component.data = deep_merge(component.data, request.data)
                component.save()
        return Response(component.data)

    def put(self, request, *args, **kwargs):
        component, _ = ComponentData.objects.update_or_create(
            name=self._name(), defaults={"data": request.data}
        )
        return Response(component.data)

    def delete(self, request, *args, **kwargs):
        ComponentData.objects.filter(name=self._name()).delete()
        return Response(status=204)


# ==================== IMAGE UPLOADS ====================

class UploadedImageViewSet(ListCreateAPIView):
    queryset = UploadedImage.objects.all()
    serializer_class = UploadedImageSerializer

    def get_permissions(self):
        if self.request.method == 'GET':
            return [AllowAny()]
        return [IsAdminUser()]


class RetrieveImage(generics.RetrieveUpdateDestroyAPIView):
    queryset = UploadedImage.objects.all()
    serializer_class = UploadedImageSerializer

    def get_permissions(self):
        if self.request.method == 'GET':
            return [AllowAny()]
        return [IsAdminUser()]


# ==================== SITE-WIDE SETTINGS (singleton) ====================

class SiteSettingsView(APIView):
    """GET/PATCH the single site-wide settings row (org identity, scripts, default SEO)."""

    def get_permissions(self):
        if self.request.method == 'GET':
            return [AllowAny()]
        return [IsAdminUser()]

    def get(self, request, *args, **kwargs):
        settings_row = SiteSettings.objects.filter(pk=1).first()
        return Response(settings_row.data if settings_row else {})

    def patch(self, request, *args, **kwargs):
        with transaction.atomic():
            settings_row, created = SiteSettings.objects.select_for_update().get_or_create(
                pk=1, defaults={"data": request.data}
            )
            if not created:
                settings_row.data = deep_merge(settings_row.data or {}, request.data)
                settings_row.save()
        return Response(settings_row.data)


# ==================== PAGE SEO ====================

class PageSEOListView(ListAPIView):
    """All PageSEO rows — used by the frontend for sitemap generation and cross-page audits.
    Paginated like every other list endpoint in this API (DEFAULT_PAGINATION_CLASS)."""
    queryset = PageSEO.objects.all()
    serializer_class = PageSEOSerializer
    permission_classes = [AllowAny]


class PageSEODetailView(APIView):
    """GET/PATCH a single page's SEO fields, keyed by path. Same upsert-safe contract as ComponentDataView."""

    def get_permissions(self):
        if self.request.method == 'GET':
            return [AllowAny()]
        return [IsAdminUser()]

    def get(self, request, *args, **kwargs):
        try:
            row = PageSEO.objects.get(path=kwargs.get('path'))
            return Response(row.data)
        except PageSEO.DoesNotExist:
            return Response({})

    def patch(self, request, *args, **kwargs):
        path = kwargs.get('path')
        with transaction.atomic():
            row, created = PageSEO.objects.select_for_update().get_or_create(
                path=path, defaults={"data": request.data}
            )
            if not created:
                row.data = deep_merge(row.data or {}, request.data)
                row.save()
        return Response(row.data)


# ==================== BLOG ====================

class BlogPostViewSet(ModelViewSet):
    serializer_class = BlogPostSerializer
    lookup_field = 'slug'

    def get_permissions(self):
        if self.request.method in permissions.SAFE_METHODS:
            return [AllowAny()]
        return [IsAdminUser()]

    def get_queryset(self):
        queryset = BlogPost.objects.all()
        if not (self.request.user and self.request.user.is_staff):
            # A "published" post with a future published_at is a scheduled
            # post, not a live one yet — only admins should see it early.
            queryset = queryset.filter(status="published", published_at__lte=timezone.now())
        return queryset


# ==================== REDIRECTS ====================

class RedirectViewSet(ModelViewSet):
    queryset = Redirect.objects.all()
    serializer_class = RedirectSerializer

    def get_permissions(self):
        if self.request.method in permissions.SAFE_METHODS:
            return [AllowAny()]
        return [IsAdminUser()]


# ==================== FORM SUBMISSIONS ====================

class FormSubmitView(APIView):
    """Public, throttled endpoint that accepts a submission for a named form definition."""
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'form_submit'

    def post(self, request, *args, **kwargs):
        form_name = kwargs.get('name')
        payload = dict(request.data)

        # Honeypot: a hidden field real users never fill in. Silently accept
        # (don't tip off bots) but never persist it.
        if payload.pop("website", None):
            return Response({"success": True})

        FormSubmission.objects.create(form_name=form_name, data=payload)
        self._notify(form_name, payload)
        return Response({"success": True}, status=status.HTTP_201_CREATED)

    def _notify(self, form_name, payload):
        """Best-effort email nudge so a new booking/lead doesn't just sit
        unread until someone happens to poll the submissions endpoint.
        Never lets a notification failure fail the submission itself."""
        recipient = getattr(settings, 'FORM_NOTIFICATION_EMAIL', '')
        if not recipient:
            return
        body_lines = [f"New '{form_name}' form submission:\n"]
        body_lines += [f"{key}: {value}" for key, value in payload.items()]
        send_mail(
            subject=f"New {form_name} submission",
            message="\n".join(body_lines),
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[recipient],
            fail_silently=True,
        )


class FormSubmissionListView(ListAPIView):
    """Admin-only list of submissions for a named form."""
    serializer_class = FormSubmissionSerializer
    permission_classes = [IsAdminUser]

    def get_queryset(self):
        return FormSubmission.objects.filter(form_name=self.kwargs.get('name'))
