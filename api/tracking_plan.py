"""The tracking plan (R31): validation, trigger resolution, the runtime config
the kit reads, server-side conversion matching, test compilation and diffs.

The plan is stored in SiteSettings.data.analytics.plan (see
TRACKING_IMPLEMENTATION_PLAN.md §2.1). Nothing here talks to a tool.
"""

import copy
import json
import re

from .site_facts import norm_path
from .tracking_vocab import EVENTS, META_STANDARD, PAGE_TYPES, TIKTOK_STANDARD

ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,39}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
TIERS = ("primary", "secondary")
REGIONS = ("uk_eu", "us", "other")
VALUE_MODES = ("none", "fixed", "by_option", "by_intent")
PERCENTS = (25, 50, 75, 90, 100)
METHODS = ("phone", "email", "whatsapp")

# Per-tool caps, with headroom for the owner's own items (§2.1).
CAPS = {"primary": 25, "conversions": 80, "audiences": 80, "intents": 40, "segments": 30, "stages": 10}

WHERE_KEYS = {"form", "field", "option", "intent", "stage", "segment", "blocks", "ctaTargets", "ctaLabel",
              "path", "pathPrefix", "pageType", "percent", "method"}


class PlanError(ValueError):
    pass


def empty_plan():
    return {"version": 0, "status": "draft", "region": "uk_eu", "currency": "GBP", "intents": [], "segments": [],
            "stages": [], "conversions": [], "audiences": [], "valueRules": [], "facts": {}}


def get_plan():
    from .models import SiteSettings
    site = (SiteSettings.objects.filter(pk=1).first() or SiteSettings()).data or {}
    plan = (site.get("analytics") or {}).get("plan")
    return plan if isinstance(plan, dict) else empty_plan()


def save_plan(plan):
    """Store the plan (replacing, not deep-merging: lists must be exact)."""
    from django.db import transaction

    from .models import SiteSettings
    with transaction.atomic():
        row, _ = SiteSettings.objects.select_for_update().get_or_create(pk=1, defaults={"data": {}})
        data = row.data or {}
        analytics = dict(data.get("analytics") or {})
        analytics["plan"] = plan
        data["analytics"] = analytics
        row.data = data
        row.save()
    return plan


# ------------------------------------------------------------- validation

def _str(v, n):
    return str(v or "").strip()[:n]


def _fact_index(facts):
    forms = {f["name"]: {x["name"]: x for x in f["fields"]} for f in facts.get("forms") or []}
    paths = {p["path"] for p in facts.get("pages") or []}
    return {
        "forms": forms, "paths": paths, "blocks": set((facts.get("blocks") or {}).keys()),
        "scanned": bool(facts.get("scanned")), "channels": facts.get("channels") or {},
    }


