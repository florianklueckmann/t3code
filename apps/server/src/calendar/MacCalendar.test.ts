import {
  BotId,
  MAC_CALENDAR_CONNECTION_ID,
  type MacCalendarAvailability,
  McpConnectionId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type * as BotTurnContextModule from "../bots/BotTurnContext.ts";
import * as BotTurnContext from "../bots/BotTurnContext.ts";
import * as McpCallerChanges from "../mcp/McpCallerChanges.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MacCalendar from "./MacCalendar.ts";
import * as MacCalendarHelper from "./MacCalendarHelper.ts";

const threadId = ThreadId.make("thread-calendar");
const caller = { threadId, sealedLoad: false };
const work = { id: "cal-work", title: "Work" };
const family = { id: "cal-family", title: "Family" };
const otherMail = McpConnectionId.make("1a1a1a1a-0000-4000-8000-00000000001a");

const granted: BotTurnContextModule.BotMcpAccess = {
  _tag: "bot",
  botId: BotId.make("bot-calendar"),
  botName: "Planner",
  connectionIds: [MAC_CALENDAR_CONNECTION_ID],
  ownCodexMcpServers: false,
};
const notGranted: BotTurnContextModule.BotMcpAccess = { ...granted, connectionIds: [otherMail] };

const eventsResponse = JSON.stringify({
  events: {
    items: [
      {
        title: "Standup",
        calendar: work,
        start: "2026-11-18T09:00:00+01:00",
        end: "2026-11-18T09:15:00+01:00",
        allDay: false,
        timeZone: "Europe/Berlin",
        reference: "opaque",
      },
      {
        title: "Holiday",
        calendar: family,
        start: "2026-11-18",
        end: "2026-11-19",
        allDay: true,
        timeZone: "Europe/Berlin",
        reference: "opaque-2",
      },
    ],
    truncated: true,
  },
});

type Answer = string | undefined | "never" | "fail";

/** A helper that answers each request from `answer`, records what it was sent and can fail. */
const harness = Effect.fn("MacCalendarTest.harness")(function* (options: {
  readonly availability?: MacCalendarAvailability;
  readonly answer: (request: Record<string, unknown>) => Answer;
  readonly access?: ReadonlyArray<BotTurnContextModule.BotMcpAccess>;
  readonly changes?: McpCallerChanges.McpCallerChangesValue;
  readonly enabled?: boolean;
  readonly calendars?: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}) {
  const requests = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
  const accessQueue = yield* Ref.make(options.access ?? [granted]);
  const helper = Layer.succeed(
    MacCalendarHelper.MacCalendarHelper,
    MacCalendarHelper.MacCalendarHelper.of({
      availability: Effect.succeed(options.availability ?? "available"),
      exchange: (text) =>
        Effect.gen(function* () {
          const request = JSON.parse(text) as Record<string, unknown>;
          yield* Ref.update(requests, (all) => [...all, request]);
          const answer = options.answer(request);
          if (answer === "never") return yield* Effect.never;
          if (answer === "fail") return yield* new MacCalendarHelper.MacCalendarHelperError({});
          return answer;
        }),
    }),
  );
  const turns = Layer.mock(BotTurnContext.BotTurnContext)({
    mcpAccessForThreadId: () =>
      Ref.modify(accessQueue, (queue) => [
        queue[0] ?? { _tag: "none" as const },
        queue.length > 1 ? queue.slice(1) : queue,
      ]),
  });
  const changes = Layer.succeed(
    McpCallerChanges.McpCallerChanges,
    McpCallerChanges.McpCallerChanges.of({
      forThread: () => Effect.succeed(options.changes ?? "allowed"),
    }),
  );
  const calendar = yield* MacCalendar.MacCalendar.pipe(
    Effect.provide(
      MacCalendar.layer.pipe(
        Layer.provide(Layer.mergeAll(helper, turns, changes)),
        Layer.provide(
          ServerSettings.layerTest({
            macCalendar: {
              enabled: options.enabled ?? true,
              revision: 3,
              calendars: [...(options.calendars ?? [work, family])],
            },
          }),
        ),
      ),
    ),
  );
  return { calendar, requests: Ref.get(requests) };
});

const today = { start: "2026-11-18", end: "2026-11-19" };
const refusal = <A, E extends { readonly code: string; readonly message: string }>(
  effect: Effect.Effect<A, E>,
) =>
  Effect.flip(effect).pipe(Effect.map((error) => ({ code: error.code, message: error.message })));

it.effect("reads the selected calendars for a granted Bot and passes `truncated` through", () =>
  Effect.gen(function* () {
    const { calendar, requests } = yield* harness({ answer: () => eventsResponse });
    const result = yield* calendar.listEvents(caller, today);
    assert.deepEqual(
      result.events.map((event) => [event.title, event.start, event.end, event.allDay]),
      [
        ["Standup", "2026-11-18T09:00:00+01:00", "2026-11-18T09:15:00+01:00", false],
        ["Holiday", "2026-11-18", "2026-11-19", true],
      ],
    );
    assert.isTrue(result.truncated);
    assert.notProperty(result.events[0] ?? {}, "reference");
    assert.deepEqual(result.calendars, [work, family]);
    const [sent] = yield* requests;
    assert.equal(sent?.command, "list-events");
    assert.deepEqual(sent?.calendarIds, [work.id, family.id]);
    assert.equal(sent?.limit, 50);
    // A bare date is midnight on this Mac, with its offset.
    assert.match(String(sent?.start), /^2026-11-18T00:00:00[+-]\d{2}:\d{2}$/);
  }),
);

it.effect.each([
  ["a Bot without the grant", { access: [notGranted] }, "is not granted to this Bot"],
  ["a thread of no Bot", { access: [{ _tag: "none" as const }] }, "is not granted to this Bot"],
  ["a Home check", { changes: "botNote" as const }, "Home checks have no access"],
  ["a Home Waiting check", { changes: "botWaiting" as const }, "Home checks have no access"],
  ["a turned-off connection", { enabled: false }, "is turned off"],
  ["no selected calendars", { calendars: [] }, "No calendars are selected"],
] as const)("refuses %s without asking the helper", ([, options, message]) =>
  Effect.gen(function* () {
    const { calendar, requests } = yield* harness({ ...options, answer: () => eventsResponse });
    const error = yield* refusal(calendar.listEvents(caller, today));
    assert.equal(error.code, "capability_denied");
    assert.include(error.message, message);
    assert.deepEqual(yield* requests, []);
  }),
);

it.effect("refuses a sealed load whatever its grants", () =>
  Effect.gen(function* () {
    const { calendar, requests } = yield* harness({ answer: () => eventsResponse });
    const error = yield* refusal(calendar.listEvents({ threadId, sealedLoad: true }, today));
    assert.include(error.message, "Home checks have no access");
    assert.deepEqual(yield* requests, []);
  }),
);

it.effect("reads in a No changes run, which is read-only", () =>
  Effect.gen(function* () {
    const { calendar } = yield* harness({ changes: "none", answer: () => eventsResponse });
    assert.lengthOf((yield* calendar.listEvents(caller, today)).events, 2);
  }),
);

it.effect("refuses after the grant is revoked, on the next call", () =>
  Effect.gen(function* () {
    const { calendar, requests } = yield* harness({
      access: [granted, notGranted],
      answer: () => eventsResponse,
    });
    yield* calendar.listEvents(caller, today);
    const error = yield* refusal(calendar.listEvents(caller, today));
    assert.include(error.message, "is not granted to this Bot");
    assert.lengthOf(yield* requests, 1);
  }),
);

it.effect("refuses calendars outside the selection and reads a subset inside it", () =>
  Effect.gen(function* () {
    const { calendar, requests } = yield* harness({
      calendars: [work],
      answer: () => eventsResponse,
    });
    const outside = yield* refusal(
      calendar.listEvents(caller, { ...today, calendar_ids: [work.id, family.id] }),
    );
    assert.equal(outside.code, "capability_denied");
    assert.include(outside.message, `"Work" (${work.id})`);
    assert.deepEqual(yield* requests, []);
    yield* calendar.listEvents(caller, { ...today, calendar_ids: [work.id] });
    assert.deepEqual((yield* requests)[0]?.calendarIds, [work.id]);
  }),
);

it.effect.each([
  ["no offset", { start: "2026-11-18T09:00:00", end: "2026-11-19" }],
  ["end before start", { start: "2026-11-19", end: "2026-11-18" }],
  ["more than 14 days", { start: "2026-11-01", end: "2026-11-16" }],
  ["a limit above 100", { ...today, limit: 101 }],
] as const)("refuses bounds with %s", ([, input]) =>
  Effect.gen(function* () {
    const { calendar, requests } = yield* harness({ answer: () => eventsResponse });
    assert.equal((yield* refusal(calendar.listEvents(caller, input))).code, "invalid_request");
    assert.deepEqual(yield* requests, []);
  }),
);

const helperFailures: ReadonlyArray<
  readonly [
    string,
    { readonly availability?: MacCalendarAvailability; readonly answer?: () => Answer },
    string,
  ]
> = [
  ["is not installed", { availability: "helper-missing" }, "not installed"],
  [
    "has no Full Access",
    { answer: () => JSON.stringify({ error: { code: "notAuthorized" } }) },
    "no Full Access",
  ],
  [
    "lost a selected calendar",
    { answer: () => JSON.stringify({ error: { code: "unknownCalendar" } }) },
    "no longer on this Mac",
  ],
  ["writes no response", { answer: () => undefined }, "did not answer"],
  ["writes an empty response", { answer: () => " \n" }, "did not answer"],
  ["writes a malformed response", { answer: () => '{"events":' }, "did not answer"],
  [
    "writes another command's response",
    { answer: () => '{"status":{"authorization":"fullAccess"}}' },
    "did not answer",
  ],
  ["fails to launch", { answer: () => "fail" }, "did not answer"],
];

it.effect.each(helperFailures)("fails a read when the helper %s", ([, options, message]) =>
  Effect.gen(function* () {
    const { calendar } = yield* harness({ answer: () => eventsResponse, ...options });
    const error = yield* refusal(calendar.listEvents(caller, today));
    assert.equal(error.code, "orchestration_error");
    assert.include(error.message, message);
  }),
);

it.effect("gives up on a helper that does not answer in time", () =>
  Effect.gen(function* () {
    const { calendar } = yield* harness({ answer: () => "never" });
    const read = yield* Effect.forkChild(refusal(calendar.listEvents(caller, today)));
    yield* TestClock.adjust("41 seconds");
    const error = yield* Fiber.join(read);
    assert.include(error.message, "did not answer");
  }),
);

it.effect("inspects the permission and lists calendars only with Full Access", () =>
  Effect.gen(function* () {
    const items = [{ ...work, sourceName: "me@example.test", writable: true }];
    const answers: Record<string, string> = {
      status: JSON.stringify({ status: { authorization: "notDetermined" } }),
      "list-calendars": JSON.stringify({ calendars: { items } }),
    };
    const { calendar, requests } = yield* harness({
      answer: (request) => answers[String(request.command)],
    });
    assert.deepEqual(yield* calendar.inspect, { authorization: "notDetermined", calendars: [] });
    assert.deepEqual(
      (yield* requests).map((request) => request.command),
      ["status"],
    );
    answers.status = JSON.stringify({ status: { authorization: "fullAccess" } });
    assert.deepEqual(yield* calendar.inspect, {
      authorization: "fullAccess",
      calendars: [{ ...work, sourceName: "me@example.test" }],
    });
  }),
);

it.effect("saves a selection with the Mac's titles and refuses unknown or stale ones", () =>
  Effect.gen(function* () {
    const items = [
      { id: work.id, title: "Work (renamed)", sourceName: "me@example.test", writable: true },
    ];
    const { calendar } = yield* harness({
      answer: () => JSON.stringify({ calendars: { items } }),
    });
    const unknown = yield* Effect.flip(
      calendar.update({ expectedRevision: 3, calendarIds: [work.id, "elsewhere"] }),
    );
    assert.equal(unknown.reason, "unknown-calendar");
    const saved = yield* calendar.update({ expectedRevision: 3, calendarIds: [work.id] });
    assert.deepEqual(saved.calendars, [{ id: work.id, title: "Work (renamed)" }]);
    assert.equal(saved.revision, 4);
    const stale = yield* Effect.flip(calendar.update({ expectedRevision: 3, enabled: false }));
    assert.equal(stale.reason, "revision-conflict");
  }),
);

it.effect("reports a Mac without the helper and never launches it for setup", () =>
  Effect.gen(function* () {
    const { calendar, requests } = yield* harness({
      availability: "helper-missing",
      answer: () => undefined,
    });
    assert.equal((yield* calendar.summary).availability, "helper-missing");
    assert.equal((yield* Effect.flip(calendar.setup)).reason, "helper-missing");
    assert.deepEqual(yield* requests, []);
  }),
);
