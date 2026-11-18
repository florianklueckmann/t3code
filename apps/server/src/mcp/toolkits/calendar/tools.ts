import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as MacCalendar from "../../../calendar/MacCalendar.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
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
    calendars: Schema.Array(CalendarRef),
    events: Schema.Array(
      Schema.Struct({
        title: Schema.String,
        calendar: CalendarRef,
        start: Schema.String,
        end: Schema.String,
        allDay: Schema.Boolean,
        timeZone: Schema.String,
      }),
    ),
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

export const CalendarToolkit = Toolkit.make(ListEventsTool);
