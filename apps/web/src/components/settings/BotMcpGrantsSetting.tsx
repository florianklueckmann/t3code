import { useAtomValue } from "@effect/atom-react";
import {
  botMcpGrantsChange,
  botMcpGrantsSection,
  codexMcpServerNames,
  latestBotMcpGrants,
} from "@t3tools/client-runtime/mcp-connections";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type BotId,
  type BotMcpGrants,
  type EnvironmentId,
  McpConnectionId,
  type McpConnectionOAuthState,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { useNowAfter } from "../../hooks/useDeadline";
import { randomUUID } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  McpConnectionSignInButtons,
  McpConnectionSignInDetails,
  useMcpConnectionSignIn,
} from "./McpConnectionSignIn";
import { McpConnectionDialog } from "./McpConnectionsSettings";

const STATUS_BADGE = {
  ok: "success",
  warning: "warning",
  error: "error",
  muted: "outline",
} as const;

/** The MCP connections a Bot may use; each change saves the whole set apart from the Bot form. */
export function BotMcpGrantsSetting({
  environment,
  botId,
  formLocked,
}: {
  readonly environment: EnvironmentPresentation;
  readonly botId: BotId;
  readonly formLocked: boolean;
}) {
  const environmentId = environment.environmentId;
  const descriptor = environment.serverConfig?.environment;
  const ownServersId = useId();
  const bots = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const now = useNowAfter(null);
  const catalog = useEnvironmentQuery(serverEnvironment.mcpConnections(environmentId));
  const routines = useEnvironmentQuery(
    descriptor?.capabilities.botRoutines === true
      ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} })
      : null,
  );
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canChange = useAtomValue(serverEnvironment.setBotMcpGrants.permissionAtom(environmentId));
  const canAdd = useAtomValue(serverEnvironment.createMcpConnection.permissionAtom(environmentId));
  const setGrants = useAtomCommand(serverEnvironment.setBotMcpGrants, {
    label: "bot set mcp grants",
  });
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState<BotMcpGrants | null>(null);
  const [adding, setAdding] = useState<McpConnectionId | null>(null);
  const bot = bots.data?.bots.find((entry) => entry.id === botId);
  if (bot?.mcpGrants === undefined || descriptor === undefined) return null;
  const grants = latestBotMcpGrants(bot.mcpGrants, acknowledged);
  if (catalog.data === null) {
    return catalog.error === null ? null : (
      <p className="text-xs text-destructive">{catalog.error}</p>
    );
  }
  const connections = catalog.data.connections;
  const view = botMcpGrantsSection({
    botId,
    grants,
    codexMcpServerNames: codexMcpServerNames(providers),
    catalog: connections,
    providerDriver: providers.find(
      (provider) => provider.instanceId === bot.modelSelection.instanceId,
    )?.driver,
    platformOs: descriptor.platform.os,
    environmentLabel: environment.label,
    routines: routines.data?.tasks ?? null,
    canChange,
    archived: bot.archivedAt !== null,
    now,
  });
  const oauthSupported = descriptor.capabilities.mcpConnectionsOAuth === true;
  const disabled = busy || formLocked || !view.editable;

  const change = async (next: Parameters<typeof botMcpGrantsChange>[3]) => {
    setBusy(true);
    const result = await setGrants({
      environmentId,
      input: botMcpGrantsChange(botId, grants, connections, next),
    });
    setBusy(false);
    if (result._tag === "Success") setAcknowledged(result.value.mcpGrants ?? null);
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    // Another client's change is refused; the live Bot list then shows the newer set.
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not change MCP connections",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>MCP connections</Label>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || !canAdd}
          onClick={() => setAdding(McpConnectionId.make(randomUUID()))}
        >
          <PlusIcon className="size-3" aria-hidden />
          Add connection
        </Button>
      </div>
      {view.rows.length > 0 ? (
        <ul className="space-y-2">
          {view.rows.map((row) => (
            <li key={row.id} className="space-y-1">
              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={row.granted}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    void change({ connectionId: row.id, granted: checked === true })
                  }
                />
                <span className="min-w-0 space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 font-medium wrap-anywhere">{row.label}</span>
                    {row.transport === null ? null : (
                      <Badge variant="outline">{row.transport === "http" ? "HTTP" : "stdio"}</Badge>
                    )}
                  </span>
                  {oauthSupported && row.oauth !== null ? null : (
                    <Badge variant={STATUS_BADGE[row.status.tone]}>{row.status.text}</Badge>
                  )}
                </span>
              </label>
              {oauthSupported && row.oauth !== null ? (
                <BotMcpGrantSignIn
                  environmentId={environmentId}
                  connectionId={row.id}
                  fallback={row.oauth}
                  disabled={formLocked}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {view.ownServers === null ? null : (
        <div className="flex items-start justify-between gap-3 text-sm">
          <div className="min-w-0 space-y-1">
            <Label htmlFor={ownServersId}>{view.ownServers.label}</Label>
            <p id={`${ownServersId}-description`} className="text-xs text-muted-foreground">
              {view.ownServers.description}
            </p>
          </div>
          <Switch
            id={ownServersId}
            aria-describedby={`${ownServersId}-description`}
            checked={view.ownServers.on}
            disabled={disabled}
            onCheckedChange={(on) => void change({ ownCodexMcpServers: on })}
          />
        </div>
      )}
      {view.notes.map((note) => (
        <p
          key={note.text}
          className={
            note.tone === "warning" ? "text-sm text-warning" : "text-sm text-muted-foreground"
          }
        >
          {note.text}
        </p>
      ))}
      {adding === null ? null : (
        <McpConnectionDialog
          key={adding}
          environmentId={environmentId}
          environmentLabel={environment.label}
          oauthSupported={oauthSupported}
          target={{ kind: "create", connectionId: adding }}
          grant={{
            botName: bot.name,
            onCreated: (connectionId) => void change({ connectionId, granted: true }),
          }}
          onClose={() => setAdding(null)}
        />
      )}
    </div>
  );
}

/** An OAuth connection's live state in a Bot's settings, with a way back in when signed out. */
function BotMcpGrantSignIn({
  environmentId,
  connectionId,
  fallback,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly connectionId: McpConnectionId;
  readonly fallback: McpConnectionOAuthState;
  readonly disabled: boolean;
}) {
  const signIn = useMcpConnectionSignIn({ environmentId, connectionId, fallback, audience: "bot" });
  return (
    <div className="grid gap-1.5 pl-7">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_BADGE[signIn.view.tone]}>{signIn.view.text}</Badge>
        <McpConnectionSignInButtons signIn={signIn} disabled={disabled} />
      </div>
      <McpConnectionSignInDetails signIn={signIn} />
    </div>
  );
}
