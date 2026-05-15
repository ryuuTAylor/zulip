import calendar
import zoneinfo
from datetime import date, datetime, time, timedelta, timezone, tzinfo

from django.utils.translation import gettext as _

from zerver.lib.exceptions import ResourceNotFoundError
from zerver.lib.timezone import canonicalize_timezone
from zerver.models import ScheduledMessage, UserProfile
from zerver.models.scheduled_jobs import (
    APIReminderDirectMessageDict,
    APIScheduledDirectMessageDict,
    APIScheduledStreamMessageDict,
)

UTC = timezone.utc


def _resolve_tz(tz_name: str | None) -> tzinfo:
    """Return a tzinfo for tz_name (an IANA name); None means UTC.

    Recurrence math is done in the user's wall-clock timezone so that
    "every day at 9 AM" stays at 9 AM local time across DST shifts, and
    weekday-based rules use the local calendar day.
    """
    if tz_name is None:
        return UTC
    try:
        return zoneinfo.ZoneInfo(canonicalize_timezone(tz_name))
    except zoneinfo.ZoneInfoNotFoundError:
        return UTC

# Type alias used in the recurrence helpers below. recurrence_days is
# list[int] for weekly/specific_days jobs and a dict for monthly jobs;
# the str | int union covers every value that appears in either shape.
RecurrenceDays = list[int] | dict[str, str | int]


def parse_scheduled_time(scheduled_time_str: str) -> time:
    """Parse a wall-clock "HH:MM" string into a time object.

    The string is interpreted in the timezone stored alongside the
    scheduled message (UTC if NULL), not in UTC unconditionally.
    """
    try:
        parts = scheduled_time_str.split(":")
        if len(parts) != 2:
            raise ValueError
        hour, minute = int(parts[0]), int(parts[1])
        return time(hour, minute)
    except (ValueError, AttributeError) as e:
        raise ValueError("Invalid scheduled_time format. Expected HH:MM.") from e


def validate_recurrence_days(recurrence_days: RecurrenceDays, recurrence_type: str) -> None:
    """Raise ValueError if recurrence_days is invalid for recurrence_type."""
    if recurrence_type == ScheduledMessage.DAILY:
        if recurrence_days:
            raise ValueError("recurrence_days must be empty for daily recurrence type.")
        return

    if recurrence_type in (ScheduledMessage.WEEKLY, ScheduledMessage.SPECIFIC_DAYS):
        if not isinstance(recurrence_days, list) or not recurrence_days:
            raise ValueError(
                "recurrence_days is required for weekly and specific_days recurrence types."
            )
        if not all(isinstance(day, int) and 0 <= day <= 6 for day in recurrence_days):
            raise ValueError("recurrence_days must be integers between 0 (Monday) and 6 (Sunday).")
        return

    if recurrence_type == ScheduledMessage.MONTHLY:
        validate_monthly_rule(recurrence_days)
        return

    raise ValueError(f"Unknown recurrence_type {recurrence_type!r}.")


def access_scheduled_message(
    user_profile: UserProfile, scheduled_message_id: int
) -> ScheduledMessage:
    try:
        return ScheduledMessage.objects.get(
            id=scheduled_message_id, sender=user_profile, delivery_type=ScheduledMessage.SEND_LATER
        )
    except ScheduledMessage.DoesNotExist:
        raise ResourceNotFoundError(_("Scheduled message does not exist"))


def get_undelivered_scheduled_messages(
    user_profile: UserProfile,
) -> list[APIScheduledDirectMessageDict | APIScheduledStreamMessageDict]:
    scheduled_messages = ScheduledMessage.objects.filter(
        realm_id=user_profile.realm_id,
        sender=user_profile,
        # Notably, we don't require failed=False, since we will want
        # to display those to users.
        delivered=False,
        delivery_type=ScheduledMessage.SEND_LATER,
    ).order_by("scheduled_timestamp")
    scheduled_message_dicts: list[APIScheduledDirectMessageDict | APIScheduledStreamMessageDict] = [
        scheduled_message.to_dict() for scheduled_message in scheduled_messages
    ]
    return scheduled_message_dicts


