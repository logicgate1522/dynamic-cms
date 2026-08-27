"""Dynamic Page / Section system — endpoints.

URL shape: `content/<path>/sections/…` (ContentPage host) and the identical
surface at `blog/<slug>/sections/…` (BlogPost host). Sections use normal
id/REST semantics (they are a real collection); the host lookup is by
path/slug.
"""

from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from rest_framework import status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAdminUser
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import serializers as drf_serializers
from django.utils import timezone

from .dynamic_pages import (
    SECTION_SCHEMA,
    PER_ITEM_IMAGE_SECTION_TYPES,
    RECOMMENDED_SIZE,
    SINGLE_IMAGE_SECTION_TYPES,
    VIDEO_HOST_PATTERN,
    DynamicPageParseError,
    build_ai_prompt,
    build_copy_structure_prompt,
    parse_and_validate,
)
from .models import BlogPost, ContentPage, DynamicSection, SectionMedia
from .utils import build_unique_slug


# --------------------------------------------------------------- host helpers

def _get_host(kind, key, for_write=False):
    if kind == "blog":
        return BlogPost.objects.filter(slug=key).first()
    return ContentPage.objects.filter(path=key.strip("/")).first()


def _host_ct(host):
    return ContentType.objects.get_for_model(type(host))


def _sections_qs(host, published_only):
    qs = DynamicSection.objects.filter(
        content_type=_host_ct(host), object_id=host.pk
    ).order_by("order")
    if published_only:
        qs = qs.filter(status="published")
    return qs


def serialize_section(section, request=None):
    return {
        "id": section.id,
        "section_type": section.section_type,
        "order": section.order,
        "status": section.status,
        "content": section.content,
        "media": [
            {
                "id": m.id, "slot": m.slot, "required": m.required,
                "image_prompt": m.image_prompt, "alt_override": m.alt_override,
                "image": _image_payload(m.image, request),
            }
            for m in section.media.all()
        ],
    }


def _image_payload(image, request=None):
    if image is None:
        return None
    url = image.image.url if image.image else None
    if url and request is not None:
        url = request.build_absolute_uri(url)
    return {"id": image.id, "url": url,
            "alt_text": getattr(image, "alt_text", ""),
            "width": image.width, "height": image.height}


def _missing_required_media(host):
    out = []
    for section in _sections_qs(host, published_only=False):
        for m in section.media.filter(required=True, image__isnull=True):
            out.append({"section_id": section.id, "section_type": section.section_type,
                        "slot": m.slot, "image_prompt": m.image_prompt})
    return out


def _pending_images(host):
    out = []
    for section in _sections_qs(host, published_only=False):
        for m in section.media.filter(image__isnull=True):
            out.append({
                "section_id": section.id, "section_type": section.section_type,
                "slot": m.slot, "image_prompt": m.image_prompt,
                "recommended_size": RECOMMENDED_SIZE.get(section.section_type, "1200x800"),
            })
    return out


def _validate_section_payload(raw_sections):
    """Validate a POSTed list of section dicts against SECTION_SCHEMA. Returns
    (validated_list, errors)."""
    errors = []
    validated = []
    for i, sec in enumerate(raw_sections):
        if not isinstance(sec, dict):
            errors.append({"section_index": i, "message": "Section must be an object."})
            continue
        stype = sec.get("section_type") or sec.get("type")
        if stype not in SECTION_SCHEMA:
            errors.append({"section_index": i, "message": f'Unknown section type "{stype}".'})
            continue
        content = sec.get("content") or {}
        for field, rule in SECTION_SCHEMA[stype].items():
            if rule == "required" and not str(content.get(field) or "").strip():
                errors.append({"section_index": i, "message": f'"{field}" is required.'})
            if rule == "required_list" and not (isinstance(content.get(field), list) and content.get(field)):
                errors.append({"section_index": i, "message": f'"{field}" must be a non-empty array.'})
        if stype == "video" and not VIDEO_HOST_PATTERN.match(content.get("video_url") or ""):
            errors.append({"section_index": i, "message": '"video_url" must be a YouTube/Vimeo embed URL.'})
        validated.append({"section_type": stype, "order": sec.get("order", i),
                          "content": content, "status": sec.get("status", "published"),
                          "media": sec.get("media") or []})
    return validated, errors


