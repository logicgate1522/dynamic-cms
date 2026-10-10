"""Contacts (R33, §12): a privacy-safe, lightweight CRM built from leads.

- Created/updated from stored, non-spam, non-test submissions that carry an
  email or phone. Same normalised email → same contact. Same phone with a
  different email → a *suggested* merge, never automatic.
- Holds: form answers (option fields only), intent/segment/stage, source,
  approximate location, pipeline status, notes, tags, marketing opt-in.
- Linking later visits (`vid`) only with analytics consent.
- Retention: non-clients are erased `retentionMonths` after last contact.
- Erase = contact + events + (optionally) submissions + tombstone + removal
  from ad-tool audiences on the next sync. Export = everything held, as JSON.
- Only opted-in contacts ever reach an ad tool (hashed).
Settings (SiteSettings.data.contacts): {enabled, retentionMonths,
deleteSubmissionsOnErase, statuses, webhooks: [{url, secret, events}]}.
"""

import csv
import hashlib
import hmac
import io
import json
import re
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from .tracking_adapters.base import norm_email, norm_phone, sha256

DEFAULT_STATUSES = ["new", "contacted", "consultation_done", "client", "not_proceeding"]
STATUS_LABELS = {"new": "New", "contacted": "Contacted", "consultation_done": "Consultation done", "client": "Client",
                 "not_proceeding": "Not proceeding"}
OPTION_TYPES = {"select", "radio", "checkbox", "checkboxes", "multiselect", "date", "time", "datetime", "range", "rating", "number"}
NAME_KEYS = ("name", "full_name", "fullname", "your_name")
TRUE_VALUES = (True, "true", "True", "on", "yes", "1", 1)


def settings_data():
    from .models import SiteSettings
    site = (SiteSettings.objects.filter(pk=1).first() or SiteSettings()).data or {}
    c = site.get("contacts") or {}
    statuses = c.get("statuses") if isinstance(c.get("statuses"), list) and c.get("statuses") else DEFAULT_STATUSES
    return {"enabled": c.get("enabled", True) is not False, "retentionMonths": int(c.get("retentionMonths") or 24),
            "deleteSubmissionsOnErase": c.get("deleteSubmissionsOnErase", True) is not False,
            "statuses": statuses, "webhooks": c.get("webhooks") if isinstance(c.get("webhooks"), list) else []}


def _form_fields(form_name):
    from .models import ComponentData
    row = ComponentData.objects.filter(name=f"form-{form_name}").first()
    return {f["name"]: f for f in ((row.data or {}).get("fields") or []) if isinstance(f, dict) and f.get("name")} if row else {}


def identity(data, fields):
    email = phone = ""
    for key, value in data.items():
        ftype = (fields.get(key) or {}).get("type")
        if not email and (ftype == "email" or key in ("email", "email_address")):
            email = norm_email(value)
        if not phone and (ftype == "tel" or key in ("phone", "telephone", "mobile", "phone_number")):
            phone = str(value or "").strip()
    name = next((str(data[k]).strip() for k in NAME_KEYS if data.get(k)), "")
    if not name and (data.get("first_name") or data.get("last_name")):
        name = f"{data.get('first_name', '')} {data.get('last_name', '')}".strip()
    return email, phone, name[:200]


def tombstone_key(value):
    return sha256(f"erased:{value}") if value else ""


def is_tombstoned(email, phone_e164):
    """Was THIS person erased in the last 30 days? Identified by email when
    there is one (a shared office phone must not block other people), else
    by phone."""
    from .models import ErasureTombstone
    keys = [tombstone_key(email)] if email else [tombstone_key(phone_e164)] if phone_e164 else []
    cutoff = timezone.now() - timedelta(days=30)
    return keys and ErasureTombstone.objects.filter(key_hash__in=keys, created_at__gte=cutoff).exists()


def retain_until(contact, months):
    if contact.is_client:
        return None
    return (contact.last_seen or timezone.now()) + timedelta(days=30 * months)


