"""Contacts API (R33). Admin-only; nothing here is public or cached.

    GET    contacts/                      list (q, status, intent, segment, stage, group, opt_in, page)
    GET    contacts/<id>/                 detail (+ submissions, events)
    PATCH  contacts/<id>/                 name, status, tags, is_client, add_note
    POST   contacts/<id>/erase/           irreversible erase (confirm: "ERASE")
    GET    contacts/<id>/export/          everything held (subject access request)
    POST   contacts/<id>/merge/           {other: id}  manual merge into this one
    GET    contacts/export/               CSV (group/filters; free_text=1 optional)
    GET    contacts/groups/               automatic + custom groups with sizes
    POST   contacts/groups/               create custom group {label, rule, sync_to}
    PATCH/DELETE contacts/groups/<key>/
    GET/PUT contacts/settings/            retention, statuses, webhooks, deleteSubmissionsOnErase
    GET    contacts/audit/                admin audit log
"""

import re

from django.http import HttpResponse
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import IsAdminUser
from rest_framework.response import Response
from rest_framework.views import APIView

from . import contacts as cx
from .models import AdminAuditLog, Contact, ContactGroup

PAGE_SIZE = 50


def _user(request):
    return str(getattr(request.user, "username", "") or getattr(request.user, "email", "") or "admin")[:150]


def _audit(request, action, target="", detail=None):
    AdminAuditLog.objects.create(user=_user(request), action=action, target=str(target)[:200], detail=detail or {})


def summary(c):
    top = sorted((c.intents or {}).items(), key=lambda kv: -kv[1])
    src = c.first_source or {}
    return {"id": c.pk, "name": c.name, "email": c.email_norm, "phone": c.phone_e164, "status": c.status,
            "intent": top[0][0] if top else "", "intents": [k for k, _ in top[:3]], "segment": c.segment, "stages": c.stages,
            "country": c.country, "region": c.region, "city": c.city,
            "source": (src.get("utm") or {}).get("source") or src.get("source", ""), "campaign": (src.get("utm") or {}).get("campaign", ""),
            "opt_in": c.marketing_opt_in, "is_client": c.is_client, "tags": c.tags, "visits": c.visits, "value": c.value,
            "first_seen": c.first_seen, "last_seen": c.last_seen, "retain_until": c.retain_until,
            "merge_suggestions": c.merge_suggestions}


def _group_rule(key):
    from .tracking_plan import get_plan
    if key.startswith("auto:"):
        g = next((g for g in cx.auto_groups(get_plan()) if g["key"] == key), None)
        return g["rule"] if g else None
    g = ContactGroup.objects.filter(key=key).first()
    return g.rule if g else None


def filtered(params):
    qs = Contact.objects.all()
    q = (params.get("q") or "").strip()
    if q:
        from django.db.models import Q
        qs = qs.filter(Q(name__icontains=q) | Q(email_norm__icontains=q.lower()) | Q(phone_e164__icontains=re.sub(r"\D", "", q) or q))
    if params.get("status"):
        qs = qs.filter(status=params["status"])
    if params.get("opt_in") in ("0", "1"):
        qs = qs.filter(marketing_opt_in=params["opt_in"] == "1")
    if params.get("segment"):
        qs = qs.filter(segment=params["segment"])
    rules = []
    if params.get("intent"):
        rules.append({"field": "intent", "op": "eq", "value": params["intent"]})
    if params.get("stage"):
        rules.append({"field": "stage", "op": "eq", "value": params["stage"]})
    if params.get("group"):
        rule = _group_rule(params["group"])
        if rule is None:
            return []
        rules += rule.get("all") or []
    return cx.members({"all": rules}, qs) if rules else list(qs)


class ContactListView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        items = filtered(request.query_params)
        page = max(1, int(request.query_params.get("page") or 1))
        start = (page - 1) * PAGE_SIZE
        return Response({"count": len(items), "page": page, "pageSize": PAGE_SIZE,
                         "results": [summary(c) for c in items[start:start + PAGE_SIZE]]})


