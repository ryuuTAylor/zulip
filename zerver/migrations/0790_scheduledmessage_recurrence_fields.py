from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0789_merge_20260323_2256"),
    ]

    operations = [
        migrations.AddField(
            model_name="scheduledmessage",
            name="recurrence_type",
            field=models.CharField(
                choices=[
                    ("daily", "Daily"),
                    ("weekly", "Weekly"),
                    ("specific_days", "Specific days"),
                    ("monthly", "Monthly"),
                ],
                max_length=20,
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="scheduledmessage",
            name="recurrence_days",
            field=models.JSONField(null=True),
        ),
        migrations.AddField(
            model_name="scheduledmessage",
            name="scheduled_time",
            field=models.TimeField(null=True),
        ),
        migrations.AddField(
            model_name="scheduledmessage",
            name="timezone",
            field=models.CharField(max_length=100, null=True),
        ),
        migrations.AddField(
            model_name="scheduledmessage",
            name="next_delivery",
            field=models.DateTimeField(null=True),
        ),
        # Backfill next_delivery from scheduled_timestamp so existing
        # one-time rows are immediately queryable via the new index
        # that Commit 2 of the unification work will use.
        migrations.RunSQL(
            sql=(
                "UPDATE zerver_scheduledmessage "
                "SET next_delivery = scheduled_timestamp "
                "WHERE next_delivery IS NULL;"
            ),
            reverse_sql=migrations.RunSQL.noop,
            elidable=True,
        ),
        migrations.AddIndex(
            model_name="scheduledmessage",
            index=models.Index(
                condition=models.Q(("delivered", False), ("failed", False)),
                fields=["next_delivery"],
                name="zerver_scheduled_messages_by_next_delivery",
            ),
        ),
    ]