def get_undelivered_reminders(
    user_profile: UserProfile,
) -> list[APIReminderDirectMessageDict]:
    reminders = ScheduledMessage.objects.filter(
        realm_id=user_profile.realm_id,
        sender=user_profile,
        # Notably, we don't require failed=False, since we will want
        # to display those to users.
        delivered=False,
        delivery_type=ScheduledMessage.REMIND,
    ).order_by("scheduled_timestamp")
    reminder_dicts: list[APIReminderDirectMessageDict] = [
        reminder.to_reminder_dict() for reminder in reminders
    ]
    return reminder_dicts


# Recurrence helpers. A scheduled message with recurrence_type == NULL is a
# one-time job and never reaches the code below; only recurring jobs call
# compute_next_delivery after each send to determine when to fire next.


def _next_calendar_day_monthly(
    day: int,
    scheduled_time: time,
    after: datetime,
    tz: tzinfo,
) -> datetime:
    """Return the next monthly delivery for a calendar-day rule.

    day=-1 means the last day of the month; day=1..31 means that
    calendar day, clamped to the last day of shorter months. The month
    boundary and wall-clock time are evaluated in tz; the returned
    datetime is UTC.
    """
    after_local = after.astimezone(tz)
    year, month = after_local.year, after_local.month

    # At most 13 iterations: worst case is the current month already
    # passed, so we need to check the next 12 months.
    for _month_offset in range(13):
        days_in_month = calendar.monthrange(year, month)[1]
        actual_day = days_in_month if day == -1 else min(day, days_in_month)
        candidate = datetime.combine(
            date(year, month, actual_day), scheduled_time, tzinfo=tz
        ).astimezone(UTC)
        if candidate > after:
            return candidate
        month += 1
        if month > 12:
            year, month = year + 1, 1

    raise ValueError(  # nocoverage
        f"Could not compute next monthly delivery for calendar_day rule (day={day})"
    )


def _next_ordinal_weekday_monthly(
    ordinal: int,
    weekday: int,
    scheduled_time: time,
    after: datetime,
    tz: tzinfo,
) -> datetime:
    """Return the next monthly delivery for an ordinal-weekday rule.

    ordinal=1..4 selects the nth occurrence; ordinal=-1 selects the last.
    weekday follows Python convention (0=Monday … 6=Sunday). The month
    and weekday are evaluated in tz; the returned datetime is UTC.

    If ordinal=4 and a particular month only has three such weekdays,
    that month is skipped and the rule fires in the next qualifying month.
    """
    after_local = after.astimezone(tz)
    year, month = after_local.year, after_local.month

    for _month_offset in range(13):
        days_in_month = calendar.monthrange(year, month)[1]

        if ordinal > 0:
            first_day = date(year, month, 1)
            days_until = (weekday - first_day.weekday()) % 7
            target_day = 1 + days_until + (ordinal - 1) * 7
        else:
            # ordinal == -1: last occurrence of the weekday in the month.
            last_day = date(year, month, days_in_month)
            days_back = (last_day.weekday() - weekday) % 7
            target_day = days_in_month - days_back

        if 1 <= target_day <= days_in_month:
            candidate = datetime.combine(
                date(year, month, target_day), scheduled_time, tzinfo=tz
            ).astimezone(UTC)
            if candidate > after:
                return candidate

        month += 1
        if month > 12:
            year, month = year + 1, 1

    raise ValueError(  # nocoverage
        f"Could not compute next monthly delivery for ordinal_weekday rule "
        f"(ordinal={ordinal}, weekday={weekday})"
    )


