from django.db import migrations
from django.db.backends.base.schema import BaseDatabaseSchemaEditor
from django.db.migrations.state import StateApps


def migrate_recurring_scheduled_messages(
    apps: StateApps, schema_editor: BaseDatabaseSchemaEditor
) -> None:
    from zerver.lib.markdown import markdown_convert
    from zerver.lib.recipient_users import recipient_for_user_profiles
    from zerver.models import Client, Message, ScheduledMessage, Stream, UserProfile

    RecurringScheduledMessage = apps.get_model("zerver", "RecurringScheduledMessage")

    sending_client, _ = Client.objects.get_or_create(name="ZulipServer")

    for old_job in RecurringScheduledMessage.objects.order_by("id").iterator():
        sender = UserProfile.objects.select_related("realm").get(id=old_job.sender_id)
        rendered_content = markdown_convert(
            old_job.content,
            message_realm=sender.realm,
        ).rendered_content

        recurrence_type = old_job.recurrence_type
        if recurrence_type == "one_time":
            recurrence_type = None
            recurrence_days = None
            scheduled_time = None
        else:
            recurrence_days = old_job.recurrence_days
            scheduled_time = old_job.scheduled_time

        for destination in old_job.destinations:
            if destination["type"] == "stream":
                stream = Stream.objects.select_related("recipient").get(id=destination["stream_id"])
                recipient = stream.recipient
                assert recipient is not None
                topic_name = destination["topic"]
            else:
                user_ids = destination["user_ids"]
                user_profiles = list(UserProfile.objects.filter(id__in=user_ids))
                if len(user_profiles) != len(set(user_ids)):
                    raise RuntimeError(
                        f"Could not migrate recurring scheduled message {old_job.id}: "
                        f"missing direct message recipients"
                    )
                recipient = recipient_for_user_profiles(
                    user_profiles,
                    forwarded_mirror_message=False,
                    forwarder_user_profile=None,
                    sender=sender,
                    allow_deactivated=True,
                )
                stream = None
                topic_name = Message.DM_TOPIC

            ScheduledMessage.objects.create(
                sender=sender,
                recipient_id=recipient.id,
                subject=topic_name,
                content=old_job.content,
                rendered_content=rendered_content,
                sending_client=sending_client,
                stream=stream,
                realm=sender.realm,
                scheduled_timestamp=old_job.next_delivery,
                read_by_sender=False,
                delivered=False,
                has_attachment=False,
                request_timestamp=old_job.date_created,
                failed=False,
                delivery_type=ScheduledMessage.SEND_LATER,
                recurrence_type=recurrence_type,
                recurrence_days=recurrence_days,
                scheduled_time=scheduled_time,
                timezone=None,
                next_delivery=old_job.next_delivery,
            )


class Migration(migrations.Migration):
    dependencies = [
        ("zerver", "0790_scheduledmessage_recurrence_fields"),
    ]

    operations = [
        migrations.RunPython(
            migrate_recurring_scheduled_messages,
            reverse_code=migrations.RunPython.noop,
            elidable=True,
        ),
        migrations.DeleteModel(
            name="RecurringScheduledMessage",
        ),
    ]
