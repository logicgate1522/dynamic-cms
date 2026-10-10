"""One module per tool. Each exposes:

    send(event, conn) -> dict            server-side event copy (dispatch)
    sync(plan, conn, items) -> list      reconcile plan items (tracking_sync)
    check(conn) -> dict                  validate a connection (connect step)

`conn` = {"account": {...non-secret ids...}, "secret": {...decrypted...}}.
All HTTP goes through base.http_json, so tests replace one function.
"""

from . import ga4, google_ads, gtm, linkedin, meta, tiktok

ADAPTERS = {"meta": meta, "ga4": ga4, "tiktok": tiktok, "linkedin": linkedin, "google_ads": google_ads, "gtm": gtm}
