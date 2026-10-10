"""Verification and monitoring (R31, §11 of TRACKING_IMPLEMENTATION_PLAN.md).

A run compiles one test per conversion (tracking_plan.compile_tests), hands
the tests to a harness (the admin's browser via VerifyHarness, or the headless
runner frontend-kit/acceptance/verify-tracking.mjs), which triggers each one
and reports what was sent. The server then confirms arrival for the server
copies (outbox results) and records a verdict per step:

    trigger  the harness found and performed the action
    sent     each connected tool got the event (right name, params, no PII,
             browser/server event ids equal, consent respected)
    received the tool's API accepted the server copy

Monitoring: daily aggregate counts (TrackingDaily) give "last seen"; a
conversion that normally fires and goes quiet raises an alert.
"""

import json
import secrets
import urllib.request
from datetime import date, timedelta

from django.conf import settings
from django.core import signing
from django.core.mail import send_mail
from django.db import transaction
from django.db.models import F, Sum
from django.utils import timezone

SALT = "cms-verify-run"
TOKEN_MAX_AGE = 15 * 60

PII_PATTERNS = ("@", )


# ------------------------------------------------------------------ tokens

def make_token(run):
    return signing.dumps({"run": run.pk, "n": run.nonce}, salt=SALT)


def run_from_token(token):
    """The VerificationRun a token belongs to, or None (expired/forged/finished)."""
    from .models import VerificationRun
    if not token:
        return None
    try:
        data = signing.loads(str(token), salt=SALT, max_age=TOKEN_MAX_AGE)
    except signing.BadSignature:
        return None
    run = VerificationRun.objects.filter(pk=data.get("run")).first()
    if not run or run.nonce != data.get("n") or run.status in ("passed", "failed", "error"):
        return None
    return run


# ------------------------------------------------------------------- runs

def create_run(trigger="manual", mode="in_browser", scope=None):
    from .models import VerificationRun
    from .site_facts import get_facts
    from .tracking_plan import compile_tests, get_plan
    plan = get_plan()
    facts = get_facts()
    tests = compile_tests(plan, facts, only=scope or None)
    run = VerificationRun.objects.create(trigger=trigger, mode=mode, scope=scope or [], tests=tests,
                                         nonce=secrets.token_hex(16), status="pending")
    return run


def connected_tools():
    """Tools the browser loads (an ID is set) and tools with a server API connection."""
    from .models import SiteSettings, TrackingConnection
    analytics = ((SiteSettings.objects.filter(pk=1).first() or SiteSettings()).data or {}).get("analytics") or {}
    browser = {k: bool(str(analytics.get(v) or "").strip()) for k, v in (
        ("gtm", "gtmId"), ("ga4", "ga4Id"), ("meta", "metaPixelId"), ("tiktok", "tiktokPixelId"),
        ("linkedin", "linkedinPartnerId"), ("googleAds", "googleAdsId"))}
    server = {c.tool: c.status for c in TrackingConnection.objects.all()}
    return {"browser": browser, "server": server}


def record_results(run, payload):
    """Store harness results. payload = {results: [...], done: bool, blocked: [...]}"""
    from .models import VerificationResult
    if run.status == "pending":
        run.status = "running"
        run.started_at = timezone.now()
        run.save(update_fields=["status", "started_at"])
    rows = []
    for r in (payload.get("results") or [])[:500]:
        if not isinstance(r, dict):
            continue
        step = r.get("step") if r.get("step") in ("trigger", "sent", "received") else None
        st = r.get("status") if r.get("status") in ("ok", "fail", "skipped", "blocked", "inactive", "warn") else None
        if not step or not st:
            continue
        evidence = r.get("evidence") if isinstance(r.get("evidence"), dict) else {}
        evidence = json.loads(json.dumps(evidence, default=str)[:4000]) if len(json.dumps(evidence, default=str)) <= 4000 else {"truncated": True}
        rows.append(VerificationResult(run=run, conversion_id=str(r.get("conversion") or "")[:60], tool=str(r.get("tool") or "")[:20],
                                       step=step, status=st, detail=str(r.get("detail") or "")[:1000], evidence=evidence))
    VerificationResult.objects.bulk_create(rows)
    if payload.get("done"):
        finalise(run)
    return len(rows)


