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

from .models import (
    BlogPost,
    ComponentData,
    ComponentRevision,
    ComponentSchema,
    FormSubmission,
    PageSEO,
    Redirect,
    SEOChangeHistory,
    SiteSettings,
    UploadedImage,
)
from . import schema_builders
from .seo_resolve import resolve_seo
from .schema_validation import validate_against_schema
from .settings_validation import validate_site_settings
from .serializers import (
    BlogPostSerializer,
    ComponentRevisionSerializer,
    ComponentSchemaSerializer,
    FormSubmissionSerializer,
    PageSEOSerializer,
    RedirectSerializer,
    UploadedImageSerializer,
)
from .utils import deep_merge

REVISION_HISTORY_LIMIT = 20


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
        except ComponentData.DoesNotExist:
            return Response({})
        # ?mode=draft returns the working copy (admin editors); default GET
        # is unchanged — the public/published payload.
        if request.query_params.get("mode") == "draft":
            return Response(component.draft_data or component.data)
        return Response(component.data)

    def _resolve_schema(self, schema_key):
        if not schema_key:
            return None
        row = ComponentSchema.objects.filter(key=schema_key).first()
        return row.schema if row else None

    def patch(self, request, *args, **kwargs):
        name = self._name()
        draft_mode = request.query_params.get("mode") == "draft"
        payload = request.data if isinstance(request.data, dict) else {}
        incoming_schema_key = payload.get("schema_key")

        # select_for_update + atomic: concurrent PATCHes on the same name must
        # not race on the read-modify-write merge and silently drop an edit.
        with transaction.atomic():
            component, created = ComponentData.objects.select_for_update().get_or_create(
                name=name, defaults={"data": {} if draft_mode else {}}
            )

            schema_key = incoming_schema_key or component.schema_key
            schema = self._resolve_schema(schema_key)
            base = (component.draft_data or component.data) if draft_mode else component.data
            merged = deep_merge(base or {}, payload)
            merged.pop("schema_key", None)  # not part of the content payload

            if schema is not None:
                errors = validate_against_schema(payload, schema)
                if errors:
                    return Response(errors, status=status.HTTP_400_BAD_REQUEST)

            if incoming_schema_key is not None:
                component.schema_key = incoming_schema_key
            if draft_mode:
                component.draft_data = merged
                component.status = "draft"
            else:
                component.data = merged
            component.updated_by = request.user if request.user.is_authenticated else None
            component.save()

            self._snapshot(component, request.user, "draft edit" if draft_mode else "edit")

        return Response(component.draft_data if draft_mode else component.data)

    def put(self, request, *args, **kwargs):
        payload = request.data if isinstance(request.data, dict) else {}
        with transaction.atomic():
            component, _ = ComponentData.objects.update_or_create(
                name=self._name(), defaults={"data": payload}
            )
            component.updated_by = request.user if request.user.is_authenticated else None
            component.save(update_fields=["updated_by"])
            self._snapshot(component, request.user, "replace (PUT)")
        return Response(component.data)

    def delete(self, request, *args, **kwargs):
        ComponentData.objects.filter(name=self._name()).delete()
        return Response(status=204)

    @staticmethod
    def _snapshot(component, user, note):
        ComponentRevision.objects.create(
            component=component,
            data=component.data,
            saved_by=user if getattr(user, "is_authenticated", False) else None,
            note=note,
        )


class ComponentSchemaListView(ListAPIView):
    """GET home/schemas/ — public discovery of every editable-field contract."""
    queryset = ComponentSchema.objects.all()
    serializer_class = ComponentSchemaSerializer
    permission_classes = [AllowAny]
    pagination_class = None


class ComponentHistoryView(APIView):
    """GET home/<name>/history/ — last N revisions (admin)."""
    permission_classes = [IsAdminUser]

    def get(self, request, *args, **kwargs):
        component = ComponentData.objects.filter(name=kwargs.get("name")).first()
        if component is None:
            return Response({"detail": "No such component."}, status=status.HTTP_404_NOT_FOUND)
        revisions = component.revisions.all()[:REVISION_HISTORY_LIMIT]
        return Response(ComponentRevisionSerializer(revisions, many=True).data)


class ComponentPublishView(APIView):
    """POST home/<name>/publish/ — copy draft_data -> data (admin)."""
    permission_classes = [IsAdminUser]

    def post(self, request, *args, **kwargs):
        with transaction.atomic():
            component = ComponentData.objects.select_for_update().filter(
                name=kwargs.get("name")
            ).first()
            if component is None:
                return Response({"detail": "No such component."}, status=status.HTTP_404_NOT_FOUND)
            if component.draft_data:
                component.data = component.draft_data
            component.status = "published"
            component.updated_by = request.user if request.user.is_authenticated else None
            component.save()
            ComponentDataView._snapshot(component, request.user, "publish")
        return Response(component.data)


