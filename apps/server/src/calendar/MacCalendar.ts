import {
  MAC_CALENDAR_CONNECTION_ID,
  MAC_CALENDAR_LABEL,
  MacCalendarError,
  type MacCalendarErrorReason,
  type MacCalendarInspectResult,
  type MacCalendarSettings,
  type MacCalendarSetupResult,
  type MacCalendarSummary,
  type MacCalendarUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as BotTurnContext from "../bots/BotTurnContext.ts";
import * as McpCallerChanges from "../mcp/McpCallerChanges.ts";
import * as Settings from "../serverSettings.ts";
import * as MacCalendarHelper from "./MacCalendarHelper.ts";

/** Above the helper's own deadlines (30 s, setup 3 min), so its timeout answer still arrives. */
const READ_TIMEOUT = Duration.seconds(40);
const SETUP_TIMEOUT = Duration.minutes(4);

const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 100;

const HelperCalendar = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  sourceName: Schema.String,
});
const HelperEvent = Schema.Struct({
  title: Schema.String,
  calendar: Schema.Struct({ id: Schema.String, title: Schema.String }),
  start: Schema.String,
  end: Schema.String,
  allDay: Schema.Boolean,
  timeZone: Schema.String,
});
const HelperResponse = Schema.Union([
  Schema.Struct({ status: Schema.Struct({ authorization: Schema.String }) }),
  Schema.Struct({ calendars: Schema.Struct({ items: Schema.Array(HelperCalendar) }) }),
  Schema.Struct({
    events: Schema.Struct({
      items: Schema.Array(HelperEvent),
      truncated: Schema.optionalKey(Schema.Boolean),
    }),
  }),
  Schema.Struct({ error: Schema.Struct({ code: Schema.String }) }),
]);
type HelperResponse = typeof HelperResponse.Type;
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(HelperResponse));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export type CalendarEvent = typeof HelperEvent.Type;

export interface ListEventsInput {
  readonly start: string;
  readonly end: string;
  readonly calendar_ids?: ReadonlyArray<string> | undefined;
  readonly limit?: number | undefined;
}

export interface ListEventsResult {
  readonly timeZone: string;
  /** The calendars searched, from the user's selection. */
  readonly calendars: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly events: ReadonlyArray<CalendarEvent>;
  readonly truncated: boolean;
}

/** The thread an MCP read comes from, as its credential authenticated it. */
export interface CalendarCaller {
  readonly threadId: ThreadId;
  /** Sent from a load sealed for a restricted run, such as a Home check. */
  readonly sealedLoad: boolean;
}

/** A model's read that was refused or failed; the message is for the model. */
export class MacCalendarReadError extends Schema.TaggedError<MacCalendarReadError>()(
  "MacCalendarReadError",
  {
    code: Schema.Literals(["capability_denied", "invalid_request", "orchestration_error"]),
    message: Schema.String,
  },
) {}

const readError = (code: MacCalendarReadError["code"], message: string) =>
  new MacCalendarReadError({ code, message });

const NOT_GRANTED = `${MAC_CALENDAR_LABEL} is not granted to this Bot. The user can grant it in the Bot's settings.`;

/** One helper exchange's failure, before it is mapped for a client or a model. */
class HelperFailure extends Schema.TaggedError<HelperFailure>()("HelperFailure", {
  reason: Schema.Literals(["not-authorized", "unknown-calendar", "invalid-request", "failed"]),
}) {}

export class MacCalendar extends Context.Service<
  MacCalendar,
  {
    /** Settings and whether the helper is installed; never launches the helper. */
    readonly summary: Effect.Effect<MacCalendarSummary, MacCalendarError>;
    /** The helper's permission and, with Full Access, every calendar to choose from. */
    readonly inspect: Effect.Effect<MacCalendarInspectResult, MacCalendarError>;
    /** The only path to the helper's `setup`, which may raise the macOS prompt. */
    readonly setup: Effect.Effect<MacCalendarSetupResult, MacCalendarError>;
    readonly update: (
      input: MacCalendarUpdateInput,
    ) => Effect.Effect<MacCalendarSummary, MacCalendarError>;
    /**
     * A model's read. Checked on every call against the caller's Bot grant now, the run it
     * belongs to and the selected calendars, so a tool name a provider kept cannot widen it.
     */
    readonly listEvents: (
      caller: CalendarCaller,
      input: ListEventsInput,
    ) => Effect.Effect<ListEventsResult, MacCalendarReadError>;
  }
