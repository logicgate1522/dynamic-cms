"""Tell the frontend which cached CMS reads to drop, whenever content changes.

The frontend caches every public CMS read (Next.js ISR) under fixed tags:

    cms                    everything (site settings change)
    cms:settings           GET settings/site/
    cms:home:<name>        GET home/<name>/
    cms:seo / cms:seo:<path>   GET seo/…, seo/resolve/<path>/
    cms:blog / cms:blog:<slug> GET blog/…
    cms:pages / cms:page:<path> GET content/pages/…
    cms:redirects          the redirect list (middleware)

On every write the backend POSTs {"tags": [...]} to FRONTEND_REVALIDATE_URL,
signed with REVALIDATE_SECRET:

    X-CMS-Timestamp: <unix seconds>
    X-CMS-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">

so saves made anywhere — the inline editor, Django admin, scripts — reach
visitors immediately, and the browser never needs a credential the frontend
server can verify. Disabled when FRONTEND_REVALIDATE_URL is empty. Delivery is
best-effort, after the transaction commits, off the request thread.
"""

import hashlib
import hmac
import json
import logging
import threading
import time
import urllib.request

from django.conf import settings
from django.db import transaction
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

logger = logging.getLogger(__name__)

# Tags from committed transactions, coalesced into one webhook call per
# short burst (paste-to-build can touch dozens of rows in one request).
_queue = set()
_lock = threading.Lock()
_timer = None
DEBOUNCE_SECONDS = 0.3


def sign(body: bytes, timestamp: str, secret: str) -> str:
    digest = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def _deliver(tags):
    url = getattr(settings, "FRONTEND_REVALIDATE_URL", "")
    secret = getattr(settings, "REVALIDATE_SECRET", "")
    if not url or not secret:
        return
    body = json.dumps({"tags": sorted(tags)}).encode()
    timestamp = str(int(time.time()))
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-CMS-Timestamp": timestamp,
            "X-CMS-Signature": sign(body, timestamp, secret),
        },
    )
    try:
        urllib.request.urlopen(request, timeout=5).close()
    except Exception as exc:  # never let cache refresh break a save
        logger.warning("CMS revalidation webhook failed: %s", exc)


def _flush():
    global _timer
    with _lock:
        tags = set(_queue)
        _queue.clear()
        _timer = None
    if tags:
        _deliver(tags)


def _enqueue(tags):
    global _timer
    with _lock:
        _queue.update(tags)
        if _timer is None:
            _timer = threading.Timer(DEBOUNCE_SECONDS, _flush)
            _timer.daemon = True
            _timer.start()


def notify(*tags):
    """Queue tags for delivery once the current transaction commits (a rolled
    back transaction never notifies). Calls within ~0.3s are coalesced."""
    if not getattr(settings, "FRONTEND_REVALIDATE_URL", ""):
        return
    transaction.on_commit(lambda: _enqueue(tags))


# --------------------------------------------------------------- tag mapping

def _host_tags(host):
    from .models import BlogPost, ContentPage
    if isinstance(host, BlogPost):
        return ["cms:blog", f"cms:blog:{host.slug}", f"cms:seo:blog/{host.slug}"]
    if isinstance(host, ContentPage):
        return ["cms:pages", f"cms:page:{host.path}", f"cms:seo:{host.seo_path or host.path}"]
    return []


def tags_for(instance):
    from . import models as m
    if isinstance(instance, m.ComponentData):
        # Forms feed the tracking config (form pages, options → intents).
        return [f"cms:home:{instance.name}"] + (["cms:tracking"] if instance.name.startswith("form-") else [])
    if isinstance(instance, m.SiteSettings):
        return ["cms", "cms:settings"]
    if isinstance(instance, m.PageSEO):
        return ["cms:seo", f"cms:seo:{instance.path}"]
    if isinstance(instance, (m.BlogPost, m.ContentPage)):
        return _host_tags(instance)
    if isinstance(instance, m.DynamicSection):
        host = instance.host
        return _host_tags(host) if host is not None else []
    if isinstance(instance, m.SectionMedia):
        # Deleting a page cascades: its sections may already be gone when
        # their media's post_delete fires. The page's own signal covers it.
        try:
            section = instance.section
        except m.DynamicSection.DoesNotExist:
            return []
        host = getattr(section, "host", None)
        return _host_tags(host) if host is not None else []
    if isinstance(instance, m.Redirect):
        return ["cms:redirects"]
    return []


def _on_change(sender, instance, **kwargs):
    from . import models as m
    from .seo_resolve import bump_cache_version
    # Backend resolver caches must not outlive a write, webhook or not.
    # Sections feed structured data (FAQPage, Service), so they count too.
    if isinstance(instance, (m.PageSEO, m.SiteSettings, m.BlogPost, m.ContentPage, m.DynamicSection)):
        bump_cache_version("seo")
    if isinstance(instance, m.Redirect):
        bump_cache_version("redirects")
    if isinstance(instance, m.ComponentData) and instance.name.startswith("form-"):
        bump_cache_version("tracking")  # forms feed the tracking plan's facts
    tags = tags_for(instance)
    if tags:
        notify(*tags)
    # Content changed: re-check tracking triggers against the site (R31, debounced).
    if isinstance(instance, (m.ComponentData, m.ContentPage, m.DynamicSection, m.BlogPost)):
        from .tracking_verify import after_publish
        transaction.on_commit(after_publish)


def connect():
    from . import models as m
    for model in (m.ComponentData, m.SiteSettings, m.PageSEO, m.BlogPost, m.ContentPage,
                  m.DynamicSection, m.SectionMedia, m.Redirect):
        receiver(post_save, sender=model, dispatch_uid=f"cms-revalidate-save-{model.__name__}")(_on_change)
        receiver(post_delete, sender=model, dispatch_uid=f"cms-revalidate-delete-{model.__name__}")(_on_change)
