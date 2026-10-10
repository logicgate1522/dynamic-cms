"""Rate limits that don't get in the way of the people (and server) running the site.

- Staff are authenticated and trusted. One admin page view loads every block's
  draft and inline typing autosaves several times a second, so the general
  per-user limit would start failing saves for a fast editor.
- The site's own Next.js server renders every page from ONE IP. It identifies
  itself with the shared REVALIDATE_SECRET in `X-CMS-Frontend` (server-side
  only; the browser never sees it) so it isn't limited as one anonymous visitor.

Abuse limits stay on everyone: `login` (brute force) and `form_submit` (spam)
are never skipped.
"""

import hmac

from django.conf import settings
from rest_framework.throttling import AnonRateThrottle, ScopedRateThrottle, UserRateThrottle

ALWAYS_LIMITED_SCOPES = {"login", "form_submit"}


def is_site_server(request):
    secret = getattr(settings, "REVALIDATE_SECRET", "") or ""
    token = request.headers.get("X-CMS-Frontend", "")
    return bool(secret and token and hmac.compare_digest(token, secret))


def is_staff(request):
    user = getattr(request, "user", None)
    return bool(user and user.is_authenticated and user.is_staff)


class SiteAwareAnonRateThrottle(AnonRateThrottle):
    def allow_request(self, request, view):
        if is_site_server(request):
            return True
        return super().allow_request(request, view)


class StaffExemptUserRateThrottle(UserRateThrottle):
    # DRF's user throttle also counts anonymous requests (by IP), so the
    # site's server needs the same pass here as in the anon throttle.
    def allow_request(self, request, view):
        if is_staff(request) or is_site_server(request):
            return True
        return super().allow_request(request, view)


# Scopes added after a deployment's settings were written still get a limit.
FALLBACK_RATES = {"events": "60/minute", "verify": "240/minute"}


class SiteAwareScopedRateThrottle(ScopedRateThrottle):
    def get_rate(self):
        try:
            return super().get_rate()
        except Exception:
            if self.scope in FALLBACK_RATES:
                return FALLBACK_RATES[self.scope]
            raise

    def allow_request(self, request, view):
        scope = getattr(view, self.scope_attr, None)
        if scope not in ALWAYS_LIMITED_SCOPES and (is_staff(request) or is_site_server(request)):
            return True
        # Tracking checks (R31) submit several test bookings a minute; a valid,
        # signed, short-lived verification token is not spam. Everyone else —
        # including a forged or expired token — stays limited.
        if scope == "form_submit" and verified_test_submission(request):
            return True
        return super().allow_request(request, view)


def verified_test_submission(request):
    import json

    from .tracking_verify import run_from_token
    try:
        envelope = request.data.get("_cms") if hasattr(request.data, "get") else None
    except Exception:
        return False
    if isinstance(envelope, str):
        try:
            envelope = json.loads(envelope)
        except ValueError:
            return False
    token = envelope.get("verify") if isinstance(envelope, dict) else None
    return bool(token and run_from_token(token))
