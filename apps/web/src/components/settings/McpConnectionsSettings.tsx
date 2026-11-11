import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_MCP_CONNECTION_DRAFT,
  MCP_CONNECTIONS_NOTICE,
  mcpConnectionDraft,
  mcpConnectionRemovalMessage,
  mcpConnectionStatusText,
  mcpConnectionUsedByText,
  mcpConnectionUsers,
  planMcpConnectionSave,
  type McpConnectionDraft,
} from "@t3tools/client-runtime/mcp-connections";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  isSecretReference,
  MCP_CONNECTION_LABEL_MAX_LENGTH,
  McpConnectionId,
  type EnvironmentId,
  type McpConnectionDefinition,
  type McpConnectionSummary,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import { PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const STATUS_BADGE = {
  ok: "success",
  warning: "warning",
  error: "error",
  muted: "outline",
} as const;

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
}

function toastFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  const description = failureMessage(result);
  if (description === null) return;
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

export function McpConnectionsSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase !== "connected" || environment.serverConfig === null ? (
        <SettingsSection {...searchableSetting("mcp-connections")}>
          <SettingsRow title="Connect an environment to manage its MCP connections." />
        </SettingsSection>
      ) : environment.serverConfig.environment.capabilities.mcpConnections !== true ? (
        <SettingsSection {...searchableSetting("mcp-connections")}>
          <SettingsRow
            title="MCP connections need a newer server"
            description={`Update T3 Code on ${environment.label} to manage its MCP connections.`}
          />
        </SettingsSection>
      ) : (
        <EnvironmentMcpConnections key={environment.environmentId} environment={environment} />
      )}
    </SettingsPageContainer>
  );
}

type Editor =
  | { readonly kind: "create"; readonly connectionId: McpConnectionId }
  | { readonly kind: "update"; readonly connectionId: McpConnectionId };

