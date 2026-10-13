"""The acknowledgement email a visitor gets after submitting a form ("we have received your request").

Configured per form, in its definition (home/form-<name>):

    "autoReply": {
        "enabled": true,
        "subject": "We have received your request",          # optional
        "intro":   "Thank you for contacting {business}. We have received your request regarding {topic}, ...",
        "steps":   ["...", "..."],                            # "What happens next", optional
        "closing": "If you would like to add anything, simply reply to this email.",
        "signoff": "Kind regards",                            # optional
        "replyTo": "team@example.com",                        # default: FORM_NOTIFICATION_EMAIL / Settings contact email
        "fromName": "Logic Gate Software Solutions"           # default: the organisation name
    }

It reads like a letter, not a template with blanks: the greeting uses the first name when there is one, the
topic and the way we will reach them are worked out from what they submitted, and anything missing drops out
of the sentence instead of leaving a gap. Replies go to `replyTo`, so the visitor can answer the team directly.
Sent only for real submissions (never tests) and only when SMTP is configured.
"""

import re
import threading
from email.utils import formataddr, parseaddr

from django.conf import settings
from django.core.mail import EmailMultiAlternatives
from django.utils.html import escape

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PLACEHOLDER = re.compile(r"\{(\w+)\}")

NAME_KEYS = ("name", "fullName", "full_name", "firstName", "first_name")
EMAIL_KEYS = ("email", "emailAddress")
PHONE_KEYS = ("phone", "mobile", "tel", "telephone")
TOPIC_KEYS = ("goal", "service", "interest", "subject", "topic", "enquiry")
PLAN_KEYS = ("plan", "services", "interests", "needs")
# Answers that are plumbing, not something to read back to the visitor.
SKIP_KEYS = {"source", "sourceService", "timeZone", "budgetChosen", "whatsapp", "heardFrom", "heardFromOther",
             "consent", "consent_marketing", "country"}

DEFAULT_INTRO = ("Thank you for contacting {business}. We have received your request{topic_clause}, "
                 "and one of our team will be in touch with you {channel} within one business day.")
DEFAULT_STEPS = [
    "A member of our team reviews your request.",
    "We contact you {channel} to find a convenient time.",
    "We talk through your goals and recommend the best way forward, with no obligation.",
]
DEFAULT_CLOSING = "If you would like to add anything, simply reply to this email. It reaches our team directly."


def _first(data, keys):
    for key in keys:
        value = data.get(key)
        if value not in (None, "", [], {}):
            return str(value).strip()
    return ""


def recipient_of(data):
    address = _first(data, EMAIL_KEYS)
    return address if _EMAIL_RE.match(address) else ""


def _clean_line(value, limit=200):
    """Plain single-line text (no control characters: nothing from a visitor goes into a header raw)."""
    return re.sub(r"[\x00-\x1f\x7f]+", " ", str(value)).strip()[:limit]


def _variables(data, site):
    organisation = (site.get("organization") or {}).get("name") or ""
    name = _clean_line(_first(data, NAME_KEYS), 80)
    first = name.split()[0].capitalize() if name else ""
    topic = _clean_line(_first(data, TOPIC_KEYS), 120)
    plan = _clean_line(_first(data, PLAN_KEYS), 120)
    if topic and plan and plan.lower() not in topic.lower():
        topic = f"{topic} ({plan})"
    phone = _clean_line(_first(data, PHONE_KEYS), 40)
    whatsapp = str(data.get("whatsapp", "")).strip().lower() in ("yes", "true", "1", "on")
    if phone and whatsapp:
        channel = f"on WhatsApp ({phone})"
    elif phone:
        channel = f"by phone ({phone})"
    else:
        channel = "by email"
    return {
        "name": first, "business": organisation or "our team",
        "topic": topic or "your enquiry", "topic_clause": f" regarding {topic}" if topic else "",
        "channel": channel, "phone": phone,
    }


def _fill(template, variables):
    text = _PLACEHOLDER.sub(lambda m: str(variables.get(m.group(1), "")), template or "")
    return re.sub(r"\s{2,}", " ", text).replace(" ,", ",").replace(" .", ".").strip()


def _summary_rows(definition, data):
    labels = {f.get("name"): f.get("label") for f in (definition.get("fields") or []) if isinstance(f, dict)}
    order = [f.get("name") for f in (definition.get("fields") or []) if isinstance(f, dict) and f.get("name")]
    keys = [k for k in order if k in data] + [k for k in data if k not in order]
    rows = []
    for key in keys:
        if key in SKIP_KEYS or key in EMAIL_KEYS:
            continue
        value = data.get(key)
        if value in (None, "", [], {}) or isinstance(value, dict):
            continue
        text = ", ".join(map(str, value)) if isinstance(value, list) else str(value)
        label = labels.get(key) or re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key.replace("_", " ")).capitalize()
        rows.append((label, text.strip()[:600]))
    return rows


