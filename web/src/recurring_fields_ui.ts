/**
 * Shared helpers for the recurring-schedule form fields (recurring_fields.hbs).
 *
 * This module is intentionally free of dependencies on compose_send_menu_popover
 * and unified_scheduled_message_ui so that both can import from here without
 * creating a circular dependency.
 */

import $ from "jquery";

import {$t} from "./i18n.ts";

// ---------------------------------------------------------------------------
// Weekday mapping (used by both get_recurring_schedule_request_data and the
// initialize_recurring_fields monthly weekday selector).
// ---------------------------------------------------------------------------

export const WEEKDAY_TO_NUMBER = new Map([
    ["MO", 0],
    ["TU", 1],
    ["WE", 2],
    ["TH", 3],
    ["FR", 4],
    ["SA", 5],
    ["SU", 6],
]);

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

export function get_ordinal_day_label(day: number): string {
    const remainder_hundred = day % 100;
    if (remainder_hundred >= 11 && remainder_hundred <= 13) {
        return `${day}th`;
    }

    switch (day % 10) {
        case 1:
            return `${day}st`;
        case 2:
            return `${day}nd`;
        case 3:
            return `${day}rd`;
        default:
            return `${day}th`;
    }
}

export function get_monthly_day_option_label(day: number): string {
    return get_ordinal_day_label(day);
}

export function get_monthly_ordinal_label(ordinal: string): string {
    switch (ordinal) {
        case "first":
            return $t({defaultMessage: "first"});
        case "second":
            return $t({defaultMessage: "second"});
        case "third":
            return $t({defaultMessage: "third"});
        case "fourth":
            return $t({defaultMessage: "fourth"});
        case "last":
            return $t({defaultMessage: "last"});
        default:
            return ordinal;
    }
}

export function get_monthly_weekday_label(weekday: string): string {
    switch (weekday) {
        case "MO":
            return $t({defaultMessage: "Monday"});
        case "TU":
            return $t({defaultMessage: "Tuesday"});
        case "WE":
            return $t({defaultMessage: "Wednesday"});
        case "TH":
            return $t({defaultMessage: "Thursday"});
        case "FR":
            return $t({defaultMessage: "Friday"});
        case "SA":
            return $t({defaultMessage: "Saturday"});
        case "SU":
            return $t({defaultMessage: "Sunday"});
        default:
            return weekday;
    }
}

// ---------------------------------------------------------------------------
// Feedback helper (used by the popover's submit handler)
// ---------------------------------------------------------------------------

export function set_recurring_builder_feedback(
    $feedback: JQuery,
    state: "error" | "success",
    message: string,
): void {
    $feedback.removeClass("recurring-feedback-error recurring-feedback-success");
    $feedback.addClass(
        state === "error" ? "recurring-feedback-error" : "recurring-feedback-success",
    );
    $feedback.text(message);
}

// ---------------------------------------------------------------------------
// Read recurrence form values from any jQuery root element
// ---------------------------------------------------------------------------

export function get_recurring_schedule_request_data($root: JQuery):
    | {
          recurrence_days: string;
          recurrence_type: string;
          scheduled_time: string;
      }
    | {
          error_message: string;
      } {
    const recurrence = String($root.find(".recurring-frequency-input").val() ?? "");
    const send_time = String($root.find(".recurring-time-input").val() ?? "");

    if (recurrence === "" || send_time === "") {
        return {
            error_message: $t({defaultMessage: "Select a recurrence and time."}),
        };
    }

    if (recurrence === "weekly") {
        const selected_weekdays: number[] = [];
        $root.find<HTMLInputElement>(".recurring-weekday:checked").each(function () {
            const weekday = WEEKDAY_TO_NUMBER.get(String($(this).val()));
            if (weekday !== undefined) {
                selected_weekdays.push(weekday);
            }
        });

        if (selected_weekdays.length === 0) {
            return {
                error_message: $t({
                    defaultMessage: "For weekly recurrence, choose at least one day.",
                }),
            };
        }

        return {
            recurrence_type: recurrence,
            recurrence_days: JSON.stringify(selected_weekdays),
            scheduled_time: send_time,
        };
    }

    if (recurrence === "monthly") {
        const selected_monthly_mode = String(
            $root.find(".recurring-monthly-mode:checked").first().val() ?? "day",
        );

        let recurrence_days:
            | {
                  day: number;
                  type: "calendar_day";
              }
            | {
                  ordinal: number;
                  type: "ordinal_weekday";
                  weekday: number;
              };

        if (selected_monthly_mode === "last_day") {
            recurrence_days = {type: "calendar_day", day: -1};
        } else if (selected_monthly_mode === "weekday") {
            const ordinal_map = new Map([
                ["first", 1],
                ["second", 2],
                ["third", 3],
                ["fourth", 4],
                ["last", -1],
            ]);
            const selected_ordinal = String(
                $root.find(".recurring-monthly-ordinal-input").val() ?? "",
            );
            const selected_weekday = String(
                $root.find(".recurring-monthly-weekday-input").val() ?? "",
            );
            const ordinal = ordinal_map.get(selected_ordinal);
            const weekday = WEEKDAY_TO_NUMBER.get(selected_weekday);

            if (ordinal === undefined || weekday === undefined) {
                return {
                    error_message: $t({
                        defaultMessage: "For monthly recurrence, choose a weekday rule.",
                    }),
                };
            }

            recurrence_days = {
                type: "ordinal_weekday",
                ordinal,
                weekday,
            };
        } else {
            const selected_monthday = Number($root.find(".recurring-monthday-input").val() ?? "");
            if (!Number.isInteger(selected_monthday)) {
                return {
                    error_message: $t({
                        defaultMessage: "For monthly recurrence, choose a day of the month.",
                    }),
                };
            }
            recurrence_days = {type: "calendar_day", day: selected_monthday};
        }

        return {
            recurrence_type: recurrence,
            recurrence_days: JSON.stringify(recurrence_days),
            scheduled_time: send_time,
        };
    }

    return {
        recurrence_type: recurrence,
        recurrence_days: JSON.stringify([]),
        scheduled_time: send_time,
    };
}

