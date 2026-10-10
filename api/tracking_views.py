"""Tracking plan API (R31).

Public:
    GET  tracking/config/                    runtime config for the kit (cached)
Admin:
    GET  tracking/plan/                      plan + validation report + facts summary + health
    PUT  tracking/plan/                      save (as draft)
    POST tracking/plan/approve/              approve → live in the kit, queued for sync
    POST tracking/plan/build/                proposal from the library (+ diff), not saved
    GET  tracking/facts/                     everything the plan can reference
    POST tracking/scan/                      store a scan of the rendered site
    GET  tracking/overview/                  counts, last seen, checks, alerts (dashboard)
Verification (§11): see tracking_verify.py for the run lifecycle.
    POST tracking/verify/runs/               admin: create a run → {id, token, tests}
    GET  tracking/verify/runs/               admin: recent runs
    GET  tracking/verify/runs/<id>/          admin: one run with results
    POST tracking/verify/runs/<id>/results/  harness/runner (run token, no login)
"""

from django.core.cache import cache
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAdminUser
from rest_framework.response import Response
from rest_framework.views import APIView

from . import tracking_plan as tp
from .site_facts import clean_scan, get_facts


def _tracking_cache_key():
    from .seo_resolve import cache_version
    return f"cms-tracking-config:{cache_version('seo')}:{cache_version('tracking')}"


def facts_summary(facts):
    return {
        "hash": facts.get("hash"), "scannedAt": facts.get("scannedAt"), "scanned": facts.get("scanned"),
        "pages": len(facts.get("pages") or []), "forms": [f["name"] for f in facts.get("forms") or []],
        "formPages": facts.get("formPages") or [], "blocks": len(facts.get("blocks") or {}),
        "ctas": len(facts.get("ctas") or []), "faqs": len(facts.get("faqs") or []),
        "channels": facts.get("channels"), "has": facts.get("has"), "org": facts.get("org"), "tools": facts.get("tools"),
    }


def plan_state(plan, facts):
    clean, report = tp.validate(plan, facts)
    stale = bool(plan.get("status") == "approved" and (plan.get("facts") or {}).get("hash") not in (None, facts.get("hash")))
    return clean, report, stale


class TrackingConfigView(APIView):
    """Public, cached: what the kit needs to label and match events."""
    permission_classes = [AllowAny]

    def get(self, request):
        key = _tracking_cache_key()
        data = cache.get(key)
        if data is None:
            from .tracking_sync import runtime_sync_detail
            facts = get_facts()
            data = tp.runtime_config(tp.get_plan(), facts, runtime_sync_detail())
            cache.set(key, data, 300)
        return Response(data)


class TrackingPlanView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        from .tracking_library import classify_business, explain_tool
        from .tracking_sync import sync_status
        from .tracking_verify import latest_summary
        facts = get_facts()
        plan = tp.get_plan()
        clean, report, stale = plan_state(plan, facts)
        tools = {t: explain_tool(t, clean) for t in ("ga4", "gtm", "meta", "googleAds", "tiktok", "linkedin", "clarity", "hotjar")}
        return Response({"plan": plan, "report": report, "stale": stale, "facts": facts_summary(facts),
                         "pack": plan.get("pack") or classify_business(facts), "tools": tools,
                         "sync": sync_status(), "checks": latest_summary()})

    def put(self, request):
        facts = get_facts()
        body = request.data.get("plan") if isinstance(request.data, dict) and "plan" in request.data else request.data
        try:
            clean, report = tp.validate(body, facts)
        except tp.PlanError as err:
            return Response({"detail": str(err)}, status=status.HTTP_400_BAD_REQUEST)
        if report["errors"]:
            return Response({"detail": "The plan has errors.", "report": report}, status=status.HTTP_400_BAD_REQUEST)
        current = tp.get_plan()
        clean = tp.merge_locked(current, clean) if not request.query_params.get("unlock") else clean
        clean["status"] = "draft"
        clean["version"] = int(current.get("version") or 0)
        clean["facts"] = current.get("facts") or {}
        tp.save_plan(clean)
        _audit(request, "tracking_plan_save", "", {"items": sum(len(clean[k]) for k in ("intents", "segments", "stages", "conversions", "audiences"))})
        return Response({"plan": clean, "report": report})


