import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  BOT_LEARNING_KIND_LABELS,
  BOT_LEARNING_LEFT_OUT_EXPLANATION,
  BOT_LEARNING_STATUS_LABELS,
  botLearningLeftOut,
  botLearningOriginLabel,
  botLearningRevisionInput,
  botLearningViews,
  botProjectContextChanges,
  botProjectContextDraft,
  botRoutineDraft,
  botRoutinesFor,
  botRoutineUpsertInput,
  describeBotRoutineTiming,
  emptyBotRoutineDraft,
  emptyBotSourceDraft,
  type BotProjectContextDraft,
  type BotSourceDraft,
} from "@t3tools/client-runtime/bots";
import {
  resolveBotAppearance,
  sameBotAppearance,
  savedBotAppearance,
} from "@t3tools/client-runtime/bot-appearance";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BotId,
  CommandId,
  ProviderDriverKind,
  type BotAppearance,
  type BotDetail,
  type BotLearningEntry,
  type BotLearningKind,
  type BotLearningPolicy,
  type BotProjectContext,
  type BotSummary,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ScheduledTask,
  type ScheduledTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { Fragment, type ReactNode, useContext, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor, type ProviderInstanceEntry } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useEnvironment, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { BotAvatar } from "../BotAvatar";
import { BotTaskRow, useUpcomingInstantFormatter } from "../chat/BotTaskCards";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { BotAppearancePicker } from "./BotAppearancePicker";
import { BotContinuationNotes } from "./BotContinuationNotes";
import { BotHomeCheckSetting } from "./BotHomeCheckSetting";
import { BotMcpGrantsSetting } from "./BotMcpGrantsSetting";
import { BotMaintenanceSetting } from "./BotMaintenanceSetting";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  ScheduledRelativeLabel,
  scheduledRunStatusVariant,
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
  WEEKDAY_SHORT,
} from "./ScheduledTasksSettings";
import {
  botRoutineDraftFromForm,
  botRoutineForm,
  type BotRoutineForm,
} from "./botRoutineForm.logic";
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
          environment={environment}
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
          <BotAvatar appearance={resolveBotAppearance(bot)} size={24} className="shrink-0" />
          <span className="min-w-0 wrap-anywhere">{bot.name}</span>
          {archived ? <Badge variant="outline">Archived</Badge> : null}
          {bot.pendingLearning > 0 ? (
            <Badge variant="info">{bot.pendingLearning} to review</Badge>
          ) : null}
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
  environment,
  botId,
  onCreated,
  onClose,
}: {
  readonly environment: EnvironmentPresentation;
  readonly botId: BotId | null;
  readonly onCreated: (botId: BotId) => void;
  readonly onClose: () => void;
}) {
  const environmentId = environment.environmentId;
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
            environment={environment}
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
  /** Null keeps the default look derived from the Bot id. */
  readonly appearance: BotAppearance | null;
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
  environment,
  saved,
  current,
  refreshDetail,
  saving,
  onSavingChange: setSaving,
  onCreated,
  onClose,
}: {
  readonly environment: EnvironmentPresentation;
  /** Null when creating a Bot. */
  readonly saved: BotDetail | null;
  readonly current: BotDetail | null;
  readonly refreshDetail: () => void;
  readonly saving: boolean;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onCreated: (botId: BotId) => void;
  readonly onClose: () => void;
}) {
  const environmentId = environment.environmentId;
  const appearanceSupported =
    environment.serverConfig?.environment.capabilities.botAppearance === true;
  const maintenanceSupported =
    environment.serverConfig?.environment.capabilities.botMaintenance === true;
  // Chosen once per form so a retried create stays idempotent.
  const [newBotId] = useState(() => BotId.make(randomUUID()));
  const savedAppearance = saved ? savedBotAppearance(saved) : null;
  const [draft, setDraft] = useState<BotDraft>(() => ({
    name: saved?.name ?? "",
    instructions: saved?.instructions ?? "",
    modelSelection: null,
    learningPolicy: saved?.learningPolicy ?? null,
    appearance: savedAppearance,
  }));
  const appearanceChanged =
    appearanceSupported && !sameBotAppearance(draft.appearance, savedAppearance);
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
        ...(appearanceChanged ? { appearance: draft.appearance } : {}),
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
      draft.learningPolicy !== bot.learningPolicy ||
      appearanceChanged;
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
          ...(appearanceChanged ? { appearance: draft.appearance } : {}),
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
          <div className="flex items-end gap-3">
            <BotAppearancePicker
              botId={saved?.id ?? newBotId}
              appearance={draft.appearance}
              supported={appearanceSupported}
              environmentLabel={environment.label}
              disabled={saving || archived}
              onChange={(appearance) => setDraft((prev) => ({ ...prev, appearance }))}
            />
            <div className="min-w-0 flex-1">
              <Field label="Name" htmlFor="bot-name">
                <Input
                  id="bot-name"
                  placeholder="e.g. Release helper"
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                />
              </Field>
            </div>
          </div>
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
              When lessons from your corrections take effect. Your own standing instructions apply
              right away either way.
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
            <BotMcpGrantsSetting
              environment={environment}
              botId={current.id}
              formLocked={saving || archived}
            />
          ) : null}
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
        {/* Outside the fieldset so pausing stays reachable for an archived Bot or a detached project. */}
        {current !== null && maintenanceSupported ? (
          <div className="mt-5 space-y-3">
            {current.projects.map((context) => (
              <Fragment key={context.projectId}>
                <BotMaintenanceSetting
                  environmentId={environmentId}
                  botId={current.id}
                  projectId={context.projectId}
                  title={titleOf(context.projectId)}
                  formLocked={saving || archived}
                />
                <BotHomeCheckSetting
                  environmentId={environmentId}
                  botId={current.id}
                  projectId={context.projectId}
                  title={titleOf(context.projectId)}
                  formLocked={saving || archived}
                />
              </Fragment>
            ))}
          </div>
        ) : null}
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
  const descriptor = useEnvironment(environmentId)?.serverConfig?.environment;
  // An archived Bot's routines stay paused, so it shows none to manage.
  const routinesSupported =
    descriptor?.capabilities.botRoutines === true && bot.archivedAt === null;
  const notesSupported = descriptor?.capabilities.botContinuation === true;

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
          workingNotes={
            notesSupported ? (
              <BotContinuationNotes
                environmentId={environmentId}
                botId={bot.id}
                projectId={context.projectId}
                disabled={disabled}
              />
            ) : null
          }
        >
          {routinesSupported ? (
            <BotRoutines
              environmentId={environmentId}
              bot={bot}
              projectId={context.projectId}
              timeZone={descriptor?.timeZone}
            />
          ) : null}
          <BotLearningList
            environmentId={environmentId}
            bot={bot}
            projectId={context.projectId}
            titleOf={titleOf}
            disabled={disabled}
            onChanged={onChanged}
          />
        </BotProjectContextEditor>
      ))}
      <BotLearningList
        environmentId={environmentId}
        bot={bot}
        projectId={null}
        titleOf={titleOf}
        disabled={disabled}
        onChanged={onChanged}
      />
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

