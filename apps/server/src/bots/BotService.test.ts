import * as BotContinuation from "./BotContinuation.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BotDetail,
  BotId,
  BotTaskId,
  McpConnectionId,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotProjectGuard from "./BotProjectGuard.ts";
import * as BotService from "./BotService.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";
import * as BotTaskService from "./BotTaskService.ts";
import * as BotTurnContext from "./BotTurnContext.ts";

const campaignA = ProjectId.make("project-campaign-a");
const campaignB = ProjectId.make("project-campaign-b");
const botId = BotId.make("faerun-companion");
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

interface FakeThread {
  readonly projectId: ProjectId;
  readonly archived: boolean;
  readonly model: string;
}

/** Stands in for the orchestrator: records home threads and the commands that reach them. */
const makeThreadWorld = Effect.gen(function* () {
  const threads = yield* Ref.make(new Map<ThreadId, FakeThread>());
  const commands = yield* Ref.make<ReadonlyArray<string>>([]);
  const failNext = yield* Ref.make<string | null>(null);

  const setThread = (threadId: ThreadId, update: (thread: FakeThread) => FakeThread) =>
    Ref.update(threads, (current) => {
      const thread = current.get(threadId);
      return thread === undefined ? current : new Map(current).set(threadId, update(thread));
    });

  const dispatch = Effect.fn("FakeThreads.dispatch")(function* (
    command: OrchestrationV2ServerCommand,
  ) {
    if ((yield* Ref.get(failNext)) === command.type) {
      yield* Ref.set(failNext, null);
      return yield* Effect.die(`injected ${command.type} failure`);
    }
    yield* Ref.update(commands, (current) => [...current, command.type]);
    if (command.type === "thread.archive" || command.type === "thread.unarchive") {
      const archived = command.type === "thread.archive";
      yield* setThread(command.threadId, (thread) => ({ ...thread, archived }));
    }
    if (command.type === "thread.model-selection.set") {
      const model = command.modelSelection.model;
      yield* setThread(command.threadId, (thread) => ({ ...thread, model }));
    }
    return { storedEvents: [] } as never;
  });

  const threadLayer = Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch,
      getThreadShell: Effect.fn("FakeThreads.getThreadShell")(function* (threadId: ThreadId) {
        const thread = (yield* Ref.get(threads)).get(threadId);
        if (thread === undefined) return null;
        const shell: Pick<
          OrchestrationV2ThreadShell,
          "archivedAt" | "deletedAt" | "modelSelection"
        > = {
          archivedAt: thread.archived ? DateTime.makeUnsafe(0) : null,
          deletedAt: null,
          modelSelection: { ...codex, model: thread.model },
        };
        return shell as OrchestrationV2ThreadShell;
      }),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: Effect.fn("FakeThreads.launch")(function* (input) {
        const threadId = input.threadId ?? ThreadId.make("unexpected");
        yield* Ref.update(commands, (current) => [...current, "thread.create"]);
        yield* Ref.update(threads, (current) =>
          current.has(threadId)
            ? current
            : new Map(current).set(threadId, {
                projectId: input.projectId,
                archived: false,
                model: input.modelSelection.model,
              }),
        );
        return { threadId, resumed: false } as never;
      }),
    }),
  );
  return { threads, commands, failNext, threadLayer };
});

const layerSupport = Layer.mergeAll(
  Layer.mock(ProjectService.ProjectService)({
    getById: (projectId: ProjectId) =>
      Effect.succeedSome({ id: projectId, deletedAt: null } as Project),
  }),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    getInstance: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(instanceId === "claude" ? "claudeAgent" : "codex"),
      } as ProviderInstance),
  }),
  // Task selections are covered in BotTaskService.test.ts.
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  BotProjectGuard.layer,
  Scheduler.layer,
  ServerSettings.layerTest(),
  // Routine pausing is covered with the real scheduled task service in BotTaskService.test.ts.
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({ pauseBotRoutines: () => Effect.void }),
);