def check_where(event, where, idx, plan_ids):
    """Problems with one trigger's references, as (level, message):
    'dangling' = refers to something that isn't on the site; 'invalid' =
    malformed; 'unverified' = can't check until the site is scanned."""
    problems = []
    if event not in EVENTS or event == "conversion":
        return [("invalid", f"unknown event “{event}”")]
    if not isinstance(where, dict):
        return [("invalid", "trigger.where must be an object")]
    for key in where:
        if key not in WHERE_KEYS:
            problems.append(("invalid", f"unknown condition “{key}”"))
    form = where.get("form")
    if form is not None:
        fields = idx["forms"].get(form)
        if fields is None:
            problems.append(("dangling", f"form “{form}” doesn't exist"))
        elif where.get("field") is not None:
            field = fields.get(where["field"])
            if field is None:
                problems.append(("dangling", f"field “{where['field']}” isn't on form “{form}”"))
            elif where.get("option") is not None:
                values = {o["value"] for o in field.get("options") or []}
                if where["option"] not in values:
                    problems.append(("dangling", f"option “{where['option']}” isn't in field “{where['field']}”"))
    elif where.get("field") or where.get("option"):
        problems.append(("invalid", "field/option need a form"))
    for key, pool in (("intent", "intents"), ("stage", "stages"), ("segment", "segments")):
        if where.get(key) is not None and where[key] not in plan_ids[pool]:
            problems.append(("dangling", f"{key} “{where[key]}” isn't in the plan"))
    for block in where.get("blocks") or []:
        if idx["scanned"] and block not in idx["blocks"]:
            problems.append(("dangling", f"block “{block}” isn't on any page"))
        elif not idx["scanned"]:
            problems.append(("unverified", f"block “{block}” (scan the site to confirm)"))
    for target in where.get("ctaTargets") or []:
        if norm_path(target) not in idx["paths"]:
            problems.append(("dangling", f"CTA target {target} isn't a page"))
    if where.get("path") is not None and norm_path(where["path"]) not in idx["paths"]:
        problems.append(("dangling", f"page {where['path']} doesn't exist"))
    if where.get("pathPrefix") is not None:
        prefix = norm_path(where["pathPrefix"])
        if not any(p == prefix or p.startswith(prefix + "/") for p in idx["paths"]):
            problems.append(("dangling", f"no pages under {where['pathPrefix']}"))
    if where.get("pageType") is not None and where["pageType"] not in PAGE_TYPES:
        problems.append(("invalid", f"page type “{where['pageType']}”"))
    if where.get("percent") is not None and where["percent"] not in PERCENTS:
        problems.append(("invalid", f"percent must be one of {PERCENTS}"))
    if where.get("method") is not None:
        if where["method"] not in METHODS:
            problems.append(("invalid", f"method must be one of {METHODS}"))
        elif not idx["channels"].get(where["method"]):
            problems.append(("dangling", f"no {where['method']} link is shown on the site"))
    return problems