class ContactDetailView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request, pk):
        c = Contact.objects.filter(pk=pk).first()
        if not c:
            return Response(status=status.HTTP_404_NOT_FOUND)
        data = cx.contact_json(c)
        data["summary"] = summary(c)
        data["statuses"] = cx.settings_data()["statuses"]
        return Response(data)

    def patch(self, request, pk):
        c = Contact.objects.filter(pk=pk).first()
        if not c:
            return Response(status=status.HTTP_404_NOT_FOUND)
        d = request.data if isinstance(request.data, dict) else {}
        try:
            if "name" in d:
                c.name, c.name_locked = str(d["name"] or "")[:200], True
                c.save(update_fields=["name", "name_locked", "updated_at"])
            if "tags" in d:
                c.tags = sorted({str(t).strip()[:40] for t in (d["tags"] or []) if str(t).strip()})[:30]
                c.save(update_fields=["tags", "updated_at"])
            if "status" in d:
                cx.set_status(c, d["status"], _user(request))
            if d.get("note"):
                cx.add_note(c, d["note"], _user(request))
            if "dismiss_merge" in d:
                c.merge_suggestions = [x for x in c.merge_suggestions if x != d["dismiss_merge"]]
                c.save(update_fields=["merge_suggestions"])
        except ValueError as err:
            return Response({"detail": str(err)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(summary(Contact.objects.get(pk=pk)))


class ContactEraseView(APIView):
    permission_classes = [IsAdminUser]

    def post(self, request, pk):
        c = Contact.objects.filter(pk=pk).first()
        if not c:
            return Response(status=status.HTTP_404_NOT_FOUND)
        if request.data.get("confirm") != "ERASE":
            return Response({"detail": 'Type ERASE to confirm: this cannot be undone.'}, status=status.HTTP_400_BAD_REQUEST)
        cx.erase(c, reason=str(request.data.get("reason") or "request")[:60], user=_user(request))
        return Response({"erased": pk})


class ContactExportView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request, pk):
        import json
        c = Contact.objects.filter(pk=pk).first()
        if not c:
            return Response(status=status.HTTP_404_NOT_FOUND)
        _audit(request, "contact_export", f"contact:{pk}")
        resp = HttpResponse(json.dumps(cx.contact_json(c), default=str, indent=2), content_type="application/json")
        resp["Content-Disposition"] = f'attachment; filename="contact-{pk}.json"'
        return resp


class ContactMergeView(APIView):
    permission_classes = [IsAdminUser]

    def post(self, request, pk):
        keep = Contact.objects.filter(pk=pk).first()
        other = Contact.objects.filter(pk=request.data.get("other")).first()
        if not keep or not other or keep.pk == other.pk:
            return Response({"detail": "Pick two different contacts."}, status=status.HTTP_400_BAD_REQUEST)
        cx.merge(keep, other, _user(request))
        _audit(request, "contact_merge", f"contact:{keep.pk}", {"merged": other.pk})
        return Response(summary(keep))


class ContactsCsvView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        items = filtered(request.query_params)
        free = request.query_params.get("free_text") == "1"
        _audit(request, "contacts_export", request.query_params.get("group") or "filtered", {"count": len(items), "free_text": free})
        resp = HttpResponse(cx.export_csv(items, include_free_text=free), content_type="text/csv")
        resp["Content-Disposition"] = f'attachment; filename="contacts-{timezone.localdate().isoformat()}.csv"'
        return resp


class ContactGroupsView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        from .tracking_plan import get_plan
        everyone = list(Contact.objects.all())
        out = []
        for g in cx.auto_groups(get_plan()):
            out.append({**g, "size": sum(1 for c in everyone if cx.matches(c, g["rule"])), "sync_to": [], "remote": {}})
        for g in ContactGroup.objects.all().order_by("label"):
            out.append({"key": g.key, "label": g.label, "kind": "custom", "rule": g.rule, "sync_to": g.sync_to,
                        "remote": {t: {k: v for k, v in (s or {}).items() if k != "hashes"} for t, s in (g.remote or {}).items()},
                        "size": sum(1 for c in everyone if cx.matches(c, g.rule)),
                        "optedIn": sum(1 for c in everyone if c.marketing_opt_in and cx.matches(c, g.rule))})
        return Response({"groups": out, "fields": list(cx.FIELDS) + ["answer.<field>"], "ops": list(cx.OPS)})

    def post(self, request):
        d = request.data if isinstance(request.data, dict) else {}
        label = str(d.get("label") or "").strip()[:100]
        if not label:
            return Response({"detail": "Name the group."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            rule = cx.validate_rule(d.get("rule"))
        except ValueError as err:
            return Response({"detail": str(err)}, status=status.HTTP_400_BAD_REQUEST)
        from .tracking_library import slug_id
        key = slug_id(label)
        n = 2
        while ContactGroup.objects.filter(key=key).exists():
            key, n = f"{slug_id(label)[:36]}_{n}", n + 1
        g = ContactGroup.objects.create(key=key, label=label, rule=rule, sync_to=[t for t in d.get("sync_to") or [] if t in ("meta",)])
        if g.sync_to:
            from .tracking_sync import queue_sync
            queue_sync(reason=f"group {key}")
        return Response({"key": g.key}, status=status.HTTP_201_CREATED)


class ContactGroupDetailView(APIView):
    permission_classes = [IsAdminUser]

    def patch(self, request, key):
        g = ContactGroup.objects.filter(key=key).first()
        if not g:
            return Response(status=status.HTTP_404_NOT_FOUND)
        d = request.data if isinstance(request.data, dict) else {}
        try:
            if "rule" in d:
                g.rule = cx.validate_rule(d["rule"])
        except ValueError as err:
            return Response({"detail": str(err)}, status=status.HTTP_400_BAD_REQUEST)
        if "label" in d:
            g.label = str(d["label"] or g.label)[:100]
        if "sync_to" in d:
            g.sync_to = [t for t in d["sync_to"] or [] if t in ("meta",)]
        g.save()
        from .tracking_sync import queue_sync
        queue_sync(reason=f"group {key}")
        return Response({"key": g.key})

    def delete(self, request, key):
        ContactGroup.objects.filter(key=key).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ContactSettingsView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        data = cx.settings_data()
        data["webhooks"] = [{**h, "secret": "…" if h.get("secret") else ""} for h in data["webhooks"]]
        data["statusLabels"] = cx.STATUS_LABELS
        data["webhookEvents"] = list(cx.WEBHOOK_EVENTS)
        return Response(data)

    def put(self, request):
        from django.db import transaction

        from .models import SiteSettings
        d = request.data if isinstance(request.data, dict) else {}
        current = cx.settings_data()
        out = {"enabled": d.get("enabled", current["enabled"]) is not False,
               "deleteSubmissionsOnErase": d.get("deleteSubmissionsOnErase", current["deleteSubmissionsOnErase"]) is not False}
        try:
            months = int(d.get("retentionMonths", current["retentionMonths"]))
        except (TypeError, ValueError):
            return Response({"detail": "Retention must be a number of months."}, status=status.HTTP_400_BAD_REQUEST)
        if not 1 <= months <= 120:
            return Response({"detail": "Retention must be between 1 and 120 months."}, status=status.HTTP_400_BAD_REQUEST)
        out["retentionMonths"] = months
        statuses = d.get("statuses", current["statuses"])
        if not isinstance(statuses, list) or not statuses or not all(re.match(r"^[a-z][a-z0-9_]{0,39}$", str(s)) for s in statuses):
            return Response({"detail": "Statuses are lowercase ids (letters, digits, _)."}, status=status.HTTP_400_BAD_REQUEST)
        if "new" not in statuses:
            statuses = ["new"] + list(statuses)
        out["statuses"] = list(dict.fromkeys(statuses))[:15]
        hooks = []
        old = {h.get("url"): h for h in current["webhooks"]}
        for h in d.get("webhooks", current["webhooks"]) or []:
            url = str((h or {}).get("url") or "").strip()
            if not url:
                continue
            if not re.match(r"^https://", url):
                return Response({"detail": "Webhook URLs must start with https://"}, status=status.HTTP_400_BAD_REQUEST)
            secret = h.get("secret")
            if secret in (None, "", "…"):
                secret = (old.get(url) or {}).get("secret", "")
            hooks.append({"url": url[:500], "secret": str(secret)[:200],
                          "events": [e for e in (h.get("events") or cx.WEBHOOK_EVENTS) if e in cx.WEBHOOK_EVENTS]})
        out["webhooks"] = hooks[:10]
        with transaction.atomic():
            row, _ = SiteSettings.objects.select_for_update().get_or_create(pk=1, defaults={"data": {}})
            data = row.data or {}
            data["contacts"] = out
            row.data = data
            row.save()
        _audit(request, "contacts_settings", "", {"retentionMonths": months, "webhooks": len(hooks)})
        return Response({**out, "webhooks": [{**h, "secret": "…" if h["secret"] else ""} for h in out["webhooks"]]})


class AuditLogView(APIView):
    permission_classes = [IsAdminUser]

    def get(self, request):
        return Response([{"user": a.user, "action": a.action, "target": a.target, "detail": a.detail, "at": a.at}
                         for a in AdminAuditLog.objects.all()[:200]])


class WebhookTestView(APIView):
    permission_classes = [IsAdminUser]

    def post(self, request):
        from .models import TrackingJob
        url = str(request.data.get("url") or "")
        hook = next((h for h in cx.settings_data()["webhooks"] if h["url"] == url), None)
        if not hook:
            return Response({"detail": "Save the webhook first."}, status=status.HTTP_400_BAD_REQUEST)
        fake = Contact(pk=0, name="Test Contact", email_norm="test@example.org", status="new")
        job = TrackingJob(kind="webhook", payload={"url": url, "secret": hook.get("secret", ""), "body": cx.webhook_payload("contact.created", fake)})
        try:
            code = cx.deliver_webhook(job)
        except Exception as err:
            return Response({"ok": False, "detail": str(err)[:300]})
        return Response({"ok": 200 <= code < 300, "detail": f"HTTP {code}"})
