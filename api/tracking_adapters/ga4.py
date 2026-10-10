"""Google Analytics 4: Measurement Protocol (server copies, only when the
browser's GA4 tag didn't load) + Admin API sync (custom dimensions, key
events, audiences, MP secret, internal-traffic filter).

Auth: a service account (JSON key) added as Editor on the property. Tokens
come from google_auth.access_token(); no Google client library needed.
"""

from . import base, google_auth

MP = "https://www.google-analytics.com/mp/collect"
MP_DEBUG = "https://www.google-analytics.com/debug/mp/collect"
ADMIN = "https://analyticsadmin.googleapis.com"
DATA = "https://analyticsdata.googleapis.com"

DIMENSIONS = [("intent", "Intent"), ("segment", "Customer segment"), ("stage", "Buying stage"), ("block", "Page section"),
              ("cta_label", "CTA label"), ("page_type", "Page type"), ("faq_topic", "FAQ topic"), ("form_name", "Form name"),
              ("conversion_id", "Conversion id"), ("traffic_type", "Traffic type")]

SCOPES = ["https://www.googleapis.com/auth/analytics.edit", "https://www.googleapis.com/auth/analytics.readonly"]


def check(conn):
    acct = conn.get("account") or {}
    if not acct.get("propertyId"):
        raise base.Permanent("Enter the GA4 property id (numbers only, from Admin → Property details).")
    token = google_auth.access_token(conn, SCOPES)
    _, prop = base.http_json("GET", f"{ADMIN}/v1beta/properties/{acct['propertyId']}", headers={"Authorization": f"Bearer {token}"})
    _, streams = base.http_json("GET", f"{ADMIN}/v1beta/properties/{acct['propertyId']}/dataStreams", headers={"Authorization": f"Bearer {token}"})
    web = [s for s in streams.get("dataStreams") or [] if s.get("type") == "WEB_DATA_STREAM"]
    return {"property": prop.get("displayName"), "streams": [{"name": s["name"], "measurementId": (s.get("webStreamData") or {}).get("measurementId")} for s in web]}


def mp_body(event, client_id):
    params = {k: v for k, v in (event.get("params") or {}).items() if k not in ("event_id", "cms_v")}
    params.setdefault("engagement_time_msec", 1)
    if event.get("is_test"):
        params["debug_mode"] = True
        params["traffic_type"] = "internal"
    events = [{"name": event["name"], "params": params}]
    for cid in (event.get("conversion_ids") or []):
        events.append({"name": f"cv_{cid}"[:40], "params": {**params, "conversion_id": cid}})
    consent = event.get("consent") or {}
    return {"client_id": client_id, "events": events,
            "consent": {"ad_user_data": "GRANTED" if consent.get("ad_user_data") else "DENIED",
                        "ad_personalization": "GRANTED" if consent.get("ad_personalization") else "DENIED"}}


def send(event, conn):
    acct = conn.get("account") or {}
    secret = (conn.get("secret") or {}).get("mpSecret") or acct.get("mpSecret")
    mid = acct.get("measurementId")
    if not secret or not mid:
        return {"ok": False, "skipped": True, "detail": "GA4 server copies need the measurement id and an API secret (created by Sync)."}
    client_id = (event.get("context") or {}).get("ga_client_id") or f"{int(base.sha256(event["event_id"])[:9], 16)}.{base.event_time(event)}"
    body = mp_body(event, client_id)
    if event.get("is_test"):
        # Verification: the validation server checks the payload without recording it.
        _, res = base.http_json("POST", f"{MP_DEBUG}?measurement_id={mid}&api_secret={secret}", body)
        problems = res.get("validationMessages") or []
        return {"ok": not problems, "detail": "; ".join(m.get("description", "") for m in problems)[:500] or "valid (GA4 validation server)"}
    base.http_json("POST", f"{MP}?measurement_id={mid}&api_secret={secret}", body)
    return {"ok": True, "detail": "sent (Measurement Protocol)"}


# ----------------------------------------------------------------- sync

def desired(plan):
    items = [{"kind": "custom_dimension", "plan_id": key, "parameterName": key, "displayName": label} for key, label in DIMENSIONS]
    for c in plan.get("conversions") or []:
        if c.get("enabled", True) and c.get("tier") == "primary" and (c.get("destinations") or {}).get("ga4") == "key_event":
            items.append({"kind": "key_event", "plan_id": c["id"], "eventName": f"cv_{c['id']}"[:40]})
    items.append({"kind": "key_event", "plan_id": "generate_lead", "eventName": "generate_lead"})
    items.append({"kind": "mp_secret", "plan_id": "dynamic_cms", "displayName": "dynamic-cms server events"})
    for a in plan.get("audiences") or []:
        if "ga4" in (a.get("tools") or []):
            items.append({"kind": "audience", "plan_id": a["id"], "audience": a, "displayName": f"{a['label']} [cms:{a['id']}]"[:100]})
    return items


def _auth(conn):
    return {"Authorization": f"Bearer {google_auth.access_token(conn, SCOPES)}"}


def _prop(conn):
    return f"properties/{conn['account']['propertyId']}"


def fetch(conn):
    h = _auth(conn)
    p = _prop(conn)
    out = {}
    _, dims = base.http_json("GET", f"{ADMIN}/v1beta/{p}/customDimensions?pageSize=200", headers=h)
    out["custom_dimension"] = {d["parameterName"]: d for d in dims.get("customDimensions") or []}
    _, keys = base.http_json("GET", f"{ADMIN}/v1beta/{p}/keyEvents?pageSize=200", headers=h)
    out["key_event"] = {k["eventName"]: k for k in keys.get("keyEvents") or []}
    return out


