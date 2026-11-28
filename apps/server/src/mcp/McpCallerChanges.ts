import type { OrchestrationV2RunRestriction, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * What a calling thread may change through T3 Code's tools: everything, nothing, its Home's working
 * note from a restricted run ("botNote", "botWaiting"), or its Bot's tasks, learning and note
 * ("botTasks": the Bot-level Home with read access). "none" when unknown; every server provides one.
 */
export type McpCallerChangesValue = "allowed" | "none" | "botTasks" | OrchestrationV2RunRestriction;

export class McpCallerChanges extends Context.Service<
  McpCallerChanges,
  {
    readonly canReadThread: (caller: ThreadId, localTarget?: ThreadId) => Effect.Effect<boolean>;
    readonly forThread: (threadId: ThreadId) => Effect.Effect<McpCallerChangesValue>;
  }
>()("t3/mcp/McpCallerChanges") {}
