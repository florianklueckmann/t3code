import * as BotContinuation from "../../../bots/BotContinuation.ts";
import { expect, it } from "@effect/vitest";
import {
  BotId,
  type BotDetail,
  BotError,
  BotLearningEntryId,
  BotTaskId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as BotService from "../../../bots/BotService.ts";
import * as BotTaskService from "../../../bots/BotTaskService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpCallerBot from "../../McpCallerBot.ts";
import type { McpCallerBotValue } from "../../McpCallerBot.ts";
import * as McpCallerChanges from "../../McpCallerChanges.ts";
import type { McpCallerChangesValue } from "../../McpCallerChanges.ts";
import { layerCallerChangesAllowed, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BotHandlers from "./handlers.ts";
import { BotToolkit, type BotToolInput } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:bots");
const threadId = ThreadId.make("thread:bots");
const botId = BotId.make("faerun-companion");
const campaignA = ProjectId.make("project-campaign-a");

const detail = {
  id: botId,
  name: "Faerun Companion",
  instructions: "",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  learningPolicy: "automatic",
  appearance: { color: "teal", face: "happy", topper: "antenna" },
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  archivedAt: null,
  projects: [],
  learning: [],
  pendingLearning: 0,
} satisfies BotDetail;

const otherBot = BotId.make("work-companion");
const ownTask = BotTaskId.make("bot-task:1");
const otherTask = BotTaskId.make("bot-task:work");
const taskOwners = new Map([
  [ownTask, botId],
  [otherTask, otherBot],
]);

const taskSummary = {
  id: ownTask,
  botId,
  projectId: campaignA,
  homeThreadId: threadId,
  workThreadId: ThreadId.make("bot-work:bot-task:1"),
  origin: "direct" as const,
  title: "Recap",
  scheduledTaskId: null,
  occurrenceDueAt: null,
  sessionAt: null,
  runtimeMode: "full-access" as const,
  status: "accepted" as const,
  detail: null,
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  completedAt: null,
  modelSelection: detail.modelSelection,
};

const continuationView = (input: { readonly botId: BotId; readonly projectId: ProjectId }) => ({
  ...input,
  homeThreadId: threadId,
  revision: null,
  note: { requests: [], waiting: [], decided: [], context: [] },
  updatedBy: null,
  updatedAt: null,
  restoredFrom: null,
  coverage: null,
  basis: null,
  writable: true,
  newerInputs: { count: 0, firstOrdinal: null, lastOrdinal: null },
  sources: [],
  moreSources: 0,
  activeTasks: [],
  moreActiveTasks: 0,
});

const callTool = (
  params: BotToolInput,
  access: "read-only" | undefined,
  /** The Bot conversation the calling thread is, if any. */
  callerBot?: { readonly botId: BotId; readonly projectId: ProjectId; readonly taskId?: BotTaskId },
  external = false,
  caller: {
    readonly changes?: McpCallerChangesValue;
    readonly subagent?: boolean;
    readonly sealedLoad?: boolean;
    /** The Bot whose access the caller's line runs under. */
    readonly accessOf?: McpCallerBotValue;
  } = {},
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (call: string) =>
      Ref.update(calls, (current) => [...current, call]).pipe(Effect.as(detail));
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* BotToolkit;
      const results = yield* toolkit
        .handle("t3_bot", params)
        .pipe(Stream.unwrap, Stream.runCollect);
      return results.at(-1)?.encodedResult;
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(BotHandlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(McpInvocationContext.McpInvocationContext, {
                environmentId,
                requestNamespace: "provider:bots",
                thread: external
                  ? undefined
                  : {
                      threadId,
                      providerSessionId: "provider:bots",
                      providerInstanceId: ProviderInstanceId.make("codex"),
                      ...(caller.subagent === true ? { subagent: true } : {}),
                      ...(caller.sealedLoad === true ? { sealedLoad: true as const } : {}),
                    },
                client:
                  access === undefined && !external
                    ? undefined
                    : {
                        sessionId: "session:bots",
                        label: "Test client",
                        access: access ?? "full-access",
                      },
                capabilities: new Set(["orchestration" as const]),
                issuedAt: 0,
              }),
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
              }),
              caller.changes === undefined
                ? layerCallerChangesAllowed
                : Layer.succeed(McpCallerChanges.McpCallerChanges, {
                    forThread: () => Effect.succeed(caller.changes!),
                  }),
              Layer.succeed(McpCallerBot.McpCallerBot, {
                forThread: () => Effect.succeed(caller.accessOf ?? { _tag: "none" }),
              }),
              Layer.mock(BotContinuation.BotContinuation)({
                save: (input) =>
                  record("save_continuation").pipe(
                    Effect.as({
                      _tag: "conflict",
                      reason: "revision",
                      current: continuationView(input),
                    } as const),
                  ),
                get: (input) => Effect.succeed(continuationView(input)),
              }),
              Layer.mock(BotService.BotService)({
                list: Effect.succeed({ bots: [] }),
                get: () => record("get"),
                attachProject: (input) => record(`attach:${input.projectId}`),
                updateProjectContext: (input) =>
                  record(`project:${input.projectId}:${input.guidance}:${input.sources?.length}`),
                update: () =>
                  record("update").pipe(
                    Effect.andThen(Effect.fail(new BotError({ message: "This Bot is archived." }))),
                  ),
                create: () => record("create"),
                setArchived: (input) => record(input.archived ? "archive" : "restore"),
                detachProject: () => record("detach"),
                retireLearning: () => record("retire"),
                restoreLearning: () => record("reinstate"),
                scopeOfThread: () =>
                  Effect.succeed(
                    callerBot === undefined
                      ? undefined
                      : { homeThreadId: threadId, taskId: null, ...callerBot },
                  ),
                recordLearning: (input) =>
                  record(
                    `learn:${input.projectId}:${input.origin}:${
                      input.source.kind === "thread" ? input.source.threadId : input.source.kind
                    }`,
                  ).pipe(
                    Effect.map((bot) => ({
                      bot,
                      learned: {
                        entryId: BotLearningEntryId.make("entry-1"),
                        revision: 1,
                        status: "pending" as const,
                        duplicate: false,
                      },
                    })),
                  ),
                decideLearning: (input) => record(`decide:${input.decision}`),
                resolveProject: (input) =>
                  Effect.succeed({ projectId: input.projectId ?? campaignA } as never),
              }),
              Layer.mock(BotTaskService.BotTaskService)({
                list: () =>
                  Ref.update(calls, (current) => [...current, "list_tasks"]).pipe(
                    Effect.as({ tasks: [] }),
                  ),
                get: (taskId) => {
                  const owner = taskOwners.get(taskId);
                  return owner === undefined
                    ? Effect.fail(new BotError({ message: "Bot task not found." }))
                    : Effect.succeed({ ...taskSummary, id: taskId, botId: owner });
                },
                cancel: () =>
                  Ref.update(calls, (current) => [...current, "cancel"]).pipe(
                    Effect.as(taskSummary),
                  ),
                start: (input) =>
                  Ref.update(calls, (current) => [
                    ...current,
                    `start:${JSON.stringify(input.modelSelection ?? null)}`,
                  ]).pipe(
                    Effect.as({
                      ...taskSummary,
                      projectId: input.projectId,
                      modelSelection: input.modelSelection ?? detail.modelSelection,
                    }),
                  ),
              }),
            ),
          ),
        ),
      ),
    );
    return { result, calls: yield* Ref.get(calls) };
  });

