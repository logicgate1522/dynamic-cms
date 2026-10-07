"""Collection endpoints (admin only) — see api/site_collections.py.

    GET    collections/                          every configured collection (+ entry counts)
    GET    collections/for-path/?path=           the collection a site path belongs to, and its role
    GET    collections/<key>/entries/            entries, newest first (drafts included)
    POST   collections/<key>/entries/            create {title, slug?, fields?, raw?}
                                                 (raw = the AI's reply; omitted = blank template)
    GET    collections/<key>/prompt/             ?title&topic&slug&<brief> — strict new-entry prompt
    GET    collections/<key>/entries/<slug>/prompt/   ?instruction&strategy — rewrite prompt for one entry
    POST   collections/<key>/entries/<slug>/apply/    {raw} — AI rewrite, fitted to the template, as drafts
    PATCH  collections/<key>/entries/<slug>/     {title?, slug?, status?, fields?}
    DELETE collections/<key>/entries/<slug>/
"""

import json

from django.db import transaction
from rest_framework import status
from rest_framework.permissions import IsAdminUser
from rest_framework.response import Response
from rest_framework.views import APIView

from . import prompts
from . import site_collections as sc
from .ai_normalize import NormalizeError, extract_json, strip_markdown_links
from .ai_views import _brief
from .dynamic_pages import DynamicPageParseError, parse_and_validate
from .models import BlogPost, ContentPage, PageSEO, Redirect
from .section_views import (
    _create_sections,
    apply_sections,
    serialize_section,
    _pending_images,
    _sections_qs,
    _seed_page_seo,
    publish_blocking_reason,
)


def _flat(sections):
    return [{"type": s["type"], **(s.get("content") or {})} for s in sections or []]


def _collection_or_404(key):
    try:
        return sc.get_collection(key), None
    except sc.CollectionError as e:
        return None, Response({"detail": str(e)}, status=404)


def _describe(cfg):
    return {**cfg, "count": sc.entries_qs(cfg).count()}


class CollectionListView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        return Response([_describe(cfg) for cfg in sc.all_collections().values()])


class CollectionForPathView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        cfg, role = sc.collection_for_path(request.query_params.get("path") or "")
        if not cfg:
            return Response({"collection": None, "role": None})
        out = {"collection": _describe(cfg), "role": role}
        if role == "entry":
            slug = str(request.query_params.get("path") or "").strip("/").split("/")[-1]
            host = sc.get_entry(cfg, slug)
            out["entry"] = sc.serialize_entry(cfg, host) if host else None
        return Response(out)


class CollectionPromptView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request, key):
        cfg, err = _collection_or_404(key)
        if err:
            return err
        q = request.query_params
        reference = sc.reference_sections(cfg)
        prompt = prompts.collection_entry_prompt(
            cfg, title=q.get("title") or "", topic=q.get("topic") or "", brief=_brief(q),
            slug=q.get("slug") or "", reference=_flat(reference),
            image_types=sc.reference_image_types(cfg),
        )
        return Response({"prompt": prompt, "template": cfg["sections"], "has_reference": bool(reference)})


class CollectionEntryPromptView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request, key, slug):
        cfg, err = _collection_or_404(key)
        if err:
            return err
        host = sc.get_entry(cfg, slug)
        if host is None:
            return Response({"detail": "No such entry."}, status=404)
        existing = [{"type": s.section_type,
                     "content": s.draft_content if s.draft_content is not None else s.content}
                    for s in _sections_qs(host, published_only=False)]
        q = request.query_params
        prompt = prompts.collection_entry_prompt(
            cfg, title=host.title, slug=slug, brief=_brief(q), existing=_flat(existing),
            reference=_flat(sc.reference_sections(cfg, exclude=host)),
            image_types=sc.reference_image_types(cfg),
            instruction=q.get("instruction") or "", strategy=q.get("strategy") or "expand",
        )
        return Response({"prompt": prompt, "template": cfg["sections"]})


def _parse_reply(raw, fallback_title):
    """AI reply -> (title, seo, fields, sections) or raises NormalizeError /
    DynamicPageParseError."""
    data = strip_markdown_links(extract_json(raw))
    if isinstance(data, list):
        data = {"sections": data}
    if not isinstance(data, dict):
        raise NormalizeError("Expected a JSON object with a \"sections\" array.")
    # Tolerate {"type", "content": {...}} sections — flatten them.
    sections = []
    for s in data.get("sections") or []:
        if isinstance(s, dict) and isinstance(s.get("content"), dict) and s.get("type"):
            s = {**s["content"], "type": s["type"]}
        sections.append(s)
    data["sections"] = sections
    if not str(data.get("title") or "").strip():
        data["title"] = fallback_title or "Untitled"
    parsed = parse_and_validate(json.dumps(data))
    fields = data.get("fields") if isinstance(data.get("fields"), dict) else {}
    return parsed["title"], parsed.get("seo") or {}, fields, parsed["sections"]


