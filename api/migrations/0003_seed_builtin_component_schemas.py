from django.db import migrations

from api.builtin_schemas import sync_builtin_schemas


def forwards(apps, schema_editor):
    sync_builtin_schemas(apps.get_model("api", "ComponentSchema"))


def backwards(apps, schema_editor):
    apps.get_model("api", "ComponentSchema").objects.filter(builtin=True).delete()


class Migration(migrations.Migration):
    dependencies = [("api", "0002_componentschema_componentdata_draft_data_and_more")]
    operations = [migrations.RunPython(forwards, backwards)]
