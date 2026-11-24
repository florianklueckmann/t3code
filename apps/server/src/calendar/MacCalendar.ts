import {
  MAC_CALENDAR_CONNECTION_ID,
  MAC_CALENDAR_LABEL,
  MacCalendarError,
  type MacCalendarErrorReason,
  macCalendarsForBot,
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
import * as Semaphore from "effect/Semaphore";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";

import * as BotTurnContext from "../bots/BotTurnContext.ts";
import * as McpCallerChanges from "../mcp/McpCallerChanges.ts";
import * as Settings from "../serverSettings.ts";
import * as MacCalendarHelper from "./MacCalendarHelper.ts";
import type { CalendarMutation } from "./CalendarMutation.ts";
import * as CalendarWriteStore from "./CalendarWriteStore.ts";

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
  writable: Schema.optionalKey(Schema.Boolean),
});
export const CalendarEventSchema = Schema.Struct({
  title: Schema.String,
  calendar: Schema.Struct({ id: Schema.String, title: Schema.String }),
  start: Schema.String,
  end: Schema.String,
  allDay: Schema.Boolean,
  timeZone: Schema.String,
  reference: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(Schema.String),
});
export const CalendarWriteResult = Schema.Struct({
  event: Schema.optionalKey(CalendarEventSchema),
  deleted: Schema.Boolean,
});

const HelperResponse = Schema.Union([
  Schema.Struct({ status: Schema.Struct({ authorization: Schema.String }) }),
  Schema.Struct({ calendars: Schema.Struct({ items: Schema.Array(HelperCalendar) }) }),
  Schema.Struct({
    events: Schema.Struct({
      items: Schema.Array(CalendarEventSchema),
      truncated: Schema.optionalKey(Schema.Boolean),
    }),
  }),
  Schema.Struct({ mutation: Schema.Struct({ event: Schema.optionalKey(CalendarEventSchema) }) }),
  Schema.Struct({ error: Schema.Struct({ code: Schema.String }) }),
]);
type HelperResponse = typeof HelperResponse.Type;
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(HelperResponse));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export type CalendarEvent = typeof CalendarEventSchema.Type;

export interface ListEventsInput {
  readonly start: string;
  readonly end: string;
  readonly calendar_ids?: ReadonlyArray<string> | undefined;
  readonly limit?: number | undefined;
}

export interface ListEventsResult {
  readonly timeZone: string;
  /** The calendars searched, from the user's selection. */
  readonly calendars: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly writable?: boolean;
  }>;
  readonly events: ReadonlyArray<CalendarEvent>;
  readonly truncated: boolean;
}

/** The thread an MCP read comes from, as its credential authenticated it. */
export interface CalendarCaller {
  readonly threadId: ThreadId;
  /** Sent from a load sealed for a restricted run, such as a Home check. */
  readonly sealedLoad: boolean;
  readonly subagent?: boolean;
}

/** A calendar tool call that was refused or failed; the message is for the model. */
export class MacCalendarToolError extends Schema.TaggedError<MacCalendarToolError>()(
  "MacCalendarToolError",
  {
    code: Schema.Literals(["capability_denied", "invalid_request", "orchestration_error"]),
    message: Schema.String,
  },
) {}

const decodeWrite = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([CalendarWriteResult, MacCalendarToolError])),
);

const toolError = (code: MacCalendarToolError["code"], message: string) =>
  new MacCalendarToolError({ code, message });

const NOT_GRANTED = `${MAC_CALENDAR_LABEL} is not granted to this Bot. The user can grant it in the Bot's settings.`;

