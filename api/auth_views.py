"""Browser admin sessions.

Two ways to authenticate, by audience:

- Browser admin UI  -> server-side Django session (HttpOnly cookie) + CSRF.
  Nothing secret is ever readable by page JavaScript, which matters because
  SiteSettings lets admins inject arbitrary analytics/custom scripts.
- Scripts / CI       -> DRF token (`Authorization: Token <key>`), unchanged.

Flow for a browser on another origin (e.g. the Next.js site):

    GET  auth/csrf/              -> {"csrfToken"}  (also starts the session)
    POST auth/login/ {username|email, password, "session": true}
         header X-CSRFToken      -> sets the session cookie, returns the user
    GET  auth/session/           -> {"authenticated", "user"}
    POST auth/logout/            -> flushes the session

Every unsafe request made with the session must send X-CSRFToken and use
`credentials: "include"`. The CMS API must share a registrable domain with
the site (cms.example.com + www.example.com) for the cookie to be sent.
"""

from django.contrib.auth import logout as django_logout
from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.views.decorators.cache import never_cache
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView


def user_payload(user):
    name = ""
    if hasattr(user, "get_full_name"):
        name = (user.get_full_name() or "").strip()
    return {
        "id": user.pk,
        "username": user.get_username(),
        "email": getattr(user, "email", "") or "",
        "name": name or user.get_username(),
        "is_superuser": bool(user.is_superuser),
    }


@method_decorator(never_cache, name="dispatch")
class CsrfTokenView(APIView):
    """GET auth/csrf/ — the masked CSRF token page JS sends back as
    X-CSRFToken. With CSRF_USE_SESSIONS the secret lives server-side."""
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = []

    def get(self, request, *args, **kwargs):
        return Response({"csrfToken": get_token(request)})


@method_decorator(never_cache, name="dispatch")
class SessionStatusView(APIView):
    """GET auth/session/ — server-authoritative "is this browser an admin?".
    The frontend shows edit affordances only when this says so."""
    authentication_classes = [SessionAuthentication]
    permission_classes = [AllowAny]
    # Called on page load by every visitor; read-only, no credentials.
    throttle_classes = []

    def get(self, request, *args, **kwargs):
        user = request.user
        if user and user.is_authenticated and user.is_active and user.is_staff:
            return Response({"authenticated": True, "user": user_payload(user)})
        return Response({"authenticated": False})


class LogoutView(APIView):
    """POST auth/logout/ — real server-side logout (session flushed)."""
    authentication_classes = [SessionAuthentication]
    permission_classes = [AllowAny]

    def post(self, request, *args, **kwargs):
        django_logout(request)
        return Response({"success": True})
