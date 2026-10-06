"""AI assist endpoints (admin only). Prompt text lives in api/prompts.py;
reply cleaning in api/ai_normalize.py. The admin UI only ever:

  1. asks one of these for a prompt  -> shows it with a Copy button
  2. sends the AI's reply to ai/normalize/ -> applies what comes back

Brief fields accepted everywhere a page prompt is built (query string for
GET, body for POST): keyword, intent, location, audience, supporting, cta.
"""

from rest_framework import status
from rest_framework.permissions import IsAdminUser
from rest_framework.response import Response
from rest_framework.views import APIView

from . import prompts
from .ai_normalize import (
    NormalizeError,
    normalize_page,
    normalize_page_assist,
    normalize_section,
    normalize_seo,
)
from .models import PageSEO

BRIEF_KEYS = ("keyword", "intent", "location", "audience", "supporting", "cta")


def _brief(source):
    return {key: str(source.get(key) or "").strip() for key in BRIEF_KEYS if str(source.get(key) or "").strip()}


def _seo_row(path):
    key = str(path or "").strip("/") or "home"
    row = PageSEO.objects.filter(path=key).first()
    return (row.data if row else {}) or {}


def _types(raw):
    return [s.strip() for s in raw.split(",") if s.strip()] if raw else None


def existing_sections_for_prompt(host):
    """The live sections of a page, as the edit prompt shows them (pending
    drafts included, so an admin improves what they are looking at)."""
    from .section_views import _sections_qs
    out = []
    for section in _sections_qs(host, published_only=False).prefetch_related("media__image"):
        media = [
            f"{m.slot}: {m.alt_override or getattr(m.image, 'alt_text', '') or 'image'}"
            for m in section.media.all() if m.image_id
        ]
        entry = {"type": section.section_type,
                 "content": section.draft_content if section.draft_content is not None else section.content}
        if media:
            entry["existing_media"] = media
        out.append(entry)
    return out


class NewPagePromptView(APIView):
    """GET ai/new-page-prompt/?title=&topic=&path=&page_type=&host_kind=&sections=&<brief>"""
    permission_classes = [IsAdminUser]

    def get(self, request):
        q = request.query_params
        context = {
            "mode": "create",
            "host_kind": q.get("host_kind") or "content",
            "path": q.get("path") or "",
            "title": q.get("title") or "",
            "page_type": q.get("page_type") or ("article" if q.get("host_kind") == "blog" else "generic"),
            "topic": q.get("topic") or "",
            "brief": _brief(q),
        }
        return Response({"prompt": prompts.page_prompt(_types(q.get("sections")), context)})


class BuildPromptView(APIView):
    """GET content/<key>/build-prompt/?mode=create|edit&strategy=expand|override&topic=&sections=&<brief>
    A prompt for THIS page; edit mode includes its current sections."""
    permission_classes = [IsAdminUser]
    kind = "content"

    def get(self, request, key):
        from .section_views import _get_host
        host = _get_host(self.kind, key)
        if host is None:
            return Response({"detail": "No such page."}, status=status.HTTP_404_NOT_FOUND)
        q = request.query_params
        mode = q.get("mode") or "edit"
        path = f"blog/{host.slug}" if self.kind == "blog" else host.path
        brief = _brief(q)
        if "keyword" not in brief:
            primary = ((_seo_row(path).get("keywords") or {}).get("primary") or "").strip()
            if primary:
                brief["keyword"] = primary
        context = {
            "mode": mode,
            "host_kind": self.kind,
            "path": path,
            "title": host.title,
            "page_type": "article" if self.kind == "blog" else host.page_type,
            "topic": q.get("topic") or "",
            "strategy": q.get("strategy") or "expand",
            "brief": brief,
            "existing_sections": existing_sections_for_prompt(host) if mode == "edit" else [],
        }
        return Response({"prompt": prompts.page_prompt(_types(q.get("sections")), context)})


class BlogBuildPromptView(BuildPromptView):
    kind = "blog"


