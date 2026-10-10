"""LinkedIn: Conversions API + conversion rules (needs Marketing API access
approved for the app). Without approval the panel says so; nothing breaks."""

from . import base

API = "https://api.linkedin.com/rest"


def _headers(conn):
    return {"Authorization": f"Bearer {conn['secret']['token']}", "LinkedIn-Version": conn["account"].get("apiVersion") or "202405",
            "X-Restli-Protocol-Version": "2.0.0"}


def check(conn):
    if not (conn.get("secret") or {}).get("token") or not (conn.get("account") or {}).get("adAccountId"):
        raise base.Permanent("Connect with an access token (Marketing API) and the ad account id.")
    _, res = base.http_json("GET", f"{API}/adAccounts/{conn['account']['adAccountId']}", headers=_headers(conn))
    return {"adAccount": res.get("name")}


def send(event, conn):
    if event.get("is_test"):
        return {"ok": False, "skipped": True, "detail": "LinkedIn has no test mode; test conversions are never sent (they would affect bidding)."}
    urn = (event.get("sync") or {}).get("linkedinConversionId")
    if not urn or not (conn.get("secret") or {}).get("token"):
        return {"ok": False, "skipped": True, "detail": "No LinkedIn conversion rule for this conversion yet (Sync)."}
    consent = event.get("consent") or {}
    ids = event.get("identifiers") or {}
    ctx = event.get("context") or {}
    user_ids = []
    if consent.get("ad_user_data") and ids.get("em"):
        user_ids.append({"idType": "SHA256_EMAIL", "idValue": ids["em"]})
    if ctx.get("li_fat_id"):
        user_ids.append({"idType": "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", "idValue": ctx["li_fat_id"]})
    if not user_ids:
        return {"ok": False, "skipped": True, "detail": "No consented identifier to match on (LinkedIn needs one)."}
    body = {"conversion": f"urn:lla:llaPartnerConversion:{urn}", "conversionHappenedAt": base.event_time(event) * 1000,
            "eventId": event["event_id"], "user": {"userIds": user_ids}}
    if event.get("params", {}).get("value") is not None:
        body["conversionValue"] = {"currencyCode": event["params"].get("currency", "USD"), "amount": str(event["params"]["value"])}
    base.http_json("POST", f"{API}/conversionEvents", body, headers=_headers(conn))
    return {"ok": True, "detail": "sent (Conversions API)"}


def desired(plan):
    return [{"kind": "linkedin_conversion", "plan_id": c["id"], "name": f"{c['label']} [cms:{c['id']}]"}
            for c in plan.get("conversions") or [] if c.get("enabled", True) and c.get("tier") == "primary"
            and (c.get("destinations") or {}).get("linkedin")]


def create(item, conn, plan):
    acct = conn["account"]["adAccountId"]
    body = {"name": item["name"][:100], "account": f"urn:li:sponsoredAccount:{acct}", "type": "LEAD",
            "conversionMethod": "CONVERSIONS_API", "attributionType": "LAST_TOUCH_BY_CAMPAIGN",
            "postClickAttributionWindowSize": 30, "viewThroughAttributionWindowSize": 7, "enabled": True}
    _, res = base.http_json("POST", f"{API}/conversions", body, headers=_headers(conn))
    return str(res.get("id") or ""), {}


def update(item, remote_id, conn, plan):
    base.http_json("POST", f"{API}/conversions/{remote_id}", {"patch": {"$set": {"name": item["name"][:100]}}}, headers={**_headers(conn), "X-RestLi-Method": "PARTIAL_UPDATE"})
    return remote_id


def archive(kind, remote_id, conn, name):
    base.http_json("POST", f"{API}/conversions/{remote_id}", {"patch": {"$set": {"enabled": False, "name": f"[removed] {name}"[:100]}}},
                   headers={**_headers(conn), "X-RestLi-Method": "PARTIAL_UPDATE"})
