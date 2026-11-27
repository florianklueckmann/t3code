import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as McpCallerChanges from "../mcp/McpCallerChanges.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as BotExecutionConstraint from "./BotExecutionConstraint.ts";
import * as BotDatabase from "./persistence/BotDatabase.ts";

const database = Sqlite.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-constraint-test-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const now = "2026-11-10T10:00:00.000Z";

it.effect("answers a caller's restriction from its newest unfinished run", () =>
  Effect.gen(function* () {
    const main = yield* SqlClient.SqlClient;
    const changes = yield* McpCallerChanges.McpCallerChanges;
    const home = ThreadId.make("bot-home:bot:project");
    const run = (id: string, ordinal: number, status: string, restriction?: string) =>
      main`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${id}, ${home}, ${ordinal}, 'codex', ${status}, ${now}, ${JSON.stringify(restriction === undefined ? {} : { restriction })})`;
    yield* run("restricted-done", 1, "completed", "botNote");
    assert.equal(yield* changes.forThread(home), "allowed");
    yield* run("restricted", 2, "running", "botWaiting");
    yield* run("queued-user", 3, "queued");
    assert.equal(yield* changes.forThread(home), "botWaiting");
    yield* main`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'restricted'`;
    yield* run("ordinary", 4, "running");
    assert.equal(yield* changes.forThread(home), "allowed");
  }).pipe(
    Effect.provide(BotExecutionConstraint.layerMcpCallerChanges.pipe(Layer.provideMerge(database))),
  ),
);

it.effect("lets the Bot-level Home with read access change things only through tasks", () =>
  Effect.gen(function* () {
    const bots = yield* BotDatabase.BotDatabase;
    const main = yield* SqlClient.SqlClient;
    const changes = yield* McpCallerChanges.McpCallerChanges;
    const constraint = yield* BotExecutionConstraint.BotExecutionConstraint;
    const botHome = ThreadId.make("bot-home:bot:bot-home-bot");
    const projectHome = ThreadId.make("bot-home:bot:project");
    yield* bots`INSERT INTO bots (bot_id, name, instructions, model_selection_json, learning_policy, created_at, updated_at)
      VALUES ('bot', 'Bot', '', '{}', 'after_adoption', ${now}, ${now})`;
    const home = (threadId: ThreadId, projectId: string, kind: string) =>
      bots`INSERT INTO bot_project_contexts (home_thread_id, bot_id, project_id, kind, guidance, sources_json, revision, attached_at, updated_at)
        VALUES (${threadId}, 'bot', ${projectId}, ${kind}, '', '[]', 0, ${now}, ${now})`;
    yield* home(botHome, "bot-home-bot", "bot");
    yield* home(projectHome, "project", "project");

    assert.equal(yield* constraint.forThread(botHome), "home-read");
    assert.equal(yield* changes.forThread(botHome), "botTasks");
    // A project Home of the same Bot keeps its own mode.
    assert.equal(yield* changes.forThread(projectHome), "allowed");
    // A restricted run is narrower than the Home's access.
    yield* main`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('note', ${botHome}, 1, 'codex', 'running', ${now}, ${JSON.stringify({ restriction: "botNote" })})`;
    assert.equal(yield* changes.forThread(botHome), "botNote");
    yield* main`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'note'`;

    yield* bots`UPDATE bots SET home_access = 'full' WHERE bot_id = 'bot'`;
    assert.equal(yield* constraint.forThread(botHome), "standard");
    assert.equal(yield* changes.forThread(botHome), "allowed");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BotExecutionConstraint.layerMcpCallerChanges,
        BotExecutionConstraint.layer,
      ).pipe(Layer.provideMerge(database)),
    ),
  ),
);