def upsert_from_submission(submission, plan, said, envelope):
    from .models import Contact
    cfg = settings_data()
    if not cfg["enabled"] or submission.is_test or submission.is_spam:
        return None
    data = submission.data or {}
    fields = _form_fields(submission.form_name)
    email, phone_raw, name = identity(data, fields)
    country = submission.country or ""
    phone = norm_phone(phone_raw, country or "GB") if phone_raw else ""
    if not email and not phone:
        return None
    if is_tombstoned(email, phone):
        return None
    profile = submission.profile or {}
    consent = submission.consent or {}
    now = timezone.now()
    with transaction.atomic():
        contact = None
        if email:
            contact = Contact.objects.select_for_update().filter(email_norm=email).first()
        if contact is None and not email and phone:
            contact = Contact.objects.select_for_update().filter(phone_e164=phone, email_norm="").first()
        created = contact is None
        if created:
            contact = Contact(email_norm=email, phone_e164=phone, first_seen=now,
                              status_history=[{"status": "new", "at": now.isoformat(), "by": "form"}])
        if phone and not contact.phone_e164:
            contact.phone_e164 = phone
        if name and not contact.name_locked:
            contact.name = name
        answers = dict(contact.answers or {})
        for key, value in data.items():
            ftype = (fields.get(key) or {}).get("type")
            if ftype in OPTION_TYPES:
                answers[key] = value
            if ftype == "consent_marketing" and value in TRUE_VALUES and not contact.marketing_opt_in:
                contact.marketing_opt_in = True
                contact.opt_in_at = now
                contact.opt_in_source = {"form": submission.form_name, "label": (fields.get(key) or {}).get("label", ""),
                                         "submission": submission.pk}
        contact.answers = answers
        scores = dict(contact.intents or {})
        for k, v in ((profile.get("scores") or {}).get("intent") or {}).items():
            scores[k] = round(max(scores.get(k, 0), v), 2)
        for k in said.get("intents") or []:
            scores[k] = round(scores.get(k, 0) + 10, 2)
        contact.intents = scores
        primary = profile.get("primary") or {}
        contact.segment = (said.get("segments") or [primary.get("segment") or contact.segment or ""])[0] or ""
        contact.stages = sorted(set(contact.stages or []) | set(primary.get("stages") or []))
        src = profile.get("first") or {}
        if src and not contact.first_source:
            contact.first_source = src
        if profile.get("last") or src:
            contact.last_source = profile.get("last") or src
        contact.visits = max(contact.visits or 0, int(profile.get("visits") or 1))
        if consent.get("analytics") and profile.get("vid"):
            contact.vid = profile["vid"]
        if submission.country:
            contact.country, contact.region, contact.city = submission.country, submission.region, submission.city
        values = [i.get("value") or 0 for i in plan.get("intents") or [] if i["id"] in (said.get("intents") or [])]
        contact.value = max(contact.value or 0, float(sum(values)))
        contact.last_seen = now
        contact.retain_until = retain_until(contact, cfg["retentionMonths"])
        contact.save()
        submission.contact = contact
        submission.save(update_fields=["contact"])
        if phone:
            others = Contact.objects.filter(phone_e164=phone).exclude(pk=contact.pk)
            for other in others:
                for a, b in ((contact, other), (other, contact)):
                    if b.pk not in (a.merge_suggestions or []):
                        a.merge_suggestions = (a.merge_suggestions or []) + [b.pk]
                        a.save(update_fields=["merge_suggestions"])
    queue_webhook("contact.created" if created else "contact.updated", contact)
    return contact


# ------------------------------------------------------------- pipeline

def set_status(contact, status, user="admin"):
    cfg = settings_data()
    if status not in cfg["statuses"]:
        raise ValueError(f"Unknown status “{status}”.")
    now = timezone.now()
    contact.status = status
    contact.is_client = status == "client"
    contact.status_history = (contact.status_history or []) + [{"status": status, "at": now.isoformat(), "by": user}]
    contact.retain_until = retain_until(contact, cfg["retentionMonths"])
    contact.save()
    queue_webhook("contact.status_changed", contact)
    return contact


def add_note(contact, text, user="admin"):
    text = str(text or "").strip()[:4000]
    if not text:
        raise ValueError("Write the note first.")
    contact.notes = (contact.notes or []) + [{"text": text, "at": timezone.now().isoformat(), "by": user}]
    contact.save(update_fields=["notes", "updated_at"])
    return contact


