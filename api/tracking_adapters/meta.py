"""Meta (Facebook/Instagram): Conversions API + custom conversions + website
custom audiences + customer-list audiences."""

from django.conf import settings

from . import base

GRAPH = "https://graph.facebook.com"


def _v():
    return getattr(settings, "META_GRAPH_VERSION", "v21.0")


def _url(path):
    return f"{GRAPH}/{_v()}/{path.lstrip('/')}"


def check(conn):
    token = (conn.get("secret") or {}).get("token")
    pixel = (conn.get("account") or {}).get("pixelId")
    if not token or not pixel:
        raise base.Permanent("Paste a system-user token and the pixel (dataset) id.")
    _, me = base.http_json("GET", _url(f"me?access_token={token}"))
    _, px = base.http_json("GET", _url(f"{pixel}?fields=id,name&access_token={token}"))
    out = {"user": me.get("name") or me.get("id"), "pixel": px.get("name") or px.get("id")}
    ad_account = (conn.get("account") or {}).get("adAccountId")
    if ad_account:
        _, acct = base.http_json("GET", _url(f"act_{str(ad_account).replace('act_', '')}?fields=name,account_status&access_token={token}"))
        out["adAccount"] = acct.get("name")
    return out


def build_event(event, test_code=None):
    consent = event.get("consent") or {}
    ctx = event.get("context") or {}
    ids = event.get("identifiers") or {}
    user = {}
    if consent.get("ad_user_data"):
        if ids.get("em"):
            user["em"] = [ids["em"]]
        if ids.get("ph"):
            user["ph"] = [ids["ph"]]
        if ids.get("external_id"):
            user["external_id"] = [ids["external_id"]]
        if ctx.get("ip"):
            user["client_ip_address"] = ctx["ip"]
        if ctx.get("ua"):
            user["client_user_agent"] = ctx["ua"]
        for k in ("fbp", "fbc"):
            if ctx.get(k):
                user[k] = ctx[k]
        if ids.get("country"):
            user["country"] = [base.sha256(ids["country"].lower())]
    params = dict(event.get("params") or {})
    custom = {k: v for k, v in params.items() if k not in ("event_id", "debug_mode", "traffic_type", "cms_v")}
    if params.get("intent"):
        custom["content_category"] = params["intent"]
    data = {
        "event_name": event["meta_name"], "event_time": base.event_time(event), "event_id": event["event_id"],
        "action_source": "website", "event_source_url": ctx.get("url") or "", "user_data": user, "custom_data": custom,
    }
    body = {"data": [data]}
    if test_code:
        body["test_event_code"] = test_code
    return body


def send(event, conn):
    token = (conn.get("secret") or {}).get("token")
    pixel = (conn.get("account") or {}).get("pixelId")
    if not token or not pixel:
        return {"ok": False, "skipped": True, "detail": "Meta isn't connected (token + pixel id)."}
    test_code = (conn.get("account") or {}).get("testEventCode") if event.get("is_test") else None
    if event.get("is_test") and not test_code:
        return {"ok": False, "skipped": True, "detail": "Set a test event code in the Meta connection to verify without counting real conversions."}
    status, res = base.http_json("POST", _url(f"{pixel}/events?access_token={token}"), build_event(event, test_code))
    received = res.get("events_received")
    return {"ok": received == 1, "detail": f"events_received={received} fbtrace_id={res.get('fbtrace_id', '')}"}


# ----------------------------------------------------------------- sync

def conversion_rule(item):
    """One Meta event per action carries every matched conversion id in a
    `conversions` param ("|lead|lead_payroll|"), so a lead is counted once as
    Lead while each custom conversion filters on its own id."""
    return {"and": [{"event": {"eq": item["meta_event"]}}, {"conversions": {"i_contains": f"|{item['id']}|"}}]}


def desired(plan):
    """What Meta should contain for this plan."""
    items = []
    for c in plan.get("conversions") or []:
        if not c.get("enabled", True):
            continue
        dest = (c.get("destinations") or {}).get("meta")
        if not dest:
            continue
        meta_event = dest if dest != "custom" else "".join(p.capitalize() for p in c["trigger"]["event"].split("_"))
        items.append({"kind": "custom_conversion", "plan_id": c["id"], "name": f"{c['label']} [cms:{c['id']}]",
                      "meta_event": meta_event, "id": c["id"],
                      "category": {"Lead": "LEAD", "Schedule": "LEAD", "Contact": "CONTACT", "ViewContent": "CONTENT_VIEW",
                                   "Search": "SEARCH", "CompleteRegistration": "COMPLETE_REGISTRATION",
                                   "SubmitApplication": "SUBMIT_APPLICATION", "Purchase": "PURCHASE"}.get(meta_event, "OTHER")})
    for a in plan.get("audiences") or []:
        if "meta" not in (a.get("tools") or []):
            continue
        items.append({"kind": "website_audience", "plan_id": a["id"], "name": f"{a['label']} [cms:{a['id']}]",
                      "retention_days": min(int(a.get("windowDays") or 30), 180), "audience": a})
    return items


