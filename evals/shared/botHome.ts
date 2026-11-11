// @effect-diagnostics nodeBuiltinImport:off - standalone eval fixtures on disk and in SQLite.
/**
 * A synthetic Bot Home on a running, parent-owned T3 Code server, and what the Bot evals read
 * back from it. Shared by the evals that run real Home turns end to end.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import { BotDetail, Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Call, encodeJson, SampleError } from "./devServerTools.ts";

export interface ObservedRef {
  readonly kind: string;
  readonly taskId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly quote?: string | undefined;
}
export interface ObservedItem {
  readonly text: string;
  readonly refs: readonly ObservedRef[];
}
export type ObservedNote = Readonly<
  Record<"requests" | "waiting" | "decided" | "context", readonly ObservedItem[]>
>;
export const NOTE_SECTIONS = ["requests", "waiting", "decided", "context"] as const;

const Ref = Schema.Struct({
  kind: Schema.String,
  taskId: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
  quote: Schema.optional(Schema.String),
});
const Item = Schema.Struct({ text: Schema.String, refs: Schema.Array(Ref) });
const Continuation = Schema.Struct({
  continuation: Schema.Struct({
    note: Schema.Struct({
      requests: Schema.Array(Item),
      waiting: Schema.Array(Item),
      decided: Schema.Array(Item),
      context: Schema.Array(Item),
    }),
  }),
});
const Tasks = Schema.Struct({
  tasks: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
});
export const TERMINAL_TASK = ["completed", "failed", "cancelled", "interrupted", "skipped"];

export interface BotHome {
  readonly root: string;
  readonly botId: string;
  readonly projectId: string;
  readonly homeThreadId: string;
}

/** A content hash of every project file outside `.git`, to show a turn changed none. */
export const files = (root: string): string =>
  encodeJson(
    NodeFS.readdirSync(root, { recursive: true, withFileTypes: true })
      .flatMap((entry) => {
        const path = NodePath.relative(root, NodePath.join(entry.parentPath, entry.name));
        if (path.split(NodePath.sep).includes(".git") || entry.isDirectory()) return [];
        return [
          [
            path,
            NodeCrypto.createHash("sha256")
              .update(NodeFS.readFileSync(NodePath.join(root, path)))
              .digest("hex"),
          ],
        ];
      })
      .sort((left, right) => left[0]!.localeCompare(right[0]!)),
  );

/** A new git project with one Bot on the given Codex model, attached so it has its Home. */
export const createBotHome = Effect.fn("evals.createBotHome")(function* (
  call: Call,
  input: {
    readonly tag: string;
    readonly work: string;
    readonly model: string;
    readonly effort: string;
  },
) {
  const root = NodePath.join(input.work, input.tag);
  NodeFS.mkdirSync(root, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "--quiet", root]);
  const project = yield* call(
    "t3_project_create",
    { title: "Acme planning", workspaceRoot: root },
    Project,
  );
  yield* call(
    "t3_bot",
    {
      action: "create",
      botId: input.tag,
      name: "Acme planning assistant",
      instructions: "Help plan synthetic Acme work.",
      learningPolicy: "after_adoption",
      modelSelection: {
        instanceId: "codex",
        model: input.model,
        options: [{ id: "reasoningEffort", value: input.effort }],
      },
    },
    Schema.Unknown,
  );
  const attached = yield* call(
    "t3_bot",
    { action: "attach", botId: input.tag, projectId: project.id },
    Schema.Struct({ bot: BotDetail }),
  );
  const homeThreadId = attached.bot.projects[0]?.homeThreadId;
  if (homeThreadId === undefined)
    return yield* new SampleError({ message: "fixture Home missing" });
  return { root, botId: input.tag, projectId: project.id, homeThreadId } satisfies BotHome;
});

export const noteOf = Effect.fn("evals.botNote")(function* (
  call: Call,
  home: { readonly botId: string; readonly projectId: string },
) {
  const read = yield* call("t3_bot", { action: "read_continuation", ...home }, Continuation);
  return read.continuation.note satisfies ObservedNote;
});

export const taskList = (call: Call, botId: string) =>
  call("t3_bot", { action: "list_tasks", botId }, Tasks).pipe(Effect.map((result) => result.tasks));

/** Whether a server-started Home turn could run: idle, with a completed turn and its native conversation. */
export const homeIsEligible = (state: NodeSqlite.DatabaseSync, home: string) =>
  state
    .prepare(`SELECT 1 AS eligible
    FROM orchestration_v2_projection_threads t
    JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = t.active_provider_thread_id
      AND p.thread_id = t.thread_id AND p.provider_instance_id = t.provider_instance_id
    WHERE t.thread_id = ? AND t.archived_at IS NULL AND t.deleted_at IS NULL
      AND json_extract(p.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id AND r.status = 'completed')
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id AND r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting'))
    LIMIT 1`)
    .get(home)?.eligible === 1;