def merge(keep, other, user="admin"):
    """Manual merge: `other`'s history moves to `keep`; `other` is deleted."""
    from .models import ContactEvent, FormSubmission
    with transaction.atomic():
        FormSubmission.objects.filter(contact=other).update(contact=keep)
        ContactEvent.objects.filter(contact=other).update(contact=keep)
        for k, v in (other.intents or {}).items():
            keep.intents[k] = max(keep.intents.get(k, 0), v)
        keep.stages = sorted(set(keep.stages or []) | set(other.stages or []))
        keep.notes = (keep.notes or []) + (other.notes or []) + [{"text": f"Merged with contact #{other.pk} ({other.email_norm or other.phone_e164})",
                                                                   "at": timezone.now().isoformat(), "by": user}]
        keep.tags = sorted(set(keep.tags or []) | set(other.tags or []))
        keep.answers = {**(other.answers or {}), **(keep.answers or {})}
        keep.marketing_opt_in = keep.marketing_opt_in or other.marketing_opt_in
        keep.phone_e164 = keep.phone_e164 or other.phone_e164
        keep.first_seen = min(keep.first_seen, other.first_seen)
        keep.last_seen = max(keep.last_seen, other.last_seen)
        keep.visits = max(keep.visits, other.visits)
        keep.merge_suggestions = [x for x in (keep.merge_suggestions or []) if x != other.pk]
        keep.save()
        other.delete()
    return keep


# ---------------------------------------------------------------- groups

FIELDS = ("intent", "segment", "stage", "status", "country", "region", "city", "source", "medium", "campaign", "tag",
          "opt_in", "is_client", "value", "visits", "created", "last_seen")
OPS = ("eq", "neq", "contains", "in", "gte", "lte", "exists", "before", "after")


def _contact_value(contact, field):
    if field == "intent":
        return sorted((contact.intents or {}).keys(), key=lambda k: -contact.intents[k])
    if field == "stage":
        return contact.stages or []
    if field == "tag":
        return contact.tags or []
    if field in ("source", "medium", "campaign"):
        src = contact.first_source or {}
        utm = src.get("utm") or {}
        return utm.get(field) or src.get(field) or ""
    if field == "opt_in":
        return contact.marketing_opt_in
    if field == "created":
        return contact.first_seen
    if field.startswith("answer."):
        return (contact.answers or {}).get(field[7:])
    return getattr(contact, field, None)


def matches(contact, rule):
    conds = (rule or {}).get("all") or []
    for cond in conds:
        field, op, value = cond.get("field"), cond.get("op", "eq"), cond.get("value")
        actual = _contact_value(contact, field)
        many = actual if isinstance(actual, list) else [actual]
        if op == "eq":
            ok = any(str(a).lower() == str(value).lower() for a in many) if not isinstance(actual, bool) else actual == (value in TRUE_VALUES)
        elif op == "neq":
            ok = all(str(a).lower() != str(value).lower() for a in many)
        elif op == "contains":
            ok = any(str(value).lower() in str(a).lower() for a in many)
        elif op == "in":
            vals = [str(v).lower() for v in (value if isinstance(value, list) else [value])]
            ok = any(str(a).lower() in vals for a in many)
        elif op in ("gte", "lte"):
            try:
                ok = (float(actual) >= float(value)) if op == "gte" else (float(actual) <= float(value))
            except (TypeError, ValueError):
                ok = False
        elif op in ("before", "after"):
            from django.utils.dateparse import parse_date, parse_datetime
            try:
                when_dt = parse_datetime(str(value))
                when_d = None if when_dt else parse_date(str(value))
            except ValueError:
                when_dt = when_d = None
            if actual is None or (when_dt is None and when_d is None):
                ok = False
            elif when_dt is not None:
                if timezone.is_naive(when_dt):
                    when_dt = timezone.make_aware(when_dt)
                ok = actual < when_dt if op == "before" else actual > when_dt
            else:
                a = actual.date() if hasattr(actual, "date") else actual
                ok = a < when_d if op == "before" else a > when_d
        elif op == "exists":
            ok = bool(actual) if not isinstance(actual, list) else bool(actual)
        else:
            ok = False
        if not ok:
            return False
    return True


