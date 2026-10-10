"""Internal-link audit endpoints (R34). The analysis lives in link_audit.py."""

from rest_framework import status
from rest_framework.permissions import IsAdminUser
from rest_framework.response import Response
from rest_framework.views import APIView

from . import link_audit
from .site_facts import clean_scan


class LinkAuditView(APIView):
    """GET seo/links/ — the analysis of the last site scan (Site tools →
    SEO → Internal links → Scan site stores one via tracking/scan/)."""
    permission_classes = [IsAdminUser]

    def get(self, request):
        result = link_audit.latest()
        return Response(result or {"scanned": False, "summary": None, "pages": [], "issues": [], "suggestions": []})


class LinkAnalyzeView(APIView):
    """POST seo/links/analyze/ {pages: [...]} — analyse a scan without storing
    it (frontend-kit/acceptance/site-audit.mjs sends the production build's
    link graph here, so the gate and the admin report share one analyser)."""
    permission_classes = [IsAdminUser]

    def post(self, request):
        try:
            scan = clean_scan(request.data)
        except ValueError as err:
            return Response({"detail": str(err)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(link_audit.analyze(scan))
