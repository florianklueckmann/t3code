import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  botProjectContextChanges,
  botProjectContextDraft,
  emptyBotSourceDraft,
  type BotProjectContextDraft,
  type BotSourceDraft,
} from "@t3tools/client-runtime/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BotId,
  ProviderDriverKind,
  type BotDetail,
  type BotLearningPolicy,
  type BotProjectContext,
  type BotSummary,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useContext, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor, type ProviderInstanceEntry } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

/** The server accepts only Codex instances until other adapters deliver Bot instructions. */
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

const LEARNING_POLICY_OPTIONS: ReadonlyArray<{
  readonly value: BotLearningPolicy;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "automatic",
    label: "Learn automatically",
    description: "Apply what the Bot learns right away.",
  },
  {
    value: "after_adoption",
    label: "Only after I adopt it",
    description: "Hold what the Bot learns until you adopt it.",
  },
];

function toastError(title: string, description: string) {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

/** Toasts a failed command; true when it succeeded. */
function settled(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure") return true;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastError(title, error instanceof Error ? error.message : String(error));
  }
  return false;
}

function useOpenBotConversation(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  return (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
}

function useEnvironmentProjectTitles(environmentId: EnvironmentId) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  return {
    projects,
    titleOf: (projectId: ProjectId) =>
      projects.find((project) => project.id === projectId)?.title ?? "Unknown project",
  };
}

function useCodexInstanceEntries(environmentId: EnvironmentId) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, null).filter(
    (entry) => entry.driverKind === CODEX_DRIVER_KIND,
  );
  return { settings, providers, entries };
}

function modelLabel(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  selection: ModelSelection,
): string {
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const model =
    entry?.models.find((candidate) => candidate.slug === selection.model)?.name ?? selection.model;
  return entry ? `${entry.displayName} · ${model}` : model;
}

