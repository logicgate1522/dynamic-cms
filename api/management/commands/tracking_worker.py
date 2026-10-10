"""Background work for tracking (R31–R33):

    ./venv/bin/python manage.py tracking_worker            loop forever (systemd / a container)
    ./venv/bin/python manage.py tracking_worker --once     one pass (cron every minute)

Each pass: deliver due server-side events (retries), run a queued sync,
deliver contact webhooks, and once a day: anomalies, static trigger check,
contact retention purge, nightly sync (drift), clean-up.
Nothing here is required for a site to work; without it, events are sent
once inline and the dashboard's launch check says retries need the worker.
"""

import time

from django.core.cache import cache
from django.core.management.base import BaseCommand
from django.utils import timezone

from api.models import TrackingJob


def heartbeat():
    cache.set("cms-tracking-worker-heartbeat", timezone.now().isoformat(), 24 * 3600)
    TrackingJob.objects.filter(kind="heartbeat").delete()
    TrackingJob.objects.create(kind="heartbeat", status="done", result={"at": timezone.now().isoformat()})


def one_pass(stdout=None):
    from api import contacts, tracking_dispatch, tracking_sync, tracking_verify
    sent = tracking_dispatch.process_due()
    tracking_sync.run_pending_sync()
    tracking_sync.process_audience_removals()
    hooks = 0
    for job in TrackingJob.objects.filter(kind="webhook", status="pending")[:50]:
        try:
            contacts.deliver_webhook(job)
            job.status = "done"
        except Exception as err:
            attempts = int(job.payload.get("attempts", 0)) + 1
            job.payload = {**job.payload, "attempts": attempts}
            job.result = {"error": str(err)[:300]}
            if attempts >= 5:
                job.status = "error"
        job.finished_at = timezone.now()
        job.save()
        hooks += 1
    today = timezone.localdate().isoformat()
    if cache.get("cms-tracking-nightly") != today:
        last = TrackingJob.objects.filter(kind="nightly").order_by("-created_at").first()
        if not last or last.created_at.date().isoformat() != today:
            TrackingJob.objects.create(kind="nightly", status="done")
            tracking_verify.nightly()
            contacts.purge_expired()
            tracking_sync.queue_sync(reason="nightly")
            tracking_sync.run_pending_sync()
        cache.set("cms-tracking-nightly", today, 26 * 3600)
    heartbeat()
    if stdout:
        stdout.write(f"tracking_worker: sent={sent} webhooks={hooks}")


class Command(BaseCommand):
    help = "Deliver tracking events, sync tools, send webhooks, run nightly checks."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")
        parser.add_argument("--interval", type=int, default=30)

    def handle(self, *args, once=False, interval=30, **kw):
        if once:
            one_pass(self.stdout)
            return
        while True:
            try:
                one_pass()
            except Exception as err:  # keep looping; the next pass retries
                self.stderr.write(f"tracking_worker: {err}")
            time.sleep(max(5, interval))