class TrackingPlanApproveView(APIView):
    permission_classes = [IsAdminUser]

    def post(self, request):
        facts = get_facts()
        plan = tp.get_plan()
        clean, report = tp.validate(plan, facts)
        if report["errors"] or report["dangling"]:
            return Response({"detail": "Fix these before approving.", "report": report}, status=status.HTTP_400_BAD_REQUEST)
        clean["status"] = "approved"
        clean["version"] = int(plan.get("version") or 0) + 1
        clean["facts"] = {"hash": facts.get("hash"), "at": timezone.now().isoformat()}
        tp.save_plan(clean)
        _audit(request, "tracking_plan_approve", f"v{clean['version']}")
        from .tracking_sync import queue_sync
        queue_sync(reason="approved")
        return Response({"plan": clean, "report": report})


class TrackingPlanBuildView(APIView):
    """A plan from the library alone (deterministic). Locked items are kept."""
    permission_classes = [IsAdminUser]

    def post(self, request):
        from .tracking_library import build_plan
        facts = get_facts()
        current = tp.get_plan()
        proposal = build_plan(facts, region=current.get("region") if current.get("intents") else None)
        clean, report = tp.validate(proposal, facts)
        clean = tp.merge_locked(current, clean)
        return Response({"plan": clean, "report": report, "diff": tp.diff(current, clean)})


class TrackingFactsView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        return Response(get_facts())


class TrackingScanView(APIView):
    permission_classes = [IsAdminUser]

    def post(self, request):
        from .models import TrackingScan
        from .seo_resolve import bump_cache_version
        try:
            scan = clean_scan(request.data)
        except ValueError as err:
            return Response({"detail": str(err)}, status=status.HTTP_400_BAD_REQUEST)
        source = request.query_params.get("source") if request.query_params.get("source") in ("browser", "headless") else "browser"
        previous = TrackingScan.objects.filter(pk=1).first()
        before = len((previous.data or {}).get("pages") or []) if previous else 0
        warning = ""
        if before >= 5 and len(scan["pages"]) < before / 2:
            warning = (f"Only {len(scan['pages'])} page(s) were scanned (last time {before}). Check /sitemap.xml lists every page; "
                       "the plan's facts now reflect this smaller scan.")
        TrackingScan.objects.update_or_create(pk=1, defaults={"data": scan, "scanned_at": timezone.now(), "source": source})
        bump_cache_version("tracking")
        from .revalidation import notify
        notify("cms:tracking")
        facts = get_facts()
        plan = tp.get_plan()
        _, report, stale = plan_state(plan, facts)
        return Response({"facts": facts_summary(facts), "stale": stale, "report": report, "warning": warning})


class TrackingOverviewView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        from .tracking_verify import overview
        return Response(overview())


def _audit(request, action, target="", detail=None):
    from .models import AdminAuditLog
    user = getattr(request.user, "username", "") or getattr(request.user, "email", "") or "?"
    AdminAuditLog.objects.create(user=str(user)[:150], action=action, target=str(target)[:200], detail=detail or {})


# ================================================================ ingest (§9.1)

BOT_UA = ("bot", "crawler", "spider", "slurp", "headless", "lighthouse", "pingdom", "uptime", "preview", "facebookexternalhit")
COUNTED = {"service_engaged", "cta_click", "faq_open", "form_start", "form_abandon", "scroll_depth", "contact_click",
           "file_download", "outbound_click", "section_view", "conversion", "page_view"}
MAX_BODY = 8 * 1024


