"""TikTok: Events API (server copies). Pixel events need no definitions;
custom audiences from pixel rules are created where the Business API allows."""

from . import base

EVENTS_API = "https://business-api.tiktok.com/open_api/v1.3/event/track/"


def check(conn):
    token = (conn.get("secret") or {}).get("token")
    pixel = (conn.get("account") or {}).get("pixelCode")
    if not token or not pixel:
        raise base.Permanent("Paste an Events API access token and the pixel code.")
    return {"pixel": pixel}


def send(event, conn):
    token = (conn.get("secret") or {}).get("token")
    pixel = (conn.get("account") or {}).get("pixelCode")
    if not token or not pixel:
        return {"ok": False, "skipped": True, "detail": "TikTok isn't connected."}
    test_code = (conn.get("account") or {}).get("testEventCode") if event.get("is_test") else None
    if event.get("is_test") and not test_code:
        return {"ok": False, "skipped": True, "detail": "Set a test event code in the TikTok connection to verify."}
    consent = event.get("consent") or {}
    ctx = event.get("context") or {}
    ids = event.get("identifiers") or {}
    user = {}
    if consent.get("ad_user_data"):
        if ids.get("em"):
            user["email"] = ids["em"]
        if ids.get("ph"):
            user["phone"] = ids["ph"]
        for k_src, k_dst in (("ip", "ip"), ("ua", "user_agent"), ("ttp", "ttp"), ("ttclid", "ttclid")):
            if ctx.get(k_src):
                user[k_dst] = ctx[k_src]
    params = event.get("params") or {}
    props = {k: params[k] for k in ("value", "currency") if k in params}
    if params.get("intent"):
        props["content_category"] = params["intent"]
    if params.get("conversions"):
        props["description"] = params["conversions"]
    body = {"event_source": "web", "event_source_id": pixel,
            "data": [{"event": event["tiktok_name"], "event_time": base.event_time(event), "event_id": event["event_id"],
                      "user": user, "page": {"url": ctx.get("url") or ""}, "properties": props}]}
    if test_code:
        body["test_event_code"] = test_code
    _, res = base.http_json("POST", EVENTS_API, body, headers={"Access-Token": token})
    ok = res.get("code") == 0
    return {"ok": ok, "detail": f"{res.get('message', '')} (code {res.get('code')})"}


def desired(plan):
    return []
