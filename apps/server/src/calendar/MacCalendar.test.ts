import {
  BotId,
  MAC_CALENDAR_CONNECTION_ID,
  type MacCalendarAvailability,
  McpConnectionId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import type * as BotTurnContextModule from "../bots/BotTurnContext.ts";
import * as BotTurnContext from "../bots/BotTurnContext.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as McpCallerChanges from "../mcp/McpCallerChanges.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CalendarWriteStore from "./CalendarWriteStore.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
  readonly calendars?: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly allowWrite?: boolean;
  }>;
  readonly writes?: Partial<CalendarWriteStore.CalendarWriteStore["Service"]>;
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
      canReadThread: () => Effect.succeed(true),
      forThread: () => Effect.succeed(options.changes ?? "allowed"),
    }),
  );
  const calendar = yield* MacCalendar.MacCalendar.pipe(
    Effect.provide(
      MacCalendar.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            helper,
            turns,
            changes,
            Layer.mock(CalendarWriteStore.CalendarWriteStore)(options.writes ?? {}),
            NodeCrypto.layer,
          ),
        ),
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
  [
    "a Bot whose choice left the selection",
    { access: [{ ...granted, calendarIds: ["cal-retired"] }] },
    "No calendars are chosen for this Bot",
  ],
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

it.effect("gives each Bot only the selected calendars it chose", () =>
  Effect.gen(function* () {
    const workBot = { ...granted, calendarIds: [work.id] };
    const familyBot = { ...granted, botId: BotId.make("bot-family"), calendarIds: [family.id] };
    const { calendar, requests } = yield* harness({
      access: [workBot, familyBot, familyBot, workBot],
      answer: () => eventsResponse,
    });
    const workRead = yield* calendar.listEvents(caller, today);
    assert.deepEqual(workRead.calendars, [work]);
    assert.deepEqual(
      workRead.events.map((event) => event.title),
      ["Standup"],
    );
    const familyRead = yield* calendar.listEvents(caller, today);
    assert.deepEqual(familyRead.calendars, [family]);
    assert.deepEqual(
      familyRead.events.map((event) => event.title),
      ["Holiday"],
    );
    assert.deepEqual(
      (yield* requests).map((request) => request.calendarIds),
      [[work.id], [family.id]],
    );
    for (const outside of [work.id, family.id]) {
      const refused = yield* refusal(
        calendar.listEvents(caller, { ...today, calendar_ids: [outside] }),
      );
      assert.equal(refused.code, "capability_denied");
      assert.notInclude(refused.message, outside === work.id ? "Work" : "Family");
    }
    assert.lengthOf(yield* requests, 2);
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
      calendars: [{ ...work, sourceName: "me@example.test", writable: true }],
    });
  }),
);