def finalise(run):
    """Add server-side arrival checks, compute the verdict, open/close alerts."""
    from .models import EventOutbox, VerificationResult
    # Received: server copies sent during this run (tagged with the run id).
    for row in EventOutbox.objects.filter(is_test=True, params__cms_verify_run=str(run.pk)):
        cid = str((row.params or {}).get("conversion_id") or row.name)
        for tool, res in (row.results or {}).items():
            VerificationResult.objects.create(run=run, conversion_id=cid, tool=tool, step="received",
                                              status="ok" if res.get("ok") else ("skipped" if res.get("skipped") else "fail"),
                                              detail=str(res.get("detail") or "")[:1000], evidence={"event": row.name, "event_id": row.event_id})
    results = list(run.results.all())
    by_conv = {}
    for r in results:
        by_conv.setdefault(r.conversion_id, []).append(r)
    failing = sorted({r.conversion_id for r in results if r.status == "fail"})
    tests = {t["conversion"]: t for t in run.tests}
    unplaced = sorted(cid for cid, t in tests.items() if t.get("error"))
    untested = sorted(cid for cid in tests if cid not in by_conv and cid not in unplaced)
    run.summary = {
        "conversions": len(tests), "passed": len([c for c in tests if c in by_conv and c not in failing]),
        "failing": failing, "unplaced": unplaced, "untested": untested,
        "blocked": sorted({r.conversion_id for r in results if r.status == "blocked"}),
    }
    # A full run proves something only if it tested every lead form: zero
    # tests, or a lead form none of whose lead conversions fired, is a fail.
    missing = []
    if not run.scope:
        if not tests:
            missing.append("no conversions were tested")
        else:
            from .site_facts import get_facts
            from .tracking_library import lead_forms
            from .tracking_plan import get_plan
            convs = {c.get("id"): c for c in get_plan().get("conversions") or []}
            proven = {cid for cid in tests if cid not in failing and any(r.status == "ok" for r in by_conv.get(cid, []))}
            for form in lead_forms(get_facts()):
                if not any((convs.get(cid, {}).get("trigger") or {}).get("event") == "generate_lead"
                           and ((convs[cid]["trigger"].get("where") or {}).get("form") in (None, "", form["name"])) for cid in proven):
                    missing.append(f"lead form “{form['name']}”: no lead conversion was tested")
    run.summary["missing"] = missing
    run.status = "failed" if failing or unplaced or missing else "passed"
    run.finished_at = timezone.now()
    run.save(update_fields=["summary", "status", "finished_at"])
    if failing or unplaced or missing:
        names = ", ".join((failing + unplaced + missing)[:6])
        open_alert("checks", "warning", f"Tracking checks failing for: {names}. Open Site tools → Tracking → Checks.")
    else:
        resolve_alert("checks")
    return run


def run_detail(run):
    return {
        "id": run.pk, "trigger": run.trigger, "mode": run.mode, "status": run.status, "summary": run.summary,
        "created_at": run.created_at, "started_at": run.started_at, "finished_at": run.finished_at, "tests": run.tests,
        "results": [{"conversion": r.conversion_id, "tool": r.tool, "step": r.step, "status": r.status, "detail": r.detail,
                     "evidence": r.evidence} for r in run.results.all().order_by("id")],
    }


def latest_summary():
    from .models import VerificationRun
    run = VerificationRun.objects.exclude(status__in=("pending", "running")).exclude(trigger="acceptance").first()
    if not run:
        return None
    return {"id": run.pk, "status": run.status, "summary": run.summary, "finished_at": run.finished_at, "trigger": run.trigger}


# ------------------------------------------------------- static (publish) check

def static_check():
    """Cheap, synchronous check after content changes: triggers that no longer
    resolve against the site (a renamed form option, a removed page…)."""
    from .site_facts import get_facts
    from .tracking_plan import get_plan, validate
    plan = get_plan()
    if plan.get("status") != "approved":
        return {"dangling": []}
    facts = get_facts()
    _, report = validate(plan, facts)
    stale = (plan.get("facts") or {}).get("hash") not in (None, facts.get("hash"))
    if report["dangling"]:
        open_alert("dangling", "warning", "Tracking triggers no longer match the site: " + "; ".join(report["dangling"][:4]) +
                   ". Review the plan in Site tools → Tracking.")
    else:
        resolve_alert("dangling")
    return {"dangling": report["dangling"], "stale": stale}


def after_publish():
    """Debounced (60 s) static check + a queued run for the scheduled runner."""
    from django.core.cache import cache
    if not cache.add("cms-tracking-after-publish", 1, 60):
        return
    try:
        static_check()
    except Exception:  # never let monitoring break a publish
        pass


# -------------------------------------------------------------- daily counts

def count(name, conversion_id="", intent="", test=False, n=1):
    from .models import TrackingDaily
    today = timezone.localdate()
    row, _ = TrackingDaily.objects.get_or_create(date=today, name=name[:60], conversion_id=(conversion_id or "")[:60], intent=(intent or "")[:60])
    if test:
        TrackingDaily.objects.filter(pk=row.pk).update(test_count=F("test_count") + n)
    else:
        TrackingDaily.objects.filter(pk=row.pk).update(count=F("count") + n, last_at=timezone.now())


def last_seen():
    from .models import TrackingDaily
    out = {}
    for row in TrackingDaily.objects.filter(count__gt=0).exclude(conversion_id="").order_by("conversion_id", "-date"):
        out.setdefault(row.conversion_id, row.last_at)
    return out