const layerDatabase = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-service-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const seedProjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [projectId, title] of [
    // Equal titles: only the ids in the Bot context tell the campaigns apart.
    [campaignA, "Faerun"],
    [campaignB, "Faerun"],
  ] as const) {
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${projectId}, ${title}, ${`/campaigns/${projectId}`}, NULL,
        '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
      )
    `;
  }
});

/** Builds the services fresh, as a server restart over the same database would. */
const withServices = <A, E>(
  threadLayer: Layer.Layer<
    ThreadManagementService.ThreadManagementService | ThreadLaunchService.ThreadLaunchService
  >,
  body: (services: {
    readonly bots: BotService.BotService["Service"];
    readonly turnContext: BotTurnContext.BotTurnContext["Service"];
    readonly continuation: BotContinuation.BotContinuation["Service"];
    readonly settings: ServerSettings.ServerSettingsService["Service"];
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const bots = yield* BotService.BotService;
    const turnContext = yield* BotTurnContext.BotTurnContext;
    const continuation = yield* BotContinuation.BotContinuation;
    const settings = yield* ServerSettings.ServerSettingsService;
    return yield* body({ bots, turnContext, continuation, settings });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(BotService.layer, BotTurnContext.layer, BotContinuation.layer).pipe(
        Layer.provide(BotTaskService.layer),
        Layer.provideMerge(Layer.merge(threadLayer, layerSupport)),
      ),
    ),
    Effect.scoped,
  );

const instructionsFor = Effect.fn("BotServiceTest.instructionsFor")(function* (
  turnContext: BotTurnContext.BotTurnContext["Service"],
  threadId: ThreadId,
) {
  const result = yield* turnContext.forThread(threadId);
  return result._tag === "active" ? result.instructions : result._tag;
});

const createCampaignBot = (bots: BotService.BotService["Service"], id = botId) =>
  bots.create({
    botId: id,
    name: "Faerun Companion",
    instructions: "Answer as the campaign companion.",
    modelSelection: codex,
    learningPolicy: "after_adoption",
  });

it.effect(
  "serves two campaigns with separate conversations and instructions across a restart",
  () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const world = yield* makeThreadWorld;
      const twinId = BotId.make("faerun-companion-twin");
      const vault = { label: "Campaign A vault", location: "/vaults/a" };
      const homes = yield* withServices(world.threadLayer, ({ bots, continuation }) =>
        Effect.gen(function* () {
          yield* createCampaignBot(bots);
          yield* bots.attachProject({
            botId,
            projectId: campaignA,
            guidance: "Strahd is alive in this campaign.",
            sources: [vault],
          });
          const detail = yield* bots.attachProject({
            botId,
            projectId: campaignB,
            guidance: "Strahd was defeated in this campaign.",
          });
          yield* continuation.save(
            {
              botId,
              projectId: campaignA,
              baseRevision: null,
              updateId: "campaign-note",
              note: {
                requests: [{ text: "Prepare the Amber Temple encounter after a date is chosen." }],
                waiting: [],
                decided: [],
                context: [],
              },
            },
            { kind: "user" },
          );
          const [a, b] = detail.projects;
          assert.notEqual(a?.homeThreadId, b?.homeThreadId);
          // Same name as the first Bot, attached to the same project.
          yield* createCampaignBot(bots, twinId);
          const twin = yield* bots.attachProject({ botId: twinId, projectId: campaignA });
          return {
            a: a?.homeThreadId ?? assert.fail(),
            b: b?.homeThreadId ?? assert.fail(),
            twin: twin.projects[0]?.homeThreadId ?? assert.fail(),
          };
        }),
      );

      yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
        Effect.gen(function* () {
          const a = yield* instructionsFor(turnContext, homes.a);
          assert.include(a, "Strahd is alive");
          assert.include(a, "Working notes");
          assert.include(a, "save_continuation");
          assert.include(a, "Prepare the Amber Temple encounter");
          assert.include(a, `botId "${botId}"`);
          assert.include(a, `projectId "${campaignA}"`);
          assert.include(a, "- Campaign A vault: /vaults/a");
          assert.notInclude(a, "Strahd was defeated");
          const b = yield* instructionsFor(turnContext, homes.b);
          assert.include(b, "Strahd was defeated");
          assert.include(b, `projectId "${campaignB}"`);
          assert.notInclude(b, "Strahd is alive");
          assert.notInclude(b, "Prepare the Amber Temple encounter");
          const twin = yield* instructionsFor(turnContext, homes.twin);
          assert.include(twin, `botId "${twinId}"`);
          assert.notInclude(twin, `botId "${botId}"`);
          assert.notInclude(twin, "Prepare the Amber Temple encounter");
          assert.equal(yield* instructionsFor(turnContext, ThreadId.make("plain")), "none");

          // A standing change through the ids, as the t3_bot tool makes it.
          yield* bots.updateProjectContext({
            botId,
            projectId: campaignA,
            guidance: "Strahd fled to the Amber Temple.",
            sources: [vault, { label: "Sword Coast guide", location: "/books/scag.pdf" }],
          });

          // A repeated attach keeps the existing conversation.
          yield* bots.attachProject({ botId, projectId: campaignA });
        }),
      );

      yield* withServices(world.threadLayer, ({ turnContext }) =>
        Effect.gen(function* () {
          const a = yield* instructionsFor(turnContext, homes.a);
          assert.include(a, "Amber Temple");
          assert.include(a, "- Campaign A vault: /vaults/a");
          assert.include(a, "- Sword Coast guide: /books/scag.pdf");
          assert.notInclude(yield* instructionsFor(turnContext, homes.b), "Sword Coast guide");
          assert.notInclude(yield* instructionsFor(turnContext, homes.twin), "Sword Coast guide");
        }),
      );
      const created = (yield* Ref.get(world.commands)).filter((type) => type === "thread.create");
      assert.lengthOf(created, 3);
      const threads = yield* Ref.get(world.threads);
      assert.equal(threads.get(homes.a)?.projectId, campaignA);
      assert.equal(threads.get(homes.b)?.projectId, campaignB);
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("archive blocks the conversations and restore reopens them", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
      Effect.gen(function* () {
        yield* createCampaignBot(bots);
        const detail = yield* bots.attachProject({ botId, projectId: campaignA });
        const home = detail.projects[0]?.homeThreadId ?? assert.fail();

        const archived = yield* bots.setArchived({ botId, archived: true });
        assert.isNotNull(archived.archivedAt);
        assert.isTrue((yield* Ref.get(world.threads)).get(home)?.archived);
        assert.equal(yield* instructionsFor(turnContext, home), "inactive");
        const edit = yield* bots.update({ botId, name: "Renamed" }).pipe(Effect.flip);
        assert.include(edit.message, "archived");

        yield* bots.setArchived({ botId, archived: false });
        assert.isFalse((yield* Ref.get(world.threads)).get(home)?.archived);
        assert.include(yield* instructionsFor(turnContext, home), "campaign companion");
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("keeps a chosen appearance through restarts and other edits until reset", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    const look = { color: "orange", face: "joy", topper: "sprout" } as const;
    yield* withServices(world.threadLayer, ({ bots }) =>
      Effect.gen(function* () {
        assert.isNull((yield* createCampaignBot(bots)).appearance);
        yield* bots.update({ botId, appearance: look });
        yield* bots.update({ botId, name: "Renamed", modelSelection: { ...codex, model: "o3" } });
        yield* bots.setArchived({ botId, archived: true });
        yield* bots.setArchived({ botId, archived: false });
      }),
    );
    yield* withServices(world.threadLayer, ({ bots }) =>
      Effect.gen(function* () {
        const [summary] = (yield* bots.list).bots;
        assert.equal(summary?.name, "Renamed");
        assert.deepStrictEqual(summary?.appearance, look);
        assert.isNull((yield* bots.update({ botId, appearance: null })).appearance);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("detach and reattach keep the same conversation and its guidance", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
      Effect.gen(function* () {
        yield* createCampaignBot(bots);
        const attached = yield* bots.attachProject({
          botId,
          projectId: campaignA,
          guidance: "Use the session log.",
        });
        const home = attached.projects[0]?.homeThreadId ?? assert.fail();

        const detached = yield* bots.detachProject({ botId, projectId: campaignA });
        assert.isNotNull(detached.projects[0]?.detachedAt);
        assert.isTrue((yield* Ref.get(world.threads)).get(home)?.archived);
        assert.equal(yield* instructionsFor(turnContext, home), "inactive");
        // A model change while detached reaches the conversation on reattach.
        yield* bots.update({ botId, modelSelection: { ...codex, model: "gpt-5.5" } });
        assert.equal((yield* Ref.get(world.threads)).get(home)?.model, "gpt-5");

        const reattached = yield* bots.attachProject({ botId, projectId: campaignA });
        assert.equal(reattached.projects[0]?.homeThreadId, home);
        assert.isNull(reattached.projects[0]?.detachedAt);
        assert.isFalse((yield* Ref.get(world.threads)).get(home)?.archived);
        assert.equal((yield* Ref.get(world.threads)).get(home)?.model, "gpt-5.5");
        assert.include(yield* instructionsFor(turnContext, home), "Use the session log.");
      }),
    );
    const created = (yield* Ref.get(world.commands)).filter((type) => type === "thread.create");
    assert.lengthOf(created, 1);
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("finishes an interrupted archive when the request is repeated", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
      Effect.gen(function* () {
        yield* createCampaignBot(bots);
        const detail = yield* bots.attachProject({ botId, projectId: campaignA });
        const home = detail.projects[0]?.homeThreadId ?? assert.fail();

        yield* Ref.set(world.failNext, "thread.archive");
        yield* bots.setArchived({ botId, archived: true }).pipe(Effect.exit);
        // The intent is recorded, so the conversation is already blocked.
        assert.isFalse((yield* Ref.get(world.threads)).get(home)?.archived);
        assert.equal(yield* instructionsFor(turnContext, home), "inactive");

        yield* bots.setArchived({ botId, archived: true });
        assert.isTrue((yield* Ref.get(world.threads)).get(home)?.archived);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("moves home conversations to a new model and rejects providers without Bot support", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots }) =>
      Effect.gen(function* () {
        yield* createCampaignBot(bots);
        const detail = yield* bots.attachProject({ botId, projectId: campaignA });
        const home = detail.projects[0]?.homeThreadId ?? assert.fail();

        yield* bots.update({ botId, modelSelection: { ...codex, model: "gpt-5.5" } });
        assert.equal((yield* Ref.get(world.threads)).get(home)?.model, "gpt-5.5");

        const claude = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus" };
        const rejected = yield* bots.update({ botId, modelSelection: claude }).pipe(Effect.flip);
        assert.include(rejected.message, "Codex");
        const rejectedCreate = yield* bots
          .create({
            botId: BotId.make("other-bot"),
            name: "Other",
            instructions: "",
            modelSelection: claude,
            learningPolicy: "automatic",
          })
          .pipe(Effect.flip);
        assert.include(rejectedCreate.message, "Codex");
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("pushes a rename to open Bot list subscriptions without renaming the conversation", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots }) =>
      Effect.gen(function* () {
        yield* createCampaignBot(bots);
        yield* bots.attachProject({ botId, projectId: campaignA });
        const pull = yield* Stream.toPull(bots.subscribeList());
        assert.deepEqual(
          (yield* pull).map(({ bots: list }) => list.map((bot) => bot.name)),
          [["Faerun Companion"]],
        );

        // Another client or the t3_bot tool renames it while this subscriber is open.
        yield* bots.update({ botId, name: "Sword Coast Companion" });
        assert.deepEqual(
          (yield* pull).map(({ bots: list }) => list.map((bot) => bot.name)),
          [["Sword Coast Companion"]],
        );
        assert.notInclude(yield* Ref.get(world.commands), "thread.metadata.update");
      }).pipe(Effect.scoped),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

const privateMail = McpConnectionId.make("2a2a2a2a-0000-4000-8000-00000000002a");
const workMail = McpConnectionId.make("2b2b2b2b-0000-4000-8000-00000000002b");
const retiredMail = McpConnectionId.make("2c2c2c2c-0000-4000-8000-00000000002c");
const mailDefinition = (label: string) => ({
  label,
  enabled: true,
  revision: 1,
  transport: { type: "stdio" as const, command: "mail-mcp", args: [], env: {} },
  authentication: { type: "bindings" as const },
});
const seedCatalog = (settings: ServerSettings.ServerSettingsService["Service"]) =>
  settings.updateMcpConnections(() =>
    Effect.succeed({
      mcpConnections: {
        [privateMail]: mailDefinition("Private mail"),
        [workMail]: mailDefinition("Work mail"),
      },
      retiredMcpConnectionIds: [retiredMail],
    }),
  );

it.effect("grants only catalog connections, as a whole set guarded by its revision", () =>
  Effect.gen(function* () {
    const world = yield* makeThreadWorld;
    const twinId = BotId.make("faerun-companion-twin");
    yield* withServices(world.threadLayer, ({ bots, settings }) =>
      Effect.gen(function* () {
        yield* seedCatalog(settings);
        const created = yield* createCampaignBot(bots);
        yield* createCampaignBot(bots, twinId);
        assert.deepEqual(created.mcpGrants, { revision: 0, connectionIds: [] });

        const granted = yield* bots.setMcpGrants({
          botId,
          expectedRevision: 0,
          connectionIds: [workMail, privateMail, workMail],
        });
        assert.deepEqual(granted.mcpGrants, {
          revision: 1,
          connectionIds: [privateMail, workMail],
        });

        const stale = yield* bots
          .setMcpGrants({ botId, expectedRevision: 0, connectionIds: [] })
          .pipe(Effect.flip);
        assert.include(stale.message, "changed since you opened them");
        for (const unknown of [
          retiredMail,
          McpConnectionId.make("2d2d2d2d-0000-4000-8000-00000000002d"),
        ]) {
          const refused = yield* bots
            .setMcpGrants({ botId, expectedRevision: 1, connectionIds: [unknown] })
            .pipe(Effect.flip);
          assert.include(refused.message, "no longer exists");
        }
        yield* bots.setMcpGrants({ botId: twinId, expectedRevision: 0, connectionIds: [workMail] });

        // Removing a catalog connection drops it from every Bot that had it.
        const pull = yield* Stream.toPull(bots.subscribeList());
        yield* pull;
        yield* bots.forgetMcpConnection(workMail);
        const [listed] = yield* pull;
        assert.deepEqual(
          listed?.bots.map((bot) => [bot.id, bot.mcpGrants]),
          [
            [botId, { revision: 2, connectionIds: [privateMail] }],
            [twinId, { revision: 2, connectionIds: [] }],
          ],
        );

        yield* bots.setArchived({ botId: twinId, archived: true });
        const archived = yield* bots
          .setMcpGrants({ botId: twinId, expectedRevision: 2, connectionIds: [privateMail] })
          .pipe(Effect.flip);
        assert.include(archived.message, "archived");
      }).pipe(Effect.scoped),
    );
    yield* withServices(world.threadLayer, ({ bots }) =>
      Effect.gen(function* () {
        assert.deepEqual((yield* bots.get({ botId })).mcpGrants, {
          revision: 2,
          connectionIds: [privateMail],
        });
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "gives forks and subagents of a Bot thread that Bot's grants, and refuses lost lines",
  () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const world = yield* makeThreadWorld;
      const sql = yield* SqlClient.SqlClient;
      const lineages = new Map<string, OrchestrationV2AppThreadLineage>();
      const thread = (
        id: string,
        parent: string | null,
        relationship: "fork" | "subagent" | null,
      ) =>
        Effect.gen(function* () {
          const lineage = {
            parentThreadId: parent === null ? null : ThreadId.make(parent),
            relationshipToParent: relationship,
            rootThreadId: ThreadId.make(id),
          };
          lineages.set(id, lineage);
          yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${id}, ${campaignA}, ${id}, 'codex', 'full-access', 'default',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${JSON.stringify({ lineage })}
          )
        `;
        });
      yield* withServices(world.threadLayer, ({ bots, turnContext, settings }) =>
        Effect.gen(function* () {
          yield* seedCatalog(settings);
          yield* createCampaignBot(bots);
          const home = (yield* bots.attachProject({ botId, projectId: campaignA })).projects[0]!
            .homeThreadId;
          yield* bots.setMcpGrants({ botId, expectedRevision: 0, connectionIds: [privateMail] });
          yield* thread(home, null, null);
          yield* thread("helper", home, "subagent");
          yield* thread("helper-fork", "helper", "fork");
          yield* thread("nested-helper", "helper-fork", "subagent");
          yield* thread("plain", null, null);
          yield* thread("plain-fork", "plain", "fork");
          yield* thread("orphan", "deleted-parent", "subagent");
          yield* thread("loop-a", "loop-b", "fork");
          yield* thread("loop-b", "loop-a", "fork");
          const access = (id: string) =>
            turnContext.mcpAccessForThread({ id: ThreadId.make(id), lineage: lineages.get(id)! });
          const granted = {
            _tag: "bot",
            botId,
            botName: "Faerun Companion",
            connectionIds: [privateMail],
          } as const;
          for (const id of [home, "helper", "helper-fork", "nested-helper"]) {
            assert.deepEqual(yield* access(id), granted, id);
          }
          for (const id of ["plain", "plain-fork"]) {
            assert.deepEqual(yield* access(id), { _tag: "none" }, id);
          }
          for (const id of ["orphan", "loop-a"]) {
            assert.equal((yield* access(id))._tag, "refused", id);
          }
          // Instructions and learning do not follow the line; only MCP access does.
          assert.equal((yield* turnContext.forThread(ThreadId.make("helper")))._tag, "none");

          yield* bots.detachProject({ botId, projectId: campaignA });
          const detached = yield* access("nested-helper");
          assert.equal(detached._tag, "refused");
          assert.include(detached._tag === "refused" ? detached.message : "", "detached");
        }),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

const correction = {
  origin: "correction" as const,
  kind: "preference" as const,
  text: "Give in-world dates in Dale Reckoning.",
  evidence: "No, we use DR dates here.",
  source: { kind: "thread" as const, threadId: ThreadId.make("bot-home:faerun-companion:a") },
};

const statusesOf = (detail: { readonly learning: BotDetail["learning"] }) =>
  detail.learning.map((entry) => entry.revisions.map((revision) => revision.status).join(","));

it.effect(
  "applies corrections by policy, standing instructions at once, and keeps them across a restart",
  () =>
    Effect.gen(function* () {
      yield* seedProjects;
      const world = yield* makeThreadWorld;
      const autoId = BotId.make("auto-companion");
      const homes = yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
        Effect.gen(function* () {
          yield* createCampaignBot(bots);
          yield* bots.create({
            botId: autoId,
            name: "Auto Companion",
            instructions: "",
            modelSelection: codex,
            learningPolicy: "automatic",
          });
          const adoption = yield* bots.attachProject({ botId, projectId: campaignA });
          const auto = yield* bots.attachProject({ botId: autoId, projectId: campaignA });
          const adoptionHome = adoption.projects[0]?.homeThreadId ?? assert.fail();
          const autoHome = auto.projects[0]?.homeThreadId ?? assert.fail();

          const automatic = yield* bots.recordLearning({
            ...correction,
            botId: autoId,
            projectId: campaignA,
          });
          assert.equal(automatic.learned.status, "active");
          assert.include(yield* instructionsFor(turnContext, autoHome), "Dale Reckoning");
          // The user restating it makes it their instruction, which inferred lessons cannot override.
          const confirmed = yield* bots.recordLearning({
            ...correction,
            origin: "instruction",
            source: { kind: "user" },
            botId: autoId,
            projectId: campaignA,
          });
          assert.deepEqual(confirmed.learned, {
            ...automatic.learned,
            revision: 2,
            duplicate: false,
          });
          const override = yield* bots.recordLearning({
            ...correction,
            text: "Give dates in the Gregorian calendar.",
            replaces: { entryId: confirmed.learned.entryId, revision: 2 },
            botId: autoId,
            projectId: campaignA,
          });
          assert.equal(override.learned.status, "pending");

          const proposed = yield* bots.recordLearning({
            ...correction,
            botId,
            projectId: campaignA,
          });
          assert.equal(proposed.learned.status, "pending");
          assert.equal(proposed.bot.pendingLearning, 1);
          assert.notInclude(yield* instructionsFor(turnContext, adoptionHome), "Dale Reckoning");

          const instruction = yield* bots.recordLearning({
            botId,
            projectId: campaignA,
            origin: "instruction",
            kind: "preference",
            text: "Answer in German.",
            source: { kind: "user" },
          });
          assert.equal(instruction.learned.status, "active");
          assert.include(yield* instructionsFor(turnContext, adoptionHome), "Answer in German.");

          yield* bots.decideLearning({
            botId,
            entryId: proposed.learned.entryId,
            revision: 1,
            decision: "adopt",
          });
          return { adoptionHome };
        }),
      );

      yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
        Effect.gen(function* () {
          const detail = yield* bots.get({ botId });
          assert.deepEqual(statusesOf(detail), ["active", "active"]);
          assert.equal(detail.pendingLearning, 0);
          const dates = detail.learning.find((entry) => entry.revisions[0]?.text.includes("Dale"));
          assert.deepEqual(dates?.revisions[0]?.source, correction.source);
          assert.equal(dates?.revisions[0]?.evidence, correction.evidence);
          const instructions = yield* instructionsFor(turnContext, homes.adoptionHome);
          assert.include(instructions, "Dale Reckoning");
          assert.include(instructions, "Answer in German.");
        }),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("settles duplicates, stale replacements and conflicts with standing instructions", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
      Effect.gen(function* () {
        yield* bots.create({
          botId,
          name: "Faerun Companion",
          instructions: "",
          modelSelection: codex,
          learningPolicy: "automatic",
        });
        const attached = yield* bots.attachProject({ botId, projectId: campaignA });
        const home = attached.projects[0]?.homeThreadId ?? assert.fail();

        const first = yield* bots.recordLearning({ ...correction, botId, projectId: campaignA });
        const again = yield* bots.recordLearning({
          ...correction,
          text: "  give in-world dates in  Dale Reckoning. ",
          botId,
          projectId: campaignA,
        });
        assert.isTrue(again.learned.duplicate);
        assert.deepEqual(statusesOf(again.bot), ["active"]);

        const entryId = first.learned.entryId;
        const revised = yield* bots.recordLearning({
          ...correction,
          text: "Give in-world dates in Dale Reckoning, with the month name.",
          replaces: { entryId, revision: 1 },
          botId,
          projectId: campaignA,
        });
        assert.equal(revised.learned.status, "active");
        const stale = yield* bots.recordLearning({
          ...correction,
          text: "Give dates in the Gregorian calendar.",
          replaces: { entryId, revision: 1 },
          botId,
          projectId: campaignA,
        });
        assert.equal(stale.learned.status, "stale");
        assert.deepEqual(statusesOf(stale.bot), ["superseded,active,stale"]);
        assert.notInclude(yield* instructionsFor(turnContext, home), "Gregorian");

        // The user's standing instruction is not overridden by a later inferred lesson.
        const instruction = yield* bots.recordLearning({
          ...correction,
          origin: "instruction",
          text: "Keep answers under five sentences.",
          replaces: { entryId, revision: 2 },
          botId,
          projectId: campaignA,
        });
        assert.equal(instruction.learned.status, "active");
        assert.equal(instruction.learned.revision, 4);
        const conflicting = {
          ...correction,
          replaces: { entryId, revision: 4 },
          botId,
          projectId: campaignA,
        };
        const longer = yield* bots.recordLearning({ ...conflicting, text: "Answer at length." });
        const listed = yield* bots.recordLearning({ ...conflicting, text: "Answer as a list." });
        assert.equal(longer.learned.status, "pending");
        assert.equal(listed.learned.status, "pending");
        const repeated = yield* bots.recordLearning({ ...conflicting, text: "Answer at length." });
        assert.deepEqual(repeated.learned, { ...longer.learned, duplicate: true });
        const entry = listed.bot.learning[0];
        assert.isTrue(entry?.revisions[4]?.conflictsWithInstruction);
        assert.include(yield* instructionsFor(turnContext, home), "under five sentences");

        // Adopting one of two contradictory proposals settles the other.
        const decided = yield* bots.decideLearning({
          botId,
          entryId,
          revision: listed.learned.revision,
          decision: "adopt",
        });
        assert.deepEqual(statusesOf(decided), [
          "superseded,superseded,stale,superseded,stale,active",
        ]);

        const retired = yield* bots.retireLearning({ botId, entryId });
        assert.notInclude(yield* instructionsFor(turnContext, home), "Answer as a list.");
        assert.deepEqual(statusesOf(retired), [
          "superseded,superseded,stale,superseded,stale,retired",
        ]);
        const restored = yield* bots.restoreLearning({
          botId,
          entryId,
          revision: 4,
          source: { kind: "user" },
        });
        assert.include(yield* instructionsFor(turnContext, home), "under five sentences");
        assert.equal(restored.learning[0]?.revisions.at(-1)?.origin, "instruction");
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("counts a work task's lesson only once the server sees that task completed", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    const sql = yield* BotDatabase.BotDatabase;
    // Task rows as BotTaskService persists them, with the status it derived from the work thread.
    const insertTask = (taskId: string, homeThreadId: ThreadId) =>
      sql`
        INSERT INTO bot_tasks (
          task_id, bot_id, project_id, home_thread_id, work_thread_id, origin, title, prompt,
          runtime_mode, status, created_at, updated_at
        ) VALUES (
          ${taskId}, ${botId}, ${campaignA}, ${homeThreadId}, ${`bot-work:${taskId}`}, 'direct',
          'Prepare', 'Prepare the session.', 'full-access', 'running',
          '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z'
        )
      `.pipe(Effect.orDie);
    const setTaskStatus = (taskId: string, status: string) =>
      sql`UPDATE bot_tasks SET status = ${status} WHERE task_id = ${taskId}`.pipe(Effect.orDie);
    yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
      Effect.gen(function* () {
        yield* bots.create({
          botId,
          name: "Faerun Companion",
          instructions: "",
          modelSelection: codex,
          learningPolicy: "automatic",
        });
        const attached = yield* bots.attachProject({ botId, projectId: campaignA });
        const home = attached.projects[0]?.homeThreadId ?? assert.fail();
        yield* insertTask("bot-task:done", home);
        yield* insertTask("bot-task:failed", home);

        // Provenance comes from the work thread the caller runs in.
        const scope = yield* bots.scopeOfThread(ThreadId.make("bot-work:bot-task:done"));
        assert.deepEqual(scope, {
          botId,
          projectId: campaignA,
          homeThreadId: home,
          taskId: BotTaskId.make("bot-task:done"),
        });
        const fromTask = (taskId: string, text: string) =>
          bots.recordLearning({
            ...correction,
            text,
            source: { kind: "task", taskId: BotTaskId.make(taskId) },
            botId,
            projectId: campaignA,
          });

        // Even a Bot that learns automatically waits for the task to complete.
        const proposed = yield* fromTask("bot-task:done", "Open session prep with a recap.");
        assert.equal(proposed.learned.status, "pending");
        assert.isTrue((yield* fromTask("bot-task:done", "Something else.")).learned.duplicate);
        const early = yield* bots
          .decideLearning({
            botId,
            entryId: proposed.learned.entryId,
            revision: 1,
            decision: "adopt",
          })
          .pipe(Effect.flip);
        assert.include(early.message, "did not complete");
        const instructionFromTask = yield* bots
          .recordLearning({
            ...correction,
            origin: "instruction",
            text: "Always skip the recap.",
            source: { kind: "task", taskId: BotTaskId.make("bot-task:failed") },
            botId,
            projectId: campaignA,
          })
          .pipe(Effect.flip);
        assert.include(instructionFromTask.message, "standing instructions come from the user");
        yield* fromTask("bot-task:failed", "Skip the recap.");

        yield* setTaskStatus("bot-task:done", "completed");
        yield* setTaskStatus("bot-task:failed", "failed");
        yield* bots.reconcileTaskLearning;

        const detail = yield* bots.get({ botId });
        const statusOf = (text: string) =>
          detail.learning.find((entry) => entry.revisions[0]?.text === text)?.revisions.at(-1)
            ?.status;
        assert.equal(statusOf("Open session prep with a recap."), "active");
        assert.equal(statusOf("Skip the recap."), "diagnostic");
        // History cannot bring a lesson from unfinished work back either.
        const diagnostic = detail.learning.find(
          (entry) => entry.revisions[0]?.text === "Skip the recap.",
        );
        const restored = yield* bots
          .restoreLearning({
            botId,
            entryId: diagnostic?.id ?? assert.fail(),
            revision: 1,
            source: { kind: "user" },
          })
          .pipe(Effect.flip);
        assert.include(restored.message, "did not complete");
        const homeInstructions = yield* instructionsFor(turnContext, home);
        assert.include(homeInstructions, "Open session prep with a recap.");
        assert.notInclude(homeInstructions, "Skip the recap.");
        assert.include(
          yield* instructionsFor(turnContext, ThreadId.make("bot-work:bot-task:failed")),
          "Open session prep with a recap.",
        );
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("keeps facts in their project by default and shares them when explicitly requested", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots, turnContext }) =>
      Effect.gen(function* () {
        yield* bots.create({
          botId,
          name: "Faerun Companion",
          instructions: "",
          modelSelection: codex,
          learningPolicy: "automatic",
        });
        yield* bots.attachProject({ botId, projectId: campaignA });
        const detail = yield* bots.attachProject({ botId, projectId: campaignB });
        const [homeA, homeB] = detail.projects.map((project) => project.homeThreadId);

        const local = yield* bots.recordLearning({
          ...correction,
          kind: "fact",
          text: "Strahd fled to the Amber Temple.",
          botId,
          projectId: campaignA,
        });
        const explicitLocal = yield* bots.recordLearning({
          ...correction,
          kind: "fact",
          scope: "project",
          text: "The party meets in Vallaki.",
          botId,
          projectId: campaignA,
        });
        const existingFacts = explicitLocal.bot.learning;
        assert.equal(local.learned.status, "active");
        assert.equal(explicitLocal.learned.status, "active");
        assert.isTrue(existingFacts.every((entry) => entry.projectId === campaignA));

        const sharedFact = yield* bots.recordLearning({
          botId,
          projectId: campaignA,
          kind: "fact",
          scope: "bot",
          origin: "instruction",
          text: "The user's name is Rowan.",
          evidence: "Remember my name, Rowan, for all your projects.",
          source: { kind: "user" },
        });
        assert.equal(sharedFact.learned.status, "active");
        const sharedEntry = sharedFact.bot.learning.find(
          (entry) => entry.id === sharedFact.learned.entryId,
        );
        assert.equal(sharedEntry?.kind, "fact");
        assert.isNull(sharedEntry?.projectId);
        assert.equal(sharedEntry?.revisions[0]?.learnedInProjectId, campaignA);

        const proposedFact = yield* bots.recordLearning({
          ...correction,
          kind: "fact",
          scope: "bot",
          text: "The user's timezone is Europe/Berlin.",
          botId,
          projectId: campaignA,
        });
        assert.equal(proposedFact.learned.status, "pending");

        // Sharing is deliberate: an inferred lesson for every project waits for the user.
        const inferred = yield* bots.recordLearning({
          ...correction,
          scope: "bot",
          text: "Sign answers with the Bot's name.",
          botId,
          projectId: campaignA,
        });
        assert.equal(inferred.learned.status, "pending");
        yield* bots.recordLearning({
          botId,
          projectId: campaignA,
          scope: "bot",
          origin: "instruction",
          kind: "preference",
          text: "Use metric units.",
          source: { kind: "user" },
        });

        const a = yield* instructionsFor(turnContext, homeA ?? assert.fail());
        const b = yield* instructionsFor(turnContext, homeB ?? assert.fail());
        assert.include(a, "Amber Temple");
        assert.notInclude(b, "Amber Temple");
        assert.include(a, "Vallaki");
        assert.notInclude(b, "Vallaki");
        for (const instructions of [a, b]) {
          assert.include(
            instructions,
            `[${sharedFact.learned.entryId} r1; fact, all projects, standing instruction] The user's name is Rowan.`,
          );
          assert.notInclude(instructions, "Europe/Berlin");
        }
        assert.include(a, "Use metric units.");
        assert.include(b, "Use metric units.");
        assert.notInclude(b, "Sign answers");

        const adopted = yield* bots.decideLearning({
          botId,
          entryId: proposedFact.learned.entryId,
          revision: proposedFact.learned.revision,
          decision: "adopt",
        });
        for (const home of [homeA, homeB]) {
          assert.include(
            yield* instructionsFor(turnContext, home ?? assert.fail()),
            `[${proposedFact.learned.entryId} r1; fact, all projects] The user's timezone is Europe/Berlin.`,
          );
        }
        assert.deepEqual(
          adopted.learning.filter((entry) => entry.projectId === campaignA),
          existingFacts,
        );

        const detached = yield* bots.detachProject({ botId, projectId: campaignB });
        const refused = yield* bots
          .recordLearning({ ...correction, botId, projectId: campaignB })
          .pipe(Effect.flip);
        assert.include(refused.message, "not attached");
        assert.lengthOf(detached.learning, 6);
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("selects the only attached project and asks when several match", () =>
  Effect.gen(function* () {
    yield* seedProjects;
    const world = yield* makeThreadWorld;
    yield* withServices(world.threadLayer, ({ bots }) =>
      Effect.gen(function* () {
        yield* createCampaignBot(bots);
        yield* bots.attachProject({ botId, projectId: campaignA });
        assert.equal((yield* bots.resolveProject({ botId })).projectId, campaignA);

        yield* bots.attachProject({ botId, projectId: campaignB });
        const ambiguous = yield* bots.resolveProject({ botId }).pipe(Effect.flip);
        assert.include(ambiguous.message, "choose one");
        assert.equal(
          (yield* bots.resolveProject({ botId, projectId: campaignB })).projectId,
          campaignB,
        );
      }),
    );
  }).pipe(Effect.provide(layerDatabase)),
);
