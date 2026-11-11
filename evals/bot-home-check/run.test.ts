// @effect-diagnostics nodeBuiltinImport:off - isolated SQLite fixture for eval eligibility.
import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import { homeIsEligible } from "./run.ts";
import { CASES } from "./cases.ts";
import { gradeSample, type Observation, type ObservedNote } from "./grade.ts";

const caseOf = (id: string) => CASES.find((testCase) => testCase.id === id)!;
const note = (waiting: ObservedNote["waiting"] = []): ObservedNote => ({
  requests: [{ text: "Acme offsite plan", refs: [] }],
  waiting,
  decided: [],
  context: [],
});
const run = (change: Partial<Observation> = {}): Observation => ({
  outcome: { kind: "noop" },
  before: note(),
  after: note(),
  reply: "Nothing needs you before the next check.",
  taskId: "task-1",
  userMessageIds: ["message-1"],
  tasksBefore: 1,
  tasksAfter: 1,
  unchangedFiles: true,
  setup: [],
  ...change,
});
const failed = (checks: ReturnType<typeof gradeSample>) =>
  checks.filter((check) => !check.pass).map((check) => check.name);
const proposed = (item: ObservedNote["waiting"][number]) =>
  run({ outcome: { kind: "proposed", added: 1 }, after: note([item]) });

it.each([
  ["a silent no-op", "nothing-useful-noop", run(), []],
  [
    "a save on a control",
    "already-in-waiting",
    proposed({ text: "Bring the passport", refs: [] }),
    ["nothing saved"],
  ],
  [
    "a multi-line reply",
    "event-after-next-check",
    run({ reply: "Checked.\nNothing to add." }),
    ["one-line reply"],
  ],
  ["a started task", "nothing-useful-noop", run({ tasksAfter: 2 }), ["no task started"]],
  [
    "a broken precondition",
    "removed-not-repeated",
    run({ setup: ["the first check proposed nothing to remove"] }),
    ["setup held"],
  ],
  [
    "a check that never finished",
    "nothing-useful-noop",
    run({ outcome: null }),
    ["check finished", "nothing saved"],
  ],
  [
    "an item naming the task",
    "decision-needed-to-waiting",
    proposed({
      text: "Pick Harbor Hall or Lantern Loft",
      refs: [{ kind: "task", taskId: "task-1" }],
    }),
    [],
  ],
  [
    "a task title without the result's choice",
    "decision-needed-to-waiting",
    proposed({ text: "Pick a venue", refs: [{ kind: "task", taskId: "task-1" }] }),
    ["names what needs the user"],
  ],
  [
    "only half the result's choice",
    "decision-needed-to-waiting",
    proposed({ text: "Book Harbor Hall", refs: [{ kind: "task", taskId: "task-1" }] }),
    ["names what needs the user"],
  ],
  [
    "an item without the task",
    "decision-needed-to-waiting",
    proposed({
      text: "Pick a venue",
      refs: [{ kind: "message", messageId: "message-1", quote: "venue" }],
    }),
    ["names what needs the user", "names the task"],
  ],
  [
    "an item quoting the user",
    "upcoming-event-preparation",
    proposed({
      text: "Pack the passport and signed lease for the 10:00 notary appointment",
      refs: [{ kind: "message", messageId: "message-1", quote: "bring my passport" }],
    }),
    [],
  ],
  [
    "an item quoting a message the user did not send",
    "upcoming-event-preparation",
    proposed({
      text: "Pack the passport",
      refs: [{ kind: "message", messageId: "check-prompt", quote: "Daily Home check" }],
    }),
    ["quotes the user"],
  ],
  [
    "an item about something else",
    "upcoming-event-preparation",
    proposed({
      text: "Review the offsite budget",
      refs: [{ kind: "message", messageId: "message-1", quote: "bring my passport" }],
    }),
    ["names what needs the user"],
  ],
  [
    "two items where one is expected",
    "upcoming-event-preparation",
    run({
      outcome: { kind: "proposed", added: 2 },
      after: note([
        {
          text: "Pack the passport",
          refs: [{ kind: "message", messageId: "message-1", quote: "passport" }],
        },
        {
          text: "Pack the lease",
          refs: [{ kind: "message", messageId: "message-1", quote: "lease" }],
        },
      ]),
    }),
    ["one item added"],
  ],
  [
    "a change outside Waiting",
    "nothing-useful-noop",
    run({ after: { ...note(), context: [{ text: "Offsite is in May", refs: [] }] } }),
    ["only Waiting grew"],
  ],
] as const)("grades %s", (_, id, observation, failures) => {
  expect(failed(gradeSample(caseOf(id), observation))).toEqual(failures);
});

it("requires an idle Home's completed turn and matching native conversation before the eval waits", () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, active_provider_thread_id TEXT, provider_instance_id TEXT, archived_at TEXT, deleted_at TEXT);
      CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT, thread_id TEXT, provider_instance_id TEXT, payload_json TEXT);
      CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT);
      INSERT INTO orchestration_v2_projection_threads VALUES ('home', NULL, 'codex', NULL, NULL);`);
    expect(homeIsEligible(db, "home")).toBe(false);
    db.exec(`INSERT INTO orchestration_v2_projection_runs VALUES ('work', 'completed');`);
    expect(homeIsEligible(db, "home")).toBe(false);
    db.exec(`INSERT INTO orchestration_v2_projection_runs VALUES ('home', 'completed');
      INSERT INTO orchestration_v2_projection_provider_threads VALUES ('native', 'home', 'codex', '{"nativeThreadRef":{"nativeId":"synthetic"}}');
      UPDATE orchestration_v2_projection_threads SET active_provider_thread_id = 'native';`);
    expect(homeIsEligible(db, "home")).toBe(true);
    db.exec(`UPDATE orchestration_v2_projection_threads SET provider_instance_id = 'other';`);
    expect(homeIsEligible(db, "home")).toBe(false);
    db.exec(`UPDATE orchestration_v2_projection_threads SET provider_instance_id = 'codex';`);
    for (const status of ["preparing", "queued", "starting", "running", "waiting"]) {
      db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES ('home', ?)").run(status);
      expect(homeIsEligible(db, "home"), status).toBe(false);
      db.prepare("DELETE FROM orchestration_v2_projection_runs WHERE status = ?").run(status);
    }
  } finally {
    db.close();
  }
});
