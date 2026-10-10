"""Server-side event copies (R31/R32, §9): outbox → tools, with retries.

Who gets a server copy of an event:
  ga4        Google connected, analytics consent, and the browser reported
             that its GA4 tag did NOT load (GA4 doesn't de-duplicate MP
             against gtag, so a second copy would double count). Test runs
             go to GA4's validation server instead (never recorded).
  meta       Meta connected and marketing consent (or, outside uk_eu, not
             refused). De-duplicated by event_id with the pixel.
  tiktok     as Meta.
  linkedin   as Meta, primary conversions only, needs a synced rule.
  google_ads API mode only (developer token), primary conversions, gclid.
Hashed identifiers (email/phone) only with ad_user_data consent. Test runs
never reach Google Ads or LinkedIn (they would affect bidding).
"""

import threading
from datetime import timedelta

from django.conf import settings
from django.core.cache import cache
from django.db import close_old_connections, transaction
from django.utils import timezone

from .tracking_adapters import ADAPTERS
from .tracking_adapters.base import AuthError, ToolError, norm_email, norm_phone, sha256
from .tracking_vocab import EVENTS, clean_params, meta_name, tiktok_name

BACKOFF = [30, 120, 600, 3600, 6 * 3600]
MAX_AGE = timedelta(days=7)
CIRCUIT_LIMIT = 20
TOOL_CONN = {"ga4": "google", "meta": "meta", "tiktok": "tiktok", "linkedin": "linkedin", "google_ads": "google_ads"}


# ------------------------------------------------------------- connections

def load_connection(tool):
    """{account, secret} for a connected tool, or None."""
    from .crypto import MissingKey, decrypt
    from .models import TrackingConnection
    conn = TrackingConnection.objects.filter(tool=TOOL_CONN.get(tool, tool)).first()
    if not conn or conn.status not in ("connected",):
        return None
    try:
        secret = decrypt(conn.secret) if conn.secret else {}
    except (MissingKey, Exception):
        return None
    return {"account": conn.account or {}, "secret": secret, "row": conn}


def connected():
    from .models import TrackingConnection
    return {c.tool for c in TrackingConnection.objects.filter(status="connected")}


def tools_for(name, consent, context, region, is_test, primary):
    conns = connected()
    tools = []
    marketing_ok = consent.get("marketing") or (region != "uk_eu" and not consent.get("known"))
    if "google" in conns and (consent.get("analytics") or is_test) and (is_test or not context.get("ga4_loaded")):
        tools.append("ga4")
    if "meta" in conns and (marketing_ok or is_test):
        tools.append("meta")
    if "tiktok" in conns and (marketing_ok or is_test):
        tools.append("tiktok")
    if "linkedin" in conns and marketing_ok and primary and not is_test:
        tools.append("linkedin")
    if "google_ads" in conns and primary and not is_test and context.get("gclid"):
        tools.append("google_ads")
    return tools


# ------------------------------------------------------------------ enqueue

def identifiers_for(data, consent, country):
    if not consent.get("ad_user_data"):
        return {}
    ids = {}
    email = norm_email(data.get("email"))
    if email:
        ids["em"] = sha256(email)
    phone = norm_phone(data.get("phone") or data.get("telephone") or data.get("mobile"), country)
    if phone:
        ids["ph"] = sha256(phone)
    if country:
        ids["country"] = country.upper()
    return ids


