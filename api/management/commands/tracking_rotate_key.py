"""Re-encrypt stored tool credentials with a new TRACKING_SECRET_KEY.

1. Set TRACKING_SECRET_KEY=<new> and TRACKING_SECRET_KEY_OLD=<old>.
2. ./venv/bin/python manage.py tracking_rotate_key
3. Remove TRACKING_SECRET_KEY_OLD.
"""

from django.core.management.base import BaseCommand

from api.crypto import decrypt, encrypt
from api.models import TrackingConnection


class Command(BaseCommand):
    help = "Re-encrypt tracking connection secrets with the current key."

    def handle(self, *args, **kw):
        n = 0
        for row in TrackingConnection.objects.exclude(secret=""):
            row.secret = encrypt(decrypt(row.secret))
            row.save(update_fields=["secret"])
            n += 1
        self.stdout.write(f"re-encrypted {n} connection(s)")