def audience_rule(audience, plan):
    pixel_ref = "{pixel}"

    def filt(rule):
        f = []
        if rule.get("conversion"):
            f.append({"field": "conversions", "operator": "i_contains", "value": f"|{rule['conversion']}|"})
        if rule.get("event"):
            conv = {"service_engaged": "ViewContent", "generate_lead": "Lead"}.get(rule["event"])
            f.append({"field": "event", "operator": "eq", "value": conv or "".join(p.capitalize() for p in rule["event"].split("_"))})
        for k in ("intent", "stage", "segment"):
            if rule.get(k):
                f.append({"field": k, "operator": "eq", "value": rule[k]})
        return {"operator": "and", "filters": f}

    days = min(int(audience.get("windowDays") or 30), 180) * 86400
    inclusions = {"operator": "or", "rules": [{"event_sources": [{"id": pixel_ref, "type": "pixel"}], "retention_seconds": days,
                                                "filter": filt(r)} for r in audience.get("include") or []]}
    rule = {"inclusions": inclusions}
    if audience.get("exclude"):
        rule["exclusions"] = {"operator": "or", "rules": [{"event_sources": [{"id": pixel_ref, "type": "pixel"}], "retention_seconds": 180 * 86400,
                                                            "filter": filt(r)} for r in audience["exclude"]]}
    return rule


def create(item, conn, plan):
    import json
    token = conn["secret"]["token"]
    acct = "act_" + str(conn["account"]["adAccountId"]).replace("act_", "")
    pixel = conn["account"]["pixelId"]
    if item["kind"] == "custom_conversion":
        body = {"name": item["name"][:100], "event_source_id": pixel, "custom_event_type": item["category"],
                "rule": json.dumps(conversion_rule(item)),
                "description": f"Managed by dynamic-cms [cms:{item['plan_id']}]", "access_token": token}
        _, res = base.http_json("POST", base_url(f"{acct}/customconversions"), body, form=True)
        return res.get("id"), {}
    if item["kind"] == "website_audience":
        rule = json.dumps(audience_rule(item["audience"], plan)).replace("{pixel}", str(pixel))
        body = {"name": item["name"][:100], "rule": rule, "retention_days": item["retention_days"], "prefill": "true",
                "description": f"Managed by dynamic-cms [cms:{item['plan_id']}] — {item['audience'].get('purpose', '')}"[:500],
                "access_token": token}
        _, res = base.http_json("POST", base_url(f"{acct}/customaudiences"), body, form=True)
        return res.get("id"), {}
    raise base.Permanent(f"unknown item kind {item['kind']}")


def update(item, remote_id, conn, plan):
    import json
    token = conn["secret"]["token"]
    if item["kind"] == "custom_conversion":
        # Rules can't change once a custom conversion has data: rename only.
        base.http_json("POST", base_url(remote_id), {"name": item["name"][:100], "access_token": token}, form=True)
        return remote_id
    if item["kind"] == "website_audience":
        rule = json.dumps(audience_rule(item["audience"], plan)).replace("{pixel}", str(conn["account"]["pixelId"]))
        base.http_json("POST", base_url(remote_id), {"name": item["name"][:100], "rule": rule,
                                                      "retention_days": item["retention_days"], "access_token": token}, form=True)
        return remote_id
    return remote_id


def archive(kind, remote_id, conn, name):
    """Never delete data-bearing items: rename to “[removed] …” (custom
    conversions also can't be deleted while they have data)."""
    token = conn["secret"]["token"]
    base.http_json("POST", base_url(remote_id), {"name": f"[removed] {name}"[:100], "access_token": token}, form=True)


def upload_customer_list(audience_id, hashed_rows, conn, remove=False):
    """Customer-list audience membership (opted-in contacts only)."""
    token = conn["secret"]["token"]
    body = {"payload": {"schema": ["EMAIL", "PHONE"], "data": hashed_rows}, "access_token": token}
    import json as _j
    method = "DELETE" if remove else "POST"
    _, res = base.http_json(method, base_url(f"{audience_id}/users"), {"payload": _j.dumps(body["payload"]), "access_token": token}, form=True)
    return res


def create_customer_audience(name, conn):
    token = conn["secret"]["token"]
    acct = "act_" + str(conn["account"]["adAccountId"]).replace("act_", "")
    _, res = base.http_json("POST", base_url(f"{acct}/customaudiences"), {
        "name": name[:100], "subtype": "CUSTOM", "customer_file_source": "USER_PROVIDED_ONLY",
        "description": "Managed by dynamic-cms (opted-in contacts)", "access_token": token}, form=True)
    return res.get("id")


def base_url(path):
    return _url(path)
