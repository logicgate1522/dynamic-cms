import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings


class ToolError(Exception):
    retry = True

    def __init__(self, message, status=0, body=None):
        super().__init__(message)
        self.status = status
        self.body = body


class AuthError(ToolError):
    """Token expired/revoked or missing permission: connection needs re-auth."""
    retry = False


class RateLimited(ToolError):
    retry = True


class Permanent(ToolError):
    """The tool refused this request for good (bad payload, policy, cap)."""
    retry = False


class Transient(ToolError):
    retry = True


def http_json(method, url, body=None, headers=None, timeout=None, form=False):
    """JSON (or form-encoded) request → (status, parsed body). Raises the
    typed errors above. Replaced in tests."""
    data = None
    hdrs = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        if form:
            data = urllib.parse.urlencode(body).encode()
            hdrs.setdefault("Content-Type", "application/x-www-form-urlencoded")
        else:
            data = json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    timeout = timeout or getattr(settings, "TRACKING_DELIVERY_TIMEOUT", 3)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return res.status, _parse(raw)
    except urllib.error.HTTPError as err:
        parsed = _parse(err.read())
        raise classify(err.code, parsed) from None
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        raise Transient(f"network: {err}") from None


def _parse(raw):
    if not raw:
        return {}
    try:
        return json.loads(raw.decode() if isinstance(raw, bytes) else raw)
    except ValueError:
        return {"raw": (raw[:500].decode(errors="replace") if isinstance(raw, bytes) else str(raw)[:500])}


def classify(status, body):
    message = _message(body) or f"HTTP {status}"
    if status in (401, 403) or _is_meta_auth(body):
        return AuthError(message, status, body)
    if status == 429:
        return RateLimited(message, status, body)
    if 400 <= status < 500:
        return Permanent(message, status, body)
    return Transient(message, status, body)


def _message(body):
    if not isinstance(body, dict):
        return ""
    err = body.get("error")
    if isinstance(err, dict):
        return str(err.get("message") or err.get("error_user_msg") or err)[:500]
    return str(body.get("message") or body.get("error_description") or err or "")[:500]


def _is_meta_auth(body):
    err = (body or {}).get("error") if isinstance(body, dict) else None
    return isinstance(err, dict) and err.get("code") in (190, 102, 10, 200) and err.get("type") == "OAuthException"


# ------------------------------------------------------------------ hashing

def sha256(text):
    return hashlib.sha256(text.encode()).hexdigest()


def norm_email(email):
    e = str(email or "").strip().lower()
    return e if re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", e) else ""


def norm_phone(phone, country="GB"):
    """E.164 digits without '+', best effort (no external library)."""
    digits = re.sub(r"\D", "", str(phone or ""))
    if not digits:
        return ""
    raw = str(phone).strip()
    if raw.startswith("+"):
        return digits
    if raw.startswith("00"):
        return digits[2:]
    codes = {"GB": "44", "IE": "353", "US": "1", "CA": "1", "AU": "61", "NZ": "64", "DE": "49", "FR": "33",
             "ES": "34", "IT": "39", "NL": "31", "IN": "91", "PK": "92", "AE": "971", "ZA": "27", "SG": "65"}
    code = codes.get((country or "GB").upper(), "")
    if digits.startswith("0") and code:
        return code + digits[1:]
    if code and len(digits) == 10 and code == "1":
        return "1" + digits
    return digits


def event_time(event):
    from django.utils import timezone
    at = event.get("at") or timezone.now()
    return int(at.timestamp())