function defaultModelSelection(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ModelSelection | null {
  const entry = entries.find((candidate) => candidate.enabled);
  const model = entry?.models.find((candidate) => candidate.isDefault) ?? entry?.models[0];
  return entry && model ? { instanceId: entry.instanceId, model: model.slug } : null;
}

export function BotsSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase !== "connected" || environment.serverConfig === null ? (
        <SettingsSection {...searchableSetting("bots")}>
          <SettingsRow title="Connect an environment to manage its Bots." />
        </SettingsSection>
      ) : environment.serverConfig.environment.capabilities.bots !== true ? (
        <SettingsSection {...searchableSetting("bots")}>
          <SettingsRow
            title="Bots need a newer server"
            description={`Update T3 Code on ${environment.label} to use Bots.`}
          />
        </SettingsSection>
      ) : (
        <EnvironmentBots key={environment.environmentId} environment={environment} />
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentBots({ environment }: { readonly environment: EnvironmentPresentation }) {
  const environmentId = environment.environmentId;
  const botsQuery = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const canCreate = useAtomValue(serverEnvironment.createBot.permissionAtom(environmentId));
  const [editor, setEditor] = useState<{ readonly botId: BotId | null } | null>(null);
  const registry = useContext(RegistryContext);
  const bots = botsQuery.data?.bots.toSorted(
    (left, right) =>
      Number(left.archivedAt !== null) - Number(right.archivedAt !== null) ||
      left.name.localeCompare(right.name),
  );
  return (
    <>
      <SettingsSection
        {...searchableSetting("bots")}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!canCreate}
            onClick={() => setEditor({ botId: null })}
          >
            <PlusIcon className="size-3" aria-hidden />
            New Bot
          </Button>
        }
      >
        {botsQuery.error ? (
          <SettingsRow title="Could not load Bots" description={botsQuery.error} />
        ) : !bots ? (
          <SettingsRow title="Loading Bots…" role="status" />
        ) : bots.length === 0 ? (
          <SettingsRow
            title="No Bots yet"
            description="A Bot has its own instructions and model, and keeps one conversation in each project you attach it to."
          />
        ) : (
          bots.map((bot) => (
            <BotRow
              key={bot.id}
              environmentId={environmentId}
              bot={bot}
              onEdit={() => {
                // A cached detail may predate the last save or an MCP edit.
                registry.refresh(
                  serverEnvironment.botDetail({ environmentId, input: { botId: bot.id } }),
                );
                setEditor({ botId: bot.id });
              }}
            />
          ))
        )}
      </SettingsSection>
      {editor ? (
        <BotEditorDialog
          key={editor.botId ?? "new"}
          environmentId={environmentId}
          botId={editor.botId}
          onCreated={(botId) => setEditor({ botId })}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </>
  );
}

function BotRow({
  environmentId,
  bot,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: BotSummary;
  readonly onEdit: () => void;
}) {
  const canOperate = useAtomValue(serverEnvironment.setBotArchived.permissionAtom(environmentId));
  const setArchived = useAtomCommand(serverEnvironment.setBotArchived, {
    label: "bot set archived",
  });
  const [busy, setBusy] = useState(false);
  const { entries } = useCodexInstanceEntries(environmentId);
  const { titleOf } = useEnvironmentProjectTitles(environmentId);
  const openConversation = useOpenBotConversation(environmentId);
  const archived = bot.archivedAt !== null;
  const toggleArchived = async () => {
    setBusy(true);
    const result = await setArchived({
      environmentId,
      input: { botId: bot.id, archived: !archived },
    });
    setBusy(false);
    settled(archived ? "Could not restore Bot" : "Could not archive Bot", result);
  };
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 wrap-anywhere">{bot.name}</span>
          {archived ? <Badge variant="outline">Archived</Badge> : null}
        </span>
      }
      description={modelLabel(entries, bot.modelSelection)}
      status={
        bot.projects.length === 0 ? (
          "Not attached to a project"
        ) : (
          <ul className="space-y-1">
            {bot.projects.map((context) => (
              <li key={context.projectId} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 wrap-anywhere">{titleOf(context.projectId)}</span>
                {context.detachedAt !== null ? (
                  <Badge variant="outline">Detached</Badge>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() => openConversation(context.homeThreadId)}
                  >
                    <MessageSquareIcon aria-hidden />
                    Open conversation
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )
      }
      control={
        archived ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !canOperate}
            onClick={() => void toggleArchived()}
          >
            <ArchiveRestoreIcon aria-hidden />
            Restore
          </Button>
        ) : (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Actions for ${bot.name}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={onEdit}>
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuItem disabled={!canOperate} onClick={() => void toggleArchived()}>
                <ArchiveIcon />
                Archive
              </MenuItem>
            </MenuPopup>
          </Menu>
        )
      }
    />
  );
}

function BotEditorDialog({
  environmentId,
  botId,
  onCreated,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId | null;
  readonly onCreated: (botId: BotId) => void;
  readonly onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const detailQuery = useEnvironmentQuery(
    botId === null ? null : serverEnvironment.botDetail({ environmentId, input: { botId } }),
  );
  // The form starts from the answer Edit asked for, not a cached one a save or an MCP edit has
  // outdated, and keeps its draft through later refreshes.
  const [openedAt] = useState(() => Date.now());
  const [initialDetail, setInitialDetail] = useState<BotDetail | null>(null);
  if (
    initialDetail === null &&
    detailQuery.data !== null &&
    !detailQuery.isPending &&
    detailQuery.dataUpdatedAt >= openedAt
  ) {
    setInitialDetail(detailQuery.data);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        {botId !== null && initialDetail === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Edit Bot</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <p className="text-sm text-muted-foreground" role="status">
                {detailQuery.error ?? "Loading Bot…"}
              </p>
            </DialogPanel>
          </>
        ) : (
          <BotEditorForm
            environmentId={environmentId}
            saved={initialDetail}
            current={detailQuery.data}
            refreshDetail={detailQuery.refresh}
            saving={saving}
            onSavingChange={setSaving}
            onCreated={onCreated}
            onClose={onClose}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

interface BotDraft {
  readonly name: string;
  readonly instructions: string;
  /** Null until the user picks a model; the form then shows the saved or default one. */
  readonly modelSelection: ModelSelection | null;
  readonly learningPolicy: BotLearningPolicy | null;
}

function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function BotEditorForm({
  environmentId,
  saved,
  current,
  refreshDetail,
  saving,
  onSavingChange: setSaving,
  onCreated,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  /** Null when creating a Bot. */
  readonly saved: BotDetail | null;
  readonly current: BotDetail | null;
  readonly refreshDetail: () => void;
  readonly saving: boolean;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onCreated: (botId: BotId) => void;
  readonly onClose: () => void;
}) {
  // Chosen once per form so a retried create stays idempotent.
  const [newBotId] = useState(() => BotId.make(randomUUID()));
  const [draft, setDraft] = useState<BotDraft>(() => ({
    name: saved?.name ?? "",
    instructions: saved?.instructions ?? "",
    modelSelection: null,
    learningPolicy: saved?.learningPolicy ?? null,
  }));
  const [contextDrafts, setContextDrafts] = useState<
    ReadonlyMap<ProjectId, BotProjectContextDraft>
  >(() => new Map());
  const { settings, providers, entries } = useCodexInstanceEntries(environmentId);
  const { titleOf } = useEnvironmentProjectTitles(environmentId);
  const canOperate = useAtomValue(serverEnvironment.createBot.permissionAtom(environmentId));
  const createBot = useAtomCommand(serverEnvironment.createBot, { label: "bot create" });
  const updateBot = useAtomCommand(serverEnvironment.updateBot, { label: "bot update" });
  const updateContext = useAtomCommand(serverEnvironment.updateBotProjectContext, {
    label: "bot project context update",
  });

  const modelSelection =
    draft.modelSelection ?? saved?.modelSelection ?? defaultModelSelection(entries);
  const activeInstanceId = modelSelection?.instanceId ?? entries[0]?.instanceId;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId ?? null,
    modelSelection?.model ?? null,
  );
  const archived = current?.archivedAt != null;
  const complete =
    draft.name.trim() !== "" && draft.learningPolicy !== null && modelSelection !== null;

  const contextDraftOf = (context: BotProjectContext) =>
    contextDrafts.get(context.projectId) ?? botProjectContextDraft(context);
  const setContextDraft = (context: BotProjectContext, next: BotProjectContextDraft) =>
    setContextDrafts((drafts) => new Map(drafts).set(context.projectId, next));

  const create = async () => {
    if (draft.learningPolicy === null || modelSelection === null) return;
    setSaving(true);
    const result = await createBot({
      environmentId,
      input: {
        botId: newBotId,
        name: draft.name.trim(),
        instructions: draft.instructions.trim(),
        modelSelection,
        learningPolicy: draft.learningPolicy,
      },
    });
    setSaving(false);
    // Stay in the editor so the new Bot can be attached to projects right away.
    if (settled("Could not create Bot", result)) onCreated(newBotId);
  };

  const save = async (bot: BotDetail) => {
    const name = draft.name.trim();
    const instructions = draft.instructions.trim();
    const contextChanges = (current?.projects ?? []).flatMap((context) => {
      const contextDraft = contextDrafts.get(context.projectId);
      if (contextDraft === undefined || context.detachedAt !== null) return [];
      const changes = botProjectContextChanges(contextDraft, context);
      return changes === null ? [] : [{ projectId: context.projectId, changes }];
    });
    for (const { projectId, changes } of contextChanges) {
      if ("error" in changes) {
        toastError(`Preferred sources in ${titleOf(projectId)} are incomplete`, changes.error);
        return;
      }
    }
    setSaving(true);
    const botChanged =
      name !== bot.name ||
      instructions !== bot.instructions ||
      draft.modelSelection !== null ||
      draft.learningPolicy !== bot.learningPolicy;
    if (botChanged) {
      const result = await updateBot({
        environmentId,
        input: {
          botId: bot.id,
          ...(name !== bot.name ? { name } : {}),
          ...(instructions !== bot.instructions ? { instructions } : {}),
          ...(draft.modelSelection !== null ? { modelSelection: draft.modelSelection } : {}),
          ...(draft.learningPolicy !== null && draft.learningPolicy !== bot.learningPolicy
            ? { learningPolicy: draft.learningPolicy }
            : {}),
        },
      });
      if (!settled("Could not save Bot", result)) {
        setSaving(false);
        return;
      }
    }
    for (const { projectId, changes } of contextChanges) {
      if ("error" in changes) continue;
      const result = await updateContext({
        environmentId,
        input: { botId: bot.id, projectId, ...changes },
      });
      if (!settled("Could not save project context", result)) {
        setSaving(false);
        refreshDetail();
        return;
      }
    }
    setSaving(false);
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{saved ? "Edit Bot" : "New Bot"}</DialogTitle>
        <DialogDescription>
          A Bot keeps one conversation in each project you attach it to, and follows the
          instructions and model you set here.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <fieldset disabled={saving || archived} className="min-w-0 space-y-5">
          {archived ? (
            <p className="text-sm text-muted-foreground" role="status">
              This Bot is archived. Restore it from the list to edit it.
            </p>
          ) : null}
          <Field label="Name" htmlFor="bot-name">
            <Input
              id="bot-name"
              placeholder="e.g. Release helper"
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            />
          </Field>
          <Field label="Instructions" htmlFor="bot-instructions">
            <Textarea
              id="bot-instructions"
              className="max-h-64 overflow-y-auto"
              placeholder="How should this Bot work and answer?"
              value={draft.instructions}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, instructions: event.target.value }))
              }
            />
          </Field>
          <Field label="Model">
            {activeInstanceId === undefined ? (
              <p className="text-sm text-muted-foreground">
                Bots run on Codex. Add a Codex provider in Providers to pick a model.
              </p>
            ) : (
              <div>
                <ProviderModelPicker
                  environmentId={environmentId}
                  disabled={saving || archived}
                  activeInstanceId={activeInstanceId}
                  model={modelSelection?.model ?? ""}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onInstanceModelChange={(instanceId, model) =>
                    setDraft((prev) => ({ ...prev, modelSelection: { instanceId, model } }))
                  }
                />
              </div>
            )}
          </Field>
          <div className="space-y-2">
            <Label>Learning</Label>
            <p id="bot-learning-note" className="text-sm text-muted-foreground">
              Bots don't learn yet. Your choice is saved and takes effect once learning is
              available.
            </p>
            <RadioGroup
              aria-label="Learning"
              aria-describedby="bot-learning-note"
              value={draft.learningPolicy}
              onValueChange={(value) => {
                const option = LEARNING_POLICY_OPTIONS.find((entry) => entry.value === value);
                if (option) setDraft((prev) => ({ ...prev, learningPolicy: option.value }));
              }}
            >
              {LEARNING_POLICY_OPTIONS.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-start gap-3 text-sm">
                  <Radio value={option.value} />
                  <span className="min-w-0 space-y-0.5">
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-muted-foreground">{option.description}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
          {current !== null ? (
            <BotProjectContexts
              environmentId={environmentId}
              bot={current}
              disabled={saving || archived}
              draftOf={contextDraftOf}
              onDraftChange={setContextDraft}
              onChanged={refreshDetail}
            />
          ) : null}
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          Cancel
        </DialogClose>
        <Button
          size="sm"
          disabled={!canOperate || saving || archived || !complete}
          onClick={() => void (saved ? save(saved) : create())}
        >
          {saved ? "Save Bot" : "Create Bot"}
        </Button>
      </DialogFooter>
    </>
  );
}

function BotProjectContexts({
  environmentId,
  bot,
  disabled,
  draftOf,
  onDraftChange,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: BotDetail;
  readonly disabled: boolean;
  readonly draftOf: (context: BotProjectContext) => BotProjectContextDraft;
  readonly onDraftChange: (context: BotProjectContext, draft: BotProjectContextDraft) => void;
  readonly onChanged: () => void;
}) {
  const { projects, titleOf } = useEnvironmentProjectTitles(environmentId);
  const attachProject = useAtomCommand(serverEnvironment.attachBotProject, {
    label: "bot attach project",
  });
  const detachProject = useAtomCommand(serverEnvironment.detachBotProject, {
    label: "bot detach project",
  });
  const canAttach = useAtomValue(serverEnvironment.attachBotProject.permissionAtom(environmentId));
  const canDetach = useAtomValue(serverEnvironment.detachBotProject.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const locked = disabled || busy || !canAttach || !canDetach;
  const [pickedProjectId, setPickedProjectId] = useState<ProjectId | null>(null);
  const attachable = projects.filter(
    (project) =>
      project.archivedAt == null &&
      !bot.projects.some((context) => context.projectId === project.id),
  );
  const pickedProject = attachable.find((project) => project.id === pickedProjectId);

  const run = async (
    title: string,
    command: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusy(true);
    const result = await command();
    setBusy(false);
    if (settled(title, result)) onChanged();
    return result._tag !== "Failure";
  };
  const attach = (projectId: ProjectId, title: string) =>
    run(title, () => attachProject({ environmentId, input: { botId: bot.id, projectId } }));
  const detach = (projectId: ProjectId) =>
    run("Could not detach project", () =>
      detachProject({ environmentId, input: { botId: bot.id, projectId } }),
    );

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Projects</Label>
        <p className="text-sm text-muted-foreground">
          Attaching a project starts the Bot's conversation there. Detaching archives it, and
          reattaching brings it back.
        </p>
      </div>
      {bot.projects.map((context) => (
        <BotProjectContextEditor
          key={context.projectId}
          context={context}
          title={titleOf(context.projectId)}
          draft={draftOf(context)}
          disabled={locked}
          onDraftChange={(next) => onDraftChange(context, next)}
          onDetach={() => void detach(context.projectId)}
          onReattach={() => void attach(context.projectId, "Could not reattach project")}
        />
      ))}
      <div className="flex items-center gap-2">
        <Select
          value={pickedProject?.id ?? null}
          onValueChange={(projectId) => setPickedProjectId(projectId)}
        >
          <div className="grid min-w-0 flex-1 grid-cols-1">
            <SelectTrigger size="sm" aria-label="Project to attach" disabled={locked}>
              <SelectValue
                placeholder={attachable.length === 0 ? "No other projects" : "Select a project"}
              >
                {pickedProject?.title}
              </SelectValue>
            </SelectTrigger>
          </div>
          <SelectPopup>
            {attachable.map((project) => (
              <SelectItem key={project.id} value={project.id} label={project.title}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={locked || pickedProject === undefined}
          onClick={async () => {
            if (pickedProject === undefined) return;
            if (await attach(pickedProject.id, "Could not attach project")) {
              setPickedProjectId(null);
            }
          }}
        >
          <PlusIcon aria-hidden />
          Attach
        </Button>
      </div>
    </div>
  );
}

function BotProjectContextEditor({
  context,
  title,
  draft,
  disabled,
  onDraftChange,
  onDetach,
  onReattach,
}: {
  readonly context: BotProjectContext;
  readonly title: string;
  readonly draft: BotProjectContextDraft;
  readonly disabled: boolean;
  readonly onDraftChange: (draft: BotProjectContextDraft) => void;
  readonly onDetach: () => void;
  readonly onReattach: () => void;
}) {
  const detached = context.detachedAt !== null;
  const guidanceId = `bot-guidance-${context.projectId}`;
  const updateSource = (id: string, patch: Partial<BotSourceDraft>) =>
    onDraftChange({
      ...draft,
      sources: draft.sources.map((source) => (source.id === id ? { ...source, ...patch } : source)),
    });
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="min-w-0 wrap-anywhere">{title}</span>
          {detached ? <Badge variant="outline">Detached</Badge> : null}
        </span>
        {detached ? (
          <Button size="xs" variant="outline" disabled={disabled} onClick={onReattach}>
            Reattach
          </Button>
        ) : (
          <Button size="xs" variant="ghost-muted" disabled={disabled} onClick={onDetach}>
            Detach
          </Button>
        )}
      </div>
      {detached ? null : (
        <>
          <Field label="Guidance" htmlFor={guidanceId}>
            <Textarea
              id={guidanceId}
              className="max-h-48 overflow-y-auto"
              placeholder="Anything the Bot should know about this project."
              value={draft.guidance}
              onChange={(event) => onDraftChange({ ...draft, guidance: event.target.value })}
            />
          </Field>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <Label>Preferred sources</Label>
                <p className="text-xs text-muted-foreground">
                  Where the Bot looks first. It can still use other sources when these don't answer
                  the question.
                </p>
              </div>
              <Button
                className="shrink-0"
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  onDraftChange({ ...draft, sources: [...draft.sources, emptyBotSourceDraft()] })
                }
              >
                <PlusIcon aria-hidden />
                Add source
              </Button>
            </div>
            {draft.sources.map((source, index) => (
              <div key={source.id} className="flex items-center gap-2">
                <div className="grid w-36 shrink-0 grid-cols-1">
                  <Input
                    aria-label={`Source ${index + 1} label`}
                    placeholder="Label"
                    value={source.label}
                    onChange={(event) => updateSource(source.id, { label: event.target.value })}
                  />
                </div>
                <div className="grid min-w-0 flex-1 grid-cols-1">
                  <Input
                    aria-label={`Source ${index + 1} location`}
                    placeholder="Path, URL or tool"
                    value={source.location}
                    onChange={(event) => updateSource(source.id, { location: event.target.value })}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  aria-label={`Remove source ${index + 1}`}
                  onClick={() =>
                    onDraftChange({
                      ...draft,
                      sources: draft.sources.filter((entry) => entry.id !== source.id),
                    })
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