def validate_rule(rule):
    if not isinstance(rule, dict) or not isinstance(rule.get("all"), list) or not rule["all"]:
        raise ValueError('A group needs at least one condition: {"all": [{field, op, value}]}')
    for c in rule["all"]:
        f = str(c.get("field") or "")
        if not (f in FIELDS or re.match(r"^answer\.[A-Za-z0-9_]{1,60}$", f)):
            raise ValueError(f"Unknown field “{f}”.")
        if c.get("op", "eq") not in OPS:
            raise ValueError(f"Unknown operator “{c.get('op')}”.")
    return {"all": [{"field": c["field"], "op": c.get("op", "eq"), "value": c.get("value")} for c in rule["all"]][:20]}


def auto_groups(plan):
    groups = []
    for kind, field in (("intents", "intent"), ("segments", "segment"), ("stages", "stage")):
        for item in plan.get(kind) or []:
            groups.append({"key": f"auto:{field}:{item['id']}", "label": f"{item['label']}", "kind": "auto",
                           "rule": {"all": [{"field": field, "op": "eq", "value": item["id"]}]}})
    for status in settings_data()["statuses"]:
        groups.append({"key": f"auto:status:{status}", "label": f"Status: {STATUS_LABELS.get(status, status)}", "kind": "auto",
                       "rule": {"all": [{"field": "status", "op": "eq", "value": status}]}})
    groups.append({"key": "auto:opted_in", "label": "Opted in to marketing", "kind": "auto",
                   "rule": {"all": [{"field": "opt_in", "op": "eq", "value": True}]}})
    return groups


def members(rule, qs=None):
    from .models import Contact
    qs = qs if qs is not None else Contact.objects.all()
    return [c for c in qs.iterator() if matches(c, rule)]


# ----------------------------------------------------------- export / erase

def contact_json(contact, include_free_text=True):
    from .models import FormSubmission
    subs = FormSubmission.objects.filter(contact=contact).order_by("created_at")
    return {
        "id": contact.pk, "name": contact.name, "email": contact.email_norm, "phone": contact.phone_e164,
        "status": contact.status, "status_history": contact.status_history, "tags": contact.tags, "notes": contact.notes,
        "marketing_opt_in": contact.marketing_opt_in, "opt_in_at": contact.opt_in_at, "opt_in_source": contact.opt_in_source,
        "location": {"country": contact.country, "region": contact.region, "city": contact.city},
        "first_source": contact.first_source, "last_source": contact.last_source, "intents": contact.intents,
        "segment": contact.segment, "stages": contact.stages, "answers": contact.answers, "value": contact.value,
        "visits": contact.visits, "first_seen": contact.first_seen, "last_seen": contact.last_seen,
        "retain_until": contact.retain_until, "is_client": contact.is_client,
        "submissions": [{"id": s.pk, "form": s.form_name, "at": s.created_at,
                         "data": s.data if include_free_text else {k: v for k, v in (s.data or {}).items() if not isinstance(v, str) or len(v) < 60},
                         "summary": (s.profile or {}).get("summary", "")} for s in subs],
        "events": [{"at": e.at, "name": e.name, "params": e.params} for e in contact.events.all()[:500]],
    }


CSV_COLUMNS = ["id", "name", "email", "phone", "status", "intent", "segment", "stages", "country", "region", "city",
               "source", "campaign", "opt_in", "first_seen", "last_seen", "visits", "value", "tags"]


def export_csv(contacts, include_free_text=False):
    out = io.StringIO()
    w = csv.writer(out)
    answer_keys = sorted({k for c in contacts for k in (c.answers or {})})
    w.writerow(CSV_COLUMNS + [f"answer:{k}" for k in answer_keys] + (["last_message"] if include_free_text else []))
    for c in contacts:
        src = c.first_source or {}
        top = sorted((c.intents or {}).items(), key=lambda kv: -kv[1])
        row = [c.pk, c.name, c.email_norm, c.phone_e164, c.status, top[0][0] if top else "", c.segment, ";".join(c.stages or []),
               c.country, c.region, c.city, (src.get("utm") or {}).get("source") or src.get("source", ""),
               (src.get("utm") or {}).get("campaign", ""), "yes" if c.marketing_opt_in else "no",
               c.first_seen.isoformat(), c.last_seen.isoformat(), c.visits, c.value, ";".join(c.tags or [])]
        row += [json.dumps(c.answers.get(k)) if isinstance((c.answers or {}).get(k), list) else (c.answers or {}).get(k, "") for k in answer_keys]
        if include_free_text:
            last = c.submissions.order_by("-created_at").first()
            row.append(((last.data or {}).get("message") or "") if last else "")
        w.writerow(row)
    return out.getvalue()


