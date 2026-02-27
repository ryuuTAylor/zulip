from typing import Any

from django.db import models
from django.utils.timezone import now as timezone_now

from zerver.models.realms import Realm
from zerver.models.users import UserProfile


class RecurringScheduledMessage(models.Model):
    ONE_TIME = "one_time"
    DAILY = "daily"
    WEEKLY = "weekly"
    SPECIFIC_DAYS = "specific_days"

    RECURRENCE_TYPES = [
        (ONE_TIME, "One time"),
        (DAILY, "Daily"),
        (WEEKLY, "Weekly"),
        (SPECIFIC_DAYS, "Specific days"),
    ]

    sender = models.ForeignKey(UserProfile, on_delete=models.CASCADE)
    realm = models.ForeignKey(Realm, on_delete=models.CASCADE)
    content = models.TextField()

    # JSON list of destinations. Each entry is one of:
    #   {"type": "stream", "stream_id": <int>, "topic": <str>}
    #   {"type": "direct", "user_ids": [<int>, ...]}
    destinations = models.JSONField()

    recurrence_type = models.CharField(
        max_length=20,
        choices=RECURRENCE_TYPES,
        default=ONE_TIME,
    )

    # List of weekday integers (0=Monday … 6=Sunday).
    # Used when recurrence_type is WEEKLY or SPECIFIC_DAYS.
    # Empty list for ONE_TIME and DAILY.
    recurrence_days = models.JSONField(default=list)

    # Time of day to send, stored in UTC.
    scheduled_time = models.TimeField()

    # Next UTC datetime the worker should fire this job.
    # Indexed for efficient worker queries.
    next_delivery = models.DateTimeField(db_index=True)

    is_active = models.BooleanField(default=True)
    date_created = models.DateTimeField(default=timezone_now)

    class Meta:
        indexes = [
            models.Index(
                name="zerver_active_recurring_by_time",
                fields=["next_delivery"],
                condition=models.Q(is_active=True),
            ),
        ]

    def to_api_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "content": self.content,
            "destinations": self.destinations,
            "recurrence_type": self.recurrence_type,
            "recurrence_days": self.recurrence_days,
            "scheduled_time": self.scheduled_time.isoformat(),
            "next_delivery": int(self.next_delivery.timestamp()),
            "is_active": self.is_active,
            "date_created": int(self.date_created.timestamp()),
        }
