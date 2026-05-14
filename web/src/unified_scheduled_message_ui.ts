/**
 * Unified scheduled-message modal.
 *
 * Combines template (saved snippet) selection, a datetime picker for one-time
 * delivery, recurrence controls (daily / weekly / monthly), and a
 * multi-destination manager (channels + DMs) into a single modal dialog.
 *
 * Submit routing:
 *  - recurrence selected  → POST /json/batch_scheduled_messages with recurrence fields
 *  - one-time delivery    → POST /json/batch_scheduled_messages without recurrence fields
 *
 * One destination is valid in both cases; users are not forced to add more than one.
 */

import $ from "jquery";
import _ from "lodash";

import render_unified_scheduled_message_modal from "../templates/unified_scheduled_message_modal.hbs";

import * as channel from "./channel.ts";
import * as compose_state from "./compose_state.ts";
import * as composebox_typeahead from "./composebox_typeahead.ts";
import * as dialog_widget from "./dialog_widget.ts";
import {$t, $t_html} from "./i18n.ts";
import type * as input_pill from "./input_pill.ts";
import * as people from "./people.ts";
import * as pill_typeahead from "./pill_typeahead.ts";
<<<<<<< Updated upstream
import {get_recurring_schedule_request_data, initialize_recurring_fields} from "./recurring_fields_ui.ts";
=======
import {
    get_recurring_schedule_request_data,
    initialize_recurring_fields,
} from "./recurring_fields_ui.ts";
>>>>>>> Stashed changes
import * as saved_snippets_ui from "./saved_snippets_ui.ts";
import * as stream_data from "./stream_data.ts";
import * as sub_store from "./sub_store.ts";
import * as ui_report from "./ui_report.ts";
import * as user_pill from "./user_pill.ts";

// ---------------------------------------------------------------------------
// Destination state
// ---------------------------------------------------------------------------

type StreamDestination = {type: "stream"; stream_id: number; topic: string};
type DirectDestination = {type: "direct"; user_ids: number[]};
type Destination = StreamDestination | DirectDestination;

let pending_destinations: Destination[] = [];
let dm_pill_widget: input_pill.InputPillContainer<user_pill.UserPill> | null = null;

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function get_dialog_error_element(): JQuery {
    return $("#dialog_error").expectOne();
}

function show_modal_error(message: string): void {
    ui_report.client_error(message, get_dialog_error_element());
}

function clear_modal_error(): void {
    get_dialog_error_element().hide().empty();
}

// ---------------------------------------------------------------------------
// Destination chip rendering
// ---------------------------------------------------------------------------

function render_pending_destinations(): void {
    const $list = $("#unified-destinations-list");
    $list.empty();

    for (const [idx, dest] of pending_destinations.entries()) {
        let label: string;
        if (dest.type === "stream") {
            const stream = sub_store.get(dest.stream_id);
            const name = stream ? stream.name : String(dest.stream_id);
            label = `${_.escape(name)} > ${_.escape(dest.topic)}`;
        } else {
            const names = dest.user_ids.map((uid) => {
                const person = people.maybe_get_user_by_id(uid);
                return _.escape(person ? person.full_name : String(uid));
            });
            label = `DM: ${names.join(", ")}`;
        }
        const $chip = $(
            `
            <div class="rsm-destination-chip">
                <span>${label}</span>
                <button type="button" class="unified-remove-dest-btn" data-idx="${idx}">&times;</button>
            </div>
        `.trim(),
        );
        $list.append($chip);
    }
}

function remove_destination(idx: number): void {
    pending_destinations.splice(idx, 1);
    render_pending_destinations();
}

// ---------------------------------------------------------------------------
// Duplicate-destination guards
// ---------------------------------------------------------------------------

function is_duplicate_stream_destination(stream_id: number, topic: string): boolean {
    const topic_lower = topic.toLowerCase();
    return pending_destinations.some(
        (dest) =>
            dest.type === "stream" &&
            dest.stream_id === stream_id &&
            dest.topic.toLowerCase() === topic_lower,
    );
}

function is_duplicate_direct_destination(user_ids: number[]): boolean {
    const sorted_new = user_ids.toSorted((a, b) => a - b);
    return pending_destinations.some((dest) => {
        if (dest.type !== "direct" || dest.user_ids.length !== user_ids.length) {
            return false;
        }
        const sorted_existing = dest.user_ids.toSorted((a, b) => a - b);
        return sorted_existing.every((id, i) => id === sorted_new[i]);
    });
}

// ---------------------------------------------------------------------------
// Channel destination — dropdown + topic input
// ---------------------------------------------------------------------------

function populate_stream_select(): void {
    const $select = $<HTMLSelectElement>("#unified-stream-select");
    $select.find("option:not(:first-child)").remove();

    const subs = stream_data.subscribed_subs().toSorted((a, b) => a.name.localeCompare(b.name));
    for (const sub of subs) {
        $select.append($("<option>").val(sub.stream_id).text(sub.name));
    }
}

