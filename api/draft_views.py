"""Draft -> publish across the whole CMS.

Inline edits save as drafts (PATCH home/<name>/?mode=draft,
PATCH content|blog/<key>/sections/<id>/?mode=draft). Visitors keep seeing the
published content until an admin publishes. These endpoints let the admin UI
show "N unpublished changes" and publish or discard them in one action:

    GET  drafts/                      what is pending
    POST drafts/publish/  {…scope}    make it live
    POST drafts/discard/  {…scope}    throw it away

Scope (all optional; empty body = everything pending):
    {"components": ["hero", "footer"],
     "hosts": [{"kind": "content", "key": "services/vat"}, {"kind": "blog", "key": "my-post"}]}
"""

from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from rest_framework.permissions import IsAdminUser
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import BlogPost, ComponentData, ContentPage, DynamicSection


def _pending_components(names=None):
    qs = ComponentData.objects.filter(status="draft").exclude(draft_data={})
    if names is not None:
        qs = qs.filter(name__in=names)
    return qs


def _pending_sections(hosts=None):
    qs = DynamicSection.objects.filter(draft_content__isnull=False)
    if hosts is None:
        return qs
    ids = []
    for host in hosts:
        model = BlogPost if host.get("kind") == "blog" else ContentPage
        lookup = {"slug": host.get("key")} if model is BlogPost else {"path": str(host.get("key", "")).strip("/")}
        row = model.objects.filter(**lookup).first()
        if row is not None:
            ct = ContentType.objects.get_for_model(model)
            ids.extend(qs.filter(content_type=ct, object_id=row.pk).values_list("pk", flat=True))
    return DynamicSection.objects.filter(pk__in=ids)


def _scope(request):
    data = request.data if isinstance(request.data, dict) else {}
    components = data.get("components")
    hosts = data.get("hosts")
    if components is None and hosts is None:
        return None, None  # everything
    return (components or []), (hosts or [])


def _host_label(section):
    host = section.host
    if isinstance(host, BlogPost):
        return {"kind": "blog", "key": host.slug, "title": host.title}
    if isinstance(host, ContentPage):
        return {"kind": "content", "key": host.path, "title": host.title}
    return {"kind": "unknown", "key": str(section.object_id), "title": ""}


class DraftListView(APIView):
    """GET drafts/ — every pending unpublished change."""
    permission_classes = [IsAdminUser]

    def get(self, request):
        components = [
            {"name": c.name, "updated_at": c.updated_at,
             "updated_by": str(c.updated_by) if c.updated_by else None}
            for c in _pending_components()
        ]
        hosts = {}
        for section in _pending_sections():
            label = _host_label(section)
            key = (label["kind"], label["key"])
            hosts.setdefault(key, {**label, "sections": 0})["sections"] += 1
        host_list = sorted(hosts.values(), key=lambda h: (h["kind"], h["key"]))
        return Response({
            "components": components,
            "hosts": host_list,
            "total": len(components) + sum(h["sections"] for h in host_list),
        })


class DraftPublishView(APIView):
    """POST drafts/publish/ — make pending drafts live (all, or a scope)."""
    permission_classes = [IsAdminUser]

    def post(self, request):
        from .views import ComponentDataView
        names, hosts = _scope(request)
        published_components = []
        published_sections = 0
        with transaction.atomic():
            for component in _pending_components(names).select_for_update():
                component.data = component.draft_data
                component.draft_data = {}
                component.status = "published"
                component.updated_by = request.user
                component.save()
                ComponentDataView._snapshot(component, request.user, "publish")
                published_components.append(component.name)
            for section in _pending_sections(hosts).select_for_update():
                section.content = section.draft_content
                section.draft_content = None
                section.save(update_fields=["content", "draft_content"])
                published_sections += 1
        return Response({"components": published_components, "sections": published_sections})


class DraftDiscardView(APIView):
    """POST drafts/discard/ — drop pending drafts (all, or a scope)."""
    permission_classes = [IsAdminUser]

    def post(self, request):
        names, hosts = _scope(request)
        with transaction.atomic():
            discarded_components = list(_pending_components(names).values_list("name", flat=True))
            _pending_components(names).update(draft_data={}, status="published")
            discarded_sections = _pending_sections(hosts).update(draft_content=None)
        return Response({"components": discarded_components, "sections": discarded_sections})