def validate(plan, facts):
    """Returns (clean_plan, report). report = {errors: [...], dangling: [...],
    unverified: [...], warnings: [...]}. Errors make the plan unsaveable;
    dangling triggers make it unapprovable (§2.1)."""
    report = {"errors": [], "dangling": [], "unverified": [], "warnings": []}
    if not isinstance(plan, dict):
        raise PlanError("The plan must be an object.")
    idx = _fact_index(facts)
    out = empty_plan()
    out["version"] = int(plan.get("version") or 0)
    out["status"] = plan.get("status") if plan.get("status") in ("draft", "approved") else "draft"
    out["region"] = plan.get("region") if plan.get("region") in REGIONS else "uk_eu"
    cur = str(plan.get("currency") or "").upper()
    out["currency"] = cur if CURRENCY_RE.match(cur) else ((facts.get("org") or {}).get("currency") or "USD")
    out["pack"] = _str(plan.get("pack"), 40)
    out["facts"] = plan.get("facts") if isinstance(plan.get("facts"), dict) else {}

    def take(kind, items, cap, clean_item):
        seen = set()
        result = []
        for i, item in enumerate(items if isinstance(items, list) else []):
            if not isinstance(item, dict):
                report["errors"].append(f"{kind}[{i}] must be an object")
                continue
            iid = str(item.get("id") or "")
            if not ID_RE.match(iid):
                report["errors"].append(f"{kind}[{i}] id “{iid}” must be lowercase letters, digits and _ (2–40, starting with a letter)")
                continue
            if iid in seen:
                report["errors"].append(f"{kind}: duplicate id “{iid}”")
                continue
            seen.add(iid)
            cleaned = clean_item(item)
            cleaned.update({"id": iid, "label": _str(item.get("label"), 60) or iid,
                            "createdBy": item.get("createdBy") if item.get("createdBy") in ("ai", "library", "owner") else "owner",
                            "locked": bool(item.get("locked")), "rationale": _str(item.get("rationale"), 300)})
            result.append(cleaned)
        if len(result) > cap:
            report["errors"].append(f"too many {kind}: {len(result)} (max {cap})")
        return result

    def match_of(item, keys):
        m = item.get("match") if isinstance(item.get("match"), dict) else {}
        out_m = {}
        for key in keys:
            value = m.get(key) or []
            if key == "formOptions":
                out_m[key] = [{"form": _str(x.get("form"), 60), "field": _str(x.get("field"), 60), "option": _str(x.get("option"), 100)}
                              for x in value if isinstance(x, dict)][:20]
            elif key in ("paths", "pathPrefixes"):
                out_m[key] = [norm_path(x) for x in value if isinstance(x, str)][:20]
            else:
                out_m[key] = [_str(x, 80) for x in value if isinstance(x, str) and x.strip()][:30]
        return out_m

    out["intents"] = take("intents", plan.get("intents"), CAPS["intents"],
                          lambda it: {"match": match_of(it, ("paths", "pathPrefixes", "blocks", "faqKeywords", "formOptions")),
                                      "value": max(0.0, float(it.get("value") or 0)) if _num(it.get("value")) else 0})
    out["segments"] = take("segments", plan.get("segments"), CAPS["segments"],
                           lambda it: {"match": match_of(it, ("blocks", "faqKeywords", "formOptions"))})
    out["stages"] = take("stages", plan.get("stages"), CAPS["stages"],
                         lambda it: {"match": match_of(it, ("faqKeywords", "blocks")), "strength": int(it.get("strength") or 1) if _num(it.get("strength")) else 1})
    plan_ids = {k: {x["id"] for x in out[k]} for k in ("intents", "stages", "segments")}

    # Form-option references inside intents/segments must exist too.
    for kind in ("intents", "segments"):
        for item in out[kind]:
            for fo in item["match"].get("formOptions") or []:
                for level, msg in check_where("generate_lead", fo, idx, plan_ids):
                    report[level if level != "invalid" else "errors"].append(f"{kind} “{item['id']}”: {msg}")
            for path in item["match"].get("paths") or []:
                if path not in idx["paths"]:
                    report["dangling"].append(f"{kind} “{item['id']}”: page {path} doesn't exist")

    def clean_conversion(c):
        trig = c.get("trigger") if isinstance(c.get("trigger"), dict) else {}
        event = str(trig.get("event") or "")
        where = {k: v for k, v in (trig.get("where") or {}).items() if k in WHERE_KEYS} if isinstance(trig.get("where"), dict) else {}
        if "ctaTargets" in where:
            where["ctaTargets"] = [norm_path(x) for x in where["ctaTargets"] if isinstance(x, str)][:10]
        if "blocks" in where:
            where["blocks"] = [str(x)[:80] for x in where["blocks"] if isinstance(x, str)][:10]
        value = c.get("value") if isinstance(c.get("value"), dict) else {}
        mode = value.get("mode") if value.get("mode") in VALUE_MODES else "none"
        val = {"mode": mode}
        if mode == "fixed":
            val["amount"] = max(0.0, float(value.get("amount") or 0)) if _num(value.get("amount")) else 0
        if mode == "by_option":
            val["field"] = _str(value.get("field"), 60)
            val["map"] = {str(k)[:100]: max(0.0, float(v)) for k, v in (value.get("map") or {}).items() if _num(v)}
        dest = c.get("destinations") if isinstance(c.get("destinations"), dict) else {}
        meta = dest.get("meta")
        tiktok = dest.get("tiktok")
        return {
            "tier": c.get("tier") if c.get("tier") in TIERS else "secondary",
            "trigger": {"event": event, "where": where}, "value": val, "enabled": c.get("enabled", True) is not False,
            "destinations": {
                "ga4": dest.get("ga4") if dest.get("ga4") in ("key_event", "event", None) else "event",
                "meta": meta if meta in META_STANDARD or meta in ("custom", None) else "custom",
                "tiktok": tiktok if tiktok in TIKTOK_STANDARD or tiktok is None else None,
                "googleAds": dest.get("googleAds") if dest.get("googleAds") in ("import_from_ga4", "conversion_action", None) else None,
                "linkedin": dest.get("linkedin") if dest.get("linkedin") in ("auto", None) else None,
            },
        }

    out["conversions"] = take("conversions", plan.get("conversions"), CAPS["conversions"], clean_conversion)
    # Unknown conditions would silently broaden a trigger (a typo'd "optoin"
    # makes a per-service conversion fire on every lead): refuse them.
    for raw in plan.get("conversions") or []:
        if isinstance(raw, dict) and isinstance(raw.get("trigger"), dict) and isinstance(raw["trigger"].get("where"), dict):
            for key in raw["trigger"]["where"]:
                if key not in WHERE_KEYS:
                    report["errors"].append(f"conversion “{raw.get('id')}”: unknown condition “{key}”")
    for c in out["conversions"]:
        if len(c["id"]) > 37:
            report["errors"].append(f"conversion “{c['id']}”: id must be at most 37 characters (GA4 event cv_<id> ≤ 40)")
    for c in out["conversions"]:
        for level, msg in check_where(c["trigger"]["event"], c["trigger"]["where"], idx, plan_ids):
            report[level if level != "invalid" else "errors"].append(f"conversion “{c['id']}”: {msg}")
        if c["value"]["mode"] == "by_option" and c["trigger"]["where"].get("form"):
            fields = idx["forms"].get(c["trigger"]["where"]["form"]) or {}
            field = fields.get(c["value"].get("field"))
            if not field:
                report["dangling"].append(f"conversion “{c['id']}”: value field “{c['value'].get('field')}” isn't on the form")
            else:
                values = {o["value"] for o in field.get("options") or []}
                for opt in c["value"]["map"]:
                    if opt not in values:
                        report["dangling"].append(f"conversion “{c['id']}”: value option “{opt}” isn't in the field")
    primaries = [c for c in out["conversions"] if c["tier"] == "primary" and c["enabled"]]
    if len(primaries) > CAPS["primary"]:
        report["errors"].append(f"too many primary conversions: {len(primaries)} (max {CAPS['primary']}; GA4 allows 30 key events)")
    if not primaries:
        report["warnings"].append("no primary conversion: nothing will count as a lead in your ad tools")
    conv_ids = {c["id"] for c in out["conversions"]}

    def clean_audience(a):
        def rules(value):
            out_r = []
            for r in value if isinstance(value, list) else []:
                if not isinstance(r, dict):
                    continue
                rule = {}
                if r.get("conversion") is not None:
                    rule["conversion"] = str(r["conversion"])
                if r.get("event") is not None:
                    rule["event"] = str(r["event"])
                for k in ("intent", "stage", "segment"):
                    if r.get(k) is not None:
                        rule[k] = str(r[k])
                if r.get("percent") is not None and _num(r["percent"]):
                    rule["percent"] = int(r["percent"])
                if rule:
                    out_r.append(rule)
            return out_r[:10]
        days = int(a.get("windowDays") or 30) if _num(a.get("windowDays")) else 30
        return {"purpose": _str(a.get("purpose"), 200), "include": rules(a.get("include")), "exclude": rules(a.get("exclude")),
                "windowDays": min(max(days, 1), 540), "role": "exclusion" if a.get("role") == "exclusion" else "target",
                "tools": [t for t in (a.get("tools") or []) if t in ("ga4", "meta", "googleAds", "tiktok", "linkedin")]}

    out["audiences"] = take("audiences", plan.get("audiences"), CAPS["audiences"], clean_audience)
    for a in out["audiences"]:
        if not a["include"]:
            report["errors"].append(f"audience “{a['id']}”: needs at least one include rule")
        for rule in a["include"] + a["exclude"]:
            if "conversion" in rule and rule["conversion"] not in conv_ids:
                report["dangling"].append(f"audience “{a['id']}”: conversion “{rule['conversion']}” isn't in the plan")
            if "event" in rule and rule["event"] not in EVENTS:
                report["errors"].append(f"audience “{a['id']}”: unknown event “{rule['event']}”")
            for k, pool in (("intent", "intents"), ("stage", "stages"), ("segment", "segments")):
                if k in rule and rule[k] not in plan_ids[pool]:
                    report["dangling"].append(f"audience “{a['id']}”: {k} “{rule[k]}” isn't in the plan")
        if "meta" in a["tools"] and a["windowDays"] > 180:
            report["warnings"].append(f"audience “{a['id']}”: Meta keeps website audiences for at most 180 days (it will use 180)")
    out["valueRules"] = []
    report["gaps"] = completeness(out, facts)
    return out, report