>()("t3/calendar/MacCalendar") {}

const RFC3339 =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$/i;
const LOCAL_DATE = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

/**
 * A bound the helper accepts: RFC 3339 with an offset as given, or a bare date as midnight on
 * this Mac. Undefined when it is neither.
 */
function calendarBound(value: string): { readonly text: string; readonly at: number } | undefined {
  if (RFC3339.test(value)) {
    const at = Date.parse(value);
    return Number.isNaN(at) ? undefined : { text: value, at };
  }
  const date = LOCAL_DATE.exec(value);
  if (date === null) return undefined;
  // The host's own zone and DST rules, which the helper reads events in.
  // @effect-diagnostics-next-line globalDate:off
  const local = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
  if (local.getDate() !== Number(date[3])) return undefined;
  const offset = -local.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  return {
    text: `${value}T00:00:00${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`,
    at: local.getTime(),
  };
}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const helper = yield* MacCalendarHelper.MacCalendarHelper;
  const turns = yield* BotTurnContext.BotTurnContext;
  const callerChanges = yield* McpCallerChanges.McpCallerChanges;

  /** One request with its own deadline. A missing, empty or malformed response is a failure. */
  const call = Effect.fn("MacCalendar.call")(function* (
    request: Record<string, unknown>,
    timeout: Duration.Duration,
  ) {
    const response = yield* helper.exchange(encodeRequest(request)).pipe(
      Effect.timeoutOption(timeout),
      Effect.mapError(() => new HelperFailure({ reason: "failed" })),
    );
    const text = Option.getOrUndefined(response);
    if (text === undefined || text.trim() === "") {
      return yield* new HelperFailure({ reason: "failed" });
    }
    const decoded = decodeResponse(text);
    if (Option.isNone(decoded)) return yield* new HelperFailure({ reason: "failed" });
    const value: HelperResponse = decoded.value;
    if ("error" in value) {
      return yield* new HelperFailure({
        reason:
          value.error.code === "notAuthorized"
            ? "not-authorized"
            : value.error.code === "unknownCalendar"
              ? "unknown-calendar"
              : value.error.code === "invalidRequest"
                ? "invalid-request"
                : "failed",
      });
    }
    return value;
  });

  const clientError = (reason: MacCalendarErrorReason) => new MacCalendarError({ reason });
  const fromHelper = (failure: HelperFailure) =>
    clientError(
      failure.reason === "not-authorized"
        ? "not-authorized"
        : failure.reason === "unknown-calendar"
          ? "unknown-calendar"
          : "helper-failed",
    );

  const requireAvailable = Effect.gen(function* () {
    const availability = yield* helper.availability;
    if (availability !== "available") return yield* clientError(availability);
  });

  const readSettings = settings.getSettings.pipe(
    Effect.map((current) => current.macCalendar),
    Effect.mapError((cause) => new MacCalendarError({ reason: "settings-unavailable", cause })),
  );

  const summaryOf = (stored: MacCalendarSettings) =>
    helper.availability.pipe(
      Effect.map((availability): MacCalendarSummary => ({
        id: MAC_CALENDAR_CONNECTION_ID,
        label: MAC_CALENDAR_LABEL,
        availability,
        enabled: stored.enabled,
        revision: stored.revision,
        calendars: stored.calendars,
      })),
    );

  const summary = readSettings.pipe(
    Effect.flatMap(summaryOf),
    Effect.withSpan("MacCalendar.summary"),
  );

  const authorizationOf = (response: HelperResponse) =>
    "status" in response ? Effect.succeed(response.status.authorization) : Effect.fail(undefined);

  const listCalendars = call({ command: "list-calendars" }, READ_TIMEOUT).pipe(
    Effect.flatMap((response) =>
      "calendars" in response
        ? Effect.succeed(response.calendars.items)
        : Effect.fail(new HelperFailure({ reason: "failed" })),
    ),
  );

  const inspect = Effect.gen(function* () {
    yield* requireAvailable;
    const authorization = yield* call({ command: "status" }, READ_TIMEOUT).pipe(
      Effect.flatMap(authorizationOf),
      Effect.mapError((failure) =>
        failure === undefined ? clientError("helper-failed") : fromHelper(failure),
      ),
    );
    if (authorization !== "fullAccess") return { authorization, calendars: [] };
    const calendars = yield* listCalendars.pipe(Effect.mapError(fromHelper));
    return {
      authorization,
      calendars: calendars.map(({ id, title, sourceName }) => ({ id, title, sourceName })),
    };
  }).pipe(Effect.withSpan("MacCalendar.inspect"));

  const setup = Effect.gen(function* () {
    yield* requireAvailable;
    const authorization = yield* call({ command: "setup" }, SETUP_TIMEOUT).pipe(
      Effect.flatMap(authorizationOf),
      Effect.mapError((failure) =>
        failure === undefined ? clientError("helper-failed") : fromHelper(failure),
      ),
    );
    return { authorization };
  }).pipe(Effect.withSpan("MacCalendar.setup"));

  const update = Effect.fn("MacCalendar.update")(function* (input: MacCalendarUpdateInput) {
    // Titles come from this Mac, never from the client, and only calendars it has are saved.
    const chosen =
      input.calendarIds === undefined
        ? undefined
        : yield* Effect.gen(function* () {
            if (input.calendarIds === undefined || input.calendarIds.length === 0) return [];
            yield* requireAvailable;
            const onThisMac = yield* listCalendars.pipe(Effect.mapError(fromHelper));
            const byId = new Map(onThisMac.map((calendar) => [calendar.id, calendar.title]));
            const ids = [...new Set(input.calendarIds)];
            if (ids.some((id) => !byId.has(id))) return yield* clientError("unknown-calendar");
            return ids.map((id) => ({ id, title: byId.get(id) ?? "" }));
          });
    const saved = yield* settings
      .updateMcpConnections((current) => {
        const stored = current.macCalendar;
        if (stored.revision !== input.expectedRevision) {
          return Effect.fail(clientError("revision-conflict"));
        }
        return Effect.succeed({
          mcpConnections: current.mcpConnections,
          retiredMcpConnectionIds: current.retiredMcpConnectionIds,
          macCalendar: {
            enabled: input.enabled ?? stored.enabled,
            revision: stored.revision + 1,
            calendars: chosen ?? stored.calendars,
          },
        });
      })
      .pipe(
        Effect.catchTags({
          ServerSettingsError: (cause) =>
            Effect.fail(new MacCalendarError({ reason: "settings-unavailable", cause })),
        }),
      );
    return yield* summaryOf(saved.macCalendar);
  });

  const listEvents = Effect.fn("MacCalendar.listEvents")(function* (
    caller: CalendarCaller,
    input: ListEventsInput,
  ) {
    // Home checks load no connections; a sealed or restricted caller is one, whatever it names.
    if (caller.sealedLoad) {
      return yield* readError(
        "capability_denied",
        `Home checks have no access to ${MAC_CALENDAR_LABEL}.`,
      );
    }
    const changes = yield* callerChanges.forThread(caller.threadId);
    if (changes === "botNote" || changes === "botWaiting") {
      return yield* readError(
        "capability_denied",
        `Home checks have no access to ${MAC_CALENDAR_LABEL}.`,
      );
    }
    const access = yield* turns
      .mcpAccessForThreadId(caller.threadId)
      .pipe(
        Effect.mapError(() =>
          readError("orchestration_error", "This Bot's grants could not be read. Try again."),
        ),
      );
    if (access._tag !== "bot" || !access.connectionIds.includes(MAC_CALENDAR_CONNECTION_ID)) {
      return yield* readError("capability_denied", NOT_GRANTED);
    }
    const stored = yield* settings.getSettings.pipe(
      Effect.map((current) => current.macCalendar),
      Effect.mapError(() =>
        readError("orchestration_error", `${MAC_CALENDAR_LABEL} could not be read. Try again.`),
      ),
    );
    if (!stored.enabled) {
      return yield* readError(
        "capability_denied",
        `${MAC_CALENDAR_LABEL} is turned off in Settings → MCP connections.`,
      );
    }
    if (stored.calendars.length === 0) {
      return yield* readError(
        "capability_denied",
        `No calendars are selected for ${MAC_CALENDAR_LABEL}. The user selects them in Settings → MCP connections.`,
      );
    }
    const start = calendarBound(input.start);
    const end = calendarBound(input.end);
    if (start === undefined || end === undefined) {
      return yield* readError(
        "invalid_request",
        "start and end must be dates (YYYY-MM-DD, midnight on this Mac) or RFC 3339 timestamps with seconds and an offset.",
      );
    }
    if (end.at <= start.at || end.at - start.at > MAX_WINDOW_MS) {
      return yield* readError(
        "invalid_request",
        "end must be after start, at most 14 days later. Split longer ranges.",
      );
    }
    const limit = input.limit ?? DEFAULT_EVENT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
      return yield* readError("invalid_request", "limit must be an integer from 1 to 100.");
    }
    const selected = new Map(stored.calendars.map((calendar) => [calendar.id, calendar]));
    const requested =
      input.calendar_ids === undefined ? undefined : [...new Set(input.calendar_ids)];
    const outside = requested?.filter((id) => !selected.has(id)) ?? [];
    if (requested?.length === 0 || outside.length > 0) {
      return yield* readError(
        "capability_denied",
        `Only the calendars the user selected can be read: ${stored.calendars
          .map((calendar) => `"${calendar.title}" (${calendar.id})`)
          .join(", ")}.`,
      );
    }
    const calendars =
      requested === undefined
        ? stored.calendars
        : requested.flatMap((id) => {
            const calendar = selected.get(id);
            return calendar === undefined ? [] : [calendar];
          });
    const availability = yield* helper.availability;
    if (availability !== "available") {
      return yield* readError(
        "orchestration_error",
        availability === "unsupported"
          ? `${MAC_CALENDAR_LABEL} needs macOS 14 or later.`
          : "The T3 Calendar Helper is not installed on this Mac. Tell the user.",
      );
    }
    const response = yield* call(
      {
        command: "list-events",
        start: start.text,
        end: end.text,
        calendarIds: calendars.map((calendar) => calendar.id),
        limit,
      },
      READ_TIMEOUT,
    ).pipe(
      Effect.mapError((failure) =>
        failure.reason === "not-authorized"
          ? readError(
              "orchestration_error",
              "T3 Calendar Helper has no Full Access to Calendars on this Mac. Tell the user to connect Calendar in Settings → MCP connections on the Mac.",
            )
          : failure.reason === "unknown-calendar"
            ? readError(
                "orchestration_error",
                "A selected calendar is no longer on this Mac. Tell the user to review the selection in Settings → MCP connections.",
              )
            : failure.reason === "invalid-request"
              ? readError("invalid_request", "The calendar helper refused these bounds.")
              : readError(
                  "orchestration_error",
                  "The calendar helper did not answer. Try again later.",
                ),
      ),
    );
    if (!("events" in response)) {
      return yield* readError(
        "orchestration_error",
        "The calendar helper did not answer. Try again later.",
      );
    }
    return {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      calendars: calendars.map(({ id, title }) => ({ id, title })),
      events: response.events.items,
      truncated: response.events.truncated === true,
    } satisfies ListEventsResult;
  });

  return MacCalendar.of({ summary, inspect, setup, update, listEvents });
});

export const layer = Layer.effect(MacCalendar, make);
