"""Google Ads. v1 (default): conversions come from GA4 key events imported
into Ads (one link in Google Ads) — nothing to send from here. v2 (optional,
needs a developer token): conversion actions, click-conversion uploads with
gclid, and Customer Match lists."""

from . import base, google_auth

API = "https://googleads.googleapis.com/v17"
SCOPES = ["https://www.googleapis.com/auth/adwords"]


def _headers(conn):
    acct = conn["account"]
    h = {"Authorization": f"Bearer {google_auth.access_token(conn, SCOPES)}", "developer-token": conn["secret"]["developerToken"]}
    if acct.get("loginCustomerId"):
        h["login-customer-id"] = str(acct["loginCustomerId"]).replace("-", "")
    return h


def enabled(conn):
    return bool((conn.get("secret") or {}).get("developerToken") and (conn.get("account") or {}).get("customerId"))


def check(conn):
    if not enabled(conn):
        return {"mode": "import_from_ga4", "detail": "Link GA4 to Google Ads and import the key events (one click in Google Ads)."}
    cid = str(conn["account"]["customerId"]).replace("-", "")
    _, res = base.http_json("GET", f"{API}/customers/{cid}", headers=_headers(conn))
    return {"mode": "api", "customer": res.get("descriptiveName") or cid}


def send(event, conn):
    if event.get("is_test"):
        return {"ok": False, "skipped": True, "detail": "Test conversions are never sent to Google Ads (they would affect bidding)."}
    if not enabled(conn):
        return {"ok": False, "skipped": True, "detail": "Counted through the GA4 import."}
    action = (event.get("sync") or {}).get("adsConversionAction")
    gclid = (event.get("context") or {}).get("gclid")
    if not action or not gclid:
        return {"ok": False, "skipped": True, "detail": "No click id (gclid) or conversion action for this event."}
    cid = str(conn["account"]["customerId"]).replace("-", "")
    from datetime import datetime, timezone as tz
    when = datetime.fromtimestamp(base.event_time(event), tz.utc).strftime("%Y-%m-%d %H:%M:%S+00:00")
    conv = {"conversionAction": action, "gclid": gclid, "conversionDateTime": when}
    params = event.get("params") or {}
    if params.get("value") is not None:
        conv.update(conversionValue=float(params["value"]), currencyCode=params.get("currency", "USD"))
    ids = event.get("identifiers") or {}
    if (event.get("consent") or {}).get("ad_user_data") and ids.get("em"):
        conv["userIdentifiers"] = [{"hashedEmail": ids["em"]}]
    conv["consent"] = {"adUserData": "GRANTED" if (event.get("consent") or {}).get("ad_user_data") else "DENIED"}
    _, res = base.http_json("POST", f"{API}/customers/{cid}:uploadClickConversions",
                            {"conversions": [conv], "partialFailure": True}, headers=_headers(conn))
    failure = res.get("partialFailureError")
    return {"ok": not failure, "detail": (failure or {}).get("message", "uploaded")[:500]}


def desired(plan):
    return []
