"""Sync engine (R31, §10): makes each connected tool match the approved plan.

For each connected tool:
    desired = adapter.desired(plan)                 what the tool should contain
    for each desired item: create / update / adopt  (by hash; idempotent)
    for each managed item no longer desired: archive (never delete data)
Every item records its status (in_sync, failed, refused, manual, unmanaged)
with a plain-words reason. The CMS only manages what it created or adopted
(TrackingSyncItem); "Keep theirs" stops managing an item.

Runs: after approval, "Sync now", (re)connecting a tool, nightly (worker).
Contact groups with `sync_to` become customer-list audiences (opted-in
contacts only, hashed) — see sync_groups().
"""

import hashlib
import json
import re
import threading

from django.db import close_old_connections
from django.db.models import Count
from django.utils import timezone

SYNC_TOOLS = (("ga4", "google"), ("meta", "meta"), ("linkedin", "linkedin"), ("tiktok", "tiktok"))
POLICY_RE = re.compile(r"polic|special ad|not allowed|restricted|prohibit|sensitive|category", re.I)


def item_hash(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()[:32]


def _hashable(item):
    if item["kind"] == "website_audience":
        a = item["audience"]
        return {"name": item["name"], "include": a.get("include"), "exclude": a.get("exclude"), "days": item.get("retention_days")}
    if item["kind"] == "audience":
        a = item["audience"]
        return {"name": item["displayName"], "include": a.get("include"), "exclude": a.get("exclude"), "days": a.get("windowDays")}
    return {k: v for k, v in item.items() if k not in ("audience",)}


# ------------------------------------------------------------------ queue

def queue_sync(reason=""):
    from .models import TrackingJob
    if not TrackingJob.objects.filter(kind="sync", status="pending").exists():
        TrackingJob.objects.create(kind="sync", payload={"reason": reason})


def sync_queued():
    from .models import TrackingJob
    job = TrackingJob.objects.filter(kind="sync", status__in=("pending", "running")).first()
    return {"reason": job.payload.get("reason"), "at": job.created_at, "status": job.status} if job else None


def run_sync_in_background():
    def run():
        try:
            run_pending_sync()
        finally:
            close_old_connections()
    threading.Thread(target=run, daemon=True).start()


def run_pending_sync():
    from .models import TrackingJob
    job = TrackingJob.objects.filter(kind="sync", status="pending").first()
    if not job:
        return None
    if not TrackingJob.objects.filter(pk=job.pk, status="pending").update(status="running"):
        return None
    try:
        result = run_sync()
        job.status, job.result = "done", result
    except Exception as err:  # recorded, never raised into a request
        job.status, job.result = "error", {"error": str(err)[:500]}
    job.finished_at = timezone.now()
    job.save(update_fields=["status", "result", "finished_at"])
    return job.result


# ------------------------------------------------------------------- state

def runtime_sync_detail():
    """Per conversion, ids the browser/dispatcher need that exist only after
    sync (Google Ads send_to label, LinkedIn conversion id)."""
    from .models import TrackingSyncItem
    out = {}
    for item in TrackingSyncItem.objects.filter(status="in_sync", kind__in=("ads_conversion", "linkedin_conversion")):
        d = out.setdefault(item.plan_id, {})
        if item.kind == "ads_conversion":
            if item.detail.get("label"):
                d["adsSendTo"] = item.detail["label"]
            if item.detail.get("resource"):
                d["adsConversionAction"] = item.detail["resource"]
        if item.kind == "linkedin_conversion" and item.remote_id:
            d["linkedinConversionId"] = item.remote_id
    return out


def sync_status():
    from .models import TrackingConnection, TrackingSyncItem
    counts = {}
    for row in TrackingSyncItem.objects.values("tool", "status").annotate(n=Count("id")):
        counts.setdefault(row["tool"], {})[row["status"]] = row["n"]
    return {
        "queued": sync_queued(),
        "connections": {c.tool: {"status": c.status, "account": c.account, "hint": c.secret_hint, "connectedAt": c.connected_at,
                                 "lastOk": c.last_ok_at, "error": c.last_error} for c in TrackingConnection.objects.all()},
        "counts": counts,
        "items": [{"id": i.pk, "tool": i.tool, "kind": i.kind, "plan_id": i.plan_id, "status": i.status, "error": i.error,
                   "remote_id": i.remote_id, "synced_at": i.synced_at, "manual": i.detail.get("manual")}
                  for i in TrackingSyncItem.objects.all().order_by("tool", "kind", "plan_id")],
    }


def preview():
    """Dry run: what a sync would create / update / archive per tool."""
    from .models import TrackingSyncItem
    from .tracking_adapters import ADAPTERS
    from .tracking_dispatch import load_connection
    from .tracking_plan import get_plan
    plan = get_plan()
    out = {}
    for adapter_key, conn_key in SYNC_TOOLS:
        if not load_connection(adapter_key):
            continue
        desired = ADAPTERS[adapter_key].desired(plan) if plan.get("status") == "approved" else []
        existing = {(i.kind, i.plan_id): i for i in TrackingSyncItem.objects.filter(tool=conn_key)}
        keys = {(d["kind"], d["plan_id"]) for d in desired}
        create = [d["plan_id"] for d in desired if (d["kind"], d["plan_id"]) not in existing or not existing[(d["kind"], d["plan_id"])].remote_id]
        update = [d["plan_id"] for d in desired if (d["kind"], d["plan_id"]) in existing and existing[(d["kind"], d["plan_id"])].remote_id
                  and existing[(d["kind"], d["plan_id"])].desired_hash != item_hash(_hashable(d))
                  and existing[(d["kind"], d["plan_id"])].status != "unmanaged"]
        archive = [k[1] for k, i in existing.items() if k not in keys and i.remote_id and i.status not in ("orphaned", "unmanaged")]
        out[conn_key] = {"create": create, "update": update, "archive": archive}
    return out


# ------------------------------------------------------------------- engine

def run_sync():
    from .tracking_plan import get_plan
    plan = get_plan()
    if plan.get("status") != "approved":
        return {"skipped": "plan not approved"}
    result = {}
    for adapter_key, conn_key in SYNC_TOOLS:
        result[conn_key] = reconcile(adapter_key, conn_key, plan)
    result["groups"] = sync_groups()
    process_audience_removals()
    from .tracking_verify import open_alert, resolve_alert
    failed = [f"{tool}: {r['failed']}" for tool, r in result.items() if isinstance(r, dict) and r.get("failed")]
    if failed:
        open_alert("sync", "warning", "Some tracking items couldn't be synced (" + "; ".join(failed) + "). Site tools → Tracking → Tools.")
    else:
        resolve_alert("sync")
    return result


def reconcile(adapter_key, conn_key, plan):
    from .models import TrackingConnection, TrackingSyncItem
    from .tracking_adapters import ADAPTERS
    from .tracking_adapters.base import AuthError, Permanent, ToolError
    from .tracking_dispatch import load_connection
    conn = load_connection(adapter_key)
    if not conn:
        return {"skipped": "not connected"}
    adapter = ADAPTERS[adapter_key]
    desired = adapter.desired(plan)
    stats = {"created": 0, "updated": 0, "archived": 0, "failed": 0, "refused": 0, "unchanged": 0, "manual": 0}
    remote = {}
    if hasattr(adapter, "fetch"):
        try:
            remote = adapter.fetch(conn)
        except AuthError as err:
            return _reauth(conn_key, err)
        except ToolError:
            remote = {}
    keys = set()
    now = timezone.now()
    for item in desired:
        key = (item["kind"], item["plan_id"])
        keys.add(key)
        row, _ = TrackingSyncItem.objects.get_or_create(tool=conn_key, kind=item["kind"], plan_id=item["plan_id"])
        if row.status == "unmanaged":
            continue
        h = item_hash(_hashable(item))
        try:
            existing_remote = _find_remote(item, remote)
            if row.remote_id and remote and item["kind"] in remote and not existing_remote and item["kind"] in ("custom_dimension", "key_event"):
                row.remote_id = ""  # deleted in the tool: recreate
            if not row.remote_id:
                if existing_remote:  # same parameter / event already there: adopt it
                    row.remote_id = existing_remote.get("name", "")
                    row.detail = {**row.detail, "adopted": True}
                else:
                    remote_id, extra = adapter.create(item, conn, plan)
                    row.remote_id = str(remote_id or "")
                    if item["kind"] == "mp_secret" and extra.get("secretValue"):
                        _store_secret(conn_key, "mpSecret", extra["secretValue"])
                        extra = {}
                    row.detail = {**row.detail, **extra}
                    stats["created"] += 1
            elif row.desired_hash != h:
                if item["kind"] in ("audience",) or (item["kind"] == "custom_conversion" and _rule_changed(row, item)):
                    adapter.archive(item["kind"], row.remote_id, conn, item.get("name") or item.get("displayName") or item["plan_id"])
                    remote_id, extra = adapter.create(item, conn, plan)
                    row.remote_id = str(remote_id or "")
                else:
                    adapter.update(item, row.remote_id, conn, plan)
                stats["updated"] += 1
            else:
                stats["unchanged"] += 1
            row.desired_hash = h
            row.status, row.error, row.synced_at = "in_sync", "", now
            if item["kind"] == "custom_conversion":
                row.detail = {**row.detail, "meta_event": item.get("meta_event")}
        except AuthError as err:
            row.status, row.error = "failed", str(err)[:500]
            row.save()
            return _reauth(conn_key, err, stats)
        except Permanent as err:
            message = str(err)
            if "manually" in message or "unavailable" in message:
                row.status, row.detail = "manual", {**row.detail, "manual": _manual_definition(item)}
                stats["manual"] += 1
            elif POLICY_RE.search(message):
                row.status = "refused"
                stats["refused"] += 1
            else:
                row.status = "failed"
                stats["failed"] += 1
            row.error = message[:500]
        except ToolError as err:
            row.status, row.error = "failed", str(err)[:500]
            stats["failed"] += 1
        row.save()
    for row in TrackingSyncItem.objects.filter(tool=conn_key).exclude(status__in=("orphaned", "unmanaged")):
        if (row.kind, row.plan_id) in keys:
            continue
        try:
            if row.remote_id:
                adapter.archive(row.kind, row.remote_id, conn, row.plan_id)
            row.status, row.error = "orphaned", ""
            stats["archived"] += 1
        except ToolError as err:
            row.error = f"archive failed: {err}"[:500]
        row.save()
    TrackingConnection.objects.filter(tool=conn_key).update(last_ok_at=now)
    return stats


def _find_remote(item, remote):
    pool = remote.get(item["kind"]) or {}
    if item["kind"] == "custom_dimension":
        return pool.get(item["parameterName"])
    if item["kind"] == "key_event":
        return pool.get(item["eventName"])
    return None


def _rule_changed(row, item):
    return row.detail.get("meta_event") not in (None, item.get("meta_event"))


def _manual_definition(item):
    a = item.get("audience") or {}
    return {"name": item.get("displayName") or item.get("name"), "include": a.get("include"), "exclude": a.get("exclude"),
            "days": a.get("windowDays"), "purpose": a.get("purpose")}


def _reauth(conn_key, err, stats=None):
    from .models import TrackingConnection
    from .tracking_verify import open_alert
    TrackingConnection.objects.filter(tool=conn_key).update(status="needs_reauth", last_error=str(err)[:500])
    open_alert(f"reauth:{conn_key}", "warning", f"{conn_key}: reconnect in Site tools → Tracking → Tools ({err}).")
    return {**(stats or {}), "error": "needs re-auth"}


def _store_secret(conn_key, key, value):
    from .crypto import decrypt, encrypt
    from .models import TrackingConnection
    row = TrackingConnection.objects.filter(tool=conn_key).first()
    if not row:
        return
    secret = decrypt(row.secret) if row.secret else {}
    secret[key] = value
    row.secret = encrypt(secret)
    row.save(update_fields=["secret"])


def archive_all(conn_key):
    """Disconnect with "also remove what the CMS created"."""
    from .models import TrackingSyncItem
    from .tracking_adapters import ADAPTERS
    from .tracking_adapters.base import ToolError
    from .tracking_dispatch import load_connection
    adapter_key = "ga4" if conn_key == "google" else conn_key
    conn = load_connection(adapter_key)
    if not conn:
        return 0
    n = 0
    for row in TrackingSyncItem.objects.filter(tool=conn_key).exclude(status__in=("orphaned", "unmanaged")).exclude(remote_id=""):
        if row.detail.get("adopted") or row.kind == "mp_secret":
            continue
        try:
            ADAPTERS[adapter_key].archive(row.kind, row.remote_id, conn, row.plan_id)
            n += 1
        except ToolError:
            pass
    return n


# --------------------------------------------------- customer-list audiences

def sync_groups():
    """Contact groups with sync_to=[meta] → Meta customer-list audience with
    exactly the group's opted-in members (adds and removals)."""
    from .contacts import audience_rows
    from .models import ContactGroup
    from .tracking_adapters import meta
    from .tracking_adapters.base import ToolError
    from .tracking_dispatch import load_connection
    conn = load_connection("meta")
    out = {}
    for group in ContactGroup.objects.exclude(sync_to=[]):
        if "meta" not in (group.sync_to or []):
            continue
        state = (group.remote or {}).get("meta") or {}
        if not conn or not conn["account"].get("adAccountId"):
            state["error"] = "Meta isn't connected with an ad account."
        else:
            try:
                if not state.get("id"):
                    state["id"] = meta.create_customer_audience(f"{group.label} [cms:group:{group.key}]", conn)
                rows = audience_rows(group.rule)
                want = {"|".join(r) for r in rows}
                have = set(state.get("hashes") or [])
                add = [r.split("|") for r in want - have]
                remove = [r.split("|") for r in have - want]
                if add:
                    meta.upload_customer_list(state["id"], add, conn)
                if remove:
                    meta.upload_customer_list(state["id"], remove, conn, remove=True)
                state.update(hashes=sorted(want), size=len(want), synced_at=timezone.now().isoformat(), error="",
                             warning="Meta needs about 100 matched people before it will show ads to an audience." if len(want) < 100 else "")
            except ToolError as err:
                state["error"] = str(err)[:300]
        group.remote = {**(group.remote or {}), "meta": state}
        group.save(update_fields=["remote"])
        out[group.key] = {k: state.get(k) for k in ("size", "error")}
    return out


def process_audience_removals():
    """Erased contacts: remove their hashes from every synced audience."""
    from .models import ContactGroup, TrackingJob
    from .tracking_adapters import meta
    from .tracking_adapters.base import ToolError
    from .tracking_dispatch import load_connection
    conn = load_connection("meta")
    for job in TrackingJob.objects.filter(kind="audience_remove", status="pending"):
        rows = job.payload.get("rows") or []
        keys = {"|".join(r) for r in rows}
        try:
            for group in ContactGroup.objects.all():
                state = (group.remote or {}).get("meta") or {}
                if state.get("id") and keys & set(state.get("hashes") or []):
                    if conn:
                        meta.upload_customer_list(state["id"], rows, conn, remove=True)
                    state["hashes"] = sorted(set(state["hashes"]) - keys)
                    group.remote = {**group.remote, "meta": state}
                    group.save(update_fields=["remote"])
            job.status = "done"
        except ToolError as err:
            job.result = {"error": str(err)[:300]}
        job.finished_at = timezone.now()
        job.save(update_fields=["status", "result", "finished_at"])