it.effect("saves the Mac's selection and allows writing only to selected writable calendars", () =>
  Effect.gen(function* () {
    const items = [
      { id: work.id, title: "Work (renamed)", sourceName: "me@example.test", writable: true },
      { ...family, sourceName: "Fixtures", writable: false },
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
    for (const calendarIds of [[work.id], [work.id, family.id]]) {
      const invalid = yield* Effect.flip(
        calendar.update({ expectedRevision: 4, calendarIds, writableCalendarIds: [family.id] }),
      );
      assert.equal(invalid.reason, "calendar-read-only");
    }
    const writable = yield* calendar.update({
      expectedRevision: 4,
      writableCalendarIds: [work.id],
    });
    assert.deepEqual(writable.calendars, [
      { id: work.id, title: "Work (renamed)", allowWrite: true },
    ]);
    const deselected = yield* calendar.update({ expectedRevision: 5, calendarIds: [] });
    assert.deepEqual(deselected.calendars, []);
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

const writableGrant: BotTurnContextModule.BotMcpAccess = {
  ...granted,
  direct: "home",
  levels: { [MAC_CALENDAR_CONNECTION_ID]: "read-write" },
};
const writableWork = { ...work, allowWrite: true };
const sampleEvent = {
  title: "Created in fixture",
  calendar: work,
  start: "2026-11-18T09:00:00+01:00",
  end: "2026-11-18T09:15:00+01:00",
  allDay: false,
  timeZone: "Europe/Berlin",
  reference: "created-ref",
  revision: "created-revision",
};
const create = {
  kind: "create",
  input: {
    calendar_id: work.id,
    title: sampleEvent.title,
    range: { start: sampleEvent.start, end: sampleEvent.end, time_zone: sampleEvent.timeZone },
  },
} as const;
const deleteOwned = {
  kind: "delete",
  input: {
    target: {
      calendar_id: work.id,
      reference: sampleEvent.reference,
      revision: sampleEvent.revision,
      event_start: sampleEvent.start,
    },
  },
} as const;
const turn = { budgetRunId: RunId.make("calendar-write-run"), startedByUser: false };
const database = Sqlite.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "calendar-writes-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const ledger = CalendarWriteStore.layer.pipe(Layer.provideMerge(database));

it.effect(
  "replays confirmed results, proves routine ownership, and never retries an uncertain write",
  () =>
    Effect.gen(function* () {
      const writes = yield* CalendarWriteStore.CalendarWriteStore;
      const { calendar, requests } = yield* harness({
        access: [writableGrant],
        calendars: [writableWork, family],
        writes: { ...writes, currentTurn: () => Effect.succeed(turn) },
        answer: (request) => {
          const mutation = request.mutation as { readonly kind: string; readonly title: string };
          if (mutation.kind === "delete") return JSON.stringify({ mutation: {} });
          if (mutation.title === "Uncertain fixture") return undefined;
          return JSON.stringify({ mutation: { event: sampleEvent } });
        },
      });
      const unowned = {
        ...deleteOwned,
        input: { target: { ...deleteOwned.input.target, reference: "owner-event" } },
      };
      assert.equal((yield* refusal(calendar.mutate(caller, unowned))).code, "capability_denied");
      assert.deepEqual(yield* requests, []);
      const created = yield* calendar.mutate(caller, create);
      assert.deepEqual(yield* calendar.mutate(caller, create), created);
      const uncertain = { ...create, input: { ...create.input, title: "Uncertain fixture" } };
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.include(
          (yield* refusal(calendar.mutate(caller, uncertain))).message,
          "outcome is unknown",
        );
      }
      assert.isTrue((yield* calendar.mutate(caller, deleteOwned)).deleted);
      const capped = yield* refusal(
        calendar.mutate(caller, {
          ...create,
          input: { ...create.input, title: "Fourth mutation" },
        }),
      );
      assert.include(capped.message, "at most three");
      const calls = (yield* requests).map((entry) => entry.mutation);
      assert.lengthOf(calls, 3);
      assert.nestedPropertyVal(
        calls[2],
        "target.requiredMarker",
        (calls[0] as { marker: string }).marker,
      );
    }).pipe(Effect.provide(ledger)),
);

it.effect.each([
  ["a read grant", { access: [granted] }],
  ["No changes", { changes: "none" as const }],
  ["a Home check", { changes: "botWaiting" as const }],
  ["an unselected calendar", { calendars: [work, { ...family, allowWrite: true }] }],
  [
    "a writable calendar outside the Bot's choice",
    {
      access: [{ ...writableGrant, calendarIds: [family.id] }],
      calendars: [writableWork, { ...family, allowWrite: true }],
    },
  ],
] as const)("refuses a calendar mutation with %s", ([, options]) =>
  Effect.gen(function* () {
    const { calendar, requests } = yield* harness({
      access: [writableGrant],
      calendars: [writableWork],
      writes: { currentTurn: () => Effect.succeed(turn) },
      answer: () => undefined,
      ...options,
    });
    assert.equal((yield* refusal(calendar.mutate(caller, create))).code, "capability_denied");
    assert.deepEqual(yield* requests, []);
  }),
);

it.effect(
  "uses the current persisted run and denies owner-event authority to automation and continuations",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* CalendarWriteStore.CalendarWriteStore;
      const home = ThreadId.make("write-home");
      const runId = RunId.make("first-run");
      const at = "2026-11-18T09:00:00.000Z";
      const payload = {
        id: runId,
        threadId: home,
        ordinal: 1,
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
        providerThreadId: null,
        userMessageId: "typed",
        rootNodeId: null,
        activeAttemptId: null,
        status: "running",
        requestedAt: at,
        startedAt: at,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${home}, 'project', 'Fixture', 'codex', 'full-access', 'default', ${at}, ${at}, '{}')
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${runId}, ${home}, 1, 'codex', 'running', ${at}, ${JSON.stringify(payload)})
    `;
      const message = {
        id: "typed",
        threadId: home,
        runId,
        nodeId: null,
        role: "user",
        text: "Rename the fixture",
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
        createdBy: "user",
        creationSource: "web",
      };
      yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('typed', ${home}, ${runId}, 'user', 0, ${at}, ${at}, ${JSON.stringify(message)})
    `;
      assert.deepEqual(yield* store.currentTurn(home), { budgetRunId: runId, startedByUser: true });

      for (const provenance of [
        {
          context: {
            version: 1,
            records: [],
            guest: { guestMessageId: "guest-fixture", name: "Guest", text: message.text },
          },
        },
        { scheduledTaskId: "routine" },
      ]) {
        yield* sql`
          UPDATE orchestration_v2_projection_messages
          SET payload_json = ${JSON.stringify({ ...message, ...provenance })}
          WHERE message_id = 'typed'
        `;
        assert.deepEqual(yield* store.currentTurn(home), {
          budgetRunId: runId,
          startedByUser: false,
        });
      }
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'interrupted' WHERE run_id = ${runId}`;
      assert.isUndefined(yield* store.currentTurn(home));

      yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('resume', ${home}, 2, 'codex', 'running', ${at},
        ${JSON.stringify({ ...payload, id: "resume", ordinal: 2, restartContinuationOfRunId: runId })})
    `;
      assert.deepEqual(yield* store.currentTurn(home), {
        budgetRunId: runId,
        startedByUser: false,
      });
    }).pipe(Effect.provide(ledger)),
);