def _create_sections(host, validated):
    ct = _host_ct(host)
    for entry in validated:
        section = DynamicSection.objects.create(
            content_type=ct, object_id=host.pk,
            section_type=entry["section_type"], order=entry["order"],
            content=entry["content"], status=entry.get("status", "published"),
        )
        _sync_media(section, entry)


def _sync_media(section, entry):
    """Create SectionMedia rows for a section's required/declared slots."""
    stype = section.section_type
    slots = []
    explicit = entry.get("media") or []
    if explicit:
        for m in explicit:
            slots.append((m.get("slot", "image"), m.get("image_prompt", ""),
                          bool(m.get("required", True))))
    else:
        if stype in SINGLE_IMAGE_SECTION_TYPES:
            slots.append(("image", entry.get("content", {}).get("image_prompt", ""), True))
        if stype in PER_ITEM_IMAGE_SECTION_TYPES:
            for idx, item in enumerate(entry.get("content", {}).get("items") or []):
                if isinstance(item, dict) and (item.get("image_prompt") or item.get("image_required")):
                    slots.append((f"items[{idx}].image", item.get("image_prompt", ""), True))
    for slot, prompt, required in slots:
        SectionMedia.objects.get_or_create(
            section=section, slot=slot,
            defaults={"image_prompt": prompt, "required": required},
        )


# --------------------------------------------------------------- prompt endpoints

class SectionSchemaView(APIView):
    """GET ai/section-schema/ — the whole SECTION_SCHEMA (public discovery)."""
    permission_classes = [AllowAny]

    def get(self, request, *args, **kwargs):
        return Response({
            "section_schema": SECTION_SCHEMA,
            "single_image_types": sorted(SINGLE_IMAGE_SECTION_TYPES),
            "per_item_image_types": sorted(PER_ITEM_IMAGE_SECTION_TYPES),
            "recommended_sizes": RECOMMENDED_SIZE,
        })


class DynamicPagePromptView(APIView):
    """GET ai/dynamic-page-prompt/?sections=hero,faq — copy-paste AI prompt."""
    permission_classes = [IsAdminUser]

    def get(self, request, *args, **kwargs):
        raw = request.query_params.get("sections")
        types = [s.strip() for s in raw.split(",")] if raw else None
        return Response({"prompt": build_ai_prompt(types)})


class CopyStructurePromptView(APIView):
    """GET ai/copy-structure-prompt/ — prompt to reproduce a pasted page."""
    permission_classes = [IsAdminUser]

    def get(self, request, *args, **kwargs):
        return Response({"prompt": build_copy_structure_prompt()})


# --------------------------------------------------------------- paste to build

class PasteToBuildView(APIView):
    """POST content/paste-to-build/ {raw, path?, page_type?} — parse AI JSON,
    atomically create the host + sections + pending media."""
    permission_classes = [IsAdminUser]

    def post(self, request, *args, **kwargs):
        raw = request.data.get("raw")
        try:
            parsed = parse_and_validate(raw)
        except DynamicPageParseError as e:
            return Response({"errors": e.errors}, status=status.HTTP_400_BAD_REQUEST)

        page_type = request.data.get("page_type") or parsed["page_type"]
        explicit_path = (request.data.get("path") or "").strip("/")
        user = request.user if request.user.is_authenticated else None

        with transaction.atomic():
            if page_type == "article":
                host = BlogPost.objects.create(
                    title=parsed["title"], body_mode="dynamic", status="draft",
                    seo_title=parsed["seo"].get("title", ""),
                    meta_description=parsed["seo"].get("description", ""),
                )
                host_kind, host_key = "blog", host.slug
            else:
                path = explicit_path or build_unique_slug(ContentPage, parsed["title"], field="path")
                host = ContentPage.objects.create(
                    path=path, title=parsed["title"], page_type=page_type,
                    body_mode="dynamic", status="draft", updated_by=user,
                )
                host_kind, host_key = "content", host.path
            _create_sections(host, [
                {**s, "status": "published"} for s in parsed["sections"]
            ])

        return Response({
            "host": {"kind": host_kind, "key": host_key, "title": host.title,
                     "status": host.status},
            "pending_images": _pending_images(host),
        }, status=status.HTTP_201_CREATED)