def anomalies(today=None):
    """Conversions that normally fire and have gone quiet (§11.7): 14-day
    average ≥ 1/day and zero for max(2, 3/avg) days. Low-traffic
    conversions never alert."""
    from .models import TrackingDaily
    today = today or timezone.localdate()
    found = []
    window_start = today - timedelta(days=14)
    rows = TrackingDaily.objects.filter(date__gte=window_start - timedelta(days=14)).exclude(conversion_id="")
    per = {}
    for r in rows:
        per.setdefault(r.conversion_id, {})
        per[r.conversion_id][r.date] = per[r.conversion_id].get(r.date, 0) + r.count
    for cid, days in per.items():
        quiet = 0
        d = today
        while days.get(d, 0) == 0 and quiet < 28:
            quiet += 1
            d -= timedelta(days=1)
        if quiet == 0:
            continue
        base_end = today - timedelta(days=quiet)
        base = [days.get(base_end - timedelta(days=i), 0) for i in range(1, 15)]
        avg = sum(base) / 14
        if avg >= 1 and quiet >= max(2, 3 / avg):
            found.append({"conversion": cid, "quietDays": quiet, "avgPerDay": round(avg, 2)})
    return found


def overview():
    from .models import TrackingAlert, TrackingDaily
    from .tracking_plan import get_plan
    plan = get_plan()
    since = timezone.localdate() - timedelta(days=6)
    week, tests = {}, {}
    for r in TrackingDaily.objects.filter(date__gte=since).exclude(conversion_id=""):
        week.setdefault(r.conversion_id, {})
        week[r.conversion_id][r.date.isoformat()] = week[r.conversion_id].get(r.date.isoformat(), 0) + r.count
        tests[r.conversion_id] = tests.get(r.conversion_id, 0) + r.test_count
    seen = last_seen()
    conversions = [{"id": c["id"], "label": c["label"], "tier": c["tier"], "enabled": c.get("enabled", True),
                    "week": week.get(c["id"], {}), "total7": sum(week.get(c["id"], {}).values()), "tests7": tests.get(c["id"], 0),
                    "lastSeen": seen.get(c["id"])}
                   for c in plan.get("conversions") or []]
    return {
        "plan": {"status": plan.get("status"), "version": plan.get("version")},
        "conversions": conversions, "checks": latest_summary(), "anomalies": anomalies(),
        "alerts": [{"key": a.key, "level": a.level, "message": a.message, "since": a.opened_at}
                   for a in TrackingAlert.objects.filter(resolved_at__isnull=True)],
        "tools": connected_tools(),
    }


# ------------------------------------------------------------------ alerts

def open_alert(key, level, message):
    from .models import TrackingAlert
    with transaction.atomic():
        alert, created = TrackingAlert.objects.get_or_create(key=key, defaults={"level": level, "message": message})
        if not created:
            changed = alert.message != message or alert.resolved_at is not None
            alert.level, alert.message = level, message
            if alert.resolved_at is not None:
                alert.resolved_at = None
                alert.notified_at = None
            alert.save()
            if not changed and alert.notified_at and timezone.now() - alert.notified_at < timedelta(days=7):
                return alert
    _notify(alert)
    return alert


def resolve_alert(key):
    from .models import TrackingAlert
    TrackingAlert.objects.filter(key=key, resolved_at__isnull=True).update(resolved_at=timezone.now())


def _notify(alert):
    """Email (backend SMTP, if configured) and/or a signed webhook. Best effort."""
    from .models import TrackingAlert
    sent = False
    recipient = getattr(settings, "TRACKING_ALERT_EMAIL", "") or getattr(settings, "FORM_NOTIFICATION_EMAIL", "")
    backend = getattr(settings, "EMAIL_BACKEND", "")
    if recipient and "smtp" in backend:
        try:
            send_mail("Website tracking needs attention", alert.message, settings.DEFAULT_FROM_EMAIL, [recipient], fail_silently=True)
            sent = True
        except Exception:
            pass
    hook = getattr(settings, "TRACKING_ALERT_WEBHOOK", "")
    if hook:
        try:
            body = json.dumps({"text": alert.message, "key": alert.key, "level": alert.level}).encode()
            req = urllib.request.Request(hook, data=body, headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=5).read()
            sent = True
        except Exception:
            pass
    if sent:
        TrackingAlert.objects.filter(pk=alert.pk).update(notified_at=timezone.now())


def nightly():
    """Scheduled maintenance: anomalies → alerts, static check, purge old
    test data and outbox rows. Called by `manage.py tracking_worker --once`
    or its loop."""
    from .models import EventOutbox, FormSubmission, VerificationRun
    found = anomalies()
    if found:
        open_alert("quiet", "warning", "These conversions normally fire but have gone quiet: " +
                   ", ".join(f"{a['conversion']} ({a['quietDays']} days)" for a in found[:5]) + ". Run checks in Site tools → Tracking.")
    else:
        resolve_alert("quiet")
    static_check()
    now = timezone.now()
    FormSubmission.objects.filter(is_test=True, created_at__lt=now - timedelta(hours=24)).delete()
    EventOutbox.objects.filter(created_at__lt=now - timedelta(days=14)).delete()
    VerificationRun.objects.filter(created_at__lt=now - timedelta(days=60)).delete()
    VerificationRun.objects.filter(trigger="acceptance", created_at__lt=now - timedelta(days=1)).delete()
    VerificationRun.objects.filter(status__in=("pending", "running"), created_at__lt=now - timedelta(hours=2)).update(status="error")