it.effect("routes project updates to that project's guidance and sources", () =>
  Effect.gen(function* () {
    const { calls } = yield* callTool(
      {
        action: "update",
        botId,
        projectId: campaignA,
        guidance: "Use the vault from now on.",
        sources: [{ label: "Vault", location: "/vaults/a" }],
      },
      undefined,
    );
    expect(calls).toEqual([`project:${campaignA}:Use the vault from now on.:1`]);
  }),
);

it.effect(
  "records learning only from the Bot's own conversation and leaves decisions to the user",
  () =>
    Effect.gen(function* () {
      const campaignB = ProjectId.make("project-campaign-b");
      const own = { botId, projectId: campaignA };
      const learning = {
        origin: "correction" as const,
        kind: "preference" as const,
        text: "Dates use Dale Reckoning.",
      };

      const learned = yield* callTool(
        { action: "learn", botId, projectId: campaignA, learning },
        undefined,
        own,
      );
      // The source is the calling thread, whatever the caller claims.
      expect(learned.calls).toEqual([`learn:${campaignA}:correction:${threadId}`]);
      expect(learned.result).toMatchObject({ learned: { status: "pending" } });

      const otherProject = yield* callTool(
        { action: "learn", botId, projectId: campaignB, learning },
        undefined,
        own,
      );
      expect(otherProject.result).toMatchObject({ code: "invalid_request" });
      expect(otherProject.calls).toEqual([]);

      // A work thread's lesson is attributed to its task, which the server resolved.
      const fromTask = yield* callTool(
        { action: "learn", botId, projectId: campaignA, learning },
        undefined,
        { ...own, taskId: BotTaskId.make("bot-task:1") },
      );
      expect(fromTask.calls).toEqual([`learn:${campaignA}:correction:task`]);

      const selfAdopt = yield* callTool(
        { action: "adopt", botId, entryId: BotLearningEntryId.make("entry-1"), revision: 1 },
        undefined,
        own,
      );
      expect(selfAdopt.result).toMatchObject({ code: "invalid_request" });
      expect(selfAdopt.calls).toEqual([]);

      // Another agent the user directs can decide, behind the same write access as other edits.
      const adopted = yield* callTool(
        { action: "adopt", botId, entryId: BotLearningEntryId.make("entry-1"), revision: 1 },
        undefined,
      );
      expect(adopted.calls).toEqual(["decide:adopt"]);
      const readOnly = yield* callTool(
        { action: "learn", botId, projectId: campaignA, learning },
        "read-only",
      );
      expect(readOnly.result).toMatchObject({ code: "capability_denied" });
    }),
);