class CollectionEntriesView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request, key):
        cfg, err = _collection_or_404(key)
        if err:
            return err
        return Response([sc.serialize_entry(cfg, host) for host in sc.entries_qs(cfg)])

    def post(self, request, key):
        cfg, err = _collection_or_404(key)
        if err:
            return err
        body = request.data if isinstance(request.data, dict) else {}
        title = str(body.get("title") or "").strip()
        raw = body.get("raw")
        warnings = []
        seo, ai_fields = {}, {}

        if raw:
            try:
                title_from_ai, seo, ai_fields, sections = _parse_reply(raw, title)
            except NormalizeError as e:
                return Response({"detail": str(e)}, status=400)
            except DynamicPageParseError as e:
                return Response({"errors": e.errors}, status=400)
            title = title or title_from_ai
            sections, warnings = sc.fit_to_template(cfg, sections, title=title)
        else:
            if not title:
                return Response({"detail": "Give the new entry a title."}, status=400)
            sections = sc.blank_sections(cfg, title, reference=sc.reference_sections(cfg))
        # Blank entries never force an upload; AI entries follow the siblings.
        image_types = sc.reference_image_types(cfg)
        sections = sc.apply_image_policy(sections, image_types if raw else (image_types or set()))

        slug = sc.unique_slug(cfg, body.get("slug") or title)
        user = request.user if request.user.is_authenticated else None
        with transaction.atomic():
            if cfg["hostKind"] == "blog":
                host = BlogPost(title=title, slug=slug, body_mode="dynamic", status="draft",
                                seo_title=seo.get("title", ""), meta_description=seo.get("description", ""))
            else:
                host = ContentPage(path=sc.entry_path(cfg, slug), title=title, page_type=cfg["pageType"],
                                   body_mode="dynamic", status="draft", updated_by=user)
                host.seo_path = host.path
            sc.write_fields(cfg, host, {**ai_fields, **(body.get("fields") or {})})
            host.save()
            _create_sections(host, [{**s, "status": "published"} for s in sections])
            _seed_page_seo(sc.entry_path(cfg, slug), seo)

        return Response({
            "entry": sc.serialize_entry(cfg, host),
            "warnings": warnings,
            "pending_images": _pending_images(host),
        }, status=status.HTTP_201_CREATED)


class CollectionEntryDetailView(APIView):
    permission_classes = [IsAdminUser]

    def patch(self, request, key, slug):
        cfg, err = _collection_or_404(key)
        if err:
            return err
        host = sc.get_entry(cfg, slug)
        if host is None:
            return Response({"detail": "No such entry."}, status=404)
        body = request.data if isinstance(request.data, dict) else {}

        if "title" in body:
            title = str(body.get("title") or "").strip()
            if not title:
                return Response({"title": "A title is required."}, status=400)
            host.title = title
        sc.write_fields(cfg, host, body.get("fields") or {})

        if body.get("status") in ("draft", "published") and body["status"] != host.status:
            if body["status"] == "published":
                blocked = publish_blocking_reason(host)
                if blocked:
                    return Response(blocked, status=400)
            host.status = body["status"]

        old_path = sc.entry_path(cfg, slug)
        new_slug = slug
        if body.get("slug") and sc.unique_slug(cfg, body["slug"], exclude=host) != slug:
            new_slug = sc.unique_slug(cfg, body["slug"], exclude=host)

        with transaction.atomic():
            if new_slug != slug:
                new_path = sc.entry_path(cfg, new_slug)
                if cfg["hostKind"] == "blog":
                    host.slug = new_slug
                else:
                    host.path = new_path
                    host.seo_path = new_path
                PageSEO.objects.filter(path=old_path).update(path=new_path)
                # The page lives at the new URL now: a redirect away from it
                # (left by an earlier rename) would loop.
                Redirect.objects.filter(source=f"/{new_path}").delete()
                if host.status == "published":
                    # Keep old links and search results working.
                    Redirect.objects.update_or_create(
                        source=f"/{old_path}",
                        defaults={"destination": f"/{new_path}", "status_code": 301, "permanent": True,
                                  "is_active": True, "notes": "Created when the entry's URL changed."},
                    )
            host.save()
        return Response(sc.serialize_entry(cfg, host))

    def delete(self, request, key, slug):
        cfg, err = _collection_or_404(key)
        if err:
            return err
        host = sc.get_entry(cfg, slug)
        if host is None:
            return Response(status=204)
        with transaction.atomic():
            _sections_qs(host, published_only=False).delete()
            PageSEO.objects.filter(path=sc.entry_path(cfg, slug)).delete()
            host.delete()
        return Response(status=204)


class CollectionEntryApplyView(APIView):
    """Apply an AI rewrite to one entry: the reply is fitted to the
    collection's template, then written as DRAFTS (nothing goes live until
    Publish)."""
    permission_classes = [IsAdminUser]

    def post(self, request, key, slug):
        cfg, err = _collection_or_404(key)
        if err:
            return err
        host = sc.get_entry(cfg, slug)
        if host is None:
            return Response({"detail": "No such entry."}, status=404)
        try:
            _title, _seo, _fields, sections = _parse_reply(request.data.get("raw"), host.title)
        except NormalizeError as e:
            return Response({"detail": str(e)}, status=400)
        except DynamicPageParseError as e:
            return Response({"errors": e.errors}, status=400)
        sections, warnings = sc.fit_to_template(cfg, sections, title=host.title)
        sections = sc.apply_image_policy(sections, sc.reference_image_types(cfg, exclude=host))
        apply_sections(host, sections, as_draft=True)
        return Response({
            "warnings": warnings,
            "sections": [serialize_section(s, request) for s in
                         _sections_qs(host, published_only=False).prefetch_related("media__image")],
        })
