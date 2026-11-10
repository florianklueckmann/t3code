import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Whether a calling thread may change anything through T3 Code's tools. Implementations answer
 * "none" when they cannot tell. There is no default: every server that serves tools provides one.
 */
export class McpCallerChanges extends Context.Service<
  McpCallerChanges,
  { readonly forThread: (threadId: ThreadId) => Effect.Effect<"allowed" | "none"> }
>()("t3/mcp/McpCallerChanges") {}
