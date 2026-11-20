import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { CreateEvent, DeleteEvent, UpdateEvent } from "../../../calendar/CalendarMutation.ts";
import * as MacCalendar from "../../../calendar/MacCalendar.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpCallerChanges from "../../McpCallerChanges.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Lists only on a granted Calendar (this Mac) server, never on T3 Code's own (`McpHttpServer`). */
export const CALENDAR_LIST_EVENTS_TOOL = "list_events";

const CalendarRef = Schema.Struct({ id: Schema.String, title: Schema.String });

const ListEventsTool = Tool.make(CALENDAR_LIST_EVENTS_TOOL, {
  description:
    "Read events from the calendars the user shared with you from their Mac. Read-only. `start` and `end` are dates (YYYY-MM-DD, midnight on the Mac; for one day, pass that date and the next) or RFC 3339 timestamps with seconds and an offset; at most 14 days apart. All-day events have dates with an exclusive end; timed events carry the Mac's offset and `timeZone`. `truncated: true` means more events matched than `limit`: narrow the range or raise the limit.",
  parameters: Schema.Struct({
    start: Schema.String.annotate({
      description: "Start of the range: YYYY-MM-DD, or RFC 3339 like 2026-11-18T09:00:00+01:00.",
    }),
    end: Schema.String.annotate({
      description: "Exclusive end of the range, in the same forms.",
    }),
    calendar_ids: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        description:
          "Only these calendars, by id from `calendars` in an earlier result. Omit for all shared calendars.",
      }),
    ),
    limit: Schema.optionalKey(
      Schema.Int.annotate({ description: "Most events to return, 1 to 100. Default 50." }),
    ),
  }),
  success: Schema.Struct({
    timeZone: Schema.String,
    calendars: Schema.Array(
      Schema.Struct({
        ...CalendarRef.fields,
        writable: Schema.optionalKey(Schema.Boolean),
      }),
    ),
    events: Schema.Array(MacCalendar.CalendarEventSchema),
    truncated: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MacCalendar.MacCalendar,
  ],
})
  .annotate(Tool.Title, "List calendar events")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const writeOptions = {
  success: MacCalendar.CalendarWriteResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    MacCalendar.MacCalendar,
    McpCallerChanges.McpCallerChanges,
  ],
};

const CreateEventTool = Tool.make("create_event", {
  ...writeOptions,
  description:
    "Create one event in a calendar marked writable by list_events. Use the exact calendar id. For timed events give RFC 3339 start and end with seconds and the IANA time zone; all-day events use dates on this Mac with an exclusive end. No guests, series, or reminders. Calendar changes are limited to three per turn. If the result is uncertain, check list_events before trying again.",
  parameters: CreateEvent,
})
  .annotate(Tool.Title, "Create a calendar event")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const UpdateEventTool = Tool.make("update_event", {
  ...writeOptions,
  description:
    "Change the title or time of one event on a writable calendar. Use the calendar id, reference, revision and original start from list_events. To move it, supply both start and end plus the IANA time zone. Leave other fields untouched. In an unattended run only change events created by this Bot. If the event changed, read it again before acting.",
  parameters: UpdateEvent,
})
  .annotate(Tool.Title, "Update a calendar event")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const DeleteEventTool = Tool.make("delete_event", {
  ...writeOptions,
  description:
    "Delete one event on a writable calendar when asked. Use the calendar id, reference, revision and start from list_events. In an unattended run only delete events created by this Bot. If the event changed, read it again before acting.",
  parameters: DeleteEvent,
})
  .annotate(Tool.Title, "Delete a calendar event")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const CalendarToolkit = Toolkit.make(
  ListEventsTool,
  CreateEventTool,
  UpdateEventTool,
  DeleteEventTool,
);
export const CALENDAR_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(CalendarToolkit.tools));
