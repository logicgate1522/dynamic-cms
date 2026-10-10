"""Google service-account access tokens (JWT bearer flow) without the Google
client libraries: sign an RS256 JWT with the key from the uploaded JSON and
exchange it at oauth2.googleapis.com. Cached per scope set until expiry."""

import base64
import json
import time

from django.core.cache import cache

from . import base

TOKEN_URL = "https://oauth2.googleapis.com/token"


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def signed_jwt(sa, scopes, now=None):
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    now = int(now or time.time())
    header = {"alg": "RS256", "typ": "JWT", "kid": sa.get("private_key_id", "")}
    claims = {"iss": sa["client_email"], "scope": " ".join(scopes), "aud": TOKEN_URL, "iat": now, "exp": now + 3600}
    signing_input = f"{_b64(json.dumps(header).encode())}.{_b64(json.dumps(claims).encode())}".encode()
    key = serialization.load_pem_private_key(sa["private_key"].encode(), password=None)
    signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f"{signing_input.decode()}.{_b64(signature)}"


def access_token(conn, scopes):
    sa = (conn.get("secret") or {}).get("serviceAccount")
    if not isinstance(sa, dict) or not sa.get("private_key") or not sa.get("client_email"):
        raise base.AuthError("Upload the Google service account JSON key in the Google connection.")
    key = f"cms-google-token:{sa['client_email']}:{' '.join(sorted(scopes))}"
    cached = cache.get(key)
    if cached:
        return cached
    _, res = base.http_json("POST", TOKEN_URL, {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                                "assertion": signed_jwt(sa, scopes)}, form=True)
    token = res.get("access_token")
    if not token:
        raise base.AuthError("Google refused the service account key.")
    cache.set(key, token, max(60, int(res.get("expires_in", 3600)) - 120))
    return token
