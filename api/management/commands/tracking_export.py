"""Save the site's tracking plan and the scan it was built on as a fixture the seed script installs on any
fresh environment (scripts/tracking-seed.mjs import), so the conversions set up during integration exist
from day one and the owner only adjusts them.

    python manage.py tracking_export ../frontend/scripts/tracking-seed.json
"""
import json

from django.core.management.base import BaseCommand, CommandError

from api import tracking_plan as tp
from api.models import TrackingScan


class Command(BaseCommand):
    help = "Write the approved tracking plan + site scan to a JSON fixture."

    def add_arguments(self, parser):
        parser.add_argument("path")

    def handle(self, *args, path, **options):
        plan = tp.get_plan()
        scan = TrackingScan.objects.filter(pk=1).first()
        if not plan.get("conversions") or scan is None:
            raise CommandError("No plan and scan to export: scan the site and approve a plan first (Admin -> Tracking).")
        pages = []
        for page in (scan.data or {}).get("pages") or []:
            # The link audit's text and links are re-collected by the next real scan; the plan only needs the rest.
            pages.append({k: v for k, v in page.items() if k not in ("text", "links")})
        plan = {k: v for k, v in plan.items() if k not in ("status", "version", "facts")}
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"plan": plan, "scan": {"pages": pages}}, handle, ensure_ascii=False, separators=(",", ":"))
        self.stdout.write(f"Wrote {len(plan.get('conversions') or [])} conversions and {len(pages)} scanned pages to {path}")
