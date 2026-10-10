"""Approximate location for a lead (R33): country / region / city only, never
the IP. Sources, in order:
  1. hosting/CDN headers (Cloudflare, Vercel, Fastly, Netlify, CloudFront);
  2. an optional MaxMind GeoLite2-City database at GEOIP_DB_PATH (needs the
     `geoip2` package; the owner downloads the file under MaxMind's licence);
  3. nothing.
A visitor can only misstate their own enquiry's location, so headers are
trusted as-is (disable with TRUST_GEO_HEADERS=False).
"""

from urllib.parse import unquote

from django.conf import settings

HEADER_SETS = (
    ("HTTP_CF_IPCOUNTRY", "HTTP_CF_REGION", "HTTP_CF_IPCITY"),
    ("HTTP_X_VERCEL_IP_COUNTRY", "HTTP_X_VERCEL_IP_COUNTRY_REGION", "HTTP_X_VERCEL_IP_CITY"),
    ("HTTP_FASTLY_GEO_COUNTRY_CODE", "HTTP_FASTLY_GEO_REGION", "HTTP_FASTLY_GEO_CITY"),
    ("HTTP_X_COUNTRY", "HTTP_X_NF_GEO_SUBDIVISION", "HTTP_X_NF_GEO_CITY"),
    ("HTTP_CLOUDFRONT_VIEWER_COUNTRY", "HTTP_CLOUDFRONT_VIEWER_COUNTRY_REGION_NAME", "HTTP_CLOUDFRONT_VIEWER_CITY"),
)

_reader = None


def _clean(value, n):
    text = unquote(str(value or "")).strip()
    return "" if text.upper() in ("XX", "T1", "UNKNOWN") else text[:n]


def client_ip(request):
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded and getattr(settings, "TRUST_FORWARDED_FOR", True):
        return forwarded.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "")


def locate(request):
    if getattr(settings, "TRUST_GEO_HEADERS", True):
        for country_h, region_h, city_h in HEADER_SETS:
            country = _clean(request.META.get(country_h), 2).upper()
            if len(country) == 2:
                return {"country": country, "region": _clean(request.META.get(region_h), 100), "city": _clean(request.META.get(city_h), 100)}
    path = getattr(settings, "GEOIP_DB_PATH", "")
    if path:
        global _reader
        try:
            if _reader is None:
                import geoip2.database
                _reader = geoip2.database.Reader(path)
            r = _reader.city(client_ip(request))
            return {"country": (r.country.iso_code or "")[:2], "region": (r.subdivisions.most_specific.name or "")[:100],
                    "city": (r.city.name or "")[:100]}
        except Exception:
            return {"country": "", "region": "", "city": ""}
    return {"country": "", "region": "", "city": ""}