/** One helper exchange's failure, before it is mapped for a client or a model. */
class HelperFailure extends Schema.TaggedError<HelperFailure>()("HelperFailure", {
  reason: Schema.Literals([
    "not-authorized",
    "unknown-calendar",
    "invalid-request",
    "read-only-calendar",
    "event-not-found",
    "event-changed",
    "unsupported-event",
    "event-not-owned",
    "failed",
  ]),
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
    ) => Effect.Effect<ListEventsResult, MacCalendarToolError>;
    readonly canWrite: (caller: CalendarCaller) => Effect.Effect<boolean>;
    readonly mutate: (
      caller: CalendarCaller,
      mutation: CalendarMutation,
    ) => Effect.Effect<typeof CalendarWriteResult.Type, MacCalendarToolError>;
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

function calendarWriteRefusal(reason: Exclude<HelperFailure["reason"], "failed">) {
  switch (reason) {
    case "event-changed":
    case "event-not-found":
      return toolError(
        "invalid_request",
        "The event has changed or is missing. List events again.",
      );
    case "unsupported-event":
      return toolError("invalid_request", "Only single events without attendees can be changed.");
    case "not-authorized":
    case "read-only-calendar":
    case "unknown-calendar":
    case "event-not-owned":
      return toolError(
        "capability_denied",
        "The helper refused the calendar or event. No change was made.",
      );
    case "invalid-request":
      return toolError(
        "invalid_request",
        "The helper rejected the write. Check the input and that the helper is up to date.",
      );
  }
}

function normalizeWriteRange(range: {
  readonly start: string;
  readonly end: string;
  readonly time_zone: string;
}) {
  const start = calendarBound(range.start);
  const end = calendarBound(range.end);
  const allDay = LOCAL_DATE.test(range.start);
  if (
    start === undefined ||
    end === undefined ||
    allDay !== LOCAL_DATE.test(range.end) ||
    end.at <= start.at ||
    end.at - start.at > MAX_WINDOW_MS
  )
    return undefined;
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const zone = Intl.DateTimeFormat("en", { timeZone: range.time_zone }).resolvedOptions()
      .timeZone;
    if (allDay && zone !== hostZone) return undefined;
    return { start, end, allDay, timeZone: zone };
  } catch {
    return undefined;
  }
}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const helper = yield* MacCalendarHelper.MacCalendarHelper;
  const turns = yield* BotTurnContext.BotTurnContext;
  const callerChanges = yield* McpCallerChanges.McpCallerChanges;
  const writes = yield* CalendarWriteStore.CalendarWriteStore;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const writeLock = yield* Semaphore.make(1);

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
      const reasons = new Map<string, HelperFailure["reason"]>(
        Object.entries({
          notAuthorized: "not-authorized",
          unknownCalendar: "unknown-calendar",
          invalidRequest: "invalid-request",
          readOnlyCalendar: "read-only-calendar",
          eventNotFound: "event-not-found",
          eventChanged: "event-changed",
          unsupportedEvent: "unsupported-event",
          eventNotOwned: "event-not-owned",
        } as const),
      );
      return yield* new HelperFailure({ reason: reasons.get(value.error.code) ?? "failed" });
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
      calendars,
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
    const changesSelection =
      input.calendarIds !== undefined || input.writableCalendarIds !== undefined;
    const needsCatalog =
      (input.calendarIds?.length ?? 0) > 0 || (input.writableCalendarIds?.length ?? 0) > 0;
    const catalog = needsCatalog
      ? yield* requireAvailable.pipe(
          Effect.andThen(listCalendars),
          Effect.mapError((error) => (error._tag === "HelperFailure" ? fromHelper(error) : error)),
        )
      : [];
    const byId = new Map(catalog.map((calendar) => [calendar.id, calendar]));
    const saved = yield* settings
      .updateMcpConnections((current) =>
        Effect.gen(function* () {
          const stored = current.macCalendar;
          if (stored.revision !== input.expectedRevision) {
            return yield* clientError("revision-conflict");
          }
          const selectedIds = [
            ...new Set(input.calendarIds ?? stored.calendars.map(({ id }) => id)),
          ];
          if (input.calendarIds?.some((id) => !byId.has(id))) {
            return yield* clientError("unknown-calendar");
          }
          const writableIds = new Set(
            input.writableCalendarIds ??
              stored.calendars.filter((entry) => entry.allowWrite === true).map(({ id }) => id),
          );
          if (
            input.writableCalendarIds?.some(
              (id) => !selectedIds.includes(id) || byId.get(id)?.writable !== true,
            )
          ) {
            return yield* clientError("calendar-read-only");
          }
          return {
            mcpConnections: current.mcpConnections,
            retiredMcpConnectionIds: current.retiredMcpConnectionIds,
            macCalendar: {
              enabled: input.enabled ?? stored.enabled,
              revision: stored.revision + 1,
              calendars: changesSelection
                ? selectedIds.map((id) => ({
                    id,
                    title:
                      byId.get(id)?.title ??
                      stored.calendars.find((entry) => entry.id === id)?.title ??
                      "",
                    ...(writableIds.has(id) && byId.get(id)?.writable === true
                      ? { allowWrite: true }
                      : {}),
                  }))
                : stored.calendars,
            },
          };
        }),
      )
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
      return yield* toolError(
        "capability_denied",
        `Home checks have no access to ${MAC_CALENDAR_LABEL}.`,
      );
    }
    const changes = yield* callerChanges.forThread(caller.threadId);
    if (changes === "botNote" || changes === "botWaiting") {
      return yield* toolError(
        "capability_denied",
        `Home checks have no access to ${MAC_CALENDAR_LABEL}.`,
      );
    }
    // The selection before the grant: a calendar selected again leaves every choice before it is
    // saved, so a choice read after a selection that has it no longer holds a stale entry.
    const stored = yield* settings.getSettings.pipe(
      Effect.map((current) => current.macCalendar),
      Effect.mapError(() =>
        toolError("orchestration_error", `${MAC_CALENDAR_LABEL} could not be read. Try again.`),
      ),
    );
    const access = yield* turns
      .mcpAccessForThreadId(caller.threadId)
      .pipe(
        Effect.mapError(() =>
          toolError("orchestration_error", "This Bot's grants could not be read. Try again."),
        ),
      );
    if (access._tag !== "bot" || !access.connectionIds.includes(MAC_CALENDAR_CONNECTION_ID)) {
      return yield* toolError("capability_denied", NOT_GRANTED);
    }
    if (!stored.enabled) {
      return yield* toolError(
        "capability_denied",
        `${MAC_CALENDAR_LABEL} is turned off in Settings → MCP connections.`,
      );
    }
    if (stored.calendars.length === 0) {
      return yield* toolError(
        "capability_denied",
        `No calendars are selected for ${MAC_CALENDAR_LABEL}. The user selects them in Settings → MCP connections.`,
      );
    }
    const shared = macCalendarsForBot(stored.calendars, access.calendarIds);
    if (shared.length === 0) {
      return yield* toolError(
        "capability_denied",
        `No calendars are chosen for this Bot. The user chooses them in the Bot's settings.`,
      );
    }
    const start = calendarBound(input.start);
    const end = calendarBound(input.end);
    if (start === undefined || end === undefined) {
      return yield* toolError(
        "invalid_request",
        "start and end must be dates (YYYY-MM-DD, midnight on this Mac) or RFC 3339 timestamps with seconds and an offset.",
      );
    }
    if (end.at <= start.at || end.at - start.at > MAX_WINDOW_MS) {
      return yield* toolError(
        "invalid_request",
        "end must be after start, at most 14 days later. Split longer ranges.",
      );
    }
    const limit = input.limit ?? DEFAULT_EVENT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
      return yield* toolError("invalid_request", "limit must be an integer from 1 to 100.");
    }
    const selected = new Map(shared.map((calendar) => [calendar.id, calendar]));
    const requested =
      input.calendar_ids === undefined ? undefined : [...new Set(input.calendar_ids)];
    const outside = requested?.filter((id) => !selected.has(id)) ?? [];
    if (requested?.length === 0 || outside.length > 0) {
      return yield* toolError(
        "capability_denied",
        `Only the calendars the user shared with this Bot can be read: ${shared
          .map((calendar) => `"${calendar.title}" (${calendar.id})`)
          .join(", ")}.`,
      );
    }
    const calendars =
      requested === undefined
        ? shared
        : requested.flatMap((id) => {
            const calendar = selected.get(id);
            return calendar === undefined ? [] : [calendar];
          });
    const availability = yield* helper.availability;
    if (availability !== "available") {
      return yield* toolError(
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
          ? toolError(
              "orchestration_error",
              "T3 Calendar Helper has no Full Access to Calendars on this Mac. Tell the user to connect Calendar in Settings → MCP connections on the Mac.",
            )
          : failure.reason === "unknown-calendar"
            ? toolError(
                "orchestration_error",
                "A selected calendar is no longer on this Mac. Tell the user to review the selection in Settings → MCP connections.",
              )
            : failure.reason === "invalid-request"
              ? toolError("invalid_request", "The calendar helper refused these bounds.")
              : toolError(
                  "orchestration_error",
                  "The calendar helper did not answer. Try again later.",
                ),
      ),
    );
    if (!("events" in response)) {
      return yield* toolError(
        "orchestration_error",
        "The calendar helper did not answer. Try again later.",
      );
    }
    const mayWrite =
      changes === "allowed" &&
      caller.subagent !== true &&
      access.direct !== undefined &&
      access.levels?.[MAC_CALENDAR_CONNECTION_ID] === "read-write";
    const permitted = new Map(
      calendars.map((calendar) => [calendar.id, calendar.allowWrite === true]),
    );
    return {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      calendars: calendars.map(({ id, title, allowWrite }) => ({
        id,
        title,
        ...(mayWrite && allowWrite === true ? { writable: true } : {}),
      })),
      events: response.events.items
        .filter((event) => permitted.has(event.calendar.id))
        .map(({ reference, revision, ...event }) => ({
          ...event,
          ...(mayWrite &&
          permitted.get(event.calendar.id) === true &&
          reference !== undefined &&
          revision !== undefined
            ? { reference, revision }
            : {}),
        })),
      truncated: response.events.truncated === true,
    } satisfies ListEventsResult;
  });

  const writeUnavailable = () =>
    toolError(
      "orchestration_error",
      "Calendar write state could not be read. Check the calendar before retrying.",
    );
  const unknownOutcome = () =>
    toolError(
      "orchestration_error",
      "The write outcome is unknown. Check the calendar using list_events before trying a different change.",
    );

  const writeAccess = Effect.fn("MacCalendar.writeAccess")(function* (caller: CalendarCaller) {
    if (
      caller.sealedLoad ||
      caller.subagent === true ||
      (yield* callerChanges.forThread(caller.threadId)) !== "allowed"
    ) {
      return yield* toolError("capability_denied", "Calendar writes are unavailable in this turn.");
    }
    // The selection before the grant, as in listEvents.
    const stored = yield* readSettings.pipe(Effect.mapError(writeUnavailable));
    const access = yield* turns
      .mcpAccessForThreadId(caller.threadId)
      .pipe(Effect.mapError(writeUnavailable));
    if (
      access._tag !== "bot" ||
      access.direct === undefined ||
      !access.connectionIds.includes(MAC_CALENDAR_CONNECTION_ID) ||
      access.levels?.[MAC_CALENDAR_CONNECTION_ID] !== "read-write"
    ) {
      return yield* toolError(
        "capability_denied",
        "This Bot needs a Read and write calendar grant.",
      );
    }
    const calendars = macCalendarsForBot(stored.calendars, access.calendarIds);
    if (!stored.enabled || !calendars.some((calendar) => calendar.allowWrite === true)) {
      return yield* toolError(
        "capability_denied",
        "None of this Bot's calendars allows changes. The user allows them in Settings → MCP connections and chooses them in the Bot's settings.",
      );
    }
    return { botId: access.botId, direct: access.direct, calendars };
  });
  const canWrite = (caller: CalendarCaller) =>
    writeAccess(caller).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const mutate = Effect.fn("MacCalendar.mutate")(
    function* (caller: CalendarCaller, mutation: CalendarMutation) {
      const access = yield* writeAccess(caller);
      const turn = yield* writes
        .currentTurn(caller.threadId)
        .pipe(Effect.mapError(writeUnavailable));
      if (turn === undefined) {
        return yield* toolError(
          "capability_denied",
          "An active Bot turn is required to change a calendar.",
        );
      }
      const { kind, input } = mutation;
      const calendarId =
        mutation.kind === "create" ? mutation.input.calendar_id : mutation.input.target.calendar_id;
      if (
        !access.calendars.some(
          (calendar) => calendar.id === calendarId && calendar.allowWrite === true,
        )
      ) {
        return yield* toolError(
          "capability_denied",
          "This Bot may not change this calendar. Use a calendar marked writable by list_events.",
        );
      }
      if ((yield* helper.availability) !== "available") {
        return yield* toolError(
          "orchestration_error",
          "The T3 Calendar Helper is unavailable on this Mac.",
        );
      }
      const range = "range" in input ? input.range : undefined;
      const title = "title" in input ? input.title : undefined;
      const time = range === undefined ? undefined : normalizeWriteRange(range);
      if (
        (range !== undefined && time === undefined) ||
        (kind === "update" && time === undefined && title === undefined)
      ) {
        return yield* toolError(
          "invalid_request",
          "Supply a title or valid start and end bounds in one time zone.",
        );
      }
      const target = mutation.kind === "create" ? undefined : mutation.input.target;
      const anchor = target === undefined ? undefined : calendarBound(target.event_start);
      if (target !== undefined && anchor === undefined) {
        return yield* toolError("invalid_request", "Use the event start returned by list_events.");
      }
      const owned =
        target === undefined
          ? undefined
          : yield* writes
              .ownerMarker(access.botId, calendarId, target.reference)
              .pipe(Effect.mapError(writeUnavailable));
      const canChangeOthers = turn.startedByUser && access.direct === "home";
      if (target !== undefined && owned === undefined && !canChangeOthers) {
        return yield* toolError(
          "capability_denied",
          "Only an event created by this Bot can be changed in this turn.",
        );
      }

      const fingerprint = yield* digest
        .digest(
          Digest.sha256,
          new TextEncoder().encode(
            encodeRequest([
              kind,
              calendarId,
              title,
              time?.start.at,
              time?.end.at,
              time?.allDay,
              time?.timeZone,
              target?.reference,
              target?.revision,
              anchor?.at,
            ]),
          ),
        )
        .pipe(Effect.map(Hex.encode), Effect.mapError(writeUnavailable));
      const key = { runId: turn.budgetRunId, fingerprint };
      const marker = kind === "create" ? yield* random.uuidV4() : owned;
      const reserved = yield* writes
        .reserve({ ...key, botId: access.botId, calendarId })
        .pipe(Effect.mapError(writeUnavailable));
      if (reserved.kind === "limit") {
        return yield* toolError(
          "capability_denied",
          "A Bot can make at most three calendar writes per turn.",
        );
      }
      if (reserved.kind === "existing") {
        if (reserved.result === null) return yield* unknownOutcome();
        const previous = decodeWrite(reserved.result);
        if (Option.isNone(previous)) return yield* unknownOutcome();
        return "_tag" in previous.value ? yield* previous.value : previous.value;
      }

      const response = yield* call(
        {
          command: "mutate-event",
          mutation: {
            kind,
            calendarId,
            ...(kind === "create" ? { marker } : {}),
            title,
            ...(time === undefined
              ? {}
              : {
                  range: {
                    start: time.start.text,
                    end: time.end.text,
                    allDay: time.allDay,
                    timeZone: time.timeZone,
                  },
                }),
            ...(target === undefined
              ? {}
              : {
                  target: {
                    reference: target.reference,
                    revision: target.revision,
                    start: anchor?.text,
                    requiredMarker: canChangeOthers ? undefined : owned,
                  },
                }),
          },
        },
        READ_TIMEOUT,
      ).pipe(
        Effect.catch((failure) =>
          Effect.gen(function* () {
            if (failure.reason === "failed") return yield* unknownOutcome();
            const error = calendarWriteRefusal(failure.reason);
            yield* writes
              .complete(key, encodeRequest(error), undefined, true)
              .pipe(Effect.mapError(unknownOutcome));
            return yield* error;
          }),
        ),
      );
      if (!("mutation" in response)) return yield* unknownOutcome();
      const event = response.mutation.event;
      if (
        kind !== "delete" &&
        (event?.calendar.id !== calendarId ||
          event.reference === undefined ||
          event.revision === undefined)
      ) {
        return yield* unknownOutcome();
      }
      if (kind === "delete" && event !== undefined) return yield* unknownOutcome();
      const result = { deleted: kind === "delete", ...(event === undefined ? {} : { event }) };
      yield* writes
        .complete(
          key,
          encodeRequest(result),
          marker !== undefined && event?.reference !== undefined
            ? { marker, reference: event.reference }
            : undefined,
        )
        .pipe(Effect.mapError(unknownOutcome));
      return result;
    },
    (effect) => writeLock.withPermits(1)(effect),
  );

  return MacCalendar.of({ summary, inspect, setup, update, listEvents, canWrite, mutate });
});

export const layer = Layer.effect(MacCalendar, make);