def completeness(plan, facts):
    """What the site has that the plan doesn't cover (R31). An approved plan
    must be complete, not just valid: every lead form has a primary lead
    conversion, every offering page an intent, every booking/contact page a
    cta_click conversion, and every option of a "who are you" form field a
    segment. Returns readable gaps; [] = complete."""
    from .site_facts import norm_path
    from .tracking_library import SKIP_OPTIONS, lead_forms, offering_pages, segment_fields
    gaps = []
    convs = [c for c in plan.get("conversions") or [] if c.get("enabled", True)]

    def where(c):
        return (c.get("trigger") or {}).get("where") or {}

    for form in lead_forms(facts):
        if not any(c.get("tier") == "primary" and (c.get("trigger") or {}).get("event") == "generate_lead"
                   and where(c).get("form") in (None, "", form["name"]) for c in convs):
            gaps.append(f"lead form “{form['name']}” has no primary generate_lead conversion")
    intents = plan.get("intents") or []
    for _, entry in offering_pages(facts):
        path = norm_path(entry["path"])
        if not any(path in [norm_path(p) for p in (i.get("match") or {}).get("paths") or []]
                   or any(path.startswith(norm_path(x).rstrip("/") + "/") for x in (i.get("match") or {}).get("pathPrefixes") or [])
                   for i in intents):
            gaps.append(f"offering page {path} has no intent")
    for path in facts.get("ctaPages") or []:
        if not any((c.get("trigger") or {}).get("event") == "cta_click"
                   and (not where(c).get("ctaTargets") or path in [norm_path(t) for t in where(c)["ctaTargets"]]) for c in convs):
            gaps.append(f"booking/contact page {path} has no cta_click conversion")
    segments = plan.get("segments") or []
    for form, field in segment_fields(facts):
        for opt in field["options"]:
            if opt["value"].strip().lower() in SKIP_OPTIONS:
                continue
            fo = {"form": form["name"], "field": field["name"], "option": opt["value"]}
            if not any(fo in ((s.get("match") or {}).get("formOptions") or []) for s in segments):
                gaps.append(f"“{opt['label']}” ({form['name']}.{field['name']}) has no segment")
    return gaps