def validate_monthly_rule(rule: object) -> None:
    """Raise ValueError if rule is not a well-formed monthly recurrence dict.

    Call this from the view layer before creating or updating a monthly job.
    """
    if not isinstance(rule, dict):
        raise ValueError("monthly recurrence_days must be a dict.")

    rule_type = rule.get("type")

    if rule_type == "calendar_day":
        day = rule.get("day")
        if not isinstance(day, int) or not (day == -1 or 1 <= day <= 31):
            raise ValueError(
                "calendar_day rule requires 'day' as an integer 1–31 or -1 for last day."
            )

    elif rule_type == "ordinal_weekday":
        ordinal = rule.get("ordinal")
        weekday = rule.get("weekday")
        if not isinstance(ordinal, int) or not (ordinal == -1 or 1 <= ordinal <= 4):
            raise ValueError("ordinal_weekday rule requires 'ordinal' as 1–4 or -1 for last.")
        if not isinstance(weekday, int) or not 0 <= weekday <= 6:
            raise ValueError(
                "ordinal_weekday rule requires 'weekday' as an integer 0 (Monday) – 6 (Sunday)."
            )

    else:
        raise ValueError(
            f"monthly recurrence_days must have type 'calendar_day' or 'ordinal_weekday', "
            f"got {rule_type!r}."
        )


def compute_next_delivery(
    recurrence_type: str,
    recurrence_days: RecurrenceDays,
    scheduled_time: time,
    after: datetime,
    tz_name: str | None = None,
) -> datetime:
    """Return the next UTC-aware datetime when a recurring scheduled message
    should be delivered.

    Parameters
    ----------
    recurrence_type:
        One of ScheduledMessage.DAILY, WEEKLY, SPECIFIC_DAYS, or MONTHLY.
        One-time jobs (recurrence_type == NULL) must not call this function.
    recurrence_days:
        Interpretation varies by recurrence_type; see the
        ScheduledMessage.recurrence_days field comment for the full contract.
    scheduled_time:
        Wall-clock time of day in tz_name to send (UTC if tz_name is None).
    after:
        UTC-aware datetime. The returned datetime is strictly after this.
    tz_name:
        IANA timezone name; the wall-clock time and calendar/weekday
        boundaries are interpreted in this zone so that DST shifts do
        not move the firing time and weekday rules use the local day.
        None means UTC.
    """
    tz = _resolve_tz(tz_name)

    if recurrence_type == ScheduledMessage.DAILY:
        # Try today first; if the time has already passed, use tomorrow.
        # The +1 day must be added to the local date — not the UTC datetime —
        # so DST transitions don't shift the wall-clock send time.
        after_local = after.astimezone(tz)
        candidate = datetime.combine(after_local.date(), scheduled_time, tzinfo=tz).astimezone(UTC)
        if candidate <= after:
            candidate = datetime.combine(
                after_local.date() + timedelta(days=1), scheduled_time, tzinfo=tz
            ).astimezone(UTC)
        return candidate

    if recurrence_type == ScheduledMessage.MONTHLY:
        if not isinstance(recurrence_days, dict):
            raise ValueError("monthly recurrence_days must be a dict.")
        rule_type = recurrence_days.get("type")
        if rule_type == "calendar_day":
            return _next_calendar_day_monthly(
                int(recurrence_days["day"]), scheduled_time, after, tz
            )
        if rule_type == "ordinal_weekday":
            return _next_ordinal_weekday_monthly(
                int(recurrence_days["ordinal"]),
                int(recurrence_days["weekday"]),
                scheduled_time,
                after,
                tz,
            )
        raise ValueError(
            f"monthly recurrence_days must have type 'calendar_day' or 'ordinal_weekday', "
            f"got {rule_type!r}."
        )

    # WEEKLY or SPECIFIC_DAYS: find the next matching weekday in tz.
    if not isinstance(recurrence_days, list) or not recurrence_days:
        raise ValueError("recurrence_days must not be empty for weekly or specific_days jobs.")

    recurrence_day_set = set(recurrence_days)

    # Check today through 7 days ahead (inclusive) to handle the case where
    # today is a matching day but the time has already passed — the next
    # occurrence is then exactly one week away.
    after_local = after.astimezone(tz)
    for days_ahead in range(8):
        candidate_date = after_local.date() + timedelta(days=days_ahead)
        if candidate_date.weekday() in recurrence_day_set:
            candidate = datetime.combine(
                candidate_date, scheduled_time, tzinfo=tz
            ).astimezone(UTC)
            if candidate > after:
                return candidate

    # Unreachable with a valid non-empty recurrence_days list.
    raise ValueError(  # nocoverage
        f"Could not compute next delivery for recurrence_days={recurrence_days}"
    )