it.effect("starts a task on its own model without updating the Bot", () =>
  Effect.gen(function* () {
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.1",
      options: [{ id: "reasoningEffort", value: "low" }],
    };
    const started = yield* callTool(
      { action: "start_task", botId, task: "Recap.", modelSelection },
      undefined,
    );
    expect(started.calls).toEqual([`start:${JSON.stringify(modelSelection)}`]);
    expect(started.result).toMatchObject({ task: { modelSelection } });
    const inherited = yield* callTool({ action: "start_task", botId, task: "Recap." }, undefined);
    expect(inherited.calls).toEqual(["start:null"]);
    const malformed = yield* callTool(
      {
        action: "start_task",
        botId,
        task: "Recap.",
        modelSelection: { ...modelSelection, options: { reasoningEffort: 123 } },
      } as unknown as BotToolInput,
      undefined,
    );
    expect(malformed.result).toMatchObject({
      reason: { _tag: "ToolParameterValidationError" },
    });
    expect(malformed.calls).toEqual([]);
    const value = { anyOf: [{ type: "string" }, { type: "boolean" }] };
    const options = {
      anyOf: [
        { type: "array", items: { properties: { value } } },
        { type: "object", additionalProperties: value },
      ],
    };
    expect(advertisedJsonSchema(BotToolkit.tools.t3_bot)).toMatchObject({
      properties: {
        modelSelection: {
          anyOf: [
            { required: ["instanceId", "model"], properties: { options } },
            { required: ["provider", "model"], properties: { options } },
          ],
        },
      },
    });
  }),
);