def _num(v):
    if isinstance(v, bool):
        return False
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False


# ----------------------------------------------------------- runtime config

def page_maps(plan, facts):
    """path -> page type and path -> intent, resolved on the server so the
    browser does no matching of its own for pages."""
    types = {p["path"]: p["type"] for p in facts.get("pages") or []}
    intents = {}
    for intent in plan.get("intents") or []:
        for path in intent["match"].get("paths") or []:
            intents[path] = intent["id"]
        for prefix in intent["match"].get("pathPrefixes") or []:
            for p in types:
                if p.startswith(prefix.rstrip("/") + "/"):
                    intents.setdefault(p, intent["id"])
    return types, intents


def runtime_config(plan, facts, sync_detail=None):
    """Public config for the kit (GET tracking/config/). No audiences, no
    rationale, no secrets: only what the browser needs to label and match
    events."""
    from .tracking_vocab import public_vocab
    types, intents = page_maps(plan, facts)
    approved = plan.get("status") == "approved"
    sync_detail = sync_detail or {}
    conversions = []
    for c in plan.get("conversions") or []:
        if not c.get("enabled", True):
            continue
        conversions.append({"id": c["id"], "label": c["label"], "tier": c["tier"], "trigger": c["trigger"],
                            "value": c.get("value") or {"mode": "none"},
                            "meta": (c.get("destinations") or {}).get("meta"), "tiktok": (c.get("destinations") or {}).get("tiktok"),
                            **(sync_detail.get(c["id"]) or {})})
    region = plan.get("region")
    if not (plan.get("intents") or plan.get("conversions")) or region not in REGIONS:
        from .tracking_library import EU_UK
        country = (facts.get("org") or {}).get("country") or ""
        region = "us" if country == "US" else "uk_eu" if country in EU_UK else "other"
    return {
        "v": plan.get("version", 0), "approved": approved, "region": region,
        "currency": plan.get("currency", "USD"),
        "intents": [{"id": i["id"], "label": i["label"], "blocks": i["match"].get("blocks") or [],
                     "keywords": i["match"].get("faqKeywords") or [], "formOptions": i["match"].get("formOptions") or [],
                     "value": i.get("value") or 0} for i in plan.get("intents") or []],
        "segments": [{"id": s["id"], "label": s["label"], "blocks": s["match"].get("blocks") or [],
                      "keywords": s["match"].get("faqKeywords") or [], "formOptions": s["match"].get("formOptions") or []}
                     for s in plan.get("segments") or []],
        "stages": [{"id": s["id"], "label": s["label"], "keywords": s["match"].get("faqKeywords") or [],
                    "blocks": s["match"].get("blocks") or [], "strength": s.get("strength", 1)} for s in plan.get("stages") or []],
        "conversions": conversions if approved else [],
        "pageTypes": types, "pageIntents": intents, "formPages": facts.get("ctaPages") or [],
        "vocab": public_vocab(),
    }


