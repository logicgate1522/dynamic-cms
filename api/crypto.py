"""Encryption for stored tool credentials (R31, §10.1).

Fernet (AES-128-CBC + HMAC) with TRACKING_SECRET_KEY from the environment.
Without the key nothing secret can be stored: connect() refuses and the
launch check blocks while connections exist.

Rotate: set TRACKING_SECRET_KEY to the new key and TRACKING_SECRET_KEY_OLD to
the old one, run `manage.py tracking_rotate_key`, then drop the old key.
"""

import json

from django.conf import settings


class MissingKey(RuntimeError):
    pass


def _fernet(key=None):
    from cryptography.fernet import Fernet
    key = key or getattr(settings, "TRACKING_SECRET_KEY", "")
    if not key:
        raise MissingKey("TRACKING_SECRET_KEY is not set in the backend environment.")
    return Fernet(key.encode() if isinstance(key, str) else key)


def has_key():
    return bool(getattr(settings, "TRACKING_SECRET_KEY", ""))


def generate_key():
    from cryptography.fernet import Fernet
    return Fernet.generate_key().decode()


def encrypt(data):
    return _fernet().encrypt(json.dumps(data).encode()).decode()


def decrypt(token):
    from cryptography.fernet import InvalidToken
    if not token:
        return {}
    try:
        return json.loads(_fernet().decrypt(token.encode()).decode())
    except InvalidToken:
        old = getattr(settings, "TRACKING_SECRET_KEY_OLD", "")
        if old:
            return json.loads(_fernet(old).decrypt(token.encode()).decode())
        raise


def hint(secret_text):
    text = str(secret_text or "")
    return f"…{text[-4:]}" if len(text) >= 8 else "…"
