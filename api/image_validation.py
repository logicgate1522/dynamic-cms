"""Upload-time validation for images.

Enforced from `UploadedImageSerializer.validate_image` so both the list-create
and retrieve-update endpoints get the same guard. Checks, in order:

1. size cap (settings.MAX_IMAGE_BYTES)
2. extension allowlist (SVG gated behind settings.ALLOW_SVG_UPLOAD)
3. magic-byte sniff — the real file signature must match the extension, so a
   `payload.php` renamed to `logo.png` is rejected
4. dimension sanity cap (settings.MAX_IMAGE_DIMENSION), best-effort via Pillow
"""

from django.conf import settings
from rest_framework import serializers

# ext -> list of acceptable magic-byte prefixes (bytes read from offset 0)
_MAGIC = {
    ".jpg": [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".gif": [b"GIF87a", b"GIF89a"],
    ".webp": [b"RIFF"],  # RIFF....WEBP — checked further below
    ".bmp": [b"BM"],
    ".avif": [b"\x00\x00\x00"],  # ftyp box; loose check, refined below
}

ALWAYS_ALLOWED_EXT = set(_MAGIC.keys())


def _ext(name):
    name = (name or "").lower()
    dot = name.rfind(".")
    return name[dot:] if dot != -1 else ""


def validate_upload(fileobj):
    """Raise serializers.ValidationError on any problem; return None on success."""
    if fileobj is None:
        return

    size = getattr(fileobj, "size", None)
    if size is not None and size > settings.MAX_IMAGE_BYTES:
        raise serializers.ValidationError(
            f"File is {size} bytes; the limit is {settings.MAX_IMAGE_BYTES} bytes."
        )

    ext = _ext(getattr(fileobj, "name", ""))

    if ext in (".svg", ".svgz"):
        if not settings.ALLOW_SVG_UPLOAD:
            raise serializers.ValidationError(
                "SVG uploads are disabled (script-injection risk). "
                "Set ALLOW_SVG_UPLOAD=True to enable."
            )
        return  # SVG is text; no magic-byte check

    if ext not in ALWAYS_ALLOWED_EXT:
        raise serializers.ValidationError(
            f"Unsupported image type '{ext or '(none)'}'. "
            f"Allowed: {', '.join(sorted(ALWAYS_ALLOWED_EXT))}."
        )

    try:
        pos = fileobj.tell()
    except (OSError, AttributeError):
        pos = None
    head = fileobj.read(32)
    if pos is not None:
        try:
            fileobj.seek(pos)
        except OSError:
            pass

    if not _magic_ok(ext, head):
        raise serializers.ValidationError(
            f"File contents do not look like a valid {ext} image "
            "(magic-byte check failed)."
        )

    _check_dimensions(fileobj)


def _magic_ok(ext, head):
    if ext == ".webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if ext == ".avif":
        return b"ftyp" in head[:16] and (b"avif" in head[:32] or b"avis" in head[:32])
    return any(head.startswith(sig) for sig in _MAGIC.get(ext, []))


def _check_dimensions(fileobj):
    try:
        from PIL import Image
    except ImportError:
        return
    try:
        pos = fileobj.tell()
    except (OSError, AttributeError):
        pos = None
    try:
        with Image.open(fileobj) as img:
            w, h = img.size
    except Exception:
        return  # Pillow can't parse it — let the format check above stand
    finally:
        if pos is not None:
            try:
                fileobj.seek(pos)
            except OSError:
                pass
    cap = settings.MAX_IMAGE_DIMENSION
    if w > cap or h > cap:
        raise serializers.ValidationError(
            f"Image is {w}x{h}px; the limit is {cap}px on either side."
        )