def enqueue_lead(submission, envelope, conversions, intent, segment):
    """One generate_lead outbox row per stored submission, carrying every
    matched conversion (Meta counts one Lead; GA4 gets cv_<id> events)."""
    from .models import EventOutbox
    from .tracking_plan import get_plan
    plan = get_plan()
    region = plan.get("region", "uk_eu")
    consent = submission.consent or {}
    profile = submission.profile or {}
    click = profile.get("click") or {}
    run = envelope.get("run")
    country = submission.country or ((plan.get("currency") == "GBP") and "GB") or ""
    primary = [c for c in conversions if c["tier"] == "primary"]
    values = [c["value"] for c in primary if c.get("value") is not None]
    params = {"form_name": submission.form_name, "intent": intent, "segment": segment,
              "conversions": "|" + "|".join(c["id"] for c in conversions) + "|" if conversions else "",
              "page_path": envelope.get("page") or ""}
    if values:
        params.update(value=max(values), currency=plan.get("currency") or "USD")
    if run:
        params["cms_verify_run"] = str(run.pk)
    meta_event = next((c.get("meta") for c in primary if c.get("meta") and c["meta"] != "custom"), None) or "Lead"
    context = {**envelope.get("context", {}), **{k: click[k] for k in ("gclid", "fbclid", "ttclid", "li_fat_id") if click.get(k)},
               "url": envelope.get("page") or "", "fbp": profile.get("fbp"), "fbc": profile.get("fbc") or _fbc(click),
               "ttp": profile.get("ttp"), "ga_client_id": profile.get("ga_client_id")}
    if not consent.get("ad_user_data"):
        context.pop("ip", None)
        context.pop("ua", None)
    tools = tools_for("generate_lead", consent, context, region, submission.is_test, bool(primary))
    row = EventOutbox.objects.create(
        event_id=submission.event_id, name="generate_lead", params=clean_params("generate_lead", params) | {"conversions": params["conversions"]},
        consent=consent, identifiers=identifiers_for(submission.data or {}, consent, country), context=_compact(context),
        tools_pending=tools, is_test=submission.is_test, status="pending" if tools else "skipped",
    )
    row.params = {**row.params, "_meta": meta_event, "_conversion_ids": [c["id"] for c in conversions],
                  "_primary_ids": [c["id"] for c in primary], "_tiktok": next((c.get("tiktok") for c in primary if c.get("tiktok")), None)}
    if run:
        row.params["cms_verify_run"] = str(run.pk)
    row.save(update_fields=["params"])
    if tools:
        schedule_inline([row.pk])
    return row


def enqueue_event(name, params, envelope, conversions=()):
    """Server copy for a beacon event (service_engaged / conversion-level)."""
    from .models import EventOutbox
    from .tracking_plan import get_plan
    if not EVENTS.get(name, {}).get("server"):
        return None
    plan = get_plan()
    consent = envelope.get("consent") or {}
    context = envelope.get("context") or {}
    primary = [c for c in conversions if c.get("tier") == "primary"]
    tools = tools_for(name, consent, context, plan.get("region", "uk_eu"), envelope.get("is_test"), bool(primary))
    if not tools:
        return None
    clean = clean_params(name, params)
    if conversions:
        clean["conversions"] = "|" + "|".join(c["id"] for c in conversions) + "|"
    row, created = EventOutbox.objects.get_or_create(event_id=envelope["event_id"], name=name, defaults={
        "params": {**clean, "_conversion_ids": [c["id"] for c in conversions], "_primary_ids": [c["id"] for c in primary],
                   **({"cms_verify_run": str(envelope["run"].pk)} if envelope.get("run") else {})},
        "consent": consent, "context": _compact(context), "tools_pending": tools, "is_test": bool(envelope.get("is_test"))})
    if created:
        schedule_inline([row.pk])
    return row


def _fbc(click):
    fbclid = click.get("fbclid")
    return f"fb.1.{int(timezone.now().timestamp() * 1000)}.{fbclid}" if fbclid else None


def _compact(d):
    return {k: v for k, v in d.items() if v not in (None, "", False)} | ({"ga4_loaded": True} if d.get("ga4_loaded") else {})


# ------------------------------------------------------------------ deliver

def schedule_inline(ids):
    if not getattr(settings, "TRACKING_INLINE_DELIVERY", True):
        return

    def run():
        try:
            for pk in ids:
                deliver(pk)
        finally:
            close_old_connections()

    transaction.on_commit(lambda: threading.Thread(target=run, daemon=True).start())


def _event_for(row, tool, conversion_id=None):
    p = dict(row.params or {})
    conv_ids = p.pop("_conversion_ids", [])
    primary_ids = p.pop("_primary_ids", [])
    meta = p.pop("_meta", None)
    tiktok = p.pop("_tiktok", None)
    params = {k: v for k, v in p.items() if not k.startswith("_")}
    event = {"name": row.name, "event_id": row.event_id if not conversion_id else f"{row.event_id}:{conversion_id}",
             "params": params, "consent": row.consent or {}, "identifiers": row.identifiers or {}, "context": row.context or {},
             "is_test": row.is_test, "at": row.created_at, "conversion_ids": conv_ids, "primary_ids": primary_ids,
             "meta_name": meta_name(row.name, mapping=meta), "tiktok_name": tiktok_name(row.name, tiktok) or "SubmitForm"}
    if conversion_id:
        from .tracking_sync import runtime_sync_detail
        event["sync"] = runtime_sync_detail().get(conversion_id, {})
        event["sync"]["adsConversionAction"] = event["sync"].get("adsConversionAction")
    return event


