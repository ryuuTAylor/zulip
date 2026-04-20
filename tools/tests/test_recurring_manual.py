"""Manual integration test for the recurring scheduled messages feature.

Run inside the Vagrant dev environment against the dev database:

    cd /srv/zulip
    ./.venv/bin/python manage.py shell < tools/tests/test_recurring_manual.py

This script tests the full lifecycle of recurring scheduled messages:
creation (all recurrence types), listing, cancellation, and delivery.
Unlike the automated Django tests, this runs against the live dev DB
and verifies real message delivery.
"""

import time as time_module
from datetime import datetime, time, timedelta, timezone

from django.utils.timezone import now as timezone_now

from zerver.actions.recurring_scheduled_messages import (
    do_cancel_recurring_scheduled_message,
    do_create_recurring_scheduled_message,
    do_deliver_recurring_scheduled_message,
    do_get_recurring_scheduled_messages,
)
from zerver.lib.test_helpers import most_recent_message
from zerver.models import UserProfile
from zerver.models.recurring_scheduled_messages import RecurringScheduledMessage
from zerver.models.streams import get_stream

user = UserProfile.objects.get(delivery_email="iago@zulip.com")
stream = get_stream("Verona", user.realm)
hamlet = UserProfile.objects.get(delivery_email="hamlet@zulip.com")

passed = 0
failed = 0


def report(name: str, success: bool, detail: str = "") -> None:
    global passed, failed
    status = "PASS" if success else "FAIL"
    if success:
        passed += 1
    else:
        failed += 1
    print(f"  [{status}] {name}")
    if detail:
        print(f"         {detail}")


print("=" * 60)
print("RECURRING SCHEDULED MESSAGES — MANUAL INTEGRATION TESTS")
print("=" * 60)

# Test 1: Create daily recurring message (stream)
print("\nTest 1: Create daily recurring message (stream)")
job1 = do_create_recurring_scheduled_message(
    sender=user,
    content="Daily standup reminder",
    destinations=[{"type": "stream", "stream_id": stream.id, "topic": "standup"}],
    recurrence_type=RecurringScheduledMessage.DAILY,
    recurrence_days=[],
    scheduled_time=time(9, 0),
)
report("Job created", job1.id is not None, f"ID={job1.id}")
report("Type is daily", job1.recurrence_type == "daily")
report("Job is active", job1.is_active)
report("next_delivery is set", job1.next_delivery is not None, str(job1.next_delivery))

# Test 2: Create weekly recurring message (stream)
print("\nTest 2: Create weekly recurring message (stream)")
job2 = do_create_recurring_scheduled_message(
    sender=user,
    content="Weekly team sync",
    destinations=[{"type": "stream", "stream_id": stream.id, "topic": "weekly"}],
    recurrence_type=RecurringScheduledMessage.WEEKLY,
    recurrence_days=[0],  # Monday
    scheduled_time=time(14, 0),
)
report("Job created", job2.id is not None, f"ID={job2.id}")
report("Type is weekly", job2.recurrence_type == "weekly")
report("Recurrence days correct", job2.recurrence_days == [0])

# Test 3: Create monthly recurring message (calendar day)
print("\nTest 3: Create monthly recurring message (calendar day)")
job3 = do_create_recurring_scheduled_message(
    sender=user,
    content="Monthly report due",
    destinations=[{"type": "stream", "stream_id": stream.id, "topic": "reports"}],
    recurrence_type=RecurringScheduledMessage.MONTHLY,
    recurrence_days={"type": "calendar_day", "day": 15},
    scheduled_time=time(10, 0),
)
report("Job created", job3.id is not None, f"ID={job3.id}")
report("Type is monthly", job3.recurrence_type == "monthly")
report("Recurrence days is dict", isinstance(job3.recurrence_days, dict))
report(
    "Next delivery is 15th of a month",
    job3.next_delivery.day == 15,
    str(job3.next_delivery),
)

# Test 4: Create monthly recurring message (ordinal weekday)
print("\nTest 4: Create monthly recurring message (first Monday)")
job4 = do_create_recurring_scheduled_message(
    sender=user,
    content="First Monday all-hands",
    destinations=[{"type": "stream", "stream_id": stream.id, "topic": "all-hands"}],
    recurrence_type=RecurringScheduledMessage.MONTHLY,
    recurrence_days={"type": "ordinal_weekday", "ordinal": 1, "weekday": 0},
    scheduled_time=time(9, 30),
)
report("Job created", job4.id is not None, f"ID={job4.id}")
report(
    "Next delivery is a Monday",
    job4.next_delivery.weekday() == 0,
    f"weekday={job4.next_delivery.weekday()} (0=Mon), date={job4.next_delivery}",
)

# Test 5: Create one-time scheduled DM
print("\nTest 5: Create one-time scheduled direct message")
deliver_at = timezone_now() + timedelta(hours=1)
job5 = do_create_recurring_scheduled_message(
    sender=user,
    content="Hey, reminder about the meeting!",
    destinations=[{"type": "direct", "user_ids": [user.id, hamlet.id]}],
    recurrence_type=RecurringScheduledMessage.ONE_TIME,
    recurrence_days=[],
    scheduled_time=time(12, 0),
    deliver_at=deliver_at,
)
report("Job created", job5.id is not None, f"ID={job5.id}")
report("Type is one_time", job5.recurrence_type == "one_time")

# Test 6: List all active jobs
print("\nTest 6: List all active jobs")
jobs = do_get_recurring_scheduled_messages(user)
report("Returns list", isinstance(jobs, list))
report("All 5 jobs present", len(jobs) == 5, f"count={len(jobs)}")

# Test 7: Cancel a job
print("\nTest 7: Cancel weekly job")
do_cancel_recurring_scheduled_message(job2.id, user)
job2.refresh_from_db()
report("Job deactivated", not job2.is_active)
jobs_after = do_get_recurring_scheduled_messages(user)
report("Job removed from list", len(jobs_after) == 4, f"count={len(jobs_after)}")

# Test 8: Deliver a daily message and verify
print("\nTest 8: Deliver daily job and verify message sent")
job1.next_delivery = timezone_now() - timedelta(seconds=1)
job1.save(update_fields=["next_delivery"])
msg_count_before = user.realm.message_set.count()
do_deliver_recurring_scheduled_message(job1)
msg_count_after = user.realm.message_set.count()
job1.refresh_from_db()
msg = most_recent_message(user)
report("Message count increased", msg_count_after > msg_count_before)
report("Message content correct", msg.content == "Daily standup reminder")
report("Job still active", job1.is_active)
report("next_delivery advanced", job1.next_delivery > timezone_now() - timedelta(seconds=10))

# Test 9: Deliver one-time job and verify deactivation
print("\nTest 9: Deliver one-time job and verify deactivation")
job5.next_delivery = timezone_now() - timedelta(seconds=1)
job5.save(update_fields=["next_delivery"])
do_deliver_recurring_scheduled_message(job5)
job5.refresh_from_db()
report("Job deactivated after delivery", not job5.is_active)

# Summary
print("\n" + "=" * 60)
print(f"RESULTS: {passed} passed, {failed} failed, {passed + failed} total")
print("=" * 60)