function update_topic_typeahead(): void {
    // Always tear down the previous typeahead before rebinding so listeners
    // don't accumulate on #unified-topic-input across stream switches.
    current_topic_typeahead?.unlisten();
    current_topic_typeahead = null;

    const stream_id_str = ($<HTMLSelectElement>("#unified-stream-select").val() ?? "").toString();
    if (!stream_id_str) {
        return;
    }
    const stream_id = Number.parseInt(stream_id_str, 10);
    const sub = sub_store.get(stream_id);
    if (sub === undefined) {
        return;
    }
    composebox_typeahead.initialize_topic_edit_typeahead(
        $<HTMLInputElement>("#unified-topic-input"),
        sub.name,
        false,
    );
}

function add_stream_destination(): void {
    const stream_id_str = ($<HTMLSelectElement>("#unified-stream-select").val() ?? "").toString();
    const topic = ($<HTMLInputElement>("#unified-topic-input").val() ?? "").trim();

    if (!stream_id_str || !topic) {
        show_modal_error($t({defaultMessage: "Please select a channel and enter a topic."}));
        return;
    }

    const stream_id = Number.parseInt(stream_id_str, 10);

    if (is_duplicate_stream_destination(stream_id, topic)) {
        show_modal_error(
            $t({defaultMessage: "This channel and topic is already in the destination list."}),
        );
        return;
    }

    pending_destinations.push({type: "stream", stream_id, topic});
    clear_modal_error();
    render_pending_destinations();

    $<HTMLSelectElement>("#unified-stream-select").val("");
    $<HTMLInputElement>("#unified-topic-input").val("");
<<<<<<< Updated upstream
    current_topic_typeahead?.unlisten();
    current_topic_typeahead = null;
=======
>>>>>>> Stashed changes
}

// ---------------------------------------------------------------------------
// DM destination — pill widget
// ---------------------------------------------------------------------------

function init_dm_pill_widget(): void {
    const $container = $("#unified-dm-pill-container");
    $container.empty();
    $container.append(
        $("<div>").addClass("input").attr("contenteditable", "true").attr("tabindex", "0"),
    );

    dm_pill_widget = user_pill.create_pills($container, {exclude_inaccessible_users: true});
    pill_typeahead.set_up_user($container.find(".input"), dm_pill_widget, {});
}

function clear_dm_pills(): void {
    if (dm_pill_widget === null) {
        return;
    }
    const pill_elements = $("#unified-dm-pill-container").find(".pill").toArray();
    for (const el of pill_elements) {
        dm_pill_widget.removePill(el, "clear");
    }
    dm_pill_widget.clear_text();
}

function add_direct_destination(): void {
    if (dm_pill_widget === null) {
        return;
    }

    const user_ids = user_pill.get_user_ids(dm_pill_widget);
    if (user_ids.length === 0) {
        show_modal_error($t({defaultMessage: "Please select at least one recipient."}));
        return;
    }

    if (is_duplicate_direct_destination(user_ids)) {
        show_modal_error(
            $t({
                defaultMessage:
                    "This direct message recipient set is already in the destination list.",
            }),
        );
        return;
    }

    pending_destinations.push({type: "direct", user_ids});
    clear_modal_error();
    render_pending_destinations();
    clear_dm_pills();
}

// ---------------------------------------------------------------------------
// Datetime min helper (local-time-aware, no UTC offset bug)
// ---------------------------------------------------------------------------

function set_datetime_min(): void {
    const now = new Date();
    now.setSeconds(0, 0);
    now.setMinutes(now.getMinutes() + 1);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const local_min = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    $<HTMLInputElement>("#unified-scheduled-message-datetime").attr("min", local_min);
}

// ---------------------------------------------------------------------------
// Repeat-checkbox toggle (shows recurrence form, hides datetime picker)
// ---------------------------------------------------------------------------

function wire_repeat_toggle(): void {
    $("#unified-repeat-checkbox").on("change", function () {
        const is_recurring = Boolean($(this).prop("checked"));
        $("#unified-datetime-section").toggle(!is_recurring);
        $("#unified-recurrence-section").toggle(is_recurring);
    });
}

// ---------------------------------------------------------------------------
// Form submission
// ---------------------------------------------------------------------------

