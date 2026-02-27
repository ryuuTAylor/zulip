from datetime import datetime, time, timedelta, timezone

from zerver.models.recurring_scheduled_messages import RecurringScheduledMessage

UTC = timezone.utc


def compute_next_delivery(
    recurrence_type: str,
    recurrence_days: list[int],
    scheduled_time: time,
    after: datetime,
) -> datetime:
    """Return the next UTC-aware datetime when a recurring scheduled message
    should be delivered.

    Parameters
    ----------
    recurrence_type:
        One of RecurringScheduledMessage.DAILY, WEEKLY, or SPECIFIC_DAYS.
        ONE_TIME is not valid — one-time jobs are never rescheduled.
    recurrence_days:
        Weekday integers (0 = Monday … 6 = Sunday).
        Required for WEEKLY and SPECIFIC_DAYS; ignored for DAILY.
    scheduled_time:
        UTC time of day to send.
    after:
        UTC-aware datetime. The returned datetime is strictly after this.
    """
    if recurrence_type == RecurringScheduledMessage.ONE_TIME:
        raise ValueError(
            "compute_next_delivery called for a one_time job; "
            "one-time jobs are not rescheduled after delivery."
        )

    if recurrence_type == RecurringScheduledMessage.DAILY:
        # Try today first; if the time has already passed, use tomorrow.
        candidate = datetime.combine(after.date(), scheduled_time, tzinfo=UTC)
        if candidate <= after:
            candidate += timedelta(days=1)
        return candidate

    # WEEKLY or SPECIFIC_DAYS: find the next matching weekday.
    if not recurrence_days:
        raise ValueError(
            "recurrence_days must not be empty for weekly or specific_days jobs."
        )

    recurrence_day_set = set(recurrence_days)

    # Check today through 7 days ahead (inclusive) to handle the case where
    # today is a matching day but the time has already passed — the next
    # occurrence is then exactly one week away.
    for days_ahead in range(0, 8):
        candidate_date = after.date() + timedelta(days=days_ahead)
        if candidate_date.weekday() in recurrence_day_set:
            candidate = datetime.combine(candidate_date, scheduled_time, tzinfo=UTC)
            if candidate > after:
                return candidate

    # Unreachable with a valid non-empty recurrence_days list.
    raise ValueError(  # nocoverage
        f"Could not compute next delivery for recurrence_days={recurrence_days}"
    )