function BotLearningList({
  environmentId,
  bot,
  projectId,
  titleOf,
  disabled,
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: BotDetail;
  /** Null lists the entries shared across all of the Bot's projects. */
  readonly projectId: ProjectId | null;
  readonly titleOf: (projectId: ProjectId) => string;
  readonly disabled: boolean;
  readonly onChanged: () => void;
}) {
  const record = useAtomCommand(serverEnvironment.recordBotLearning, { label: "bot learning" });
  const decide = useAtomCommand(serverEnvironment.decideBotLearning, { label: "bot learning" });
  const retire = useAtomCommand(serverEnvironment.retireBotLearning, { label: "bot learning" });
  const restore = useAtomCommand(serverEnvironment.restoreBotLearning, { label: "bot learning" });
  const canChange = useAtomValue(serverEnvironment.recordBotLearning.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<BotLearningKind>("preference");
  const [shared, setShared] = useState(false);
  const [editing, setEditing] = useState<{ entryId: string; text: string } | null>(null);
  const locked = disabled || busy || !canChange;
  const views = botLearningViews(bot.learning, projectId);
  const leftOut = projectId === null ? [] : botLearningLeftOut(bot.learning, projectId);

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
  const add = async () => {
    if (projectId === null || text.trim() === "") return;
    const added = await run("Could not add the instruction", () =>
      record({
        environmentId,
        input: {
          botId: bot.id,
          projectId,
          kind,
          text: text.trim(),
          ...(shared ? { scope: "bot" as const } : {}),
        },
      }),
    );
    if (added) setText("");
  };
  const revise = async (
    title: string,
    entry: BotLearningEntry,
    change: Parameters<typeof botLearningRevisionInput>[2],
  ) => {
    const input = botLearningRevisionInput(bot, entry, change);
    if (input === null) return;
    const revised = await run(title, () => record({ environmentId, input }));
    if (revised) setEditing(null);
  };

  if (projectId === null && views.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>{projectId === null ? "Learning for all projects" : "Learning"}</Label>
        <p className="text-xs text-muted-foreground">
          {projectId === null
            ? "Applies in every project this Bot serves."
            : "What the Bot keeps for later work here: your instructions and lessons from your corrections."}
        </p>
      </div>
      {views.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing learned yet.</p>
      ) : null}
      {views.map((view) => {
        const shown = view.current ?? view.latest;
        const entryId = view.entry.id;
        return (
          <div key={entryId} className="space-y-2 rounded-md border p-2 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant="outline">{BOT_LEARNING_KIND_LABELS[view.entry.kind]}</Badge>
                  <Badge variant={view.current ? "success" : "secondary"}>
                    {BOT_LEARNING_STATUS_LABELS[view.current ? "active" : view.latest.status]}
                  </Badge>
                </div>
                <p
                  className={view.current ? "wrap-anywhere" : "wrap-anywhere text-muted-foreground"}
                >
                  {shown.text}
                </p>
                <p className="text-xs text-muted-foreground">
                  {botLearningOriginLabel(shown)}
                  {view.entry.projectId === null ? ` in ${titleOf(shown.learnedInProjectId)}` : ""}
                  {shown.evidence === "" ? "" : ` · “${shown.evidence}”`}
                </p>
              </div>
              {view.current ? (
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={locked}
                    onClick={() => setEditing({ entryId, text: view.current?.text ?? "" })}
                  >
                    Edit
                  </Button>
                  {view.entry.projectId === null ? null : (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={locked}
                      onClick={() =>
                        void revise("Could not apply it to all projects", view.entry, {
                          scope: "bot",
                        })
                      }
                    >
                      Apply to all projects
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={locked}
                    onClick={() =>
                      void run("Could not retire the entry", () =>
                        retire({ environmentId, input: { botId: bot.id, entryId } }),
                      )
                    }
                  >
                    Retire
                  </Button>
                </div>
              ) : null}
            </div>
            {editing?.entryId === entryId && view.current ? (
              <div className="space-y-2">
                <Textarea
                  aria-label="Edit lesson"
                  className="max-h-32 overflow-y-auto"
                  value={editing.text}
                  disabled={locked}
                  onChange={(event) => setEditing({ entryId, text: event.target.value })}
                />
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    disabled={
                      locked ||
                      editing.text.trim() === "" ||
                      editing.text.trim() === view.current.text
                    }
                    onClick={() =>
                      void revise("Could not save the change", view.entry, { text: editing.text })
                    }
                  >
                    Save
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {view.pending.map((revision) => (
              <div key={revision.revision} className="space-y-1 rounded-md bg-muted/40 p-2">
                <p className="text-xs font-medium">
                  {view.current ? "Proposed change" : "Proposed"}
                  {revision.conflictsWithInstruction ? " · conflicts with your instruction" : ""}
                </p>
                {/* The entry's own heading already shows the newest proposal's text and evidence. */}
                {revision === shown ? null : <p className="wrap-anywhere">{revision.text}</p>}
                {revision.rationale === "" ? null : (
                  <p className="text-xs text-muted-foreground">{revision.rationale}</p>
                )}
                {revision.evidence === "" || revision === shown ? null : (
                  <p className="text-xs text-muted-foreground">“{revision.evidence}”</p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    disabled={locked}
                    onClick={() =>
                      void run("Could not adopt the proposal", () =>
                        decide({
                          environmentId,
                          input: {
                            botId: bot.id,
                            entryId,
                            revision: revision.revision,
                            decision: "adopt",
                          },
                        }),
                      )
                    }
                  >
                    Adopt
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={locked}
                    onClick={() =>
                      void run("Could not reject the proposal", () =>
                        decide({
                          environmentId,
                          input: {
                            botId: bot.id,
                            entryId,
                            revision: revision.revision,
                            decision: "reject",
                          },
                        }),
                      )
                    }
                  >
                    Reject
                  </Button>
                </div>
              </div>
            ))}
            {view.restorable.length === 0 ? null : (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  History ({view.entry.revisions.length} revisions)
                </summary>
                <ul className="mt-1 space-y-1">
                  {view.restorable.map((revision) => (
                    <li key={revision.revision} className="flex items-start justify-between gap-2">
                      <span className="min-w-0 wrap-anywhere">
                        <span className="text-muted-foreground">
                          r{revision.revision} · {BOT_LEARNING_STATUS_LABELS[revision.status]}{" "}
                          ·{" "}
                        </span>
                        {revision.text}
                      </span>
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={locked}
                        onClick={() =>
                          void run("Could not restore the revision", () =>
                            restore({
                              environmentId,
                              input: { botId: bot.id, entryId, revision: revision.revision },
                            }),
                          )
                        }
                      >
                        Restore
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        );
      })}
      {leftOut.length === 0 ? null : (
        <div className="space-y-1 rounded-md border p-2 text-sm">
          <p className="font-medium">Left out of the Bot's turns here ({leftOut.length})</p>
          <p className="text-xs text-muted-foreground">{BOT_LEARNING_LEFT_OUT_EXPLANATION}</p>
          <ul className="space-y-1">
            {leftOut.map(({ entry, current }) => (
              <li key={entry.id} className="wrap-anywhere text-muted-foreground">
                {current.text}
                {entry.projectId === null ? " · all projects" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {projectId === null ? null : (
        <div className="space-y-2">
          <Textarea
            aria-label="New instruction"
            className="max-h-32 overflow-y-auto"
            placeholder="Add an instruction, such as “Give dates in Dale Reckoning.”"
            value={text}
            disabled={locked}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={kind}
              onValueChange={(value) => {
                if (value !== null) setKind(value);
              }}
            >
              <div className="grid w-36 grid-cols-1">
                <SelectTrigger size="sm" aria-label="Kind" disabled={locked}>
                  <SelectValue>{BOT_LEARNING_KIND_LABELS[kind]}</SelectValue>
                </SelectTrigger>
              </div>
              <SelectPopup>
                {BOT_LEARNING_KINDS.map((option) => (
                  <SelectItem key={option} value={option} label={BOT_LEARNING_KIND_LABELS[option]}>
                    {BOT_LEARNING_KIND_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={shared}
                disabled={locked}
                onCheckedChange={(checked) => setShared(checked === true)}
              />
              All projects
            </label>
            <Button
              size="xs"
              variant="outline"
              disabled={locked || text.trim() === ""}
              onClick={() => void add()}
            >
              <PlusIcon aria-hidden />
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const BOT_LEARNING_KINDS: ReadonlyArray<BotLearningKind> = ["preference", "procedure", "fact"];

function BotProjectContextEditor({
  context,
  title,
  draft,
  disabled,
  onDraftChange,
  onDetach,
  onReattach,
  workingNotes,
  children,
}: {
  readonly context: BotProjectContext;
  readonly title: string;
  readonly draft: BotProjectContextDraft;
  readonly disabled: boolean;
  readonly onDraftChange: (draft: BotProjectContextDraft) => void;
  readonly onDetach: () => void;
  readonly onReattach: () => void;
  readonly workingNotes?: ReactNode;
  /** Shown below the context while the project is attached. */
  readonly children?: ReactNode;
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
      {workingNotes}
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
          {children}
        </>
      )}
    </div>
  );
}

const RECENT_BOT_TASK_LIMIT = 5;

function BotRoutines({
  environmentId,
  bot,
  projectId,
  timeZone,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: BotDetail;
  readonly projectId: ProjectId;
  readonly timeZone: string | undefined;
}) {
  const routinesQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.botTasksLive({ environmentId, input: { botId: bot.id, projectId } }),
  );
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const [editing, setEditing] = useState<ScheduledTaskId | "new" | null>(null);
  const routines =
    routinesQuery.data === null
      ? null
      : botRoutinesFor(routinesQuery.data.tasks, bot.id, projectId);
  const recentTasks = tasksQuery.data?.tasks.slice(0, RECENT_BOT_TASK_LIMIT) ?? [];
  const editorFor = (task: ScheduledTask | null) => (
    <BotRoutineEditor
      environmentId={environmentId}
      bot={bot}
      projectId={projectId}
      timeZone={timeZone}
      task={task}
      onDone={() => setEditing(null)}
    />
  );
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Label>Routines</Label>
          <p className="text-xs text-muted-foreground">
            Each run starts a new work thread without approval prompts. Changes allowed runs in Full
            access; No changes can read and report but not change anything.
          </p>
        </div>
        <Button
          className="shrink-0"
          size="xs"
          variant="outline"
          disabled={!canOperate || editing !== null}
          onClick={() => setEditing("new")}
        >
          <PlusIcon aria-hidden />
          Add routine
        </Button>
      </div>
      {routinesQuery.error !== null ? (
        <p className="text-xs text-destructive">{routinesQuery.error}</p>
      ) : routines === null ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading routines…
        </p>
      ) : routines.length === 0 && editing !== "new" ? (
        <p className="text-xs text-muted-foreground">No routines yet.</p>
      ) : (
        <ul className="space-y-2">
          {routines.map((task) =>
            editing === task.id ? (
              <li key={task.id}>{editorFor(task)}</li>
            ) : (
              <BotRoutineRow
                key={task.id}
                environmentId={environmentId}
                task={task}
                timeZone={timeZone}
                canOperate={canOperate}
                onEdit={editing === null ? () => setEditing(task.id) : null}
              />
            ),
          )}
        </ul>
      )}
      {editing === "new" ? editorFor(null) : null}
      {tasksQuery.error !== null ? (
        <p className="text-xs text-destructive">{tasksQuery.error}</p>
      ) : recentTasks.length === 0 ? null : (
        <div className="space-y-2">
          <Label>Recent tasks</Label>
          <ul className="space-y-2 text-xs">
            {recentTasks.map((task) => (
              <BotTaskRow key={task.id} environmentId={environmentId} task={task} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BotRoutineRow({
  environmentId,
  task,
  timeZone,
  canOperate,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly timeZone: string | undefined;
  readonly canOperate: boolean;
  /** Null while another routine form is open. */
  readonly onEdit: (() => void) | null;
}) {
  const formatInstant = useUpcomingInstantFormatter();
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "bot routine enabled",
  });
  const runNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "bot routine run now",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "bot routine delete",
  });
  const [busy, setBusy] = useState(false);
  const act = async (
    title: string,
    command: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusy(true);
    const result = await command();
    setBusy(false);
    settled(title, result);
  };
  const editable = botRoutineDraft(task) !== null;
  return (
    <li className="flex items-start justify-between gap-2 text-xs">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 text-sm font-medium wrap-anywhere">{task.title}</span>
          {task.enabled ? null : <Badge variant="outline">Paused</Badge>}
          {task.lastRunStatus === "never" ? null : (
            <Badge variant={scheduledRunStatusVariant(task.lastRunStatus)}>
              Last run {task.lastRunStatus}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground">
          {describeBotRoutineTiming(task, formatInstant, timeZone)}
          {task.bot?.allowChanges ? " · Changes allowed" : " · No changes"}
        </p>
        {task.blockedByPolicy !== undefined ? (
          <p className="text-muted-foreground">{task.blockedByPolicy}</p>
        ) : task.enabled && task.nextRunAt !== null ? (
          <p className="text-muted-foreground">
            Next run <ScheduledRelativeLabel value={task.nextRunAt} />
          </p>
        ) : null}
        {task.lastRunError ? (
          <p className="text-destructive wrap-anywhere">{task.lastRunError}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !canOperate}
          onClick={() =>
            void act(task.enabled ? "Could not pause routine" : "Could not resume routine", () =>
              setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } }),
            )
          }
        >
          {task.enabled ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
          {task.enabled ? "Pause" : "Resume"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy || !canOperate}
                aria-label={`Actions for ${task.title}`}
              />
            }
          >
            <MoreHorizontalIcon className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              onClick={() =>
                void act("Could not run routine", () =>
                  runNow({ environmentId, input: { id: task.id } }),
                )
              }
            >
              <PlayIcon />
              Run now
            </MenuItem>
            {editable ? (
              <MenuItem disabled={onEdit === null} onClick={() => onEdit?.()}>
                <PencilIcon />
                Edit
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem
              onClick={() =>
                void act("Could not delete routine", () =>
                  remove({ environmentId, input: { id: task.id } }),
                )
              }
            >
              <Trash2Icon />
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
}

function BotRoutineEditor({
  environmentId,
  bot,
  projectId,
  timeZone,
  task,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: BotDetail;
  readonly projectId: ProjectId;
  readonly timeZone: string | undefined;
  /** Null when adding a routine. */
  readonly task: ScheduledTask | null;
  readonly onDone: () => void;
}) {
  // Chosen once per form so a retried create stays idempotent.
  const [commandId] = useState(() => CommandId.make(randomUUID()));
  const [form, setForm] = useState(() =>
    botRoutineForm((task === null ? null : botRoutineDraft(task)) ?? emptyBotRoutineDraft()),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canOperate = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "bot routine upsert",
  });
  const idPrefix = `bot-routine-${task?.id ?? `new-${projectId}`}`;
  const update = (patch: Partial<BotRoutineForm>) => setForm((prev) => ({ ...prev, ...patch }));

  const save = async () => {
    const built = botRoutineUpsertInput(
      botRoutineDraftFromForm(form),
      {
        botId: bot.id,
        projectId,
        modelSelection: bot.modelSelection,
        ...(task === null ? { commandId } : { id: task.id, enabled: task.enabled }),
      },
      Date.now(),
    );
    if ("error" in built) {
      setError(built.error);
      return;
    }
    setError(null);
    setSaving(true);
    const result = await upsert({ environmentId, input: built.input });
    setSaving(false);
    if (result._tag !== "Failure") {
      onDone();
    } else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <fieldset disabled={saving} className="min-w-0 space-y-3 rounded-md border p-3">
      <Field label="Name" htmlFor={`${idPrefix}-title`}>
        <Input
          id={`${idPrefix}-title`}
          value={form.title}
          onChange={(event) => update({ title: event.target.value })}
        />
      </Field>
      <Field label="Brief" htmlFor={`${idPrefix}-prompt`}>
        <Textarea
          id={`${idPrefix}-prompt`}
          className="max-h-48 overflow-y-auto"
          placeholder="What should the Bot do on each run?"
          value={form.prompt}
          onChange={(event) => update({ prompt: event.target.value })}
        />
      </Field>
      <div className="space-y-2">
        <Label>Changes</Label>
        <ToggleGroup
          aria-label="Routine changes"
          value={[form.allowChanges ? "allow" : "none"]}
          onValueChange={(values) => {
            if (values[0] === "allow" || values[0] === "none") {
              update({ allowChanges: values[0] === "allow" });
            }
          }}
        >
          <Toggle value="none">No changes</Toggle>
          <Toggle value="allow">Changes allowed</Toggle>
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">
          {form.allowChanges
            ? "The Bot is instructed to carry out the edits or messages requested in the brief."
            : "The Bot is instructed to report results and propose changes without editing files or data or sending messages."}
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>When</Label>
          <ToggleGroup
            aria-label="Routine timing"
            value={[form.timing]}
            onValueChange={(values) => {
              const timing = values[0];
              if (timing === "session" || timing === "recurring") update({ timing });
            }}
          >
            <Toggle value="session">Before an event</Toggle>
            <Toggle value="recurring">Recurring</Toggle>
          </ToggleGroup>
        </div>
        {form.timing === "session" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={`${idPrefix}-session`}>Event starts</Label>
            <Input
              type="datetime-local"
              id={`${idPrefix}-session`}
              nativeInput
              className="w-56"
              value={form.sessionAt}
              onChange={(event) => update({ sessionAt: event.target.value })}
            />
            <Input
              type="number"
              aria-label="Hours before the event"
              nativeInput
              min={0}
              step="any"
              className="w-20"
              value={form.leadHours}
              onChange={(event) => update({ leadHours: event.target.value })}
            />
            <span className="text-xs text-muted-foreground">hours before</span>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`${idPrefix}-time`}>Run at</Label>
              <Input
                type="time"
                id={`${idPrefix}-time`}
                nativeInput
                className="w-32"
                value={form.timeOfDay}
                onChange={(event) => update({ timeOfDay: event.target.value })}
              />
              <ToggleGroup
                multiple
                variant="outline"
                size="sm"
                aria-label="Days to run"
                value={form.weekdays.map(String)}
                onValueChange={(values) => update({ weekdays: values.map(Number) })}
              >
                {WEEKDAY_ORDER.map((day) => (
                  <Toggle key={day} value={String(day)} aria-label={WEEKDAY_LABELS[day]}>
                    {WEEKDAY_SHORT[day]}
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>
            <p className="text-xs text-muted-foreground">
              {`Runs at this time in ${timeZone === undefined ? "" : `${timeZone}, `}the environment's time zone. With no days picked, it runs every day.`}
            </p>
          </div>
        )}
      </div>
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="xs" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button size="xs" disabled={!canOperate} onClick={() => void save()}>
          {task === null ? "Add routine" : "Save routine"}
        </Button>
      </div>
    </fieldset>
  );
}
