"""What happens to a stored form submission, tracking-wise (R31/R33).

read_envelope()     validates the kit's `_cms` envelope (profile, event id,
                    consent, verification token) — untrusted input
after_submission()  conversions (server-side matching, authoritative), values,
                    profile summary, daily counts, server-side event copies,
                    and the Contact record
"""

import json
import re
import uuid

from .tracking_vocab import clean_value

EVENT_ID_RE = re.compile(r"^[A-Za-z0-9:_-]{8,80}$")
CLICK_IDS = ("gclid", "gbraid", "wbraid", "fbclid", "ttclid", "li_fat_id", "msclkid")
UTM = ("source", "medium", "campaign", "term", "content")
MAX_PROFILE = 8000


def _bool(v):
    return v is True or v == "granted" or v == 1 or v == "1"


def _clean_source(src):
    if not isinstance(src, dict):
        return {}
    out = {k: clean_value(src.get(k)) for k in ("at", "source", "medium", "landing", "referrer") if src.get(k)}
    utm = src.get("utm") if isinstance(src.get("utm"), dict) else {}
    out["utm"] = {k: clean_value(utm.get(k)) for k in UTM if utm.get(k)}
    if out.get("landing"):
        out["landing"] = str(out["landing"]).split("?")[0][:200]
    return out


def clean_profile(raw, consent):
    """Bound and sanitise the browser's intent profile. No free text survives
    except page paths and campaign names (themselves PII-scrubbed)."""
    if not isinstance(raw, dict):
        return {}
    scores = raw.get("scores") if isinstance(raw.get("scores"), dict) else {}

    def score_map(m):
        if not isinstance(m, dict):
            return {}
        out = {}
        for k, v in list(m.items())[:40]:
            if re.match(r"^[a-z][a-z0-9_]{1,39}$", str(k)) and isinstance(v, (int, float)) and not isinstance(v, bool):
                out[str(k)] = round(max(0.0, min(float(v), 10000.0)), 2)
        return out

    path = []
    for p in (raw.get("path") or [])[-15:]:
        if isinstance(p, dict) and isinstance(p.get("p"), str):
            path.append({"p": p["p"].split("?")[0][:200], "t": int(p.get("t") or 0) if isinstance(p.get("t"), (int, float)) else 0})
    click = raw.get("click") if isinstance(raw.get("click"), dict) else {}
    profile = {
        "v": 1,
        "visits": int(raw.get("visits") or 1) if isinstance(raw.get("visits"), (int, float)) else 1,
        "first": _clean_source(raw.get("first")), "last": _clean_source(raw.get("last")),
        "scores": {"intent": score_map(scores.get("intent")), "segment": score_map(scores.get("segment")), "stage": score_map(scores.get("stage"))},
        "path": path,
        "signals": [str(s)[:60] for s in (raw.get("signals") or [])[:20] if isinstance(s, str)],
        "click": {k: str(click[k])[:200] for k in CLICK_IDS if isinstance(click.get(k), str) and click[k]},
    }
    if consent.get("marketing"):
        for k in ("fbp", "fbc", "ttp"):
            if isinstance(raw.get(k), str) and raw[k]:
                profile[k] = raw[k][:200]
    if consent.get("analytics"):
        for k in ("vid", "ga_client_id"):
            if isinstance(raw.get(k), str) and re.match(r"^[A-Za-z0-9._-]{6,80}$", raw[k]):
                profile[k] = raw[k]
    if len(json.dumps(profile)) > MAX_PROFILE:
        profile["path"] = profile["path"][-5:]
        profile["signals"] = profile["signals"][:5]
    return profile


def read_envelope(request, raw):
    from .geo import client_ip, locate
    from .tracking_verify import run_from_token
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = {}
    raw = raw if isinstance(raw, dict) else {}
    c = raw.get("consent") if isinstance(raw.get("consent"), dict) else {}
    consent = {"analytics": _bool(c.get("analytics")), "marketing": _bool(c.get("marketing")),
               "ad_user_data": _bool(c.get("ad_user_data", c.get("marketing"))),
               "ad_personalization": _bool(c.get("ad_personalization", c.get("marketing"))),
               "known": bool(c)}
    run = run_from_token(raw.get("verify")) if raw.get("verify") else None
    event_id = raw.get("event_id") if isinstance(raw.get("event_id"), str) and EVENT_ID_RE.match(raw["event_id"]) else uuid.uuid4().hex
    return {
        "event_id": event_id, "consent": consent, "profile": clean_profile(raw.get("profile"), consent),
        "is_test": bool(run), "run": run, "geo": locate(request),
        "page": str(raw.get("page") or "").split("?")[0][:300],
        "context": {"ua": request.META.get("HTTP_USER_AGENT", "")[:400], "ip": client_ip(request),
                    "ga4_loaded": raw.get("ga4_loaded") is True},
    }


