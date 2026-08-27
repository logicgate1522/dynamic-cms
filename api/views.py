from collections import Counter
from datetime import timedelta

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.mail import send_mail
from django.db import transaction
from django.db.models import F
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

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
    SEOAuditResult,
    SEOChangeHistory,
    SiteSettings,
    UploadedImage,
)
from . import schema_builders
from .seo_resolve import resolve_seo
from .form_validation import validate_submission
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

            self._snapshot(
                component, request.user,
                "draft edit" if draft_mode else "edit",
                snapshot_data=component.draft_data if draft_mode else component.data,
            )

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
    def _snapshot(component, user, note, snapshot_data=None):
        ComponentRevision.objects.create(
            component=component,
            data=component.data if snapshot_data is None else snapshot_data,
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
    serializer_class = UploadedImageSerializer

    def get_permissions(self):
        if self.request.method == 'GET':
            return [AllowAny()]
        return [IsAdminUser()]

    def get_queryset(self):
        qs = UploadedImage.objects.all()
        params = self.request.query_params
        if params.get("category"):
            qs = qs.filter(category=params["category"])
        if params.get("missing_alt") == "1":
            qs = qs.filter(alt_text="")
        if params.get("unused") == "1":
            qs = qs.filter(usage=[])
        return qs

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        # checksum dedupe: identical bytes -> return the existing row
        upload = request.FILES.get("image")
        if upload is not None:
            import hashlib
            pos = upload.tell()
            digest = hashlib.sha256(upload.read()).hexdigest()
            upload.seek(pos)
            existing = UploadedImage.objects.filter(checksum=digest).first()
            if existing is not None:
                data = self.get_serializer(existing).data
                data["duplicate"] = True
                return Response(data, status=status.HTTP_200_OK)
        self.perform_create(serializer)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class ImageUsageView(APIView):
    """GET images/<id>/usage/ — best-effort back-references (admin)."""
    permission_classes = [IsAdminUser]

    def get(self, request, *args, **kwargs):
        img = UploadedImage.objects.filter(pk=kwargs.get("pk")).first()
        if img is None:
            return Response({"detail": "Not found."}, status=404)
        refs = list(img.usage or [])
        # live scan of SectionMedia
        from .models import SectionMedia
        for m in SectionMedia.objects.filter(image=img).select_related("section"):
            entry = {"type": "section_media",
                     "ref": f"{m.section.section_type}#{m.section_id}:{m.slot}"}
            if entry not in refs:
                refs.append(entry)
        return Response({"id": img.id, "usage": refs, "in_use": bool(refs)})


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


class SEOAuditView(APIView):
    """GET  seo/analyze/<path>/ — run a fresh audit, persist it, return it.
    POST seo/analyze/<path>/ — same, plus live-DOM checks from {html, url}.
    (admin — audits reveal content gaps and are not for the public.)"""
    permission_classes = [IsAdminUser]

    def _run(self, path, html=None, url=None):
        from .models import PageSEO
        from .seo_analyzer import analyze_page

        result = analyze_page(path, html=html, url=url)
        row = PageSEO.objects.filter(path=path.strip("/")).first()
        if row is not None:
            SEOAuditResult.objects.create(
                page=row, score=result["overall"],
                technical_score=result["technical_score"],
                content_score=result["content_score"],
                metadata_score=result["metadata_score"],
                schema_score=result["schema_score"],
                issues=result["issues"], checks=result["checks"],
            )
        return result

    def get(self, request, *args, **kwargs):
        return Response(self._run(kwargs.get("path")))

    def post(self, request, *args, **kwargs):
        return Response(self._run(
            kwargs.get("path"),
            html=request.data.get("html"),
            url=request.data.get("url"),
        ))


class SEOAuditRollupView(APIView):
    """GET seo/analyze/ — site-wide roll-up, worst pages first (admin)."""
    permission_classes = [IsAdminUser]

    def get(self, request, *args, **kwargs):
        from .models import PageSEO
        from .seo_analyzer import analyze_page

        rows = []
        for page in PageSEO.objects.all():
            r = analyze_page(page.path)
            rows.append({
                "path": page.path, "overall": r["overall"],
                "technical_score": r["technical_score"],
                "content_score": r["content_score"],
                "metadata_score": r["metadata_score"],
                "schema_score": r["schema_score"],
                "issue_count": len(r["issues"]),
            })
        rows.sort(key=lambda x: x["overall"])
        grades = Counter(_grade(r["overall"]) for r in rows)
        avg = round(sum(r["overall"] for r in rows) / len(rows)) if rows else 0
        return Response({
            "average_score": avg,
            "count_by_grade": dict(grades),
            "pages": rows,
        })


def _grade(score):
    if score >= 90:
        return "A"
    if score >= 75:
        return "B"
    if score >= 60:
        return "C"
    if score >= 40:
        return "D"
    return "F"


class SchemaValidateView(APIView):
    """POST seo/validate-schema/ {schema: <obj|string>} — structural JSON-LD
    validation for pasted markup (admin)."""
    permission_classes = [IsAdminUser]

    def post(self, request, *args, **kwargs):
        payload = request.data.get("schema", request.data)
        issues = schema_builders.validate_schema(payload)
        return Response({
            "valid": not any(i["level"] == "error" for i in issues),
            "issues": issues,
        })


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
    serializer_class = RedirectSerializer

    def get_permissions(self):
        if self.request.method in permissions.SAFE_METHODS:
            return [AllowAny()]
        return [IsAdminUser()]

    def get_queryset(self):
        qs = Redirect.objects.all()
        if self.request.query_params.get("broken") == "1":
            # target is itself a source of another redirect (chain) or a known
            # noindex PageSEO row
            noindex = {
                r.path for r in PageSEO.objects.all()
                if ((r.data or {}).get("robots") or {}).get("index") is False
            }
            chain_sources = set(Redirect.objects.values_list("source", flat=True))
            broken_ids = [
                r.id for r in qs
                if r.destination in chain_sources or r.destination.strip("/") in noindex
            ]
            qs = qs.filter(id__in=broken_ids)
        return qs

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user if self.request.user.is_authenticated else None)