# --------------------------------------------------------------- section CRUD

class _SectionBase(APIView):
    kind = "content"

    def host_or_404(self, request, key):
        host = _get_host(self.kind, key)
        if host is None:
            return None
        return host

    def is_admin(self, request):
        return bool(request.user and request.user.is_staff)


class SectionListView(_SectionBase):
    def get_permissions(self):
        return [AllowAny()] if self.request.method == "GET" else [IsAdminUser()]

    def get(self, request, key):
        host = _get_host(self.kind, key)
        if host is None:
            return Response([])
        published_only = not self.is_admin(request)
        data = [serialize_section(s, request) for s in
                _sections_qs(host, published_only).prefetch_related("media__image")]
        return Response(data)

    def post(self, request, key):
        """Replace the whole section list, atomically."""
        host = _get_host(self.kind, key)
        if host is None:
            return Response({"detail": "No such page."}, status=404)
        raw_sections = request.data if isinstance(request.data, list) else request.data.get("sections", [])
        validated, errors = _validate_section_payload(raw_sections)
        if errors:
            return Response({"errors": errors}, status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            _sections_qs(host, published_only=False).delete()
            _create_sections(host, validated)
        return Response([serialize_section(s, request) for s in _sections_qs(host, False)],
                        status=status.HTTP_200_OK)


class SectionDetailView(_SectionBase):
    permission_classes = [IsAdminUser]

    def _get(self, key, pk):
        host = _get_host(self.kind, key)
        if host is None:
            return None, None
        section = _sections_qs(host, False).filter(pk=pk).first()
        return host, section

    def patch(self, request, key, pk):
        host, section = self._get(key, pk)
        if section is None:
            return Response({"detail": "No such section."}, status=404)
        if "content" in request.data:
            section.content = request.data["content"]
        if "order" in request.data:
            section.order = request.data["order"]
        if "status" in request.data:
            section.status = request.data["status"]
        if "section_type" in request.data and request.data["section_type"] in SECTION_SCHEMA:
            section.section_type = request.data["section_type"]
        section.save()
        return Response(serialize_section(section, request))

    def delete(self, request, key, pk):
        host, section = self._get(key, pk)
        if section is None:
            return Response({"detail": "No such section."}, status=404)
        section.delete()
        return Response(status=204)


class SectionReorderView(_SectionBase):
    permission_classes = [IsAdminUser]

    def post(self, request, key):
        host = _get_host(self.kind, key)
        if host is None:
            return Response({"detail": "No such page."}, status=404)
        order = request.data.get("order") or []
        own_ids = set(_sections_qs(host, False).values_list("id", flat=True))
        if set(order) != own_ids:
            return Response(
                {"detail": "order must contain exactly this page's section ids."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        with transaction.atomic():
            for position, sid in enumerate(order):
                DynamicSection.objects.filter(pk=sid).update(order=position)
        return Response([serialize_section(s, request) for s in _sections_qs(host, False)])


class SectionMediaUploadView(_SectionBase):
    permission_classes = [IsAdminUser]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request, key, pk, slot):
        host = _get_host(self.kind, key)
        if host is None:
            return Response({"detail": "No such page."}, status=404)
        section = _sections_qs(host, False).filter(pk=pk).first()
        if section is None:
            return Response({"detail": "No such section."}, status=404)
        file = request.FILES.get("image") or request.FILES.get("file")
        if file is None:
            return Response({"detail": "No image file provided."}, status=400)

        from .serializers import UploadedImageSerializer

        ser = UploadedImageSerializer(
            data={"category": f"section-{section.section_type}", "image": file},
            context={"request": request},
        )
        ser.is_valid(raise_exception=True)
        image = ser.save()
        media, _ = SectionMedia.objects.get_or_create(section=section, slot=slot)
        media.image = image
        if "alt_override" in request.data:
            media.alt_override = request.data["alt_override"]
        media.save()
        return Response(serialize_section(section, request), status=status.HTTP_200_OK)


# --------------------------------------------------------------- publish guard

def publish_blocking_reason(host):
    """Return a dict describing missing required media, or None if publishable."""
    missing = _missing_required_media(host)
    if missing:
        return {"detail": "Cannot publish: required images are still missing.",
                "missing": missing}
    return None


class ContentPageSerializer(drf_serializers.ModelSerializer):
    class Meta:
        model = ContentPage
        fields = ["id", "path", "title", "page_type", "status", "published_at",
                  "seo_path", "body_mode", "content", "updated_at", "created_at"]

    def validate(self, attrs):
        instance = self.instance
        status_val = attrs.get("status", getattr(instance, "status", "draft"))
        if status_val == "published" and instance is not None:
            reason = publish_blocking_reason(instance)
            if reason:
                raise drf_serializers.ValidationError(reason)
        return attrs


def _visible_content_pages(request):
    qs = ContentPage.objects.all()
    if not (request.user and request.user.is_staff):
        qs = qs.filter(status="published", published_at__lte=timezone.now())
    return qs


class ContentPageListCreateView(APIView):
    """GET content/pages/ (public list) · POST content/pages/ (admin create)."""
    def get_permissions(self):
        return [AllowAny()] if self.request.method == "GET" else [IsAdminUser()]

    def get(self, request):
        rows = _visible_content_pages(request).order_by("path")
        return Response(ContentPageSerializer(rows, many=True).data)

    def post(self, request):
        ser = ContentPageSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        ser.save(updated_by=request.user if request.user.is_authenticated else None)
        return Response(ser.data, status=status.HTTP_201_CREATED)


class ContentPageDetailView(APIView):
    """GET/PATCH/DELETE content/pages/<path>/."""
    def get_permissions(self):
        return [AllowAny()] if self.request.method == "GET" else [IsAdminUser()]

    def _row(self, request, path):
        return _visible_content_pages(request).filter(path=path.strip("/")).first()

    def get(self, request, path):
        row = self._row(request, path)
        if row is None:
            return Response({"detail": "Not found."}, status=404)
        data = ContentPageSerializer(row).data
        data["sections"] = [
            serialize_section(s, request) for s in
            _sections_qs(row, published_only=not (request.user and request.user.is_staff))
        ]
        return Response(data)

    def patch(self, request, path):
        row = ContentPage.objects.filter(path=path.strip("/")).first()
        if row is None:
            return Response({"detail": "Not found."}, status=404)
        ser = ContentPageSerializer(row, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save(updated_by=request.user if request.user.is_authenticated else None)
        return Response(ser.data)

    def delete(self, request, path):
        ContentPage.objects.filter(path=path.strip("/")).delete()
        return Response(status=204)


# BlogPost-bound variants — same surface, kind="blog"
class BlogSectionListView(SectionListView):
    kind = "blog"


class BlogSectionDetailView(SectionDetailView):
    kind = "blog"


class BlogSectionReorderView(SectionReorderView):
    kind = "blog"


class BlogSectionMediaUploadView(SectionMediaUploadView):
    kind = "blog"
