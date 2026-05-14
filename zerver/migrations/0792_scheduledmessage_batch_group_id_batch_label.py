from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0791_merge_recurring_scheduled_messages"),
    ]

    operations = [
        migrations.AddField(
            model_name="scheduledmessage",
            name="batch_group_id",
            field=models.UUIDField(db_index=True, default=None, null=True),
        ),
        migrations.AddField(
            model_name="scheduledmessage",
            name="batch_label",
            field=models.TextField(blank=True, default=None, null=True),
        ),
    ]