def summarise(plan, profile, said):
    """'Interest: Payroll + Accounts · Limited company · Switching · via google / cpc'"""
    labels = {k: {x["id"]: x["label"] for x in plan.get(k) or []} for k in ("intents", "segments", "stages")}
    scores = profile.get("scores") or {}

    def top(kind, n=2):
        if said.get(kind):
            return [labels[kind].get(i, i) for i in said[kind]][:3]
        ranked = sorted((scores.get(kind[:-1] if kind != "stages" else "stage") or {}).items(), key=lambda kv: -kv[1])
        if not ranked:
            return []
        best = ranked[0][1]
        return [labels[kind].get(k, k) for k, v in ranked[:n] if v >= max(1.0, best / 1.5)]

    parts = []
    intents = top("intents")
    if intents:
        parts.append("Interest: " + " + ".join(intents))
    segments = top("segments", 1)
    if segments:
        parts.append(segments[0])
    stages = [labels["stages"].get(k, k) for k, v in sorted((scores.get("stage") or {}).items(), key=lambda kv: -kv[1]) if v >= 3][:2]
    parts += stages
    first = profile.get("first") or {}
    src = first.get("utm", {}).get("source") or first.get("source")
    if src:
        med = first.get("utm", {}).get("medium") or first.get("medium") or ""
        camp = first.get("utm", {}).get("campaign")
        parts.append(f"via {src}{' / ' + med if med else ''}{' “' + camp + '”' if camp else ''}")
    if (profile.get("visits") or 1) > 1:
        parts.append(f"{profile['visits']} visits")
    return " · ".join(parts)


def primary_of(plan, profile, said, kind="intents"):
    if said.get(kind):
        return said[kind][0]
    scores = (profile.get("scores") or {}).get(kind[:-1]) or {}
    if not scores:
        return ""
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    if len(ranked) > 1 and ranked[0][1] < ranked[1][1] * 1.5:
        return ""
    return ranked[0][0]


def after_submission(submission, envelope, request=None):
    from . import tracking_plan as tp
    from .tracking_verify import count
    if submission.is_spam:
        return {}
    plan = tp.get_plan()
    data = submission.data or {}
    said = tp.lead_profile_from_answers(plan, submission.form_name, data)
    profile = dict(submission.profile or {})
    profile["said"] = said
    profile["summary"] = summarise(plan, profile, said)
    intent = primary_of(plan, profile, said, "intents")
    segment = primary_of(plan, profile, said, "segments")
    profile["primary"] = {"intent": intent, "segment": segment,
                          "stages": [k for k, v in ((profile.get("scores") or {}).get("stage") or {}).items() if v >= 3]}
    submission.profile = profile
    submission.save(update_fields=["profile"])

    matched = tp.match_lead_conversions(plan, submission.form_name, data)
    conversions = []
    currency = plan.get("currency") or "USD"
    for c in matched:
        value = tp.conversion_value(plan, c, data, said.get("intents") or [])
        conversions.append({"id": c["id"], "tier": c["tier"], "label": c["label"], "value": value, "currency": currency,
                            "meta": (c.get("destinations") or {}).get("meta"), "tiktok": (c.get("destinations") or {}).get("tiktok"),
                            "event_id": f"{submission.event_id}:{c['id']}"})
    count("generate_lead", intent=intent, test=submission.is_test)
    for c in conversions:
        count("conversion", conversion_id=c["id"], intent=intent, test=submission.is_test)

    from .tracking_dispatch import enqueue_lead
    enqueue_lead(submission, envelope, conversions, intent, segment)

    if not submission.is_test:
        from .contacts import upsert_from_submission
        upsert_from_submission(submission, plan, said, envelope)
    return {"conversions": conversions, "summary": profile["summary"], "intent": intent, "segment": segment}
