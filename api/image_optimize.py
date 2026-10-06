"""Upload-time image optimization: re-encode every raster upload to WebP.

Called from `UploadedImage.save()` (models.py) on every *new* file — so it
covers every image category through the single upload path (SEO/OG images,
logo, gallery, blog featured images, ...), not just one form. SVG is left
alone (vector — there's nothing to re-encode). If Pillow can't decode the
file, or WebP re-encoding fails or doesn't actually save space, the original
bytes are kept untouched rather than raising — optimization is a bonus, not
a hard requirement for the upload to succeed.
"""

import io

from django.conf import settings

_SKIP_EXTS = {".svg", ".svgz"}


def optimize_to_webp(raw, ext):
    """Given raw image bytes and its (lowercased, dotted) extension, return
    `(webp_bytes, ".webp")` if it was worth re-encoding, else `None` — meaning
    the caller should keep the original bytes/name as-is."""
    if not raw or ext in _SKIP_EXTS:
        return None

    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None

    try:
        with Image.open(io.BytesIO(raw)) as img:
            is_animated = getattr(img, "is_animated", False)
            max_dim = settings.IMAGE_OPTIMIZE_MAX_DIMENSION
            quality = settings.IMAGE_OPTIMIZE_WEBP_QUALITY

            if is_animated:
                frames = []
                durations = []
                for frame_index in range(img.n_frames):
                    img.seek(frame_index)
                    frame = ImageOps.exif_transpose(img.convert("RGBA"))
                    frame = _resize_to_cap(frame, max_dim)
                    frames.append(frame)
                    durations.append(img.info.get("duration", 100))
                out = io.BytesIO()
                frames[0].save(
                    out,
                    format="WEBP",
                    save_all=True,
                    append_images=frames[1:],
                    duration=durations,
                    loop=img.info.get("loop", 0),
                    quality=quality,
                    method=6,
                )
            else:
                frame = ImageOps.exif_transpose(img)
                has_alpha = _has_alpha(frame)
                frame = frame.convert("RGBA" if has_alpha else "RGB")
                frame = _resize_to_cap(frame, max_dim)
                out = io.BytesIO()
                frame.save(out, format="WEBP", quality=quality, method=6)
    except Exception:
        # Corrupt/unsupported file, decode bomb guard tripping, etc. — the
        # magic-byte + Pillow-open checks in image_validation already ran by
        # the time save() gets here, so this is a best-effort belt-and-braces
        # catch, not the primary defense.
        return None

    webp_bytes = out.getvalue()
    # A tiny/simple source (icons, already-optimized webp re-saved, etc.) can
    # come back larger post re-encode — only replace the original when it's
    # an actual win.
    if len(webp_bytes) >= len(raw):
        return None
    return webp_bytes, ".webp"


def _has_alpha(img):
    if img.mode in ("RGBA", "LA"):
        return True
    if img.mode == "P":
        return "transparency" in img.info
    return False


def _resize_to_cap(img, max_dim):
    w, h = img.size
    if max(w, h) <= max_dim:
        return img
    from PIL import Image

    scale = max_dim / float(max(w, h))
    new_size = (max(1, round(w * scale)), max(1, round(h * scale)))
    return img.resize(new_size, Image.LANCZOS)