const learning = { origin: "correction", kind: "preference", text: "Always recap." } as const;
const entry = { entryId: BotLearningEntryId.make("entry-1"), revision: 1 };
const botChanges: ReadonlyArray<readonly [(bot: BotId) => BotToolInput, string]> = [
  [(bot) => ({ action: "start_task", botId: bot, task: "Check mail." }), "start:null"],
  [(bot) => ({ action: "cancel_task", taskId: bot === botId ? ownTask : otherTask }), "cancel"],
  [(bot) => ({ action: "update", botId: bot, instructions: "Process work mail." }), "update"],
  [
    (bot) => ({ action: "update", botId: bot, projectId: campaignA, guidance: "Changed." }),
    `project:${campaignA}:Changed.:undefined`,
  ],
  [(bot) => ({ action: "archive", botId: bot }), "archive"],
  [(bot) => ({ action: "restore", botId: bot }), "restore"],
  [(bot) => ({ action: "attach", botId: bot, projectId: campaignA }), `attach:${campaignA}`],
  [(bot) => ({ action: "detach", botId: bot, projectId: campaignA }), "detach"],
  [
    (bot) => ({
      action: "create",
      botId: bot,
      name: "Work Companion",
      modelSelection: detail.modelSelection,
      learningPolicy: "automatic",
    }),
    "create",
  ],
  [
    (bot) => ({ action: "learn", botId: bot, projectId: campaignA, learning }),
    `learn:${campaignA}:correction:${threadId}`,
  ],
  // A Bot never decides its own learning; the user does, in Settings.
  [(bot) => ({ action: "adopt", botId: bot, ...entry }), "invalid_request"],
  [(bot) => ({ action: "reject", botId: bot, ...entry }), "invalid_request"],
  [(bot) => ({ action: "retire", botId: bot, ...entry }), "invalid_request"],
  [(bot) => ({ action: "reinstate", botId: bot, ...entry }), "invalid_request"],
];
const ordinaryCallerReaches: Record<string, string> = {
  adopt: "decide:adopt",
  reject: "decide:reject",
  retire: "retire",
  reinstate: "reinstate",
};

// Its Home, a subagent or a fork: the same Bot, whichever thread the line reaches. Another Bot's
// work runs with that Bot's grants, so a Bot's line starts and changes only its own.
it.effect.each(
  botChanges.flatMap(([params, ownCall]) => {
    const own = params(botId);
    const other = params(otherBot);
    return [
      [own, { _tag: "bot", botId }, ownCall],
      [other, { _tag: "bot", botId }, "capability_denied"],
      [other, { _tag: "none" }, ordinaryCallerReaches[other.action] ?? ownCall],
      [own, { _tag: "unknown" }, "capability_denied"],
    ] as const;
  }),
)("t3_bot %o from %o: %s", ([params, accessOf, expected]) =>
  callTool(
    params,
    undefined,
    accessOf._tag === "bot" ? { botId: accessOf.botId, projectId: campaignA } : undefined,
    false,
    { accessOf },
  ).pipe(
    Effect.map(({ calls, result }) =>
      expect(calls[0] ?? (result as { readonly code?: string } | undefined)?.code).toBe(expected),
    ),
  ),
);

it.effect("lets read-only clients read Bots but not change them", () =>
  Effect.gen(function* () {
    const read = yield* callTool({ action: "read", botId }, "read-only");
    expect(read.calls).toEqual(["get"]);
    // Appearance is client presentation; the agent's view of a Bot stays unchanged.
    expect(read.result).toMatchObject({ bot: { name: detail.name } });
    expect(read.result).not.toHaveProperty("bot.appearance");
    const attach = yield* callTool({ action: "attach", botId, projectId: campaignA }, "read-only");
    expect(attach.result).toMatchObject({ code: "capability_denied" });
    expect(attach.calls).toEqual([]);
    const tasks = yield* callTool({ action: "list_tasks", botId }, "read-only");
    expect(tasks.calls).toEqual(["list_tasks"]);
    const start = yield* callTool(
      { action: "start_task", botId, task: "Prepare.", returnToHome: true },
      "read-only",
    );
    expect(start.result).toMatchObject({ code: "capability_denied" });
    expect(start.calls).toEqual([]);
  }),
);