# ------------------------------------------------- server-side lead matching

def _chosen(value):
    if isinstance(value, list):
        return [str(v) for v in value]
    if value in (None, ""):
        return []
    return [str(value)]


def lead_profile_from_answers(plan, form_name, data):
    """Intents/segments the visitor *said* (form answers win over inference)."""
    said = {"intents": [], "segments": []}
    for kind in ("intents", "segments"):
        for item in plan.get(kind) or []:
            for fo in item["match"].get("formOptions") or []:
                if fo["form"] == form_name and fo["option"] in _chosen(data.get(fo["field"])):
                    said[kind].append(item["id"])
                    break
    return said


def match_lead_conversions(plan, form_name, data):
    """Conversions a stored submission fires (generate_lead triggers)."""
    if plan.get("status") != "approved":
        return []
    matched = []
    for c in plan.get("conversions") or []:
        if not c.get("enabled", True) or c["trigger"]["event"] != "generate_lead":
            continue
        where = c["trigger"]["where"]
        if where.get("form") and where["form"] != form_name:
            continue
        if where.get("field") and where.get("option") is not None and where["option"] not in _chosen(data.get(where["field"])):
            continue
        matched.append(c)
    return matched


def conversion_value(plan, conversion, data, said_intents=()):
    v = conversion.get("value") or {}
    mode = v.get("mode")
    if mode == "fixed":
        return float(v.get("amount") or 0)
    if mode == "by_option":
        return float(sum(v.get("map", {}).get(opt, 0) for opt in _chosen(data.get(v.get("field")))))
    if mode == "by_intent":
        values = {i["id"]: i.get("value") or 0 for i in plan.get("intents") or []}
        return float(sum(values.get(i, 0) for i in said_intents))
    return None


# --------------------------------------------------------------- diffing

def diff(old, new):
    """Item-level diff for the approval view."""
    result = {}
    for kind in ("intents", "segments", "stages", "conversions", "audiences"):
        before = {x["id"]: x for x in (old or {}).get(kind) or []}
        after = {x["id"]: x for x in (new or {}).get(kind) or []}
        strip = lambda x: json.dumps({k: v for k, v in x.items() if k not in ("rationale", "createdBy")}, sort_keys=True)
        result[kind] = {
            "added": [after[i] for i in after if i not in before],
            "removed": [before[i] for i in before if i not in after],
            "changed": [{"before": before[i], "after": after[i]} for i in after if i in before and strip(before[i]) != strip(after[i])],
        }
    result["total"] = sum(len(v["added"]) + len(v["removed"]) + len(v["changed"]) for k, v in result.items() if isinstance(v, dict))
    return result


def merge_locked(old, new):
    """Locked items in `old` survive any replacement unchanged."""
    merged = copy.deepcopy(new)
    for kind in ("intents", "segments", "stages", "conversions", "audiences"):
        locked = {x["id"]: x for x in (old or {}).get(kind) or [] if x.get("locked")}
        items = [x for x in merged.get(kind) or [] if x["id"] not in locked]
        merged[kind] = items + list(locked.values())
    return merged


# ------------------------------------------------------- verification tests

