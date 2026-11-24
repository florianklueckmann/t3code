import type { McpConnectionId, ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

import type { ProviderAdapterMcpConnectionsRefusedError } from "./ProviderAdapter.ts";
import type { McpProviderSessionConfig } from "./mcpSession.ts";

/** A granted connection as a provider loads it, credentials read at load time. */
export interface GrantedMcpServer {
  readonly id: McpConnectionId;
  /** The native server name, derived from the id and never from the editable label. */
  readonly name: string;
  readonly transport:
    | {
        readonly type: "stdio";
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly env: Redacted.Redacted<Readonly<Record<string, string>>>;
      }
    | {
        readonly type: "http";
        readonly url: string;
        readonly headers: Redacted.Redacted<Readonly<Record<string, string>>>;
      };
}

export interface GrantedMcpLoad {
  readonly servers: ReadonlyArray<GrantedMcpServer>;
  /** Tells the model which granted account each tool namespace is; undefined without servers. */
  readonly instructions: string | undefined;
}

/**
 * Resolves a Bot thread's granted MCP connections for adapters outside the server package. A
 * connection that cannot be delivered refuses the whole load, with no fallback.
 */
export class McpConnectionGrants extends Context.Service<
  McpConnectionGrants,
  {
    readonly resolve: (input: {
      readonly driver: ProviderDriverKind;
      readonly ids: ReadonlyArray<McpConnectionId>;
      readonly macCalendarWrite: boolean;
      /** The thread's own MCP session, which serves T3 Code's granted toolsets. */
      readonly mcpSession: McpProviderSessionConfig | undefined;
    }) => Effect.Effect<GrantedMcpLoad, ProviderAdapterMcpConnectionsRefusedError>;
  }
>()("@t3tools/provider-core/server/McpConnectionGrants") {}
