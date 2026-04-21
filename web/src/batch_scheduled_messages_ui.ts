import $ from "jquery";
import _ from "lodash";

import render_batch_scheduled_message_modal from "../templates/batch_scheduled_message_modal.hbs";

import * as channel from "./channel.ts";
import * as compose_state from "./compose_state.ts";
import * as dialog_widget from "./dialog_widget.ts";
import {$t, $t_html} from "./i18n.ts";
import * as input_pill from "./input_pill.ts";
import * as people from "./people.ts";
import * as pill_typeahead from "./pill_typeahead.ts";
import * as stream_data from "./stream_data.ts";
import * as sub_store from "./sub_store.ts";
import * as ui_report from "./ui_report.ts";
import * as user_pill from "./user_pill.ts";

// ---------------------------------------------------------------------------
// Destination list
// ---------------------------------------------------------------------------

type StreamDestination = {type: "stream"; stream_id: number; topic: string};
type DirectDestination = {type: "direct"; user_ids: number[]};
type Destination = StreamDestination | DirectDestination;

let pending_destinations: Destination[] = [];

// Holds the active pill widget for the DM recipient picker. Reset each time
// the modal opens (via open_batch_modal) and re-created after each "Add DM"
// to clear out the selected pills.
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
    const $list = $("#batch-destinations-list");
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
        const $chip = $(`
            <div class="rsm-destination-chip">
                <span>${label}</span>
                <button type="button" class="batch-remove-dest-btn" data-idx="${idx}">&times;</button>
            </div>
        `.trim());
        $list.append($chip);
    }
}

function remove_destination(idx: number): void {
    pending_destinations.splice(idx, 1);
    render_pending_destinations();
}

// ---------------------------------------------------------------------------
// Channel (stream) destination — dropdown + topic text input
// ---------------------------------------------------------------------------

function populate_stream_select(): void {
    const $select = $<HTMLSelectElement>("#batch-stream-select");
    // Keep the placeholder option, remove any previously populated options.
    $select.find("option:not(:first-child)").remove();

    const subs = [...stream_data.subscribed_subs()].sort((a, b) =>
        a.name.localeCompare(b.name),
    );
    for (const sub of subs) {
        $select.append($("<option>").val(sub.stream_id).text(sub.name));
    }
}

function add_stream_destination(): void {
    const stream_id_str = ($<HTMLSelectElement>("#batch-stream-select").val() ?? "").toString();
    const topic = ($<HTMLInputElement>("#batch-topic-input").val() ?? "").trim();

    if (!stream_id_str || !topic) {
        show_modal_error($t({defaultMessage: "Please select a channel and enter a topic."}));
        return;
    }

    const stream_id = Number.parseInt(stream_id_str, 10);
    pending_destinations.push({type: "stream", stream_id, topic});
    clear_modal_error();
    render_pending_destinations();

    $<HTMLSelectElement>("#batch-stream-select").val("");
    $<HTMLInputElement>("#batch-topic-input").val("");
}

// ---------------------------------------------------------------------------
// Direct message destination — pill-based user picker
// ---------------------------------------------------------------------------

function init_dm_pill_widget(): void {
    const $container = $("#batch-dm-pill-container");
    // Re-seed the container with a fresh contenteditable input so the pill
    // widget has a clean slate each time (avoids stale pill DOM nodes).
    $container.empty();
    $container.append(
        $('<div class="input" contenteditable="true" tabindex="0"></div>'),
    );

    dm_pill_widget = user_pill.create_pills($container, {exclude_inaccessible_users: true});
    pill_typeahead.set_up_user($container.find(".input"), dm_pill_widget, {});
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

    pending_destinations.push({type: "direct", user_ids});
    clear_modal_error();
    render_pending_destinations();

    // Reinitialize the pill widget so the input is empty for the next entry.
    init_dm_pill_widget();
}

// ---------------------------------------------------------------------------
// Form submission
// ---------------------------------------------------------------------------

function submit_batch_form(): void {
    const content = ($<HTMLTextAreaElement>("#batch-scheduled-message-content").val() ?? "").trim();
    const datetime_val = ($<HTMLInputElement>("#batch-scheduled-message-datetime").val() ?? "");
    const batch_label = ($<HTMLInputElement>("#batch-scheduled-message-label").val() ?? "").trim();

    if (!content) {
        show_modal_error($t({defaultMessage: "Please enter a message."}));
        return;
    }

    if (!datetime_val) {
        show_modal_error($t({defaultMessage: "Please choose a send time."}));
        return;
    }

    if (pending_destinations.length === 0) {
        show_modal_error($t({defaultMessage: "Please add at least one destination."}));
        return;
    }

    const scheduled_delivery_timestamp = Math.floor(new Date(datetime_val).getTime() / 1000);
    if (scheduled_delivery_timestamp <= Math.floor(Date.now() / 1000)) {
        show_modal_error($t({defaultMessage: "Send time must be in the future."}));
        return;
    }

    const data: Record<string, unknown> = {
        content,
        destinations: JSON.stringify(pending_destinations),
        scheduled_delivery_timestamp: JSON.stringify(scheduled_delivery_timestamp),
    };

    if (batch_label) {
        data["batch_label"] = batch_label;
    }

    clear_modal_error();
    dialog_widget.submit_api_request(channel.post, "/json/batch_scheduled_messages", data);
}

// ---------------------------------------------------------------------------
// Modal lifecycle
// ---------------------------------------------------------------------------

function post_render_batch_modal(): void {
    // Populate channel dropdown with subscribed streams.
    populate_stream_select();

    // Initialize the DM user-pill widget.
    init_dm_pill_widget();

    // Pre-populate content and first destination from compose box.
    const compose_content = compose_state.message_content();
    if (compose_content) {
        $<HTMLTextAreaElement>("#batch-scheduled-message-content").val(compose_content);
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

    // Wire up add-destination buttons.
    $("#batch-add-stream-btn").on("click", add_stream_destination);
    $("#batch-add-direct-btn").on("click", add_direct_destination);

    // Wire up remove chips via event delegation.
    $("#batch-destinations-list").on("click", ".batch-remove-dest-btn", (e) => {
        const idx = Number.parseInt($(e.currentTarget).attr("data-idx") ?? "0", 10);
        remove_destination(idx);
    });

    // Set the datetime minimum to now + 1 minute.
    const now = new Date();
    now.setSeconds(0, 0);
    now.setMinutes(now.getMinutes() + 1);
    $<HTMLInputElement>("#batch-scheduled-message-datetime").attr(
        "min",
        now.toISOString().slice(0, 16),
    );
}

export function open_batch_modal(): void {
    pending_destinations = [];
    dm_pill_widget = null;
    dialog_widget.launch({
        modal_title_html: $t_html({defaultMessage: "Batch schedule message"}),
        modal_content_html: render_batch_scheduled_message_modal(),
        modal_submit_button_text: $t({defaultMessage: "Schedule"}),
        id: "batch-scheduled-message-modal",
        form_id: "batch-scheduled-message-form",
        on_click: submit_batch_form,
        post_render: post_render_batch_modal,
    });
}