it.effect("reports missing fields and service refusals as request errors", () =>
  Effect.gen(function* () {
    const attach = yield* callTool({ action: "attach", botId }, undefined);
    expect(attach.result).toMatchObject({
      code: "invalid_request",
      message: "`attach` needs `projectId`.",
    });
    const update = yield* callTool({ action: "update", botId, name: "Renamed" }, undefined);
    expect(update.result).toMatchObject({
      code: "invalid_request",
      message: "This Bot is archived.",
    });
  }),
);

it.effect(
  "allows external inspection but refuses an external continuation writer before reaching the service",
  () =>
    Effect.gen(function* () {
      const read = yield* callTool(
        { action: "read_continuation", botId, projectId: campaignA },
        undefined,
        undefined,
        true,
      );
      expect(read.result).toMatchObject({
        continuation: { revision: null, homeThreadId: threadId },
      });
      const save = yield* callTool(
        {
          action: "save_continuation",
          botId,
          projectId: campaignA,
          continuation: {
            baseRevision: null,
            updateId: "external",
            note: { requests: [], waiting: [], decided: [], context: [] },
          },
        },
        undefined,
        undefined,
        true,
      );
      expect(save.result).toMatchObject({ code: "thread_credential_required" });
      expect(save.calls).toEqual([]);
    }),
);

const saveNote = {
  action: "save_continuation",
  botId,
  projectId: campaignA,
  continuation: {
    baseRevision: null,
    updateId: "maintenance",
    note: { requests: [], waiting: [], decided: [], context: [] },
  },
} as const;

const learnFromHome = {
  action: "learn",
  botId,
  projectId: campaignA,
  learning: { origin: "correction", kind: "preference", text: "Always recap." },
} as const;

it.effect.each(["botNote", "botWaiting"] as const)(
  "a restricted Home run may save its own note and change nothing else: %s",
  (changes) =>
    Effect.gen(function* () {
      const restricted = (params: BotToolInput, subagent = false) =>
        callTool(params, undefined, { botId, projectId: campaignA }, false, {
          changes,
          subagent,
        });
      expect((yield* restricted(saveNote)).calls).toEqual(["save_continuation"]);
      for (const params of [
        { action: "start_task", botId, task: "Prepare.", returnToHome: true },
        {
          action: "learn",
          botId,
          projectId: campaignA,
          learning: { origin: "correction", kind: "preference", text: "Always recap." },
        },
        { action: "update", botId, projectId: campaignA, guidance: "Changed." },
        { action: "attach", botId, projectId: campaignA },
      ] as const) {
        const refused = yield* restricted(params as BotToolInput);
        expect(refused.result, params.action).toMatchObject({ code: "capability_denied" });
        expect(refused.calls).toEqual([]);
      }
      const fromSubagent = yield* restricted(saveNote, true);
      expect(fromSubagent.result).toMatchObject({ code: "capability_denied" });
      expect(fromSubagent.calls).toEqual([]);
    }),
);

it.effect("a sealed load's call never gets ordinary authority once its Home is ordinary", () =>
  Effect.gen(function* () {
    // A native child of a restricted run keeps the sealed load's credential after the run ends.
    for (const params of [learnFromHome, saveNote]) {
      const refused = yield* callTool(params, undefined, { botId, projectId: campaignA }, false, {
        changes: "allowed",
        sealedLoad: true,
      });
      expect(refused.result, params.action).toMatchObject({ code: "capability_denied" });
      expect(refused.calls).toEqual([]);
    }
  }),
);

it.effect("a No changes routine task still cannot save a working note", () =>
  Effect.gen(function* () {
    const refused = yield* callTool(saveNote, undefined, undefined, false, { changes: "none" });
    expect(refused.result).toMatchObject({ code: "capability_denied" });
    expect(refused.calls).toEqual([]);
  }),
);