def compile_tests(plan, facts, only=None):
    """One test per enabled conversion: where to go and what to do there,
    plus what must be sent. A test that can't be placed says why (§11.1)."""
    pages = facts.get("pages") or []
    types = {p["path"]: p["type"] for p in pages}
    ctas = facts.get("ctas") or []
    faqs = facts.get("faqs") or []
    forms = {f["name"]: f for f in facts.get("forms") or []}
    stages = {s["id"]: s for s in plan.get("stages") or []}
    intents = {i["id"]: i for i in plan.get("intents") or []}
    tests = []
    for c in plan.get("conversions") or []:
        if not c.get("enabled", True) or (only and c["id"] not in only):
            continue
        event, where = c["trigger"]["event"], c["trigger"]["where"]
        test = {"conversion": c["id"], "label": c["label"], "event": event, "where": where, "tier": c["tier"],
                "expect": [event, "conversion"], "page": None, "action": None, "args": {}, "error": None}
        if event in ("generate_lead", "form_abandon", "form_start", "form_error"):
            form = forms.get(where.get("form")) or next(iter(forms.values()), None)
            page = (form or {}).get("pages", [None])[0] if form and form.get("pages") else (facts.get("formPages") or [None])[0]
            test.update(page=page, action={"generate_lead": "submit", "form_abandon": "abandon"}.get(event, "start_form"),
                        args={"form": (form or {}).get("name"), "field": where.get("field"), "option": where.get("option")})
            if not page:
                test["error"] = f"no page shows the {(form or {}).get('name', '')} form (scan the site)"
        elif event == "cta_click":
            targets = where.get("ctaTargets") or []
            cand = [x for x in ctas if (not targets or x["target"] in targets) and (not where.get("blocks") or x["block"] in where["blocks"])]
            if cand:
                test.update(page=cand[0]["path"], action="click_cta", args={"target": cand[0]["target"], "label": cand[0]["label"], "block": cand[0]["block"]})
            else:
                test["error"] = "no CTA matching this trigger was found on any page"
        elif event == "service_engaged":
            iid = where.get("intent")
            paths = (intents.get(iid) or {}).get("match", {}).get("paths") if iid else [p for i in intents.values() for p in i["match"].get("paths", [])]
            test.update(page=(paths or [None])[0], action="engage", args={"intent": iid})
            if not test["page"]:
                test["error"] = "no page is tagged with this intent"
        elif event == "section_view":
            blocks = where.get("blocks") or []
            block_paths = [(b, p) for b in blocks for p in ((facts.get("blocks") or {}).get(b) or {}).get("paths", [])]
            if block_paths:
                test.update(page=block_paths[0][1], action="view_block", args={"block": block_paths[0][0]})
            else:
                test["error"] = "the block isn't on any scanned page"
        elif event == "faq_open":
            keywords = (stages.get(where.get("stage")) or {}).get("match", {}).get("faqKeywords") or []
            from .tracking_library import keyword_hits
            hit = next((q for q in faqs if q.get("path") and (not keywords or keyword_hits(q["question"], keywords))), None)
            if hit:
                test.update(page=hit["path"], action="open_faq", args={"question": hit["question"]})
            else:
                test["error"] = "no FAQ question on the site matches this stage"
        elif event == "scroll_depth":
            ptype = where.get("pageType") or "article"
            page = next((p for p, t in types.items() if t == ptype), None)
            test.update(page=page, action="scroll", args={"percent": where.get("percent") or 75})
            if not page:
                test["error"] = f"no {ptype} page to test on"
        elif event == "contact_click":
            test.update(page="/", action="click_contact", args={"method": where.get("method") or "phone"})
        elif event == "page_view":
            prefix = where.get("pathPrefix")
            page = next((p for p in types if prefix and p.startswith(norm_path(prefix) + "/")), where.get("path"))
            test.update(page=page, action="visit")
            if not page:
                test["error"] = "no page matches this trigger"
        elif event in ("file_download", "outbound_click", "nav_click", "search"):
            test.update(page="/", action={"file_download": "click_download", "outbound_click": "click_outbound",
                                          "nav_click": "click_nav", "search": "search"}[event])
        else:
            test["error"] = f"no automatic test for {event}"
        tests.append(test)
    return tests