class RedirectResolveView(APIView):
    """GET redirects/resolve/?path=/old — public, cached. {to, status} or 404.
    Increments hit_count/last_hit_at best-effort."""
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "resolve"

    def get(self, request, *args, **kwargs):
        from django.core.cache import cache

        path = request.query_params.get("path", "")
        if not path:
            return Response({"detail": "path query param required."}, status=400)
        cache_key = f"redirect-resolve:{path}"
        hit = cache.get(cache_key)
        if hit is None:
            row = Redirect.objects.filter(source=path, is_active=True).first()
            hit = {"to": row.destination, "status": row.effective_status, "_id": row.id} if row else {}
            cache.set(cache_key, hit, 300)
        if not hit:
            return Response({"detail": "No redirect."}, status=404)
        Redirect.objects.filter(pk=hit["_id"]).update(
            hit_count=F("hit_count") + 1, last_hit_at=timezone.now()
        )
        return Response({"to": hit["to"], "status": hit["status"]})


class RedirectImportExportView(APIView):
    """GET  redirects/io/?format=csv  — export all
    POST redirects/io/  (text/csv body or {csv: "..."}) — import (upsert). Admin."""
    permission_classes = [IsAdminUser]

    def get(self, request, *args, **kwargs):
        import csv
        import io

        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["source", "destination", "status_code", "is_active", "notes"])
        for r in Redirect.objects.all():
            w.writerow([r.source, r.destination, r.effective_status, r.is_active, r.notes])
        resp = HttpResponse(buf.getvalue(), content_type="text/csv")
        resp["Content-Disposition"] = 'attachment; filename="redirects.csv"'
        return resp

    def post(self, request, *args, **kwargs):
        import csv
        import io

        body = request.data.get("csv") if isinstance(request.data, dict) else None
        if body is None:
            body = request.body.decode("utf-8", "ignore")
        reader = csv.DictReader(io.StringIO(body))
        created, updated, errors = 0, 0, []
        for i, row in enumerate(reader):
            src = (row.get("source") or "").strip()
            dst = (row.get("destination") or "").strip()
            if not src or not dst:
                errors.append({"row": i, "message": "source and destination required"})
                continue
            defaults = {"destination": dst, "notes": (row.get("notes") or "").strip()}
            if row.get("status_code"):
                try:
                    defaults["status_code"] = int(row["status_code"])
                except ValueError:
                    pass
            if row.get("is_active") is not None:
                defaults["is_active"] = str(row.get("is_active")).lower() not in ("false", "0", "")
            _, was_created = Redirect.objects.update_or_create(source=src, defaults=defaults)
            created += was_created
            updated += not was_created
        return Response({"created": created, "updated": updated, "errors": errors})


# ==================== FORM SUBMISSIONS ====================

