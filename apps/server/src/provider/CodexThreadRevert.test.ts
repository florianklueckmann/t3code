import { assert, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";

import { revertCodexThread, revertCodexThreadAfter } from "./CodexThreadRevert.ts";

const page = (
  id: number,
  cursor: string | null,
  limit: number,
  turns: string[],
  nextCursor: string | null,
) => [
  {
    type: "expect_outbound" as const,
    frame: {
      id,
      method: "thread/turns/list",
      params: {
        threadId: "thread",
        cursor,
        limit,
        sortDirection: "desc",
        itemsView: "summary",
      },
    },
  },
  {
    type: "emit_inbound" as const,
    frame: {
      id,
      result: {
        data: turns.map((id) => ({ id, items: [], status: "completed", error: null })),
        nextCursor,
      },
    },
  },
];

it.effect("finds the revert boundary across pages of newest-first turns", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThread(client, "thread", 3).pipe(Effect.flip);
    assert.equal(result.message, "boundary reached");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-pages",
        entries: [
          ...page(1, null, 3, ["newest", "middle"], "older"),
          ...page(2, "older", 1, ["boundary"], null),
          {
            type: "expect_outbound",
            frame: {
              id: 3,
              method: "thread/revert",
              params: { threadId: "thread", beforeTurnId: "boundary" },
            },
          },
          {
            type: "emit_inbound",
            frame: { id: 3, error: { code: -32603, message: "boundary reached" } },
          },
        ],
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("reverts every native turn newer than the kept one, also turns T3 never recorded", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThreadAfter(client, "thread", new Set(["kept"])).pipe(
      Effect.flip,
    );
    assert.equal(result.message, "reverted from oldest-dropped");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-after-kept",
        entries: [
          ...page(1, null, 100, ["refused", "unrecorded"], "older"),
          ...page(2, "older", 100, ["oldest-dropped", "kept", "earlier"], null),
          {
            type: "expect_outbound",
            frame: {
              id: 3,
              method: "thread/revert",
              params: { threadId: "thread", beforeTurnId: "oldest-dropped" },
            },
          },
          {
            type: "emit_inbound",
            frame: { id: 3, error: { code: -32603, message: "reverted from oldest-dropped" } },
          },
        ],
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("keeps the newest surviving earlier turn when a recovery dropped the target", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThreadAfter(
      client,
      "thread",
      new Set(["target-dropped-by-rewind", "kept-149", "kept-148"]),
    ).pipe(Effect.flip);
    assert.equal(result.message, "reverted from after-rewind");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-after-dropped-target",
        entries: [
          ...page(1, null, 100, ["after-rewind", "kept-149", "kept-148"], null),
          {
            type: "expect_outbound",
            frame: {
              id: 2,
              method: "thread/revert",
              params: { threadId: "thread", beforeTurnId: "after-rewind" },
            },
          },
          {
            type: "emit_inbound",
            frame: { id: 2, error: { code: -32603, message: "reverted from after-rewind" } },
          },
        ],
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("reverts a fresh native conversation entirely when it holds none of the kept turns", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThreadAfter(
      client,
      "thread",
      new Set(["old-thread-turn"]),
    ).pipe(Effect.flip);
    assert.equal(result.message, "reverted from older");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-after-fresh",
        entries: [
          ...page(1, null, 100, ["newest", "older"], null),
          {
            type: "expect_outbound",
            frame: {
              id: 2,
              method: "thread/revert",
              params: { threadId: "thread", beforeTurnId: "older" },
            },
          },
          {
            type: "emit_inbound",
            frame: { id: 2, error: { code: -32603, message: "reverted from older" } },
          },
        ],
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("rejects repeated cursors instead of looping or reverting incomplete history", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThread(client, "thread", 3).pipe(Effect.flip);
    assert.equal(result.message, "Thread history pagination repeated a cursor.");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-loop",
        entries: [...page(1, null, 3, ["newest"], "again"), ...page(2, "again", 2, [], "again")],
      }),
    ),
    Effect.scoped,
  ),
);