def erase(contact, reason="request", user="admin"):
    """Irreversible. Removes the contact everywhere the CMS controls and
    queues removal from ad-tool audiences."""
    from .models import AdminAuditLog, ErasureTombstone, FormSubmission, TrackingJob
    cfg = settings_data()
    hashed = hashed_row(contact)
    with transaction.atomic():
        for value in (contact.email_norm, contact.phone_e164):
            if value:
                ErasureTombstone.objects.get_or_create(key_hash=tombstone_key(value))
        subs = FormSubmission.objects.filter(contact=contact)
        if cfg["deleteSubmissionsOnErase"]:
            subs.delete()
        else:
            subs.update(contact=None)
        pk = contact.pk
        contact.delete()
        AdminAuditLog.objects.create(user=user, action="contact_erase", target=f"contact:{pk}", detail={"reason": reason})
        if hashed:
            TrackingJob.objects.create(kind="audience_remove", payload={"rows": [hashed]})
    return pk


def purge_expired(now=None):
    from .models import Contact
    now = now or timezone.now()
    n = 0
    for contact in Contact.objects.filter(is_client=False, retain_until__lt=now):
        erase(contact, reason="retention", user="system")
        n += 1
    from .models import ErasureTombstone
    ErasureTombstone.objects.filter(created_at__lt=now - timedelta(days=30)).delete()
    return n


def hashed_row(contact):
    """[sha256(email), sha256(phone)] for customer-list audiences."""
    if not contact.email_norm and not contact.phone_e164:
        return None
    return [sha256(contact.email_norm) if contact.email_norm else "", sha256(contact.phone_e164) if contact.phone_e164 else ""]


def audience_rows(rule):
    """Opted-in members only (R33)."""
    return [r for r in (hashed_row(c) for c in members(rule) if c.marketing_opt_in) if r]


# --------------------------------------------------------------- webhooks

WEBHOOK_EVENTS = ("contact.created", "contact.updated", "contact.status_changed")


def webhook_payload(event, contact):
    return {"version": 1, "event": event, "at": timezone.now().isoformat(), "contact": {
        "id": contact.pk, "name": contact.name, "email": contact.email_norm, "phone": contact.phone_e164,
        "status": contact.status, "segment": contact.segment, "stages": contact.stages,
        "intents": sorted((contact.intents or {}).keys(), key=lambda k: -contact.intents[k])[:3],
        "marketing_opt_in": contact.marketing_opt_in, "country": contact.country, "region": contact.region,
        "source": contact.first_source, "answers": contact.answers}}


def sign_payload(secret, body):
    return hmac.new(str(secret).encode(), body, hashlib.sha256).hexdigest()


def queue_webhook(event, contact):
    from .models import TrackingJob
    hooks = [h for h in settings_data()["webhooks"] if isinstance(h, dict) and h.get("url") and event in (h.get("events") or WEBHOOK_EVENTS)]
    for hook in hooks:
        TrackingJob.objects.create(kind="webhook", payload={"url": hook["url"], "secret": hook.get("secret", ""),
                                                            "body": webhook_payload(event, contact), "attempts": 0})


def deliver_webhook(job):
    import urllib.request
    p = job.payload
    body = json.dumps(p["body"], default=str).encode()
    headers = {"Content-Type": "application/json", "X-CMS-Event": p["body"]["event"]}
    if p.get("secret"):
        headers["X-CMS-Signature"] = "sha256=" + sign_payload(p["secret"], body)
    req = urllib.request.Request(p["url"], data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as res:
        return res.status