class FormSubmitView(APIView):
    """Public, throttled endpoint that accepts a submission for a named form definition."""
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'form_submit'

    def post(self, request, *args, **kwargs):
        import hashlib

        form_name = kwargs.get('name')
        # QueryDict (form-encoded / multipart) -> flat dict; JSON body is already a dict.
        payload = request.data.dict() if hasattr(request.data, "dict") else dict(request.data)

        definition = {}
        row = ComponentData.objects.filter(name=f"form-{form_name}").first()
        if row is not None:
            definition = row.data or {}

        # Honeypot: a configurable hidden field real users never fill in.
        honeypot = definition.get("honeypotField", "website")
        if payload.pop(honeypot, None):
            return Response({"success": True})

        # Server-side validation against the field definition (if one exists).
        if definition.get("fields"):
            cleaned, errors = validate_submission(definition, payload)
            if errors:
                return Response({"errors": errors}, status=status.HTTP_400_BAD_REQUEST)
            payload = cleaned

        ip = request.META.get("REMOTE_ADDR", "")
        ip_hash = hashlib.sha256(f"{ip}:{settings.SECRET_KEY}".encode()).hexdigest() if ip else ""
        ua = request.META.get("HTTP_USER_AGENT", "")[:400]
        referer = request.META.get("HTTP_REFERER", "")[:500]

        # 60-second same-email dedupe.
        email = payload.get("email")
        if email:
            recent = FormSubmission.objects.filter(
                form_name=form_name, created_at__gte=timezone.now() - timedelta(seconds=60),
            )
            if any((s.data or {}).get("email") == email for s in recent):
                return Response({"success": True}, status=status.HTTP_201_CREATED)

        FormSubmission.objects.create(
            form_name=form_name, data=payload,
            ip_hash=ip_hash, user_agent=ua, referer=referer,
        )
        self._notify(form_name, payload, definition)
        return Response({"success": True}, status=status.HTTP_201_CREATED)

    def _notify(self, form_name, payload, definition=None):
        """Best-effort email nudge. Never lets a notification failure fail the
        submission itself."""
        notify = (definition or {}).get("notify") or {}
        recipient = notify.get("email") or getattr(settings, 'FORM_NOTIFICATION_EMAIL', '')
        if not recipient:
            return
        subject = notify.get("subject") or f"New {form_name} submission"
        body_lines = [f"New '{form_name}' form submission:\n"]
        body_lines += [f"{key}: {value}" for key, value in payload.items()]
        send_mail(
            subject=subject,
            message="\n".join(body_lines),
            from_email=settings.DEFAULT_FROM_EMAIL,
            recipient_list=[recipient],
            fail_silently=True,
        )


def _filtered_submissions(name, params):
    qs = FormSubmission.objects.filter(form_name=name)
    if params.get("is_read") in ("0", "1"):
        qs = qs.filter(is_read=params["is_read"] == "1")
    if params.get("is_spam") in ("0", "1"):
        qs = qs.filter(is_spam=params["is_spam"] == "1")
    since = params.get("since")
    if since:
        parsed = parse_datetime(since) or parse_date(since)
        if parsed is not None:
            qs = qs.filter(created_at__gte=parsed)
    return qs


class FormSubmissionListView(ListAPIView):
    """Admin-only list of submissions for a named form.
    Filters: ?is_read=&is_spam=&since=ISO8601."""
    serializer_class = FormSubmissionSerializer
    permission_classes = [IsAdminUser]

    def get_queryset(self):
        return _filtered_submissions(self.kwargs.get('name'), self.request.query_params)


class FormSubmissionExportView(APIView):
    """GET forms/<name>/submissions/export/?format=csv|json (admin)."""
    permission_classes = [IsAdminUser]

    def get(self, request, *args, **kwargs):
        import csv
        import io

        name = kwargs.get("name")
        rows = _filtered_submissions(name, request.query_params).order_by("created_at")
        fmt = request.query_params.get("format", "csv")

        if fmt == "json":
            return Response(FormSubmissionSerializer(rows, many=True).data)

        keys = []
        for r in rows:
            for k in (r.data or {}):
                if k not in keys:
                    keys.append(k)
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "created_at", "is_read", "is_spam", *keys])
        for r in rows:
            writer.writerow([r.id, r.created_at.isoformat(), r.is_read, r.is_spam,
                             *[(r.data or {}).get(k, "") for k in keys]])
        resp = HttpResponse(buf.getvalue(), content_type="text/csv")
        resp["Content-Disposition"] = f'attachment; filename="{name}-submissions.csv"'
        return resp


class FormSubmissionDetailView(APIView):
    """PATCH forms/<name>/submissions/<id>/ — toggle is_read / is_spam (admin)."""
    permission_classes = [IsAdminUser]

    def patch(self, request, *args, **kwargs):
        sub = FormSubmission.objects.filter(
            form_name=kwargs.get("name"), pk=kwargs.get("pk")
        ).first()
        if sub is None:
            return Response({"detail": "Not found."}, status=404)
        for field in ("is_read", "is_spam"):
            if field in request.data:
                setattr(sub, field, bool(request.data[field]))
        sub.save()
        return Response(FormSubmissionSerializer(sub).data)