class SectionPromptView(APIView):
    """POST ai/section-prompt/ {content, section_type?, label?, path?, page_type?,
    host_kind?, fields?, keyword?, strategy?, instruction?, existing_media?}"""
    permission_classes = [IsAdminUser]

    def post(self, request):
        d = request.data if isinstance(request.data, dict) else {}
        keyword = d.get("keyword") or ((_seo_row(d.get("path")).get("keywords") or {}).get("primary") or "")
        prompt = prompts.section_prompt(
            content=d.get("content") or {},
            section_type=d.get("section_type") or "",
            label=d.get("label") or "",
            path=d.get("path") or "",
            page_type=d.get("page_type") or "",
            host_kind=d.get("host_kind") or "",
            fields=d.get("fields"),
            keyword=keyword,
            strategy=d.get("strategy") or "expand",
            instruction=d.get("instruction") or "",
            existing_media=d.get("existing_media"),
        )
        return Response({"prompt": prompt, "keyword": keyword})


class PageAssistPromptView(APIView):
    """POST ai/page-assist-prompt/ {path, sections: {id: {label, content, excludeFromKeywordAudit?}}}
    -> {prompt, audit}. One prompt for every editable block on a page."""
    permission_classes = [IsAdminUser]

    def post(self, request):
        d = request.data if isinstance(request.data, dict) else {}
        sections = d.get("sections")
        if not isinstance(sections, dict) or not sections:
            return Response({"detail": "sections must be a non-empty object keyed by block id."},
                            status=status.HTTP_400_BAD_REQUEST)
        prompt, audit = prompts.page_assist_prompt(path=d.get("path") or "", sections=sections,
                                                   seo=_seo_row(d.get("path")))
        return Response({"prompt": prompt, "audit": audit})


class SeoPromptView(APIView):
    """POST ai/seo-prompt/ {path, page_text?} -> {prompt, checks}"""
    permission_classes = [IsAdminUser]

    def post(self, request):
        d = request.data if isinstance(request.data, dict) else {}
        path = d.get("path") or "home"
        seo = _seo_row(path)
        checks = prompts.seo_rule_checks(seo)
        failing = [c for c in checks if not c["pass"] and not c.get("skip")]
        try:
            from .seo_analyzer import analyze_page
            audit = analyze_page(str(path).strip("/") or "home", html=d.get("html"), url=d.get("url"))
            seen = {f["label"] for f in failing}
            failing += [{"label": i["label"], "fix": i.get("fix")} for i in audit.get("issues", [])
                        if i["label"] not in seen]
        except Exception:
            pass
        prompt = prompts.seo_prompt(path=path, seo=seo, failing=failing, page_text=d.get("page_text") or "")
        return Response({"prompt": prompt, "checks": checks})


class KeywordPromptView(APIView):
    """POST ai/keyword-prompt/ {path, page_text?, <brief>} -> {prompt}"""
    permission_classes = [IsAdminUser]

    def post(self, request):
        d = request.data if isinstance(request.data, dict) else {}
        path = d.get("path") or "home"
        prompt = prompts.keyword_prompt(path=path, page_text=d.get("page_text") or "",
                                        seo=_seo_row(path), brief=_brief(d))
        return Response({"prompt": prompt})


class NormalizeView(APIView):
    """POST ai/normalize/ {kind, raw, current?, path?}

    kind=section      current: {...content}       -> {content, warnings}
    kind=page_assist  current: {id: content}      -> {applied, unmatched, warnings}
    kind=seo|keywords path                        -> {patch, unknown, fields}
    kind=page                                     -> {page} (validated page JSON)
    400 {detail} (or {errors: [...]} for page) when the reply can't be used.
    """
    permission_classes = [IsAdminUser]

    def post(self, request):
        d = request.data if isinstance(request.data, dict) else {}
        kind, raw = d.get("kind"), d.get("raw")
        try:
            if kind == "section":
                return Response(normalize_section(raw, d.get("current")))
            if kind == "page_assist":
                return Response(normalize_page_assist(raw, d.get("current")))
            if kind in ("seo", "keywords"):
                return Response(normalize_seo(raw, d.get("path") or ""))
            if kind == "page":
                return Response(normalize_page(raw))
        except NormalizeError as exc:
            detail = exc.args[0] if exc.args else "Could not read that reply."
            if isinstance(detail, list):
                return Response({"errors": detail}, status=status.HTTP_400_BAD_REQUEST)
            return Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)
        return Response({"detail": "kind must be one of: section, page_assist, seo, keywords, page."},
                        status=status.HTTP_400_BAD_REQUEST)