def allowed_origin(origin):
    """The site's own origin (Settings → Site URL) or the CORS allowlist."""
    from django.conf import settings as dj
    from urllib.parse import urlparse

    from .models import SiteSettings
    if not origin:
        return False
    site = ((SiteSettings.objects.filter(pk=1).first() or SiteSettings()).data or {}).get("seoDefaults") or {}
    allowed = set(getattr(dj, "CORS_ALLOWED_ORIGINS", []) or [])
    if site.get("siteUrl"):
        u = urlparse(site["siteUrl"])
        allowed.add(f"{u.scheme}://{u.netloc}")
        if u.netloc.startswith("www."):
            allowed.add(f"{u.scheme}://{u.netloc[4:]}")
        else:
            allowed.add(f"{u.scheme}://www.{u.netloc}")
    return origin.rstrip("/") in {a.rstrip("/") for a in allowed}


class EventIngestView(APIView):
    """POST events/ — the kit's beacon for conversion-level events (public,
    throttled, origin-checked; sendBeacon sends text/plain JSON)."""
    permission_classes = [AllowAny]
    authentication_classes = []

    def get_throttles(self):
        from .throttles import SiteAwareScopedRateThrottle
        self.throttle_scope = "events"
        return [SiteAwareScopedRateThrottle()]

    def post(self, request):
        import json as _json

        from .tracking_dispatch import enqueue_event
        from .tracking_leads import read_envelope
        from .tracking_plan import get_plan
        from .tracking_verify import count
        from .tracking_vocab import EVENTS, clean_params
        if not allowed_origin(request.META.get("HTTP_ORIGIN", "")):
            return Response({"detail": "origin"}, status=status.HTTP_403_FORBIDDEN)
        if int(request.META.get("CONTENT_LENGTH") or 0) > MAX_BODY or len(request.body) > MAX_BODY:
            return Response({"detail": "too large"}, status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        ua = request.META.get("HTTP_USER_AGENT", "").lower()
        try:
            body = _json.loads(request.body or b"{}")
        except ValueError:
            return Response({"detail": "json"}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(body, dict) or not isinstance(body.get("events"), list):
            return Response({"detail": "events"}, status=status.HTTP_400_BAD_REQUEST)
        envelope = read_envelope(request, {k: body.get(k) for k in ("consent", "verify", "profile", "page", "ga4_loaded", "event_id")})
        if (any(b in ua for b in BOT_UA) or body.get("webdriver")) and not envelope["is_test"]:
            return Response(status=status.HTTP_204_NO_CONTENT)
        plan = get_plan()
        convs = {c["id"]: c for c in plan.get("conversions") or [] if c.get("enabled", True)} if plan.get("status") == "approved" else {}
        contact = _linked_contact(envelope)
        for ev in body["events"][:20]:
            if not isinstance(ev, dict):
                continue
            name = ev.get("name")
            eid = ev.get("event_id")
            if name not in EVENTS or not isinstance(eid, str) or not (8 <= len(eid) <= 80):
                continue
            if not cache.add(f"cms-ev:{eid}:{name}", 1, 86400):
                continue  # replay
            params = clean_params(name, ev.get("params") or {})
            matched = [convs[c] for c in (ev.get("conversions") or []) if c in convs and convs[c]["trigger"]["event"] == name]
            if name in COUNTED:
                count(name, intent=params.get("intent", ""), test=envelope["is_test"])
            for c in matched:
                count("conversion", conversion_id=c["id"], intent=params.get("intent", ""), test=envelope["is_test"])
            env = {**envelope, "event_id": eid}
            if EVENTS[name]["server"] or any(c["tier"] == "primary" for c in matched):
                enqueue_event(name, {**params, "event_id": eid}, env, [{"id": c["id"], "tier": c["tier"]} for c in matched])
            if contact and not envelope["is_test"] and name in ("service_engaged", "generate_lead", "cta_click", "faq_open", "conversion"):
                _contact_event(contact, name, params)
        return Response(status=status.HTTP_204_NO_CONTENT)


def _linked_contact(envelope):
    from .models import Contact
    vid = (envelope.get("profile") or {}).get("vid")
    if not vid or not (envelope.get("consent") or {}).get("analytics"):
        return None
    return Contact.objects.filter(vid=vid).first()


def _contact_event(contact, name, params):
    from .models import ContactEvent
    ContactEvent.objects.create(contact=contact, name=name, params={k: v for k, v in params.items() if k in ("intent", "stage", "page_path", "cta_label", "faq_topic", "conversion_id")})
    keep = list(ContactEvent.objects.filter(contact=contact).values_list("pk", flat=True)[:500])
    ContactEvent.objects.filter(contact=contact).exclude(pk__in=keep).delete()
    contact.last_seen = timezone.now()
    contact.save(update_fields=["last_seen"])


class ForgetVisitorView(APIView):
    """POST events/forget/ — consent withdrawn: unlink this browser's visitor
    id from any contact (the browser has already deleted its own copy)."""
    permission_classes = [AllowAny]
    authentication_classes = []

    def get_throttles(self):
        from .throttles import SiteAwareScopedRateThrottle
        self.throttle_scope = "events"
        return [SiteAwareScopedRateThrottle()]

    def post(self, request):
        import json as _json

        from .models import Contact
        if not allowed_origin(request.META.get("HTTP_ORIGIN", "")):
            return Response(status=status.HTTP_403_FORBIDDEN)
        try:
            vid = (_json.loads(request.body or b"{}") or {}).get("vid")
        except ValueError:
            vid = None
        if isinstance(vid, str) and 6 <= len(vid) <= 80:
            Contact.objects.filter(vid=vid).update(vid="")
        return Response(status=status.HTTP_204_NO_CONTENT)


# ============================================================ verification (§11)

class VerifyRunsView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        from .models import VerificationRun
        return Response([{"id": r.pk, "trigger": r.trigger, "mode": r.mode, "status": r.status, "summary": r.summary,
                          "created_at": r.created_at, "finished_at": r.finished_at} for r in VerificationRun.objects.all()[:30]])

    def post(self, request):
        from .tracking_verify import create_run, make_token
        plan = tp.get_plan()
        if plan.get("status") != "approved":
            return Response({"detail": "Approve the plan first: checks test the live plan."}, status=status.HTTP_400_BAD_REQUEST)
        mode = request.data.get("mode") if request.data.get("mode") in ("in_browser", "headless") else "in_browser"
        scope = [str(x) for x in (request.data.get("scope") or [])][:80]
        trigger = "acceptance" if request.data.get("trigger") == "acceptance" else "manual"
        run = create_run(trigger=trigger, mode=mode, scope=scope)
        if mode == "headless":
            from .models import TrackingJob
            TrackingJob.objects.create(kind="verify", payload={"run": run.pk})
        return Response({"id": run.pk, "token": make_token(run), "tests": run.tests,
                         "consent": {"forceDenied": bool(request.data.get("deniedRun"))}}, status=status.HTTP_201_CREATED)


class VerifyRunDetailView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request, pk):
        from .models import VerificationRun
        from .tracking_verify import run_detail
        run = VerificationRun.objects.filter(pk=pk).first()
        if not run:
            return Response(status=status.HTTP_404_NOT_FOUND)
        return Response(run_detail(run))


class VerifyResultsView(APIView):
    """POST tracking/verify/runs/<id>/results/ — from the harness or the
    headless runner. Authorised by the run token, not a login."""
    permission_classes = [AllowAny]
    authentication_classes = []

    def get_throttles(self):
        from .throttles import SiteAwareScopedRateThrottle
        self.throttle_scope = "verify"
        return [SiteAwareScopedRateThrottle()]

    def post(self, request, pk):
        from .tracking_verify import record_results, run_detail, run_from_token
        token = request.META.get("HTTP_X_CMS_VERIFY") or (request.data or {}).get("token")
        run = run_from_token(token)
        if not run or run.pk != int(pk):
            return Response({"detail": "Invalid or expired run token."}, status=status.HTTP_403_FORBIDDEN)
        n = record_results(run, request.data if isinstance(request.data, dict) else {})
        run.refresh_from_db()
        return Response({"stored": n, "status": run.status, **({"run": run_detail(run)} if run.finished_at else {})})


class VerifyPendingView(APIView):
    """GET tracking/verify/pending/ — for the headless runner: the next run
    waiting for it, with its token. Authorised by REVALIDATE_SECRET."""
    permission_classes = [AllowAny]
    authentication_classes = []

    def get(self, request):
        import hmac as _hmac

        from django.conf import settings as dj

        from .models import TrackingJob, VerificationRun
        from .tracking_verify import create_run, make_token
        secret = getattr(dj, "REVALIDATE_SECRET", "")
        if not secret or not _hmac.compare_digest(request.META.get("HTTP_X_CMS_RUNNER", ""), secret):
            return Response(status=status.HTTP_403_FORBIDDEN)
        job = TrackingJob.objects.filter(kind="verify", status="pending").first()
        if job is None and request.query_params.get("schedule") == "1":
            if tp.get_plan().get("status") != "approved":
                return Response({"run": None})
            run = create_run(trigger=request.query_params.get("trigger") or "schedule", mode="headless")
        elif job is not None:
            run = VerificationRun.objects.filter(pk=job.payload.get("run")).first()
            job.status = "done"
            job.finished_at = timezone.now()
            job.save(update_fields=["status", "finished_at"])
            if not run:
                return Response({"run": None})
        else:
            return Response({"run": None})
        return Response({"run": {"id": run.pk, "token": make_token(run), "tests": run.tests}})


# ============================================================ connections (§10.1)

CONNECTION_FIELDS = {
    "google": {"account": ("propertyId", "measurementId", "streamName", "gtmAccountId", "gtmContainerId"),
               "secret": ("serviceAccount", "mpSecret")},
    "meta": {"account": ("pixelId", "adAccountId", "testEventCode"), "secret": ("token",)},
    "tiktok": {"account": ("pixelCode", "advertiserId", "testEventCode"), "secret": ("token",)},
    "linkedin": {"account": ("adAccountId", "apiVersion"), "secret": ("token",)},
    "google_ads": {"account": ("customerId", "loginCustomerId"), "secret": ("developerToken", "serviceAccount")},
}


class ConnectionsView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        from .crypto import has_key
        from .tracking_sync import sync_status
        return Response({"hasKey": has_key(), "fields": {k: {"account": list(v["account"]), "secret": list(v["secret"])} for k, v in CONNECTION_FIELDS.items()},
                         **sync_status()})


class ConnectionDetailView(APIView):
    permission_classes = [IsAdminUser]

    def post(self, request, tool):
        """Connect (or update): validate with the tool, then store encrypted."""
        from .crypto import MissingKey, decrypt, encrypt, hint
        from .models import TrackingConnection
        from .tracking_adapters import ADAPTERS
        from .tracking_adapters.base import ToolError
        spec = CONNECTION_FIELDS.get(tool)
        if not spec:
            return Response(status=status.HTTP_404_NOT_FOUND)
        body = request.data if isinstance(request.data, dict) else {}
        row = TrackingConnection.objects.filter(tool=tool).first()
        try:
            old_secret = decrypt(row.secret) if row and row.secret else {}
        except Exception:
            old_secret = {}
        account = {**((row.account if row else {}) or {}), **{k: str(v).strip() for k, v in (body.get("account") or {}).items()
                                                             if k in spec["account"] and v not in (None,)}}
        secret = dict(old_secret)
        for k, v in (body.get("secret") or {}).items():
            if k in spec["secret"] and v not in (None, ""):
                if k == "serviceAccount" and isinstance(v, str):
                    import json as _json
                    try:
                        v = _json.loads(v)
                    except ValueError:
                        return Response({"detail": "The service account key must be the JSON file Google gave you."}, status=status.HTTP_400_BAD_REQUEST)
                secret[k] = v
        conn = {"account": account, "secret": secret}
        adapter = ADAPTERS["ga4" if tool == "google" else tool]
        try:
            info = adapter.check(conn)
        except ToolError as err:
            return Response({"detail": f"{tool} said: {err}"}, status=status.HTTP_400_BAD_REQUEST)
        if tool == "google" and not account.get("measurementId"):
            streams = info.get("streams") or []
            if len(streams) == 1:
                account["measurementId"] = streams[0]["measurementId"] or ""
                account["streamName"] = streams[0]["name"]
        try:
            enc = encrypt(secret)
        except MissingKey as err:
            return Response({"detail": str(err)}, status=status.HTTP_400_BAD_REQUEST)
        main = secret.get("token") or secret.get("developerToken") or (secret.get("serviceAccount") or {}).get("client_email", "")
        TrackingConnection.objects.update_or_create(tool=tool, defaults={
            "status": "connected", "account": account, "secret": enc, "secret_hint": hint(main), "connected_at": timezone.now(),
            "last_ok_at": timezone.now(), "last_error": ""})
        _audit(request, "connect_tool", tool)
        from .tracking_sync import queue_sync
        from .tracking_verify import resolve_alert
        resolve_alert(f"reauth:{tool}")
        queue_sync(reason=f"connected {tool}")
        return Response({"connected": True, "info": info, "account": account})

    def delete(self, request, tool):
        from .models import TrackingConnection, TrackingSyncItem
        row = TrackingConnection.objects.filter(tool=tool).first()
        if not row:
            return Response(status=status.HTTP_204_NO_CONTENT)
        if request.query_params.get("remote") == "1":
            from .tracking_sync import archive_all
            archive_all(tool)
        TrackingSyncItem.objects.filter(tool=tool).delete()
        row.delete()
        _audit(request, "disconnect_tool", tool, {"remote": request.query_params.get("remote") == "1"})
        return Response(status=status.HTTP_204_NO_CONTENT)


class SyncNowView(APIView):
    permission_classes = [IsAdminUser]

    def post(self, request):
        from .tracking_sync import preview, queue_sync, run_sync_in_background
        if request.query_params.get("preview") == "1":
            return Response(preview())
        queue_sync(reason="manual")
        run_sync_in_background()
        return Response({"queued": True}, status=status.HTTP_202_ACCEPTED)


class SyncItemView(APIView):
    """POST tracking/sync/items/<pk>/ {action: keep_theirs|restore_ours}"""
    permission_classes = [IsAdminUser]

    def post(self, request, pk):
        from .models import TrackingSyncItem
        item = TrackingSyncItem.objects.filter(pk=pk).first()
        if not item:
            return Response(status=status.HTTP_404_NOT_FOUND)
        action = request.data.get("action")
        if action == "keep_theirs":
            item.status = "unmanaged"
        elif action == "restore_ours":
            item.status = "pending"
            item.remote_hash = ""
        else:
            return Response({"detail": "action"}, status=status.HTTP_400_BAD_REQUEST)
        item.save(update_fields=["status", "remote_hash"])
        return Response({"status": item.status})


class GtmContainerView(APIView):
    """GET → importable container JSON; POST ?push=1 → new workspace via the
    API; POST ?publish=<workspace path> → publish (explicit click)."""
    permission_classes = [IsAdminUser]

    def _mid(self):
        from .models import SiteSettings, TrackingConnection
        a = ((SiteSettings.objects.filter(pk=1).first() or SiteSettings()).data or {}).get("analytics") or {}
        conn = TrackingConnection.objects.filter(tool="google").first()
        return a.get("ga4Id") or ((conn.account or {}).get("measurementId") if conn else "") or "G-XXXXXXXXXX"

    def get(self, request):
        from django.http import HttpResponse

        from .tracking_adapters import gtm
        import json as _json
        body = _json.dumps(gtm.container(tp.get_plan(), self._mid()), indent=2)
        resp = HttpResponse(body, content_type="application/json")
        resp["Content-Disposition"] = 'attachment; filename="gtm-container-dynamic-cms.json"'
        return resp

    def post(self, request):
        from .tracking_adapters import gtm
        from .tracking_adapters.base import ToolError
        from .tracking_dispatch import load_connection
        conn = load_connection("ga4")
        if not conn or not (conn["account"].get("gtmAccountId") and conn["account"].get("gtmContainerId")):
            return Response({"detail": "Connect Google with the GTM account and container ids first."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            if request.query_params.get("publish"):
                path = gtm.publish(request.query_params["publish"], conn)
                _audit(request, "gtm_publish", path)
                return Response({"published": path})
            path = gtm.push(tp.get_plan(), conn, self._mid())
            return Response({"workspace": path})
        except ToolError as err:
            return Response({"detail": str(err)}, status=status.HTTP_400_BAD_REQUEST)


# ================================================================ AI (§8)

class TrackingAiPromptView(APIView):
    permission_classes = [IsAdminUser]

    def post(self, request):
        from .prompts import tracking_plan_prompt
        from .tracking_library import build_plan
        facts = get_facts()
        current = tp.get_plan()
        start = current if current.get("intents") else build_plan(facts)
        return Response({"prompt": tracking_plan_prompt(facts=facts, library_plan=start, current=current)})


class TrackingAiApplyView(APIView):
    """Paste the AI reply → normalised, validated, fitted to the site.
    Dangling references are dropped (and listed); locked items survive; a
    reply that would drop more than half the plan is refused unless
    `replace` is set. Nothing is saved: the panel shows the diff first."""
    permission_classes = [IsAdminUser]

    def post(self, request):
        from .ai_normalize import NormalizeError, extract_json
        facts = get_facts()
        current = tp.get_plan()
        try:
            reply = extract_json(request.data.get("raw"))
        except NormalizeError as exc:
            return Response({"detail": exc.args[0] if exc.args else "Could not read that reply."}, status=status.HTTP_400_BAD_REQUEST)
        if isinstance(reply, dict) and isinstance(reply.get("plan"), dict):
            reply = reply["plan"]
        if not isinstance(reply, dict) or not any(isinstance(reply.get(k), list) for k in ("intents", "conversions")):
            return Response({"detail": "The reply must be a JSON object with intents, segments, stages, conversions and audiences."},
                            status=status.HTTP_400_BAD_REQUEST)
        proposal = {**current, **{k: reply.get(k) if isinstance(reply.get(k), list) else current.get(k, [])
                                  for k in ("intents", "segments", "stages", "conversions", "audiences")}}
        for kind in ("intents", "segments", "stages", "conversions", "audiences"):
            for item in proposal[kind]:
                if isinstance(item, dict) and item.get("createdBy") not in ("library", "owner"):
                    item["createdBy"] = "ai"
        before = sum(len(current.get(k) or []) for k in ("intents", "conversions", "audiences"))
        after = sum(len(proposal.get(k) or []) for k in ("intents", "conversions", "audiences"))
        if before >= 4 and after < before / 2 and not request.data.get("replace"):
            return Response({"detail": f"The reply would remove most of the plan ({before} → {after} items). Tick “replace plan” if that's intended."},
                            status=status.HTTP_400_BAD_REQUEST)
        dropped = []
        clean, report = tp.validate(proposal, facts)
        # Drop items whose references don't exist (instead of failing the whole reply).
        if report["dangling"] or report["errors"]:
            bad = {}
            for msg in report["dangling"] + report["errors"]:
                for kind, prefix in (("intents", "intents “"), ("segments", "segments “"), ("conversions", "conversion “"),
                                     ("audiences", "audience “")):
                    if msg.startswith(prefix):
                        bad.setdefault(kind, set()).add(msg[len(prefix):].split("”")[0])
            for kind, ids in bad.items():
                proposal[kind] = [x for x in proposal[kind] if not (isinstance(x, dict) and x.get("id") in ids)]
                dropped += [f"{kind}: {i}" for i in sorted(ids)]
            clean, report = tp.validate(proposal, facts)
        if report["errors"]:
            return Response({"detail": "The reply has problems the CMS can't fix.", "report": report}, status=status.HTTP_400_BAD_REQUEST)
        clean = tp.merge_locked(current, clean)
        return Response({"plan": clean, "report": report, "dropped": dropped, "diff": tp.diff(current, clean)})
