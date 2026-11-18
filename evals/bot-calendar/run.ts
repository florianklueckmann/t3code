// @effect-diagnostics globalDate:off -- Fixture days are the Mac's local calendar days.
// @effect-diagnostics globalDateInEffect:off -- Fixture days are the Mac's local calendar days.
/**
 * Grants a Bot Calendar (this Mac) on a running T3 Code dev server whose helper is a fake app with
 * fixture events, asks its Home about the day, and grades the helper's requests and the reply.
 * See README.md.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotDetail, MAC_CALENDAR_CONNECTION_ID } from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { APP_OVERRIDE_ENV } from "../../apps/server/src/calendar/MacCalendarHelper.ts";
import { createBotHome } from "../shared/botHome.ts";
import { type WsClient, withRpc } from "../shared/devServerRpc.ts";
import {
  type BotModelSelection,
  type Call,
  encodeJson,
  INSTANCE_FLAG,
  readItems,
  requireBotModel,
  runTurn,
  SampleError,
  type ToolActivity,
  toolActivity,
  withTools,
} from "../shared/devServerTools.ts";
import {
  CALENDARS,
  type CalendarCase,
  CASES,
  EVENTS,
  SELECTED,
  TODAY_TITLES,
  UNSELECTED_TITLE,
} from "./cases.ts";

const FAKE_HELPER = NodePath.join(import.meta.dirname, "fakeHelper.ts");

/** Where the dev server must find the fake helper: `<base-dir>/calendar-fixture/…app`. */
export const fakeAppPath = (baseDir: string) =>
  NodePath.join(NodePath.resolve(baseDir), "calendar-fixture", "T3 Calendar Helper.app");

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
const localDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localTimestamp = (date: Date) => {
  const offset = -date.getTimezoneOffset();
  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${offset < 0 ? "-" : "+"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
};

/** The fixture for the run's local day, in the helper's response shape. */
export const fixtureFor = (today: Date) => {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dayAt = (day: number, time = "00:00") => {
    const [hours, minutes] = time.split(":").map(Number);
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() + day, hours, minutes);
  };
  return {
    calendars: CALENDARS.map(({ id, title, sourceName, writable }) => ({
      id,
      title,
      sourceName,
      writable,
    })),
    events: EVENTS.map((event) => {
      const calendar = CALENDARS.find((entry) => entry.id === event.calendar)!;
      const allDay = "allDay" in event;
      return {
        title: event.title,
        calendar: { id: calendar.id, title: calendar.title },
        start: allDay ? localDate(dayAt(event.day)) : localTimestamp(dayAt(event.day, event.start)),
        end: allDay ? localDate(dayAt(event.day + 1)) : localTimestamp(dayAt(event.day, event.end)),
        allDay,
        timeZone,
      };
    }),
  };
};

/** Writes the fake helper app and today's fixture; the app reads both at each launch. */
const writeFakeHelper = (baseDir: string, today: Date) => {
  const app = fakeAppPath(baseDir);
  const fixtureDir = NodePath.dirname(app);
  const macos = NodePath.join(app, "Contents", "MacOS");
  NodeFS.mkdirSync(macos, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>fake-helper</string>
<key>CFBundleIdentifier</key><string>dev.t3code.evals.fake-calendar-helper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
  );
  const fixture = NodePath.join(fixtureDir, "fixture.json");
  const calls = NodePath.join(fixtureDir, "calls.jsonl");
  NodeFS.writeFileSync(fixture, JSON.stringify(fixtureFor(today)));
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const executable = NodePath.join(macos, "fake-helper");
  NodeFS.writeFileSync(
    executable,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE_HELPER)} ${quote(fixture)} ${quote(calls)} "$@"\n`,
  );
  NodeFS.chmodSync(executable, 0o755);
  return { calls };
};

export interface EventsRequest {
  readonly start: string;
  readonly end: string;
  readonly calendarIds: ReadonlyArray<string>;
}

export interface SampleRun {
  readonly text: string;
  /** The `list-events` requests the fake helper received during the turn. */
  readonly reads: ReadonlyArray<EventsRequest>;
  readonly tools: ReadonlyArray<ToolActivity>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const gradeSample = (testCase: CalendarCase, run: SampleRun, today: Date) => {
  if (!testCase.needsCalendar) {
    return [{ check: "did not read the calendar", pass: run.reads.length === 0 }];
  }
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const coversToday = run.reads.some((read) => {
    const start = Date.parse(read.start);
    const end = Date.parse(read.end);
    return start <= dayStart && end >= dayStart + DAY_MS && end - start <= 2 * DAY_MS;
  });
  const text = run.text.toLowerCase();
  return [
    { check: "read a window covering today, at most two days", pass: coversToday },
    {
      check: "names today's events",
      pass: TODAY_TITLES.every((title) => text.includes(title.toLowerCase())),
    },
    {
      check: "gives the dentist's time",
      pass: /\b0?9[:.]30\b|\b9(?::30)?\s?(?:am|a\.m\.)/.test(text),
    },
    {
      check: "never reads an unselected calendar",
      pass:
        run.reads.every((read) => read.calendarIds.every((id) => SELECTED.includes(id as never))) &&
        !text.includes(UNSELECTED_TITLE.toLowerCase()),
    },
  ];
};

const readRequests = (path: string): ReadonlyArray<EventsRequest> =>
  NodeFS.existsSync(path)
    ? NodeFS.readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as EventsRequest & { readonly command: string })
        .filter((request) => request.command === "list-events")
    : [];

const runSample = Effect.fn("botCalendar.runSample")(function* (
  call: Call,
  rpc: WsClient,
  testCase: CalendarCase,
  options: {
    readonly work: string;
    readonly modelSelection: BotModelSelection;
    readonly calls: string;
  },
) {
  const tag = `bc-${testCase.id}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const home = yield* createBotHome(call, { tag, ...options });
  const failed = (step: string) => (cause: unknown) =>
    new SampleError({ message: `${step}: ${String(cause)}` });
  const { bot } = yield* call(
    "t3_bot",
    { action: "read", botId: home.botId },
    Schema.Struct({ bot: BotDetail }),
  );
  if (bot.mcpGrants === undefined) {
    return yield* Effect.die(new Error("This server has no MCP connection grants."));
  }
  yield* rpc["bots.setMcpGrants"]({
    botId: bot.id,
    expectedRevision: bot.mcpGrants.revision,
    connectionIds: [MAC_CALENDAR_CONNECTION_ID],
  }).pipe(Effect.mapError(failed("bots.setMcpGrants")));
  NodeFS.rmSync(options.calls, { force: true });
  const runId = yield* runTurn(call, home.homeThreadId, testCase.prompt);
  const messages = yield* readItems(call, home.homeThreadId, "messages");
  return {
    text:
      messages.findLast((item) => item.runId === runId && item.type === "assistant_message")
        ?.text ?? "",
    reads: readRequests(options.calls),
    tools: toolActivity(yield* readItems(call, home.homeThreadId, "activity")),
  } satisfies SampleRun;
});