function EnvironmentMcpConnections({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const environmentId = environment.environmentId;
  const definitions = useEnvironmentSettings(environmentId, (settings) => settings.mcpConnections);
  const statuses = useEnvironmentQuery(serverEnvironment.mcpConnections(environmentId));
  const canEdit = useAtomValue(serverEnvironment.createMcpConnection.permissionAtom(environmentId));
  const canRefresh = useAtomValue(
    serverEnvironment.refreshMcpConnections.permissionAtom(environmentId),
  );
  const refresh = useAtomCommand(serverEnvironment.refreshMcpConnections, {
    label: "mcp connections refresh",
  });
  const bots = useEnvironmentQuery(
    environment.serverConfig?.environment.capabilities.bots === true
      ? serverEnvironment.botsLive({ environmentId, input: {} })
      : null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const entries = Object.entries(definitions) as Array<[McpConnectionId, McpConnectionDefinition]>;
  const summaries = new Map(statuses.data?.connections.map((summary) => [summary.id, summary]));
  const users = mcpConnectionUsers(bots.data?.bots ?? []);
  const refreshAll = async (connectionIds: ReadonlyArray<McpConnectionId>) => {
    setRefreshing(true);
    const result = await refresh({ environmentId, input: { connectionIds } });
    setRefreshing(false);
    toastFailure("Could not refresh MCP connections", result);
  };
  const editing = editor?.kind === "update" ? definitions[editor.connectionId] : undefined;
  return (
    <>
      <SettingsSection
        {...searchableSetting("mcp-connections")}
        headerAction={
          <div className="flex items-center gap-1">
            {entries.length > 0 ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={!canRefresh || refreshing}
                onClick={() => void refreshAll(entries.map(([id]) => id))}
              >
                <RefreshCwIcon className="size-3" aria-hidden />
                Refresh
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={!canEdit}
              onClick={() =>
                setEditor({ kind: "create", connectionId: McpConnectionId.make(randomUUID()) })
              }
            >
              <PlusIcon className="size-3" aria-hidden />
              Add connection
            </Button>
          </div>
        }
      >
        <p className="px-4 pt-3 text-xs text-muted-foreground">{MCP_CONNECTIONS_NOTICE}</p>
        {entries.length === 0 ? (
          <SettingsRow
            title="No MCP connections"
            description="Add one connection per account. Two accounts of the same service are two connections."
          />
        ) : (
          entries.map(([id, definition]) => (
            <McpConnectionRow
              key={id}
              environmentId={environmentId}
              id={id}
              definition={definition}
              summary={summaries.get(id)}
              users={users.get(id)}
              statusError={statuses.error}
              canEdit={canEdit}
              canRefresh={canRefresh && !refreshing}
              onRefresh={() => void refreshAll([id])}
              onEdit={() => setEditor({ kind: "update", connectionId: id })}
            />
          ))
        )}
      </SettingsSection>
      {editor !== null && (editor.kind === "create" || editing !== undefined) ? (
        <McpConnectionDialog
          key={editor.connectionId}
          environmentId={environmentId}
          environmentLabel={environment.label}
          target={
            editor.kind === "create" || editing === undefined
              ? { kind: "create", connectionId: editor.connectionId }
              : { kind: "update", connectionId: editor.connectionId, saved: editing }
          }
          onClose={() => setEditor(null)}
        />
      ) : null}
    </>
  );
}

function McpConnectionRow({
  environmentId,
  id,
  definition,
  summary,
  users,
  statusError,
  canEdit,
  canRefresh,
  onRefresh,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: McpConnectionId;
  readonly definition: McpConnectionDefinition;
  readonly summary: McpConnectionSummary | undefined;
  /** Names of the Bots granted this connection. */
  readonly users: ReadonlyArray<string> | undefined;
  readonly statusError: string | null;
  readonly canEdit: boolean;
  readonly canRefresh: boolean;
  readonly onRefresh: () => void;
  readonly onEdit: () => void;
}) {
  const update = useAtomCommand(serverEnvironment.updateMcpConnection, {
    label: "mcp connection set enabled",
  });
  const [busy, setBusy] = useState(false);
  // A status for an older revision describes a definition that no longer exists.
  const status = mcpConnectionStatusText(
    summary?.revision === definition.revision ? summary.status : undefined,
  );
  const transport = definition.transport;
  const usedBy = mcpConnectionUsedByText(users);
  const toggleEnabled = async () => {
    setBusy(true);
    const result = await update({
      environmentId,
      input: {
        connectionId: id,
        expectedRevision: definition.revision,
        enabled: !definition.enabled,
      },
    });
    setBusy(false);
    toastFailure(
      definition.enabled ? "Could not disable connection" : "Could not enable connection",
      result,
    );
  };
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 wrap-anywhere">{definition.label}</span>
          <Badge variant="outline">{transport.type === "http" ? "HTTP" : "stdio"}</Badge>
          {definition.enabled ? null : <Badge variant="outline">Disabled</Badge>}
        </span>
      }
      description={
        <>
          <span className="block wrap-anywhere">
            {transport.type === "http"
              ? transport.url
              : [transport.command, ...transport.args].join(" ")}
          </span>
          {usedBy === null ? null : <span className="block">{usedBy}</span>}
        </>
      }
      status={
        statusError !== null ? (
          <span className="text-destructive">{statusError}</span>
        ) : (
          <Badge variant={STATUS_BADGE[status.tone]}>{status.text}</Badge>
        )
      }
      control={
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" disabled={!canRefresh} onClick={onRefresh}>
            Refresh
          </Button>
          <Button size="xs" variant="ghost" disabled={!canEdit} onClick={onEdit}>
            Edit
          </Button>
          <Button size="xs" variant="ghost" disabled={!canEdit || busy} onClick={toggleEnabled}>
            {definition.enabled ? "Disable" : "Enable"}
          </Button>
          <RemoveMcpConnectionButton
            environmentId={environmentId}
            id={id}
            definition={definition}
            users={users}
            disabled={!canEdit}
          />
        </div>
      }
    />
  );
}

function RemoveMcpConnectionButton({
  environmentId,
  id,
  definition,
  users,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly id: McpConnectionId;
  readonly definition: McpConnectionDefinition;
  readonly users: ReadonlyArray<string> | undefined;
  readonly disabled: boolean;
}) {
  const remove = useAtomCommand(serverEnvironment.removeMcpConnection, {
    label: "mcp connection remove",
  });
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {definition.label}?</AlertDialogTitle>
            <AlertDialogDescription>{mcpConnectionRemovalMessage(users)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={async () => {
                setOpen(false);
                const result = await remove({
                  environmentId,
                  input: { connectionId: id, expectedRevision: definition.revision },
                });
                toastFailure("Could not remove connection", result);
              }}
            >
              Remove connection
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

interface BindingRow {
  readonly key: string;
  readonly name: string;
  readonly value: SettingsSecretValue;
  /** The saved-value marker the snapshot showed for this name, kept until replaced. */
  readonly saved: string | undefined;
}

/** Mounted per open, so each open starts from the saved definition. */
function McpConnectionDialog({
  environmentId,
  environmentLabel,
  target: liveTarget,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly target:
    | { readonly kind: "create"; readonly connectionId: McpConnectionId }
    | {
        readonly kind: "update";
        readonly connectionId: McpConnectionId;
        readonly saved: McpConnectionDefinition;
      };
  onClose: () => void;
}) {
  // The revision this form opened on; a concurrent edit makes the save fail instead of losing it.
  const [target] = useState(liveTarget);
  const create = useAtomCommand(serverEnvironment.createMcpConnection, {
    label: "mcp connection create",
  });
  const update = useAtomCommand(serverEnvironment.updateMcpConnection, {
    label: "mcp connection update",
  });
  const sources = useSecretSources(environmentId);
  const initial =
    target.kind === "update" ? mcpConnectionDraft(target.saved) : EMPTY_MCP_CONNECTION_DRAFT;
  const [draft, setDraft] = useState<Omit<McpConnectionDraft, "bindings">>(initial);
  const [bindings, setBindings] = useState<ReadonlyArray<BindingRow>>(() =>
    initial.bindings.map(({ name, value }) => ({
      key: randomUUID(),
      name,
      value,
      saved: typeof value === "string" && value !== "" ? value : undefined,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = target.kind === "update";
  const isHttp = draft.transport === "http";
  const bindingNoun = isHttp ? "header" : "environment variable";

  const setBinding = (key: string, next: Partial<BindingRow>) =>
    setBindings((rows) => rows.map((row) => (row.key === key ? { ...row, ...next } : row)));

  const save = async () => {
    const plan = planMcpConnectionSave(
      { ...draft, bindings: bindings.map(({ name, value }) => ({ name, value })) },
      target,
    );
    if (plan.kind === "invalid") {
      setError(plan.message);
      return;
    }
    setSaving(true);
    const result =
      plan.kind === "create"
        ? await create({ environmentId, input: plan.input })
        : await update({ environmentId, input: plan.input });
    setSaving(false);
    if (result._tag === "Failure") {
      setError(failureMessage(result));
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${target.saved.label}` : "Add an MCP connection"}
          </DialogTitle>
          <DialogDescription>
            Saved on {environmentLabel}. {MCP_CONNECTIONS_NOTICE}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="mcp-connection-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-connection-label">Name</Label>
              <Input
                id="mcp-connection-label"
                placeholder="Docs (work account)"
                value={draft.label}
                maxLength={MCP_CONNECTION_LABEL_MAX_LENGTH}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mcp-connection-transport">Transport</Label>
              <Select
                value={draft.transport}
                disabled={editing}
                onValueChange={(next) => {
                  if (next !== "http" && next !== "stdio") return;
                  setDraft({ ...draft, transport: next });
                  setBindings([]);
                }}
              >
                <SelectTrigger id="mcp-connection-transport" size="sm">
                  <SelectValue>{isHttp ? "HTTP" : "Local command (stdio)"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="http">HTTP</SelectItem>
                  <SelectItem value="stdio">Local command (stdio)</SelectItem>
                </SelectPopup>
              </Select>
              {editing ? (
                <p className="text-xs text-muted-foreground">
                  The endpoint is part of the connection's identity. To change it, add a new
                  connection.
                </p>
              ) : null}
            </div>
            {isHttp ? (
              <div className="grid gap-1.5">
                <Label htmlFor="mcp-connection-url">URL</Label>
                <Input
                  id="mcp-connection-url"
                  placeholder="https://mcp.example.com/mcp"
                  value={draft.url}
                  readOnly={editing}
                  spellCheck={false}
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                />
              </div>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="mcp-connection-command">Command</Label>
                  <Input
                    id="mcp-connection-command"
                    placeholder="npx"
                    value={draft.command}
                    readOnly={editing}
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="mcp-connection-args">Arguments, one per line</Label>
                  <Textarea
                    id="mcp-connection-args"
                    value={draft.args}
                    readOnly={editing}
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Put credentials in environment variables below, never in arguments.
                  </p>
                </div>
              </>
            )}
            <div className="grid gap-2">
              <Label>{isHttp ? "Headers" : "Environment variables"}</Label>
              {bindings.map((row) => (
                <div key={row.key} className="flex items-start gap-1.5">
                  <Input
                    size="sm"
                    className="w-40 shrink-0"
                    aria-label={`${bindingNoun} name`}
                    placeholder={isHttp ? "Authorization" : "API_TOKEN"}
                    value={row.name}
                    spellCheck={false}
                    onChange={(event) =>
                      // A saved value belongs to its name; a renamed binding needs a new one.
                      setBinding(
                        row.key,
                        row.saved !== undefined && row.value === row.saved
                          ? { name: event.target.value, value: "", saved: undefined }
                          : { name: event.target.value },
                      )
                    }
                  />
                  <SecretSourceInput
                    size="sm"
                    aria-label={row.name === "" ? `${bindingNoun} value` : row.name}
                    configured={row.saved !== undefined && row.value === row.saved}
                    value={isSecretReference(row.value) || row.value !== row.saved ? row.value : ""}
                    sources={sources}
                    onChange={(event) =>
                      setBinding(row.key, {
                        value:
                          event.target.value === "" && row.saved !== undefined
                            ? row.saved
                            : event.target.value,
                      })
                    }
                    onSecretChange={(secret) =>
                      setBinding(row.key, { value: secret ?? row.saved ?? "" })
                    }
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${row.name === "" ? bindingNoun : row.name}`}
                    onClick={() =>
                      setBindings((rows) => rows.filter((other) => other.key !== row.key))
                    }
                  >
                    <XIcon aria-hidden />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    setBindings((rows) => [
                      ...rows,
                      { key: randomUUID(), name: "", value: "", saved: undefined },
                    ])
                  }
                >
                  <PlusIcon className="size-3" aria-hidden />
                  Add {bindingNoun}
                </Button>
              </div>
            </div>
            {error !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="mcp-connection-form" disabled={saving}>
            {editing ? "Save changes" : "Add connection"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