class ComponentRevertView(APIView):
    """POST home/<name>/revert/<revision_id>/ — restore a revision as a NEW
    revision, never destructive (admin)."""
    permission_classes = [IsAdminUser]

    def post(self, request, *args, **kwargs):
        with transaction.atomic():
            component = ComponentData.objects.select_for_update().filter(
                name=kwargs.get("name")
            ).first()
            if component is None:
                return Response({"detail": "No such component."}, status=status.HTTP_404_NOT_FOUND)
            revision = component.revisions.filter(pk=kwargs.get("revision_id")).first()
            if revision is None:
                return Response({"detail": "No such revision."}, status=status.HTTP_404_NOT_FOUND)
            component.data = revision.data
            component.updated_by = request.user if request.user.is_authenticated else None
            component.save()
            ComponentDataView._snapshot(
                component, request.user, f"revert to revision {revision.pk}"
            )
        return Response(component.data)


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
        errors = validate_site_settings(request.data)
        if errors:
            return Response(errors, status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            settings_row, created = SiteSettings.objects.select_for_update().get_or_create(
                pk=1, defaults={"data": request.data}
            )
            if not created:
                settings_row.data = deep_merge(settings_row.data or {}, request.data)
                settings_row.save()
        return Response(settings_row.data)


class OrganizationSchemaView(APIView):
    """GET settings/site/schema/organization/ — the computed Organization /
    LocalBusiness JSON-LD, ready to inject. Public (same trust boundary as
    settings/site/ itself)."""
    permission_classes = [AllowAny]

    def get(self, request, *args, **kwargs):
        row = SiteSettings.objects.filter(pk=1).first()
        data = row.data if row else {}
        node = schema_builders.organization(data)
        graph = [node] if node.get("name") else []
        web = schema_builders.website(data)
        if web:
            graph.append(web)
        doc = {"@context": "https://schema.org", "@graph": graph}
        return Response(schema_builders.escape_jsonld(doc))


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
        user = request.user if request.user.is_authenticated else None
        with transaction.atomic():
            row, created = PageSEO.objects.select_for_update().get_or_create(
                path=path, defaults={"data": request.data}
            )
            old_data = {} if created else dict(row.data or {})
            if not created:
                row.data = deep_merge(row.data or {}, request.data)
                row.save()
            SEOChangeHistory.objects.create(
                page=row, changed_by=user, old_data=old_data, new_data=row.data,
            )
        return Response(row.data)


class PageSEOHistoryView(APIView):
    """GET seo/<path>/history/ — last N change snapshots (admin)."""
    permission_classes = [IsAdminUser]

    def get(self, request, *args, **kwargs):
        row = PageSEO.objects.filter(path=kwargs.get("path")).first()
        if row is None:
            return Response({"detail": "No SEO row for this path."}, status=404)
        history = row.history.all()[:REVISION_HISTORY_LIMIT]
        return Response([
            {"id": h.id, "old_data": h.old_data, "new_data": h.new_data,
             "changed_by": str(h.changed_by) if h.changed_by else None,
             "created_at": h.created_at}
            for h in history
        ])


class PageSEORevertView(APIView):
    """POST seo/<path>/revert/<history_id>/ — restore old_data as a new
    change (non-destructive, admin)."""
    permission_classes = [IsAdminUser]

    def post(self, request, *args, **kwargs):
        user = request.user if request.user.is_authenticated else None
        with transaction.atomic():
            row = PageSEO.objects.select_for_update().filter(path=kwargs.get("path")).first()
            if row is None:
                return Response({"detail": "No SEO row for this path."}, status=404)
            entry = row.history.filter(pk=kwargs.get("history_id")).first()
            if entry is None:
                return Response({"detail": "No such history entry."}, status=404)
            old_data = dict(row.data or {})
            row.data = entry.old_data
            row.save()
            SEOChangeHistory.objects.create(
                page=row, changed_by=user, old_data=old_data, new_data=row.data,
            )
        return Response(row.data)


class SEOResolveView(APIView):
    """GET seo/resolve/<path>/ — fully-resolved, frontend-ready metadata +
    assembled JSON-LD @graph. Public, cached, rate-limited."""
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "resolve"

    def get(self, request, *args, **kwargs):
        from django.core.cache import cache

        path = (kwargs.get("path") or "").strip("/")
        base_url = request.build_absolute_uri("/").rstrip("/")
        cache_key = f"seo-resolve:{base_url}:{path}"
        cached = cache.get(cache_key)
        if cached is None:
            cached = resolve_seo(path, base_url=base_url)
            cache.set(cache_key, cached, 300)
        return Response(cached)


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