/** Selects the fixture's calendars through Settings' RPC, which reads them from the fake helper. */
const selectCalendars = Effect.fn("botCalendar.selectCalendars")(function* (rpc: WsClient) {
  const failed = (step: string) => (cause: unknown) =>
    new SampleError({ message: `${step}: ${String(cause)}` });
  const { calendar } = yield* rpc["mcpConnections.list"]({}).pipe(
    Effect.mapError(failed("mcpConnections.list")),
  );
  if (calendar?.availability !== "available") {
    return yield* Effect.die(
      new Error(
        `The server has no fake calendar helper (${calendar?.availability ?? "no calendar"}). Start it with ${APP_OVERRIDE_ENV} as README.md says.`,
      ),
    );
  }
  yield* rpc["mcpConnections.calendarUpdate"]({
    expectedRevision: calendar.revision,
    enabled: true,
    calendarIds: [...SELECTED],
  }).pipe(Effect.mapError(failed("mcpConnections.calendarUpdate")));
});

const main = Effect.gen(function* () {
  const { values } = NodeUtil.parseArgs({
    options: {
      out: { type: "string" },
      "base-dir": { type: "string" },
      work: { type: "string" },
      instance: INSTANCE_FLAG,
      model: { type: "string", default: "gpt-6-luna" },
      effort: { type: "string", default: "medium" },
      samples: { type: "string", default: "3" },
      case: { type: "string", multiple: true },
    },
  });
  const out = values.out;
  const baseDir = values["base-dir"];
  if (out === undefined || baseDir === undefined) {
    return yield* Effect.die(new Error("Pass --out <dir> and --base-dir <dev server .t3>."));
  }
  const today = new Date();
  const { calls } = writeFakeHelper(baseDir, today);
  const selected = CASES.filter((c) => values.case === undefined || values.case.includes(c.id));
  const samples = Number(values.samples);
  const work = NodePath.resolve(values.work ?? NodePath.join(out, "work"));
  const commit = NodeChildProcess.execFileSync("git", ["describe", "--always", "--dirty"], {
    encoding: "utf8",
  }).trim();
  const jobs = selected.flatMap((testCase) =>
    Array.from({ length: samples }, (_, sample) => ({ testCase, sample })),
  );
  NodeFS.mkdirSync(work, { recursive: true });
  const rows = yield* withTools(baseDir, "bot-calendar", (call) =>
    withRpc(baseDir, (rpc) =>
      Effect.gen(function* () {
        const modelSelection = yield* requireBotModel(call, {
          instance: values.instance,
          model: values.model,
          effort: values.effort,
        });
        yield* selectCalendars(rpc);
        // One at a time: the fake helper's request log has no Bot to tell samples apart.
        return yield* Effect.forEach(jobs, ({ testCase, sample }) =>
          runSample(call, rpc, testCase, { work, modelSelection, calls }).pipe(
            Effect.map((run) => {
              const checks = gradeSample(testCase, run, today);
              return { id: testCase.id, sample, pass: checks.every((c) => c.pass), checks, ...run };
            }),
            // An incomplete sample stays in the results as an error and counts as a failure.
            Effect.catch((error) =>
              Effect.succeed({ id: testCase.id, sample, pass: false, error: error.message }),
            ),
            Effect.tap((row) =>
              Effect.sync(() =>
                NodeFS.appendFileSync(NodePath.join(out, "results.jsonl"), `${encodeJson(row)}\n`),
              ),
            ),
          ),
        );
      }),
    ),
  );
  const lines = selected.map((testCase) => {
    const own = rows.filter((row) => row.id === testCase.id);
    const passed = own.filter((row) => row.pass).length;
    const errors = own.filter((row) => "error" in row).length;
    return `| ${testCase.id} | ${passed}/${own.length} | ${errors} |`;
  });
  const summary = [
    `Commit \`${commit}\`, ${values.instance} ${values.model} at ${values.effort} effort, ${samples} samples per case.`,
    "",
    "| Case | Passed | Errors |",
    "| ---- | ------ | ------ |",
    ...lines,
    "",
  ].join("\n");
  NodeFS.mkdirSync(out, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(out, "summary.md"), summary);
  yield* Effect.log(summary);
});

if (import.meta.main) {
  main.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer, Net.layer)),
    NodeRuntime.runMain,
  );
}