def _stream(conn):
    sid = conn["account"].get("streamName")
    if sid:
        return sid
    h = _auth(conn)
    _, streams = base.http_json("GET", f"{ADMIN}/v1beta/{_prop(conn)}/dataStreams", headers=h)
    mid = conn["account"].get("measurementId")
    for s in streams.get("dataStreams") or []:
        if s.get("type") == "WEB_DATA_STREAM" and (not mid or (s.get("webStreamData") or {}).get("measurementId") == mid):
            return s["name"]
    raise base.Permanent("No web data stream found on the GA4 property.")


def audience_body(item):
    a = item["audience"]

    def clause(rule):
        filters = []
        if rule.get("conversion"):
            filters.append({"atAnyPointInTime": True, "eventFilter": {"eventName": f"cv_{rule['conversion']}"[:40]}})
        elif rule.get("event"):
            params = []
            for k in ("intent", "stage", "segment"):
                if rule.get(k):
                    params.append({"filterExpression": {"dimensionOrMetricFilter": {"fieldName": k, "stringFilter": {"matchType": "EXACT", "value": rule[k]}}}})
            ef = {"eventName": rule["event"]}
            if params:
                ef["eventParameterFilterExpression"] = {"andGroup": {"filterExpressions": params}}
            filters.append({"atAnyPointInTime": True, "eventFilter": ef})
        return {"orGroup": {"filterExpressions": [{"eventFilter": f["eventFilter"]} for f in filters]}}

    include = {"clauseType": "INCLUDE", "simpleFilter": {"scope": "AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS",
                                                          "filterExpression": {"andGroup": {"filterExpressions": [clause(r) for r in a["include"]]}}}}
    clauses = [include]
    if a.get("exclude"):
        clauses.append({"clauseType": "EXCLUDE", "simpleFilter": {"scope": "AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS",
                                                                   "filterExpression": {"andGroup": {"filterExpressions": [clause(r) for r in a["exclude"]]}}}})
    return {"displayName": item["displayName"], "description": (a.get("purpose") or "")[:250],
            "membershipDurationDays": min(int(a.get("windowDays") or 30), 540), "filterClauses": clauses}


def create(item, conn, plan):
    h = _auth(conn)
    p = _prop(conn)
    if item["kind"] == "custom_dimension":
        _, res = base.http_json("POST", f"{ADMIN}/v1beta/{p}/customDimensions", {
            "parameterName": item["parameterName"], "displayName": item["displayName"], "scope": "EVENT",
            "description": "Managed by dynamic-cms"}, headers=h)
        return res.get("name"), {}
    if item["kind"] == "key_event":
        _, res = base.http_json("POST", f"{ADMIN}/v1beta/{p}/keyEvents", {"eventName": item["eventName"], "countingMethod": "ONCE_PER_EVENT"}, headers=h)
        return res.get("name"), {}
    if item["kind"] == "mp_secret":
        _, res = base.http_json("POST", f"{ADMIN}/v1beta/{_stream(conn)}/measurementProtocolSecrets", {"displayName": item["displayName"]}, headers=h)
        return res.get("name"), {"secretValue": res.get("secretValue")}
    if item["kind"] == "audience":
        try:
            _, res = base.http_json("POST", f"{ADMIN}/v1alpha/{p}/audiences", audience_body(item), headers=h)
        except base.Permanent as err:
            if err.status in (400, 404):
                raise base.Permanent(f"GA4 audience API unavailable ({err}); create it manually from the definition shown.") from None
            raise
        return res.get("name"), {}
    raise base.Permanent(f"unknown item kind {item['kind']}")


def update(item, remote_id, conn, plan):
    h = _auth(conn)
    if item["kind"] == "custom_dimension":
        base.http_json("PATCH", f"{ADMIN}/v1beta/{remote_id}?updateMask=displayName", {"displayName": item["displayName"]}, headers=h)
    # Key events and audiences can't change their definition: archive + recreate is done by the engine.
    return remote_id


def archive(kind, remote_id, conn, name):
    h = _auth(conn)
    if kind == "custom_dimension":
        base.http_json("POST", f"{ADMIN}/v1beta/{remote_id}:archive", {}, headers=h)
    elif kind == "key_event":
        base.http_json("DELETE", f"{ADMIN}/v1beta/{remote_id}", headers=h)
    elif kind == "audience":
        base.http_json("POST", f"{ADMIN}/v1alpha/{remote_id}:archive", {}, headers=h)


def realtime_count(conn, event_names, minutes=29):
    """Events seen in the last N minutes (Data API realtime) — arrival check."""
    h = {"Authorization": f"Bearer {google_auth.access_token(conn, SCOPES)}"}
    body = {"dimensions": [{"name": "eventName"}], "metrics": [{"name": "eventCount"}],
            "minuteRanges": [{"startMinutesAgo": minutes, "endMinutesAgo": 0}],
            "dimensionFilter": {"filter": {"fieldName": "eventName", "inListFilter": {"values": list(event_names)[:20]}}}}
    _, res = base.http_json("POST", f"{DATA}/v1beta/{_prop(conn)}:runRealtimeReport", body, headers=h)
    return {r["dimensionValues"][0]["value"]: int(r["metricValues"][0]["value"]) for r in res.get("rows") or []}
