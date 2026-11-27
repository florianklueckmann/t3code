import { expect, it } from "@effect/vitest";
import {
  BOT_TURN_LEARNING_LIMITS,
  BotId,
  BotTaskId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as BotLearning from "./BotLearning.ts";
import * as BotStore from "./BotStore.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotMigrations from "./persistence/Migrations.ts";

const projectA = "project-a";
const projectB = "project-b";

const row = (
  id: string,
  minute: number,
  options: {
    readonly projectId?: string | null;
    readonly origin?: "instruction" | "correction";
    readonly status?: BotStore.BotLearningRow["status"];
    readonly text?: string;
    readonly reinforcedAt?: string;
  } = {},
): BotStore.BotLearningRow => ({
  entry_id: id,
  revision: 1,
  bot_id: "bot",
  project_id: options.projectId === undefined ? projectA : options.projectId,
  kind: "preference",
  text: options.text ?? `Lesson ${id}.`,
  normalized_text: "",
  rationale: "",
  evidence: "",
  origin: options.origin ?? "correction",
  source_json: '{"kind":"user"}',
  learned_in_project_id: projectA,
  status: options.status ?? "active",
  base_revision: null,
  conflicts_with_instruction: 0,
  created_at: `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
  decided_at: null,
  activated_at: null,
  restored_from: null,
  reinforced_at: options.reinforcedAt ?? null,
});

const many = (count: number, options: Parameters<typeof row>[2] = {}) =>
  Array.from({ length: count }, (_, index) =>
    row(`e${String(index + 1).padStart(2, "0")}`, index + 1, options),
  );

// "- [e01 r1; preference] " precedes the text of a project's correction.
const PREFIX = 23;
const sized = (lineLength: number) => "x".repeat(lineLength - PREFIX);
const perLine = BOT_TURN_LEARNING_LIMITS.chars / 8;

it.each([
  {
    name: "includes everything within the limits",
    rows: many(3),
    selected: ["e03", "e02", "e01"],
    eligible: 3,
  },
  {
    name: "includes an entry that reaches the character budget exactly",
    rows: many(8, { text: sized(perLine) }),
    selected: ["e08", "e07", "e06", "e05", "e04", "e03", "e02", "e01"],
    eligible: 8,
    chars: BOT_TURN_LEARNING_LIMITS.chars,
  },
  {
    name: "leaves out an entry one character over the budget, and everything older",
    rows: [
      row("e00", 0, { text: "Short." }),
      ...many(7, { text: sized(perLine) }),
      row("e08", 8, { text: sized(perLine + 1) }),
    ],
    selected: ["e08", "e07", "e06", "e05", "e04", "e03", "e02"],
    eligible: 9,
    chars: BOT_TURN_LEARNING_LIMITS.chars - perLine + 1,
  },
  {
    name: "leaves out the oldest past 40 entries, never a standing instruction",
    rows: [row("instruction", 0, { origin: "instruction" }), ...many(41)],
    selected: [
      "instruction",
      ...many(41)
        .slice(2)
        .map((each) => each.entry_id)
        .toReversed(),
    ],
    eligible: 42,
  },
  {
    name: "puts standing instructions first when the budget runs out",
    rows: [
      ...many(8, { text: sized(perLine) }),
      row("instruction", 0, { origin: "instruction", text: "Give dates in Dale Reckoning." }),
    ],
    selected: ["instruction", "e08", "e07", "e06", "e05", "e04", "e03", "e02"],
    eligible: 9,
  },
  {
    name: "counts entries for all projects but never another project's",
    rows: [
      row("shared", 0, { projectId: null }),
      ...many(40),
      row("other", 50, { projectId: projectB }),
    ],
    selected: many(40)
      .map((each) => each.entry_id)
      .toReversed(),
    eligible: 41,
  },
  {
    name: "keeps an old lesson that came up again ahead of newer ones",
    rows: [row("old", 0, { reinforcedAt: "2026-01-01T00:50:00.000Z" }), ...many(40)],
    selected: [
      "old",
      ...many(40)
        .slice(1)
        .map((each) => each.entry_id)
        .toReversed(),
    ],
    eligible: 41,
  },
  {
    name: "counts only entries in use",
    rows: [
      ...many(2),
      row("retired", 10, { status: "retired" }),
      row("pending", 11, { status: "pending" }),
    ],
    selected: ["e02", "e01"],
    eligible: 2,
  },
])("$name", ({ rows, selected, eligible, ...expected }) => {
  const turn = BotLearning.turnLearning(rows, projectA);
  expect(turn.summary.selected).toEqual(selected);
  expect(turn.summary.eligible).toBe(eligible);
  expect(turn.omitted).toBe(eligible - selected.length);
  // The summary describes exactly the lines the turn receives.
  expect(turn.lines.map((line) => line.slice(3, line.indexOf(" ", 3)))).toEqual(selected);
  expect(turn.summary.chars).toBe(turn.lines.reduce((sum, line) => sum + line.length, 0));
  if ("chars" in expected) expect(turn.summary.chars).toBe(expected.chars);
});

const botId = BotId.make("bot");
const policy = "automatic";
const correction = {
  botId,
  projectId: ProjectId.make(projectA),
  kind: "preference",
  text: "Use metric units.",
  origin: "correction",
  source: { kind: "thread", threadId: ThreadId.make("bot-home") },
} as const;
const user = { origin: "instruction", source: { kind: "user" } } as const;

const storeLayer = BotStore.layer.pipe(
  Layer.provide(
    Layer.effect(
      BotDatabase.BotDatabase,
      Effect.gen(function* () {
        yield* BotMigrations.runMigrations();
        return yield* SqlClient.SqlClient;
      }),
    ).pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  ),
);

const fixture = Effect.gen(function* () {
  const store = yield* BotStore.BotStore;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const createdAt = yield* now;
  yield* store.insertBot({
    bot_id: botId,
    name: "Companion",
    instructions: "",
    model_selection_json: '{"instanceId":"codex","model":"gpt-6-luna"}',
    learning_policy: policy,
    appearance_json: null,
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null,
  });
  const nextId = yield* Ref.make(0);
  const taskStatus = yield* Ref.make<"running" | "completed">("running");
  const learning = BotLearning.make({
    store,
    now,
    newEntryId: Ref.updateAndGet(nextId, (id) => id + 1).pipe(Effect.map((id) => `lesson-${id}`)),
    taskStatus: () => Ref.get(taskStatus),
  });
  for (const projectId of [projectA, projectB, projectC]) {
    yield* store.upsertContext({
      home_thread_id: `home-${projectId}`,
      bot_id: botId,
      project_id: projectId,
      guidance: "",
      sources_json: "[]",
      revision: 1,
      thread_sync: null,
      attached_at: createdAt,
      detached_at: null,
      updated_at: createdAt,
    });
  }
  const rows = store.listLearning(botId);
  const suggestions = Effect.gen(function* () {
    return BotLearning.currentSuggestions(
      yield* rows,
      yield* store.listLearningSuggestions(botId),
      yield* store.listContexts(botId),
    );
  });
  return { learning, rows, taskStatus, suggestions, store };
});

const projectC = "project-c";
const elsewhere = { ...correction, projectId: ProjectId.make(projectB) } as const;
const pair = (
  entry: BotLearning.RecordLearningResult,
  matched: BotLearning.RecordLearningResult,
) => ({
  entryId: entry.entryId,
  revision: entry.revision,
  matchedEntryId: matched.entryId,
  matchedRevision: matched.revision,
});

it.effect("suggests a lesson for all projects once a second project learns the same", () =>
  Effect.gen(function* () {
    const { learning, suggestions } = yield* fixture;
    const first = yield* learning.record(policy, correction);
    yield* learning.record(policy, { ...correction, text: "Use ISO dates." });
    yield* learning.syncSuggestions(botId);
    expect(yield* suggestions).toEqual([]);

    yield* TestClock.adjust("1 minute");
    const repeat = yield* learning.record(policy, { ...elsewhere, text: "use  METRIC units." });
    yield* learning.record(policy, { ...elsewhere, text: "Deploys run on Fridays." });
    yield* learning.syncSuggestions(botId);
    expect(yield* suggestions).toEqual([{ ...pair(repeat, first), dismissedAt: null }]);

    // An edit ends the match; the suggestion goes with it.
    yield* learning.record(policy, {
      ...correction,
      ...user,
      text: "Use metric units, except for screens.",
      replaces: first,
    });
    yield* learning.syncSuggestions(botId);
    expect(yield* suggestions).toEqual([]);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("keeps a dismissed suggestion dismissed until the user shows it again", () =>
  Effect.gen(function* () {
    const { learning, suggestions } = yield* fixture;
    const first = yield* learning.record(policy, correction);
    yield* TestClock.adjust("1 minute");
    const repeat = yield* learning.record(policy, elsewhere);
    yield* learning.syncSuggestions(botId);
    const decide = (
      decision: "accept" | "dismiss" | "undismiss",
      entry = repeat,
      matched = first,
    ) => learning.decideSuggestion(policy, { botId, ...pair(entry, matched), decision });

    yield* TestClock.adjust("1 minute");
    yield* decide("dismiss");
    const dismissed = { ...pair(repeat, first), dismissedAt: "1970-01-01T00:02:00.000Z" };
    // Neither a later sync nor the same pair found from the other lesson brings it back.
    yield* learning.syncSuggestions(botId);
    yield* learning.suggest({ botId, entry: first, matched: repeat });
    expect(yield* suggestions).toEqual([dismissed]);
    expect((yield* Effect.flip(decide("accept"))).message).toContain("dismissed");

    yield* decide("undismiss");
    expect(yield* suggestions).toEqual([{ ...dismissed, dismissedAt: null }]);
    expect((yield* Effect.flip(decide("dismiss", first, repeat))).message).toContain(
      "no suggestion",
    );
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("keeps a lesson's dismissal when the copy it matched goes with its project", () =>
  Effect.gen(function* () {
    const { learning, suggestions, store } = yield* fixture;
    const first = yield* learning.record(policy, correction);
    const third = yield* learning.record(policy, {
      ...correction,
      projectId: ProjectId.make(projectC),
    });
    yield* TestClock.adjust("1 minute");
    const repeat = yield* learning.record(policy, elsewhere);
    yield* learning.syncSuggestions(botId);
    yield* learning.decideSuggestion(policy, {
      botId,
      ...pair(repeat, first),
      decision: "dismiss",
    });

    yield* store.deleteContextsForProject(ProjectId.make(projectA));
    yield* learning.syncSuggestions(botId);
    expect(yield* suggestions).toEqual([
      { ...pair(repeat, third), dismissedAt: "1970-01-01T00:01:00.000Z" },
    ]);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("accepts a suggestion as Apply to all projects does, and retires the other copy", () =>
  Effect.gen(function* () {
    const { learning, rows, suggestions } = yield* fixture;
    const first = yield* learning.record(policy, correction);
    const control = yield* learning.record(policy, { ...elsewhere, text: "Use ISO dates." });
    yield* TestClock.adjust("1 minute");
    const repeat = yield* learning.record(policy, elsewhere);
    yield* learning.syncSuggestions(botId);

    const accept = (matched: BotLearning.RecordLearningResult) =>
      learning.decideSuggestion(policy, { botId, ...pair(repeat, matched), decision: "accept" });
    // Accepting names the two revisions the user saw, so it never moves or retires another.
    expect((yield* Effect.flip(accept(control))).message).toContain("no suggestion");
    expect((yield* Effect.flip(accept({ ...first, revision: 2 }))).message).toContain(
      "no suggestion",
    );
    yield* accept(first);
    yield* learning.record(policy, {
      ...elsewhere,
      ...user,
      text: "Use ISO dates.",
      scope: "bot",
      replaces: control,
    });

    const revisions = yield* rows;
    const moved = (entryId: string) => {
      const {
        entry_id: _,
        text: __,
        normalized_text: ___,
        ...row
      } = revisions.find((each) => each.entry_id === entryId && each.status === "active")!;
      return row;
    };
    expect(moved(repeat.entryId)).toEqual(moved(control.entryId));
    expect(moved(repeat.entryId)).toMatchObject({ project_id: null, origin: "correction" });
    expect(revisions.filter((row) => row.entry_id === first.entryId).at(-1)?.status).toBe(
      "retired",
    );
    expect(yield* suggestions).toEqual([]);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("restores the origin of the earlier revision after a user edit", () =>
  Effect.gen(function* () {
    const { learning, rows } = yield* fixture;
    const { entryId, revision } = yield* learning.record(policy, correction);
    yield* learning.record(policy, {
      ...correction,
      ...user,
      text: "Use imperial units.",
      replaces: { entryId, revision },
    });
    expect((yield* rows).find((row) => row.status === "active")?.origin).toBe("instruction");

    const restore = { botId, entryId, revision, source: user.source };
    yield* learning.restore(restore);
    expect((yield* rows).find((row) => row.status === "active")).toMatchObject({
      origin: "correction",
      text: correction.text,
      restored_from: revision,
    });
    yield* learning.restore(restore);
    expect(yield* rows).toHaveLength(3);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect.each([
  {
    name: "keeps the learned shared entry when moving an identical project lesson",
    origin: "correction",
    sharedRevision: 1,
    duplicate: true,
  },
  {
    name: "makes the shared entry an instruction when moving an identical project instruction",
    origin: "instruction",
    sharedRevision: 2,
    duplicate: false,
  },
] as const)("$name", ({ origin, sharedRevision, duplicate }) =>
  Effect.gen(function* () {
    const { learning, rows } = yield* fixture;
    const shared = yield* learning.record(policy, {
      ...correction,
      projectId: ProjectId.make(projectB),
      scope: "bot",
    });
    yield* learning.decide({
      botId,
      entryId: shared.entryId,
      revision: shared.revision,
      decision: "adopt",
    });
    const local = yield* learning.record(
      policy,
      origin === "instruction" ? { ...correction, ...user } : correction,
    );
    const moved = yield* learning.record(policy, {
      ...correction,
      ...user,
      scope: "bot",
      replaces: { entryId: local.entryId, revision: local.revision },
    });

    const revisions = yield* rows;
    expect(revisions.find((row) => row.status === "active")).toMatchObject({
      entry_id: shared.entryId,
      revision: sharedRevision,
      project_id: null,
      origin,
    });
    expect(revisions.find((row) => row.entry_id === local.entryId)?.status).toBe("retired");
    expect(moved).toEqual({
      entryId: shared.entryId,
      revision: sharedRevision,
      status: "active",
      duplicate,
    });
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("keeps a lesson from another agent's turn pending under automatic learning", () =>
  Effect.gen(function* () {
    const { learning } = yield* fixture;
    expect((yield* learning.record(policy, correction)).status).toBe("active");
    const fromAgent = yield* learning.record(policy, {
      ...elsewhere,
      awaitsUser: true,
    });
    expect(fromAgent.status).toBe("pending");
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("keeps a standing instruction when adopting a task's proposal to move it", () =>
  Effect.gen(function* () {
    const { learning, rows, taskStatus } = yield* fixture;
    const instruction = yield* learning.record(policy, { ...correction, ...user });
    const taskId = BotTaskId.make("task");
    const proposal = yield* learning.record(policy, {
      ...correction,
      scope: "bot",
      source: { kind: "task", taskId },
      replaces: { entryId: instruction.entryId, revision: instruction.revision },
    });

    expect(proposal.status).toBe("pending");
    const adopt = learning.decide({
      botId,
      entryId: proposal.entryId,
      revision: proposal.revision,
      decision: "adopt",
    });
    expect((yield* Effect.flip(adopt)).message).toContain("did not complete");
    yield* Ref.set(taskStatus, "completed");
    expect(yield* learning.settleTask({ botId, policy, taskId, status: "completed" })).toBe(false);
    yield* adopt;

    expect((yield* rows).find((row) => row.status === "active")).toMatchObject({
      revision: proposal.revision,
      project_id: null,
      origin: "instruction",
    });
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("ranks a lesson the user repeats like a newer one, not one another agent repeats", () =>
  Effect.gen(function* () {
    const { learning, rows } = yield* fixture;
    const old = yield* learning.record(policy, correction);
    yield* TestClock.adjust("1 minute");
    const newer = yield* learning.record(policy, { ...correction, text: "Use ISO dates." });
    yield* TestClock.adjust("1 minute");
    const selected = Effect.map(
      rows,
      (all) => BotLearning.turnLearning(all, projectA).summary.selected,
    );

    const fromAgent = yield* learning.record(policy, { ...correction, awaitsUser: true });
    expect(fromAgent.duplicate).toBe(true);
    expect(yield* selected).toEqual([newer.entryId, old.entryId]);

    const fromUser = yield* learning.record(policy, correction);
    expect(fromUser.duplicate).toBe(true);
    expect(yield* selected).toEqual([old.entryId, newer.entryId]);
  }).pipe(Effect.provide(storeLayer)),
);

it.effect("keeps a moved lesson behind newer lessons of the same origin", () =>
  Effect.gen(function* () {
    const { learning, rows } = yield* fixture;
    const local = yield* learning.record(policy, correction);
    yield* TestClock.adjust("1 minute");
    const newer = yield* learning.record(policy, { ...correction, text: "Use ISO dates." });
    yield* TestClock.adjust("1 minute");
    yield* learning.record(policy, {
      ...correction,
      ...user,
      scope: "bot",
      replaces: { entryId: local.entryId, revision: local.revision },
    });

    const revisions = yield* rows;
    expect(BotLearning.turnLearning(revisions, projectA).summary.selected).toEqual([
      newer.entryId,
      local.entryId,
    ]);
    expect(revisions.at(-1)).toMatchObject({
      entry_id: local.entryId,
      revision: 2,
      created_at: "1970-01-01T00:02:00.000Z",
    });
  }).pipe(Effect.provide(storeLayer)),
);
