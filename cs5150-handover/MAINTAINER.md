# Maintainer Manual — Recurring & Batch Scheduled Messages

**Project:** Recurring and batch scheduled messaging for Zulip
**Course:** Cornell CS 5150, Spring 2026
**Repository:** `https://github.com/ryuuTAylor/zulip` (fork of `zulip/zulip`)
**Trunk branch:** `main`

This manual documents the design, implementation, testing, and operation
of the recurring/batch scheduling feature delivered for CS 5150. It is
written for a future maintainer or grader who needs to understand the
system, run its tests, deploy it, and locate the source of each
behavior.

## Contents

1. [Overview](#1-overview)
2. [Requirements & user roles](#2-requirements--user-roles)
3. [Architecture](#3-architecture)
4. [Data model](#4-data-model)
5. [Backend modules](#5-backend-modules)
6. [API endpoints](#6-api-endpoints)
7. [Delivery worker](#7-delivery-worker)
8. [Frontend modules](#8-frontend-modules)
9. [Testing](#9-testing)
10. [Deployment](#10-deployment)
11. [Style guide & developer workflow](#11-style-guide--developer-workflow)
12. [Known issues & future work](#12-known-issues--future-work)
13. [References](#13-references)

---

## 1. Overview

Zulip ships with one-time scheduled messages: a user picks a future
time, writes a message, and the server delivers it once at that time.
This project adds two capabilities to that system, unified into a
single user-facing dialog:

- **Recurrence.** A scheduled message can repeat daily, weekly on
  selected weekdays, on specific days, or monthly (calendar day,
  last day, or _n_-th weekday). After each delivery the worker
  recomputes the next delivery time from the recurrence rule and
  leaves the row active.

- **Batch (multi-destination) delivery.** A single scheduling action
  can produce delivery to multiple channels and direct-message groups
  in one call. Rows sharing a `batch_group_id` are treated as a single
  logical scheduled message by the management and cancel APIs.

Both capabilities are exposed through one frontend dialog (the
"unified scheduled-message modal") and one backend pair of endpoints
(`POST /json/batch_scheduled_messages`, `DELETE
/json/batch_scheduled_messages/<batch_group_id>`). The original
single-message `/json/scheduled_messages` endpoint is unchanged and
continues to serve the legacy popover flow used by other parts of
Zulip.

## 2. Requirements & user roles

### Use cases delivered

1. Schedule a one-time message to a single channel.
2. Schedule a one-time message to one or more direct-message groups.
3. Schedule a recurring (daily / weekly / specific-days / monthly)
   message to a single destination.
4. Schedule a one-time message to multiple destinations
   simultaneously (batch).
5. Schedule a recurring message to multiple destinations (recurring +
   batch combined).
6. View a list of pending scheduled messages, including their
   recurrence pattern and next delivery time.
7. Cancel a scheduled message. For batch jobs, cancellation removes
   every row in the batch group.

### User roles

The feature is available to every authenticated Zulip member. There
are **no administrator-only controls** and no organization-wide
settings that disable or constrain it.

Access control is enforced per row by user scoping:
`access_scheduled_message(user_profile, scheduled_message_id)` in
`zerver/lib/scheduled_messages.py:59` returns the row only if the
caller is the sender. Views call this helper for every mutating
endpoint, so a user cannot read, edit, or cancel another user's
scheduled messages.

For the user-facing description of these use cases, see the help
center article _Schedule a recurring or batch message_ at
`starlight_help/src/content/docs/schedule-a-recurring-or-batch-message.mdx`.

## 3. Architecture

```
                  ┌────────────────────────────────────────┐
  Compose box →   │  Send-later popover                    │
                  │   └─ "Schedule message" menu item      │
                  └────────────────────────────────────────┘
                                   │
                                   ▼
                  ┌────────────────────────────────────────┐
                  │  Unified scheduled-message modal       │
                  │   (unified_scheduled_message_ui.ts)    │
                  │   - message content + saved snippets   │
                  │   - send-at datetime  OR  recurrence   │
                  │     (Repeat checkbox + frequency       │
                  │      + weekday/monthly sub-pattern)    │
                  │   - destinations: N×(channel+topic)    │
                  │                  + N×(DM recipient set)│
                  └────────────────────────────────────────┘
                                   │
                                   ▼  HTTPS, JSON
                  ┌────────────────────────────────────────┐
                  │  POST /json/batch_scheduled_messages   │
                  │   create_batch_scheduled_messages      │
                  │   (zerver/views/scheduled_messages.py) │
                  │   ─ validates destinations             │
                  │   ─ generates batch_group_id (UUID)    │
                  │   ─ calls do_schedule_batch_messages   │
                  └────────────────────────────────────────┘
                                   │
                                   ▼
                  ┌────────────────────────────────────────┐
                  │  do_schedule_batch_messages            │
                  │   (zerver/actions/scheduled_messages.py)│
                  │   ─ one ScheduledMessage row per dest. │
                  │   ─ all share batch_group_id           │
                  │   ─ recurrence fields copied to all    │
                  │   ─ Tornado event: new scheduled msg   │
                  └────────────────────────────────────────┘
                                   │
                                   ▼
                  ┌────────────────────────────────────────┐
                  │  Postgres: zerver_scheduledmessage     │
                  │   ─ batch_group_id UUID (nullable)     │
                  │   ─ recurrence_type, recurrence_days   │
                  │   ─ scheduled_time, next_delivery      │
                  └────────────────────────────────────────┘
                                   │
                                   ▼  every minute
                  ┌────────────────────────────────────────┐
                  │  deliver_scheduled_messages worker     │
                  │   (management/commands/                │
                  │    deliver_scheduled_messages.py)      │
                  │   loop:                                │
                  │    try_deliver_one_scheduled_message() │
                  │      ─ picks oldest row past due       │
                  │      ─ sends via do_send_messages      │
                  │      ─ if recurring:                   │
                  │        next_delivery =                 │
                  │          compute_next_delivery(...)    │
                  │      ─ else: mark delivered            │
                  │   sleep until next minute boundary     │
                  └────────────────────────────────────────┘
```

### Why a single endpoint for batch + recurring

Before unification, recurring scheduling and batch scheduling lived in
two parallel modules (`recurring_scheduled_messages` and
`batch_scheduled_messages`) with separate models, views, actions, and
frontends. Maintaining two near-duplicate scheduling stacks was the
primary technical-debt source of Sprints 2 and 3. PR #6 — the
"unification refactor" — folded both into the existing
`ScheduledMessage` model by adding nullable columns for
`batch_group_id`, `recurrence_type`, `recurrence_days`, and
`scheduled_time`. A row with `recurrence_type IS NULL` and
`batch_group_id IS NULL` behaves exactly like an upstream Zulip
one-time scheduled message; the new fields opt the row into the new
behaviors. This means the codebase has _one_ delivery worker, _one_
authorization story, and _one_ set of tests.

## 4. Data model

The single `ScheduledMessage` table now holds both one-time, recurring,
and batch jobs. Defined at `zerver/models/scheduled_jobs.py:165`.

### Columns added by this project

| Column            | Type                             | Purpose                                                                                                                                                                                                                                                 |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batch_group_id`  | `UUID`, nullable, indexed        | NULL for ordinary scheduled messages. Set when multiple rows were created together as a single batch; all rows in the batch share the same UUID.                                                                                                        |
| `batch_label`     | `TEXT`, nullable                 | Optional human-readable name for the batch.                                                                                                                                                                                                             |
| `recurrence_type` | `VARCHAR(20)`, choices, nullable | `daily`, `weekly`, `specific_days`, or `monthly`. NULL means the row is a one-time scheduled message; the row is deleted after a successful send.                                                                                                       |
| `recurrence_days` | `JSONB`, nullable                | Rule data. Shape depends on `recurrence_type` — see below.                                                                                                                                                                                              |
| `scheduled_time`  | `TIME`, nullable                 | UTC time-of-day for recurring delivery. Combined with `recurrence_days` and the previous `next_delivery` to compute the next firing.                                                                                                                    |
| `next_delivery`   | `DATETIME`, nullable, indexed    | UTC timestamp of the next firing. The worker selects from this column ordered ascending. After a successful recurring send, the action layer rewrites this from the recurrence rule; for one-time jobs the row is marked delivered and not rescheduled. |

The original `scheduled_timestamp` column is retained and is set equal
to `next_delivery` at creation. `scheduled_timestamp` is unindexed for
recurring rows; `next_delivery` is the worker's hot column.

### `recurrence_days` shape

Defined at `zerver/lib/scheduled_messages.py:1-11`:

```python
RecurrenceDays = list[int] | dict[str, str | int]
```

- **`daily`**: `[]` (empty list). The recurrence is implicit.
- **`weekly` / `specific_days`**: list of weekday integers,
  `0` (Monday) through `6` (Sunday). Must be non-empty.
- **`monthly`**: dict with one of two shapes:
  - `{"type": "calendar_day", "day": N}` where `N` is `1..31` or `-1`
    for the last day. Days beyond the month's length are clamped to
    the last day of that month (e.g., `31` becomes `28` in February).
  - `{"type": "ordinal_weekday", "ordinal": O, "weekday": W}` where
    `O ∈ {1, 2, 3, 4, -1}` (`-1` is "last") and `W ∈ {0..6}`
    (Monday=0). Months without an `O`-th occurrence of `W` are
    skipped.

### Migrations

- `zerver/migrations/0783_recurringscheduledmessage.py` — originally
  created the standalone `RecurringScheduledMessage` table. Retained
  in history but no longer references a live model (the table is now
  orphan and could be dropped in a future cleanup migration).
- `zerver/migrations/0790_scheduledmessage_recurrence_fields.py` —
  adds `recurrence_type`, `recurrence_days`, `scheduled_time`,
  `next_delivery` columns to `ScheduledMessage`.
- `zerver/migrations/0791_merge_recurring_scheduled_messages.py` —
  data migration that backfills any pre-existing recurring rows from
  the old table into the unified table.
- `zerver/migrations/0792_scheduledmessage_batch_group_id_batch_label.py` —
  adds `batch_group_id` (indexed UUID) and `batch_label` columns.

## 5. Backend modules

### `zerver/lib/scheduled_messages.py`

Pure functions shared across the action, view, and worker layers. No
DB writes here; everything is either DB read, computation, or
validation.

| Function                             | Line | Purpose                                                                                                                       |
| ------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| `parse_scheduled_time`               | 22   | Convert `"HH:MM"` to a `datetime.time` (UTC).                                                                                 |
| `validate_recurrence_days`           | 34   | Reject malformed `recurrence_days` for a given `recurrence_type`. Raises `ValueError`.                                        |
| `access_scheduled_message`           | 59   | Owner-scoped lookup by id; raises `JsonableError` if not found / not owned.                                                   |
| `get_undelivered_scheduled_messages` | 70   | Query used by `GET /scheduled_messages`.                                                                                      |
| `get_undelivered_reminders`          | 87   | Same shape, but for reminder-type rows.                                                                                       |
| `_next_calendar_day_monthly`         | 109  | Compute next calendar-day fire for a monthly job.                                                                             |
| `_next_ordinal_weekday_monthly`      | 138  | Compute next _n_-th-weekday fire for a monthly job.                                                                           |
| `validate_monthly_rule`              | 184  | Verify a monthly `recurrence_days` dict has a valid shape.                                                                    |
| `compute_next_delivery`              | 220  | Top-level next-fire computation for any recurrence type. Returns a UTC-aware datetime. Raises `ValueError` for invalid input. |

`compute_next_delivery` is the single source of truth for recurrence
math. It is called from both `do_schedule_messages` /
`do_schedule_batch_messages` (to set the initial `next_delivery`) and
from `send_scheduled_message` (to advance after a successful send).

### `zerver/actions/scheduled_messages.py`

Side-effectful operations. Each public action wraps DB writes plus
Tornado event emission.

| Function                            | Line | Purpose                                                                                                                                                                                                           |
| ----------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check_schedule_message`            | 44   | Resolve a single destination + content + time into a `SendMessageRequest` ready for persistence.                                                                                                                  |
| `do_schedule_messages`              | 114  | Persist one or more pre-validated send-requests as `ScheduledMessage` rows. Returns ids. Used by both the legacy `/scheduled_messages` endpoint and the new batch endpoint.                                       |
| `do_schedule_batch_messages`        | 179  | Wrapper that generates a `batch_group_id`, calls `do_schedule_messages` per destination, and stamps the shared UUID + recurrence fields on every resulting row. Emits a single Tornado event for the whole batch. |
| `edit_scheduled_message`            | 268  | One-time edit path (legacy). The unified frontend does not call this — it cancels + recreates instead.                                                                                                            |
| `delete_scheduled_message`          | 397  | Delete a single row by id; owner-scoped.                                                                                                                                                                          |
| `send_reminder`                     | 404  | Deliver a reminder-type row.                                                                                                                                                                                      |
| `send_scheduled_message`            | 431  | Deliver a non-reminder row. For recurring rows, after a successful send this advances `next_delivery` via `compute_next_delivery` instead of marking the row delivered. See lines 486–495.                        |
| `try_deliver_one_scheduled_message` | 540  | Worker entry point — see [§7](#7-delivery-worker).                                                                                                                                                                |

### `zerver/views/scheduled_messages.py`

HTTP layer. All endpoints are authenticated via Zulip's standard
`@typed_endpoint` / `@typed_endpoint_without_parameters` decorators,
which inject `user_profile: UserProfile`. There are no role checks
beyond that.

| Endpoint function                  | Line | Route                                                              |
| ---------------------------------- | ---- | ------------------------------------------------------------------ |
| `fetch_scheduled_messages`         | 47   | `GET /json/scheduled_messages`                                     |
| `fetch_reminders`                  | 54   | `GET /json/reminders`                                              |
| `delete_scheduled_messages`        | 59   | `DELETE /json/scheduled_messages/<id>`                             |
| `update_scheduled_message_backend` | 70   | `PATCH /json/scheduled_messages/<id>` (legacy edit)                |
| `create_scheduled_message_backend` | 147  | `POST /json/scheduled_messages` (legacy single-destination create) |
| `_validate_batch_destinations`     | 254  | Private helper — see below                                         |
| `create_batch_scheduled_messages`  | 284  | `POST /json/batch_scheduled_messages`                              |
| `cancel_batch_scheduled_messages`  | 390  | `DELETE /json/batch_scheduled_messages/<batch_group_id>`           |

`_validate_batch_destinations` accepts a list of destination dicts and
verifies that each `stream` destination has a valid `stream_id` plus
non-empty `topic`, and each `direct` destination has a non-empty
`user_ids` list. It does **not** currently verify that the
authenticated user can actually send to those destinations — see
[§12 Known issues](#12-known-issues--future-work).

## 6. API endpoints

### `POST /json/batch_scheduled_messages`

Create a single batch — one logical scheduling action that may
produce multiple `ScheduledMessage` rows.

**Request body**

| Field                          | Type             | Required      | Notes                                                                  |
| ------------------------------ | ---------------- | ------------- | ---------------------------------------------------------------------- |
| `content`                      | string           | yes           | Message body (markdown).                                               |
| `destinations`                 | JSON array       | yes           | One or more destination objects.                                       |
| `scheduled_delivery_timestamp` | int (epoch sec)  | for one-time  | Required when no recurrence.                                           |
| `recurrence_type`              | string           | for recurring | `daily`, `weekly`, `specific_days`, `monthly`.                         |
| `recurrence_days`              | JSON             | for recurring | Shape depends on `recurrence_type` — see [§4](#recurrence_days-shape). |
| `scheduled_time`               | string `"HH:MM"` | for recurring | UTC time-of-day.                                                       |
| `batch_label`                  | string           | no            | Optional human-readable batch name.                                    |

Each `destinations[i]` is one of:

```json
{"type": "stream", "stream_id": 12, "topic": "weekly update"}
{"type": "direct", "user_ids": [4, 7, 9]}
```

**Response 200**

```json
{
  "result": "success",
  "msg": "",
  "scheduled_message_ids": [101, 102, 103],
  "batch_group_id": "8c0f4b1a-...-..."
}
```

**Error responses**

- `400 destinations must not be empty.`
- `400 Each destination must have type 'stream' or 'direct'.`
- `400 Each stream destination must include an integer stream_id.`
- `400 Each stream destination must include a non-empty topic.`
- `400 Each direct destination must include a non-empty user_ids list.`
- `400 Invalid recurrence_type: <…>`
- `400 recurrence_days is required for weekly and specific_days recurrence types.`
- `400 monthly recurrence_days must have type 'calendar_day' or 'ordinal_weekday', got '<…>'.`
- `400 Invalid scheduled_time format. Expected HH:MM in UTC.`
- `400 Scheduled delivery time must be in the future.`

### `DELETE /json/batch_scheduled_messages/<batch_group_id>`

Cancel every row in the batch in one call.

**Response 200** — `{"result": "success", "msg": ""}`. Idempotent: a
cancel of an already-empty group still returns success.

### `GET /json/scheduled_messages` (existing)

Returns all undelivered `ScheduledMessage` rows owned by the caller,
including the new recurrence and batch fields. Schema is documented
in `zerver/openapi/zulip.yaml` around lines 7603–7800 (search for
`recurrence_type` to find the schema additions).

## 7. Delivery worker

The worker is a supervisor-managed Python process that polls the
`ScheduledMessage` table for due rows and delivers them.

- **Entry point:** `zerver/management/commands/deliver_scheduled_messages.py`
- **Run command:** `./manage.py deliver_scheduled_messages`
- **Supervisor config:** `puppet/zulip/templates/supervisor/zulip-once.conf.template.erb` (search for `zulip_deliver_scheduled_messages`).
- **Log:** `/var/log/zulip/events_deliver_scheduled_messages.log` in production.

### Loop body

`deliver_scheduled_messages.py:24-33` runs:

```
while True:
    if try_deliver_one_scheduled_message():
        continue
    # nothing due — sleep until the next minute boundary
    sleep((next_minute_boundary - now).total_seconds())
```

### Per-iteration logic

`try_deliver_one_scheduled_message` at
`zerver/actions/scheduled_messages.py:540` does:

1. Select the oldest undelivered row with
   `next_delivery <= now()`, ordered by `(next_delivery, id)`. Uses
   `select_for_update` to prevent two workers from grabbing the same
   row.
2. If the row is reminder-type, call `send_reminder`.
3. Otherwise, call `send_scheduled_message`.
4. Return `True` if a row was processed, `False` if nothing was due.

### Recurring recompute path

Inside `send_scheduled_message` at lines 486–495:

```python
if scheduled_message.recurrence_type is not None:
    scheduled_message.next_delivery = compute_next_delivery(
        scheduled_message.recurrence_type,
        scheduled_message.recurrence_days,
        scheduled_message.scheduled_time,
        timezone_now(),
    )
    scheduled_message.save(update_fields=["delivered_message_id", "next_delivery"])
```

For one-time rows the standard path runs instead: the row's
`delivered` flag is set and the row stays for auditing.

### Failure handling

When `send_scheduled_message` raises for any reason —
`RealmDeactivatedError`, `UserDeactivatedError`, the late-cutoff
`JsonableError`, a `check_message` permission error, or an
unexpected exception from `do_send_messages` — the worker catches
it in `try_deliver_one_scheduled_message`
(`actions/scheduled_messages.py:540`). The row is then:

1. Refreshed from the database.
2. Marked `failed = True` and `failure_message` set to the error
   text (or `"Internal server error"` for unexpected exceptions).
3. Saved with `update_fields=["failed", "failure_message"]`.
4. The sender is notified via
   `send_failed_scheduled_message_notification` — unless the realm
   or sender is itself deactivated.

Because the worker query filters on `failed = False`, **a row that
has failed once will not be retried**, even if it is recurring.
This treats every failure as terminal: a single transient hiccup
(e.g., a brief outage of the destination channel) permanently stops
an otherwise-healthy recurring job. See
[§12](#12-known-issues--future-work).

## 8. Frontend modules

### `web/src/unified_scheduled_message_ui.ts`

Owner of the unified-modal dialog. Exposes one public entry point —
`open_unified_scheduled_modal()` (line 409) — and is organized
into the following internal functions (each one is short; jump to
them in the file by name):

| Function                          | Line | Role                                                                                |
| --------------------------------- | ---- | ----------------------------------------------------------------------------------- |
| `render_pending_destinations`     | 69   | Render the destination chip list                                                    |
| `remove_destination`              | 96   | Remove a chip by index                                                              |
| `is_duplicate_stream_destination` | 105  | Reject duplicate channel+topic                                                      |
| `is_duplicate_direct_destination` | 115  | Reject duplicate DM recipient set                                                   |
| `populate_stream_select`          | 130  | Fill the stream dropdown                                                            |
| `update_topic_typeahead`          | 142  | (Re)bind the topic typeahead on stream change. Unlisten lifecycle added 2026-05-13. |
| `add_stream_destination`          | 164  | Validate and append a channel destination                                           |
| `init_dm_pill_widget`             | 196  | Set up the DM pill widget via `pill_typeahead.set_up_user`                          |
| `clear_dm_pills`                  | 207  | Reset DM pills                                                                      |
| `add_direct_destination`          | 218  | Validate and append a DM destination                                                |
| `set_datetime_min`                | 249  | Constrain the datetime input to "now or later"                                      |
| `wire_repeat_toggle`              | 262  | Toggle visibility of the recurrence section when **Repeat** is checked              |
| `submit_unified_form`             | 274  | Build the request body and `POST /json/batch_scheduled_messages`                    |
| `post_render_unified_modal`       | 354  | Run after the dialog framework injects markup                                       |
| `open_unified_scheduled_modal`    | 409  | Public entry point — called by the send-later popover                               |

The file's module docstring (lines 1–13) is the canonical short
description of the modal's behavior and submit-routing rules.

### `web/src/recurring_fields_ui.ts`

Stateless helpers for the recurrence form fields. Used by the unified
modal (and previously by the popover, removed in cleanup commit
`6963f9d6cc`). Two exports drive recurrence:

| Function                                     | Purpose                                                                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize_recurring_fields($root)`         | Wire up frequency dropdown, weekday checkboxes, monthly radio sub-mode, and the live monthly summary.                                                                                          |
| `get_recurring_schedule_request_data($root)` | Serialize the form back to the wire shape (`recurrence_type` + `recurrence_days` + `scheduled_time`). Returns `{error_message}` on validation failure so the caller can surface inline errors. |

### `web/templates/unified_scheduled_message_modal.hbs`

Modal markup. Embeds the recurrence partial:

```hbs
{{> popovers/recurring_fields}}
```

inside a section hidden until **Repeat** is checked.

### `web/templates/popovers/recurring_fields.hbs`

Recurrence form partial. Reused by the unified modal; nothing else
currently includes it. The required CSS-class contract is documented
in the file's header comment.

### `web/styles/scheduled_messages.css`

CSS for the unified modal, recurrence form, and scheduled-messages
overlay. The "popover recurring builder" rules were removed in
cleanup commit `a3ddcbb631`; the remaining rules support the
unified-modal layout, the recurrence form, and the destination
chips.

## 9. Testing

### Test plan

Coverage is organized across four levels:

| Level             | Scope                                                                         | Tool                                                                         |
| ----------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Unit              | Recurrence math (`compute_next_delivery`, monthly rule edge cases)            | Django `unittest`                                                            |
| API/integration   | View endpoints; validation; batch creation/cancellation                       | Django test client                                                           |
| Delivery workflow | Worker loop; recurring next-delivery advancement; failed-destination handling | Django + mock + freezegun                                                    |
| User/UI           | Compose-box interaction; form validation; scheduled-list display              | Manual (course documents the protocol in the Sprint 3 user-testing appendix) |

Tests live in `zerver/tests/test_scheduled_messages.py` (42 test
methods at the time of writing). Major test classes:

- `ScheduledMessageComputeNextDeliveryTest` — recurrence math
  (daily / weekly / specific days / monthly calendar-day and
  ordinal-weekday, including leap-day and short-month clamping).
- Schedule-API tests — single-destination create / fetch / delete /
  update; recurring create with validation cases; monthly rule
  rejection cases.
- Delivery tests — one-time row marked delivered; recurring row
  advances `next_delivery`; realm/sender deactivation handling;
  late-cutoff behavior.

Frontend tests:

- `web/tests/scheduled_messages.test.cjs` covers
  `get_recurring_schedule_request_data` serialization and several
  helpers exposed via `compose_send_menu_popover`.

### How to run tests

All commands must be executed inside a Zulip dev environment (Vagrant
or a local provisioned shell). From the repository root:

```bash
# Activate the dev environment first (Vagrant: `vagrant ssh`,
# native install: `source .venv/bin/activate`).

# Full backend suite for scheduled messages:
./tools/test-backend zerver.tests.test_scheduled_messages

# Single test class:
./tools/test-backend zerver.tests.test_scheduled_messages.ScheduledMessageComputeNextDeliveryTest

# Single test method:
./tools/test-backend zerver.tests.test_scheduled_messages.ScheduledMessageComputeNextDeliveryTest.test_monthly_calendar_day_last_day_is_leap_day

# Backend with coverage report:
./tools/test-backend --coverage zerver.tests.test_scheduled_messages

# Frontend tests for this feature:
./tools/test-js-with-node web/tests/scheduled_messages.test.cjs

# Frontend with coverage:
./tools/test-js-with-node --coverage

# Type and style linters across all changed files:
./tools/lint zerver/lib/scheduled_messages.py \
             zerver/actions/scheduled_messages.py \
             zerver/views/scheduled_messages.py \
             web/src/unified_scheduled_message_ui.ts \
             web/src/recurring_fields_ui.ts
```

### Reported coverage at Sprint 3

These figures are from coverage runs the team executed on
2026-04-27 (Sprint 3 report submission day), not from a fresh run
at handover time. A future maintainer should regenerate them by
running the commands above.

- **Backend** (`./tools/test-backend --coverage`): **94%** line
  coverage across the project, as reported by the team on
  2026-04-27.
- **Frontend** (`./tools/test-js-with-node --coverage`):
  Statements **71.88%** · Branches **47.43%** ·
  Functions **67.71%** · Lines **71.77%**, as reported by the
  team on 2026-04-27.

Frontend coverage is lower than backend because the unified modal
was added late in the sprint and only its critical helpers
(`get_recurring_schedule_request_data` and the serialization paths)
have dedicated tests. Improving frontend coverage on
`unified_scheduled_message_ui.ts` is the highest-value follow-up.

### Manual integration script

`tools/tests/test_recurring_manual.py` exercises the full
create / list / cancel / deliver lifecycle against the dev database.
It is not part of CI and not idempotent. Run it from inside the dev
environment via `./manage.py shell < tools/tests/test_recurring_manual.py`
when verifying a new server deployment by hand.

## 10. Deployment

The feature requires no special install steps — it ships as part of
the normal Zulip server deployment process. From a fresh production
install:

1. Apply migrations: `./manage.py migrate`. This applies
   `0790`, `0791`, and `0792`, which add the new columns.
2. Restart the application: `./scripts/restart-server`.
3. Confirm the supervisor program `zulip_deliver_scheduled_messages`
   is `RUNNING`:
   `supervisorctl status zulip_deliver_scheduled_messages`. The
   program is defined in
   `puppet/zulip/templates/supervisor/zulip-once.conf.template.erb`.
4. Verify the API is reachable: as any logged-in user,
   `POST /json/batch_scheduled_messages` with a minimal body should
   return `200` and a `batch_group_id`.

### Rolling back

The new behaviors are gated by the presence of the recurrence /
batch columns plus a non-NULL `recurrence_type` or `batch_group_id`
on individual rows. Downgrading the application code without
reverting the migrations leaves existing rows in place but inert
(the legacy code path ignores the new columns).

To fully revert:

1. Cancel any in-flight recurring or batch jobs from the application
   UI (`DELETE /json/batch_scheduled_messages/<batch_group_id>`),
   _or_ in SQL:
   `UPDATE zerver_scheduledmessage SET delivered = TRUE WHERE recurrence_type IS NOT NULL OR batch_group_id IS NOT NULL;`
2. Reverse-migrate to the migration immediately before `0790`:
   `./manage.py migrate zerver 0789_merge_20260323_2256`.
3. Deploy the pre-unification application code.

## 11. Style guide & developer workflow

This codebase follows the upstream Zulip conventions, which are
documented in detail at:

- `docs/contributing/code-style.html` (linked from
  `https://zulip.readthedocs.io/en/latest/contributing/code-style.html`)
- `docs/contributing/commit-discipline.html`
- `.claude/CLAUDE.md` in this repository — project-specific AI
  contribution rules

### Commit discipline

Each commit is a minimal coherent idea. Summary format:

```
subsystem: Sentence-case summary ending with a period.

Body explains *why*, not what. Line-wrapped at 68–70 chars.
Fixes #123.
```

Examples from the cleanup work delivered as part of this handover:

- `compose: Remove deprecated recurring-builder popover code.`
- `scheduled_messages: Unlisten previous topic typeahead before rebinding.`

### Branch flow

- Feature branches off `main`. Naming: `feat/<short-slug>`,
  `fix/<slug>`, `refactor/<slug>`, `test/<slug>`, `handover/<slug>`.
- Rebase against `main` before opening or updating a PR. Do not
  merge stale branches.
- Squash CodeRabbit / fixup commits into their originating commits
  via `git commit --fixup=<sha>` + `git rebase -i --autosquash`. Do
  not push separate "fix: apply CodeRabbit auto-fixes" commits.

### Linting

`./tools/lint` runs the full set (mypy, ruff, ESLint, prettier,
Stylelint, custom Zulip linters). Inside the dev environment, run
it before every PR. Individual linters can be run directly when the
full toolchain isn't provisioned:

```bash
node_modules/.bin/eslint web/src/<file>.ts
.venv/bin/mypy zerver/lib/scheduled_messages.py
```

## 12. Known issues & future work

The following issues are known and not yet addressed. They are
ordered roughly by impact.

### Pre-existing lint debt in `unified_scheduled_message_ui.ts`

ESLint reports seven errors in this file that were present before
the final-delivery cleanup and were not auto-fixable:

| Line          | Rule                              | Note                                                                                                                                                                                                        |
| ------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 116, 121, 134 | `unicorn/no-array-sort`           | `array.sort()` should be `array.toSorted()`. Behavior-preserving for the current call sites (all sorts run on freshly-spread copies), but the migration must verify no caller depends on in-place mutation. |
| 200           | `no-jquery/no-parse-html-literal` | The destination-chip renderer uses `$(htmlString)`. Template content is already `_.escape`-d, so this is not a current XSS surface; refactoring to DOM building would remove the warning permanently.       |
| 264, 289      | `consistent-type-assertions`      | Use `x as T` instead of `<T>x`. Pure style.                                                                                                                                                                 |
| 312           | `new-cap`                         | A capitalized function is being called without `new`. Pure style.                                                                                                                                           |

### Recurring rows die on first send failure

When `try_deliver_one_scheduled_message` catches any exception
from `send_scheduled_message`, it sets `failed = True` on the row
(`actions/scheduled_messages.py:540` onward). The worker query
filters on `failed = False`, so a failed row is never retried —
even if the failure was transient (e.g., a brief network blip, a
temporary `do_send_messages` error, or a momentarily-deactivated
realm).

For one-time scheduled messages this behavior is reasonable: the
user is notified and can recreate the message. For recurring
rows it is heavy-handed: a single transient failure permanently
stops a recurrence that was otherwise healthy. A better policy
would be either to differentiate between "definitely permanent"
errors (deactivated realm, late cutoff) and "possibly transient"
errors, retrying the latter with backoff, or to count consecutive
failures per row and only deactivate after N (e.g., 3-5) consecutive
failures.

Implementation entry point would be the `except Exception as e:`
block in `try_deliver_one_scheduled_message`.

### View-time destination access validation

`_validate_batch_destinations` checks destination _shape_ but not
whether the calling user can actually send to each destination
(channel access, DM-recipient existence). Today the resolution
happens at delivery time; a malformed destination produces a
runtime failure rather than an immediate 400. Adding access
validation to the view layer would tighten the API contract.

### Editing a recurring/batch scheduled message

There is no edit endpoint for batch jobs. The unified modal can
only cancel and recreate. Adding an edit path would require
deciding whether edits apply retroactively to the in-flight batch
group or whether they create a new group while leaving the
existing one to deliver.

### Visual indicator for batch-delivered messages

Client review feedback (Sprint 3) requested that recipients of a
batch-delivered message see a small badge indicating "this was part
of a multi-destination scheduled batch." Not implemented — would
require frontend-only changes to the message renderer and a server
field exposing `batch_group_id` on `Message` (or carrying it via
the rendered message metadata).

### Orphan migration `0783_recurringscheduledmessage`

The pre-unification `RecurringScheduledMessage` table is still
created by migration `0783` but is no longer referenced by any
live model. The data migration `0791` empties it. A future
cleanup migration could `DROP TABLE` to remove the orphan.

## 13. References

### Repository paths (quick lookup)

| Concern                       | Path                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| User-facing help article      | `starlight_help/src/content/docs/schedule-a-recurring-or-batch-message.mdx` |
| License agreement             | `cs5150-handover/LICENSE-AGREEMENT.md`                                      |
| Maintainer manual (this file) | `cs5150-handover/MAINTAINER.md`                                             |
| Backend tests                 | `zerver/tests/test_scheduled_messages.py`                                   |
| Backend recurrence math       | `zerver/lib/scheduled_messages.py`                                          |
| Backend actions               | `zerver/actions/scheduled_messages.py`                                      |
| Backend views                 | `zerver/views/scheduled_messages.py`                                        |
| Model                         | `zerver/models/scheduled_jobs.py` (class `ScheduledMessage` at line 165)    |
| Migrations                    | `zerver/migrations/079{0,1,2}*.py`                                          |
| Worker                        | `zerver/management/commands/deliver_scheduled_messages.py`                  |
| Supervisor program            | `puppet/zulip/templates/supervisor/zulip-once.conf.template.erb`            |
| Unified-modal frontend        | `web/src/unified_scheduled_message_ui.ts`                                   |
| Recurrence form helpers       | `web/src/recurring_fields_ui.ts`                                            |
| Modal template                | `web/templates/unified_scheduled_message_modal.hbs`                         |
| Recurrence partial            | `web/templates/popovers/recurring_fields.hbs`                               |
| Styles                        | `web/styles/scheduled_messages.css`                                         |
| OpenAPI schema                | `zerver/openapi/zulip.yaml` (search for `recurrence_type`)                  |

### External docs

- Zulip developer documentation:
  `https://zulip.readthedocs.io/en/latest/`
- Zulip help center:
  `https://zulip.com/help/`
- Apache 2.0 license:
  `https://www.apache.org/licenses/LICENSE-2.0`

### Course context

This work was developed for CS 5150 Spring 2026 at Cornell
University. The team's Sprint 3 report and the final-delivery
artifacts are stored in this repository under `cs5150-handover/`.
The handover package was prepared by Aryan Agarwal (aaa344) on
2026-05-13.