def _circuit_open(tool):
    return (cache.get(f"cms-circuit:{tool}") or 0) >= CIRCUIT_LIMIT


def _circuit(tool, ok):
    key = f"cms-circuit:{tool}"
    if ok:
        cache.delete(key)
        return
    n = (cache.get(key) or 0) + 1
    cache.set(key, n, 3600)
    if n == CIRCUIT_LIMIT:
        from .tracking_verify import open_alert
        open_alert(f"circuit:{tool}", "warning", f"{tool} rejected {CIRCUIT_LIMIT} server events in a row; sending is paused for an hour.")


def deliver(pk, now=None):
    """Try every pending tool for one outbox row. Safe to call from several
    workers: the row is claimed with a compare-and-set on locked_until."""
    from .models import EventOutbox, TrackingConnection
    now = now or timezone.now()
    row = EventOutbox.objects.filter(pk=pk, status="pending").first()
    if not row:
        return None
    claimed = EventOutbox.objects.filter(pk=pk, status="pending").filter(
        models_q_unlocked(now)).update(locked_until=now + timedelta(seconds=60))
    if not claimed:
        return None
    row.refresh_from_db()
    if now - row.created_at > MAX_AGE:
        row.status = "dead"
        row.results = {**row.results, "_": {"ok": False, "detail": "older than 7 days (tools reject it)"}}
        row.save(update_fields=["status", "results"])
        return row
    remaining = []
    for tool in row.tools_pending:
        if _circuit_open(tool):
            remaining.append(tool)
            continue
        conn = load_connection(tool)
        if not conn:
            row.results[tool] = {"ok": False, "skipped": True, "detail": "not connected", "at": now.isoformat()}
            continue
        adapter = ADAPTERS[tool]
        try:
            if tool in ("linkedin", "google_ads"):
                outcomes = [adapter.send(_event_for(row, tool, cid), conn) for cid in (row.params or {}).get("_primary_ids", [])]
                res = outcomes[0] if len(outcomes) == 1 else {"ok": any(o.get("ok") for o in outcomes),
                                                              "skipped": all(o.get("skipped") for o in outcomes) if outcomes else True,
                                                              "detail": "; ".join(o.get("detail", "") for o in outcomes)[:500] or "no primary conversion"}
            else:
                res = adapter.send(_event_for(row, tool), conn)
            row.results[tool] = {**res, "at": now.isoformat()}
            _circuit(tool, res.get("ok") or res.get("skipped"))
            TrackingConnection.objects.filter(tool=TOOL_CONN[tool]).update(last_ok_at=now)
        except AuthError as err:
            TrackingConnection.objects.filter(tool=TOOL_CONN[tool]).update(status="needs_reauth", last_error=str(err)[:500])
            from .tracking_verify import open_alert
            open_alert(f"reauth:{tool}", "warning", f"{tool}: the connection needs to be renewed ({err}). Site tools → Tracking → Tools.")
            row.results[tool] = {"ok": False, "detail": f"auth: {err}", "at": now.isoformat(), "held": True}
            remaining.append(tool)
        except ToolError as err:
            row.results[tool] = {"ok": False, "detail": str(err)[:500], "status": err.status, "at": now.isoformat()}
            _circuit(tool, False)
            if err.retry:
                remaining.append(tool)
        except Exception as err:  # an adapter bug must not lose the event
            row.results[tool] = {"ok": False, "detail": f"error: {err}"[:500], "at": now.isoformat()}
            remaining.append(tool)
    row.attempts += 1
    row.tools_pending = remaining
    if remaining and row.attempts <= len(BACKOFF):
        row.next_at = now + timedelta(seconds=BACKOFF[row.attempts - 1])
        row.status = "pending"
    else:
        row.status = "dead" if remaining else "done"
    row.locked_until = None
    row.save(update_fields=["results", "attempts", "tools_pending", "next_at", "status", "locked_until"])
    return row


def models_q_unlocked(now):
    from django.db.models import Q
    return Q(locked_until__isnull=True) | Q(locked_until__lt=now)


def process_due(limit=200, now=None):
    from .models import EventOutbox
    now = now or timezone.now()
    ids = list(EventOutbox.objects.filter(status="pending", next_at__lte=now).filter(models_q_unlocked(now))
               .order_by("next_at").values_list("pk", flat=True)[:limit])
    done = 0
    for pk in ids:
        if deliver(pk, now):
            done += 1
    return done