def build(definition, data, site):
    """-> {to, subject, text, html, reply_to, from_name} or None when this form sends no acknowledgement."""
    config = (definition or {}).get("autoReply") or {}
    to = recipient_of(data)
    if not config.get("enabled") or not to:
        return None
    variables = _variables(data, site)
    contact = site.get("contact") or {}
    reply_to = _clean_line(config.get("replyTo") or getattr(settings, "FORM_NOTIFICATION_EMAIL", "") or contact.get("email") or "", 120)
    business = variables["business"]
    greeting = f"Dear {variables['name']}," if variables["name"] else "Hello,"
    subject = _clean_line(_fill(config.get("subject") or "We have received your request", variables), 120)
    intro = _fill(config.get("intro") or DEFAULT_INTRO, variables)
    steps = [_fill(step, variables) for step in (config.get("steps") or DEFAULT_STEPS)]
    closing = _fill(config.get("closing") or DEFAULT_CLOSING, variables)
    signoff = _fill(config.get("signoff") or "Kind regards", variables)
    rows = _summary_rows(definition, data)
    contact_lines = [x for x in (contact.get("email") or "", contact.get("phone") or "") if x]

    text = [greeting, "", intro, ""]
    if rows:
        text += ["Your request", *[f"  {label}: {value}".replace("\n", "\n    ") for label, value in rows], ""]
    if steps:
        text += ["What happens next", *[f"  {i}. {step}" for i, step in enumerate(steps, 1)], ""]
    text += [closing, "", f"{signoff},", business]
    if contact_lines:
        text.append(" · ".join(contact_lines))

    navy, cyan, ink, muted = "#052355", "#45c4e8", "#1e293b", "#64748b"
    row_html = "".join(
        f'<tr><td style="padding:6px 14px 6px 0;color:{muted};font-size:13px;vertical-align:top;white-space:nowrap">{escape(label)}</td>'
        f'<td style="padding:6px 0;color:{ink};font-size:14px;vertical-align:top">{escape(value).replace(chr(10), "<br>")}</td></tr>'
        for label, value in rows
    )
    step_html = "".join(
        f'<tr><td style="padding:5px 12px 5px 0;vertical-align:top"><span style="display:inline-block;width:22px;height:22px;line-height:22px;'
        f'border-radius:11px;background:{cyan};color:{navy};font-size:12px;font-weight:bold;text-align:center">{i}</span></td>'
        f'<td style="padding:5px 0;color:{ink};font-size:14px;line-height:1.5">{escape(step)}</td></tr>'
        for i, step in enumerate(steps, 1)
    )
    html = f"""<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
<tr><td style="background:{navy};padding:22px 28px"><span style="color:#ffffff;font-size:18px;font-weight:bold">{escape(business)}</span></td></tr>
<tr><td style="padding:28px 28px 8px 28px;color:{ink};font-size:15px;line-height:1.6">
<p style="margin:0 0 14px 0">{escape(greeting)}</p>
<p style="margin:0 0 18px 0">{escape(intro)}</p>
{f'<p style="margin:18px 0 6px 0;color:{navy};font-size:13px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase">Your request</p><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;margin-bottom:18px">{row_html}</table>' if rows else ''}
{f'<p style="margin:18px 0 6px 0;color:{navy};font-size:13px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase">What happens next</p><table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:18px">{step_html}</table>' if steps else ''}
<p style="margin:0 0 18px 0">{escape(closing)}</p>
<p style="margin:0 0 4px 0">{escape(signoff)},</p>
<p style="margin:0;font-weight:bold;color:{navy}">{escape(business)}</p>
</td></tr>
<tr><td style="padding:16px 28px 24px 28px;color:{muted};font-size:12px;border-top:1px solid #e2e8f0">{escape(' · '.join(contact_lines))}</td></tr>
</table></td></tr></table></body></html>"""
    return {"to": to, "subject": subject, "text": "\n".join(text), "html": html, "reply_to": reply_to,
            "from_name": _clean_line(config.get("fromName") or business, 80)}


def _send(message):
    if str(getattr(settings, "EMAIL_BACKEND", "")).endswith("smtp.EmailBackend"):
        # A slow mail server must not slow the visitor's submit: send in the background.
        threading.Thread(target=lambda: message.send(fail_silently=True), daemon=True).start()
    else:
        message.send(fail_silently=True)


def send_acknowledgement(definition, data, site):
    """Builds and sends the acknowledgement. Never raises: a failed email never fails the submission."""
    try:
        built = build(definition, data, site)
        if not built:
            return False
        sender = parseaddr(getattr(settings, "DEFAULT_FROM_EMAIL", "") or "")[1]
        message = EmailMultiAlternatives(
            subject=built["subject"], body=built["text"],
            from_email=formataddr((built["from_name"], sender)) if sender else None,
            to=[built["to"]], reply_to=[built["reply_to"]] if built["reply_to"] else None,
            headers={"Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All"},
        )
        message.attach_alternative(built["html"], "text/html")
        _send(message)
        return True
    except Exception:  # noqa: BLE001 - best effort by design
        return False