function submit_unified_form(): void {
    const content = (
        $<HTMLTextAreaElement>("#unified-scheduled-message-content").val() ?? ""
    ).trim();

    if (!content) {
        show_modal_error($t({defaultMessage: "Please enter a message."}));
        return;
    }

    if (pending_destinations.length === 0) {
        show_modal_error($t({defaultMessage: "Please add at least one destination."}));
        return;
    }

    const is_recurring = Boolean($<HTMLInputElement>("#unified-repeat-checkbox").prop("checked"));

    const data: Record<string, unknown> = {
        content,
        destinations: JSON.stringify(pending_destinations),
    };

    if (is_recurring) {
        // Recurring batch: validate and forward recurrence fields.
        const recurring_result = get_recurring_schedule_request_data(
            $("#unified-scheduled-message-modal"),
        );
        if ("error_message" in recurring_result) {
            show_modal_error(recurring_result.error_message);
            return;
        }
        data["recurrence_type"] = recurring_result.recurrence_type;
        data["recurrence_days"] = recurring_result.recurrence_days;
        // scheduled_time is HH:MM as entered by the user in their local timezone.
        // Send the browser's IANA timezone so the backend stores and displays
        // the time in the user's local zone (e.g. "Daily at 8:06 PM") rather
        // than interpreting it as UTC.
        data["scheduled_time"] = recurring_result.scheduled_time;
        data["timezone"] = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    } else {
        // One-time batch: require a datetime-local value.
        const datetime_val = $<HTMLInputElement>("#unified-scheduled-message-datetime").val() ?? "";
        if (!datetime_val) {
            show_modal_error($t({defaultMessage: "Please choose a send time."}));
            return;
        }
        const scheduled_delivery_timestamp = Math.floor(new Date(datetime_val).getTime() / 1000);
        if (scheduled_delivery_timestamp <= Math.floor(Date.now() / 1000)) {
            show_modal_error($t({defaultMessage: "Send time must be in the future."}));
            return;
        }
        data["scheduled_delivery_timestamp"] = JSON.stringify(scheduled_delivery_timestamp);
    }

    clear_modal_error();
    dialog_widget.submit_api_request(channel.post, "/json/batch_scheduled_messages", data, {
        success_continuation() {
            // Reset module-level state immediately after a successful submit so
            // the next open() call starts completely clean regardless of whether
            // the dialog framework reuses the DOM element.
            pending_destinations = [];
            dm_pill_widget = null;
<<<<<<< Updated upstream
            current_topic_typeahead?.unlisten();
            current_topic_typeahead = null;
=======
>>>>>>> Stashed changes
            // Also clear the chip list DOM while the modal is still in the tree.
            $("#unified-destinations-list").empty();
        },
    });
}

// ---------------------------------------------------------------------------
// Modal lifecycle
// ---------------------------------------------------------------------------

function post_render_unified_modal(): void {
    // Wire recurrence fields (dropdowns, checkboxes, summary text).
    initialize_recurring_fields($("#unified-scheduled-message-modal"));

    // Wire the Repeat checkbox — hidden until user opts in.
    wire_repeat_toggle();

    // Set up saved-snippets dropdown to insert into the modal textarea.
    saved_snippets_ui.setup_saved_snippets_dropdown_widget(".unified-snippet-widget", () =>
        $<HTMLTextAreaElement>("#unified-scheduled-message-content"),
    );

    // Populate channel dropdown.
    populate_stream_select();

    // Initialize DM pill widget.
    init_dm_pill_widget();

    // Pre-populate content and one destination from the compose box.
    const compose_content = compose_state.message_content();
    if (compose_content) {
        $<HTMLTextAreaElement>("#unified-scheduled-message-content").val(compose_content);
    }

    const msg_type = compose_state.get_message_type();
    if (msg_type === "stream") {
        const stream_id = compose_state.stream_id();
        const topic = compose_state.topic();
        if (stream_id !== undefined && topic) {
            pending_destinations = [{type: "stream", stream_id, topic}];
        }
    } else if (msg_type === "private") {
        const user_ids = compose_state.private_message_recipient_ids();
        if (user_ids.length > 0) {
            pending_destinations = [{type: "direct", user_ids}];
        }
    }
    render_pending_destinations();

    // Wire destination buttons.
    $("#unified-stream-select").on("change", update_topic_typeahead);
    $("#unified-add-stream-btn").on("click", add_stream_destination);
    $("#unified-add-direct-btn").on("click", add_direct_destination);

    // Wire remove chips via event delegation.
    $("#unified-destinations-list").on("click", ".unified-remove-dest-btn", (e) => {
        const idx = Number.parseInt($(e.currentTarget).attr("data-idx") ?? "0", 10);
        remove_destination(idx);
    });

    // Set datetime minimum in local time (avoids UTC offset bug).
    set_datetime_min();
}

export function open_unified_scheduled_modal(): void {
    pending_destinations = [];
    dm_pill_widget = null;
<<<<<<< Updated upstream
    current_topic_typeahead?.unlisten();
    current_topic_typeahead = null;
=======
>>>>>>> Stashed changes
    dialog_widget.launch({
        modal_title_html: $t_html({defaultMessage: "Schedule message"}),
        modal_content_html: render_unified_scheduled_message_modal(),
        modal_submit_button_text: $t({defaultMessage: "Schedule"}),
        id: "unified-scheduled-message-modal",
        form_id: "unified-scheduled-message-form",
        on_click: submit_unified_form,
        post_render: post_render_unified_modal,
    });
}
