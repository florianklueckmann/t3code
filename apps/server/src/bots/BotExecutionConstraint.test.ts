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