// ---------------------------------------------------------------------------
// Wire recurring form fields in any jQuery root element
// ---------------------------------------------------------------------------

/**
 * Initialize the recurring-schedule form fields inside any jQuery root element.
 * ($root can be a popover, a modal, or any container holding the
 * recurring_fields.hbs partial.)
 *
 * Only wires up field interactions — show/hide conditional sections, populate
 * option lists, update summary text. Does NOT attach a submit handler; callers
 * wire their own submit logic after calling this.
 *
 * Pass `destination_summary` to pre-fill `.recurring-builder-destination-summary`
 * (used by the popover to show the compose-box destination). Omit it for the
 * unified modal, which manages its own destinations section separately.
 */
export function initialize_recurring_fields(
    $root: JQuery,
    destination_summary?: string,
): void {
    if ($root.data("recurring-builder-initialized") === true) {
        return;
    }
    $root.data("recurring-builder-initialized", true);

    const $frequency = $root.find(".recurring-frequency-input");
    const $weekly_options = $root.find(".recurring-weekly-options");
    const $monthly_options = $root.find(".recurring-monthly-options");
    const $monthday_input = $root.find(".recurring-monthday-input");
    const $monthly_ordinal_input = $root.find(".recurring-monthly-ordinal-input");
    const $monthly_weekday_input = $root.find(".recurring-monthly-weekday-input");
    const $monthly_mode_inputs = $root.find<HTMLInputElement>(".recurring-monthly-mode");
    const $short_month_note = $root.find(".recurring-short-month-note");
    const $monthly_summary = $root.find(".recurring-monthly-summary");
    const $destination_summary_el = $root.find(".recurring-builder-destination-summary");

    if (destination_summary !== undefined) {
        $destination_summary_el.text(destination_summary);
    }

    for (let day = 1; day <= 31; day += 1) {
        $monthday_input.append(
            $("<option>").attr("value", day).text(get_monthly_day_option_label(day)),
        );
    }
    $monthday_input.val("1");

    for (const ordinal of ["first", "second", "third", "fourth", "last"]) {
        $monthly_ordinal_input.append(
            $("<option>").attr("value", ordinal).text(get_monthly_ordinal_label(ordinal)),
        );
    }
    $monthly_ordinal_input.val("first");

    for (const weekday of ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]) {
        $monthly_weekday_input.append(
            $("<option>").attr("value", weekday).text(get_monthly_weekday_label(weekday)),
        );
    }
    $monthly_weekday_input.val("MO");

    const get_selected_monthly_mode = (): string => {
        const selected_monthly_mode = $monthly_mode_inputs.filter(":checked").first().val();
        return typeof selected_monthly_mode === "string" ? selected_monthly_mode : "day";
    };

    const refresh_monthly_selector = (): void => {
        const selected_monthly_mode = get_selected_monthly_mode();
        const use_day_selector = selected_monthly_mode === "day";
        const use_weekday_selector = selected_monthly_mode === "weekday";
        $monthday_input.prop("disabled", !use_day_selector);
        $monthly_ordinal_input.prop("disabled", !use_weekday_selector);
        $monthly_weekday_input.prop("disabled", !use_weekday_selector);

        const selected_monthday = Number($monthday_input.val());
        $short_month_note.toggleClass(
            "recurring-hidden",
            !(selected_monthly_mode === "day" && selected_monthday >= 29),
        );
    };

    const refresh_monthly_summary = (): void => {
        const selected_monthly_mode = get_selected_monthly_mode();
        let summary = "";

        if (selected_monthly_mode === "last_day") {
            summary = $t({defaultMessage: "Repeats on the last day of every month."});
        } else if (selected_monthly_mode === "weekday") {
            const ordinal = String($monthly_ordinal_input.val() ?? "first");
            const weekday = String($monthly_weekday_input.val() ?? "MO");
            summary = $t(
                {defaultMessage: "Repeats on the {ordinal} {weekday} of every month."},
                {
                    ordinal: get_monthly_ordinal_label(ordinal),
                    weekday: get_monthly_weekday_label(weekday),
                },
            );
        } else {
            const selected_monthday = Number($monthday_input.val());
            summary = $t(
                {defaultMessage: "Repeats on the {day} of every month."},
                {day: get_ordinal_day_label(selected_monthday)},
            );
        }

        $monthly_summary.text(summary);
    };

    const refresh_custom_options = (): void => {
        const recurrence = $frequency.val();
        $weekly_options.toggleClass("recurring-hidden", recurrence !== "weekly");
        $monthly_options.toggleClass("recurring-hidden", recurrence !== "monthly");
    };
    refresh_custom_options();
    refresh_monthly_selector();
    refresh_monthly_summary();
    $frequency.on("change", refresh_custom_options);
    $monthly_mode_inputs.on("change", () => {
        refresh_monthly_selector();
        refresh_monthly_summary();
    });
    $monthday_input.on("change", () => {
        refresh_monthly_selector();
        refresh_monthly_summary();
    });
    $monthly_ordinal_input.on("change", refresh_monthly_summary);
    $monthly_weekday_input.on("change", refresh_monthly_summary);
}
