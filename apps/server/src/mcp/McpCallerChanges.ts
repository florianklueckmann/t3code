import type { OrchestrationV2RunRestriction, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Whether a calling thread may change anything through T3 Code's tools: everything, nothing, or
 * only its Home's own working note ("botNote", "botWaiting") from a restricted run. Implementations
 * answer "none" when they cannot tell. There is no default: every server that serves tools provides one.
 */
export type McpCallerChangesValue = "allowed" | "none" | OrchestrationV2RunRestriction;

export class McpCallerChanges extends Context.Service<
  McpCallerChanges,
  { readonly forThread: (threadId: ThreadId) => Effect.Effect<McpCallerChangesValue> }
>()("t3/mcp/McpCallerChanges") {}
