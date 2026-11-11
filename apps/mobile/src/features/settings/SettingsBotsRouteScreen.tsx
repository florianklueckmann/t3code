import { useAtomValue } from "@effect/atom-react";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { defaultBotAppearance, resolveBotAppearance } from "@t3tools/client-runtime/bot-appearance";
import { BotId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import type { BotDetail, BotSummary, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Fragment, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BotAvatar } from "../../components/BotAvatar";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";
import { reportBotFailure } from "../bots/reportBotFailure";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useBotEditor, startBotEditor, startNewBotEditor } from "./bot-editor";
import { BotContinuationSection } from "./BotContinuationSection";
import { BotHomeCheckSection } from "./BotHomeCheckSection";
import { BotMaintenanceSection } from "./BotMaintenanceSection";
import { BotLearningSection } from "./BotLearningSection";
import { BotRoutinesSection } from "./BotRoutinesSection";
import {
  attachBotProjectDraft,
  BOT_LEARNING_POLICIES,
  botDraftFromDetail,
  botModelOptions,
  defaultBotModelSelection,
  detachBotProjectDraft,
  isBotModelOption,
  emptyBotSourceDraft,
  newBotDraft,
  planBotSave,
  updateBotProjectDraft,
  type BotDraft,
  type BotProjectDraft,
  type BotSaveStep,
} from "./botDraft";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { FormField, PickerRow, SelectRow } from "./components/SettingsFormRows";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";

type BotRoutes = {
  SettingsBotNew: undefined;
  SettingsBotEdit: undefined;
  SettingsBotModel: undefined;
  SettingsBotLook: undefined;
};

const BOT_NAME_MAX = 80;
const BOT_TEXT_MAX = 16_000;
const SOURCE_LABEL_MAX = 120;
const SOURCE_LOCATION_MAX = 2_000;
const SOURCES_MAX = 50;

function modelLabel(
  options: ReturnType<typeof botModelOptions>,
  selection: BotSummary["modelSelection"] | null,
): string | null {
  if (!selection) return null;
  return (
    options.find(
      (option) =>
        option.selection.instanceId === selection.instanceId &&
        option.selection.model === selection.model,
    )?.label ?? selection.model
  );
}

export function SettingsBotsRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { availableTargets, selectedTargets, selectedProjectKey, projectGroups } =
    useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const visibleEnvironments = settingsTargetsForProject(
    selectedTargets,
    selectedProjectKey === null ? null : selectedGroup,
  );
  const insets = useSafeAreaInsets();

  return (
    <>
      <SettingsScreen title="Bots" menus={[environmentMenu]}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="px-2 text-sm text-foreground-muted">
            A Bot keeps one conversation per project, with its own instructions and the context you
            give it for that project.
          </Text>
          {visibleEnvironments.length > 0 ? (
            visibleEnvironments.map((environment) => (
              <SettingsSection
                key={environment.environmentId}
                title={environment.label}
                titleIcon={
                  <EnvironmentMachineSymbol
                    kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                    size={16}
                    tintColorClassName={
                      Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
                    }
                  />
                }
              >
                {environment.serverConfig.environment.capabilities.bots === true ? (
                  <EnvironmentBots
                    environment={environment}
                    projectIds={
                      selectedProjectKey === null
                        ? null
                        : (selectedGroup?.members
                            .filter(
                              (member) =>
                                member.project.environmentId === environment.environmentId,
                            )
                            .map((member) => member.project.id) ?? [])
                    }
                  />
                ) : (
                  <Text className="p-4 text-base text-foreground-muted">
                    Update T3 Code on this environment to use Bots.
                  </Text>
                )}
              </SettingsSection>
            ))
          ) : (
            <Text className="px-2 text-base text-foreground-muted">
              {availableTargets.length === 0
                ? "Connect an environment to view and create Bots."
                : "No environments match these filters. Change the filter above."}
            </Text>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentBots({
  environment,
  projectIds,
}: {
  readonly environment: SettingsTarget;
  readonly projectIds: readonly ProjectId[] | null;
}) {
  const environmentId = environment.environmentId;
  const navigation = useNavigation<NativeStackNavigationProp<BotRoutes>>();
  const selectDetail = useSelectWorkspaceDetail();
  const bots = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const canCreate = useAtomValue(serverEnvironment.createBot.permissionAtom(environmentId));
  const projects = useProjects();
  const projectTitles = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title]),
  );
  const config = useEnvironmentServerConfig(environmentId);
  const modelOptions = botModelOptions(config, null);
  const visibleBots = (bots.data?.bots ?? [])
    .filter(
      (bot) =>
        projectIds === null ||
        bot.projects.some((project) => projectIds.includes(project.projectId)),
    )
    .sort((left, right) => Number(left.archivedAt !== null) - Number(right.archivedAt !== null));

  return (
    <>
      {bots.error ? (
        <Text className="p-4 text-base text-danger-foreground">{bots.error}</Text>
      ) : !bots.data ? (
        <Text className="p-4 text-base text-foreground-muted">Loading Bots…</Text>
      ) : visibleBots.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          {projectIds === null ? "No Bots yet." : "No Bots in this project."}
        </Text>
      ) : (
        visibleBots.map((bot, index) => (
          <View
            key={bot.id}
            className={
              index === 0 ? "gap-2 px-4 py-3" : "gap-2 border-t border-border-subtle px-4 py-3"
            }
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit ${bot.name}`}
              onPress={() => {
                startBotEditor(environmentId, bot.id);
                navigation.navigate("SettingsBotEdit");
              }}
              className="flex-row items-center gap-3 active:opacity-70"
            >
              <BotAvatar appearance={resolveBotAppearance(bot)} size={32} />
              <View className="min-w-0 flex-1 gap-1">
                <Text textRole="body" className="text-foreground" numberOfLines={1}>
                  {bot.name}
                </Text>
                <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                  {[
                    modelLabel(modelOptions, bot.modelSelection),
                    bot.archivedAt ? "Archived" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              <SymbolView
                name="chevron.right"
                size={14}
                tintColorClassName="accent-chevron"
                type="monochrome"
              />
            </Pressable>
            {bot.projects.length === 0 ? (
              <Text className="text-sm text-foreground-muted">No projects attached.</Text>
            ) : (
              bot.projects.map((project) => {
                const title = projectTitles.get(project.projectId) ?? "Unknown project";
                const opens = project.detachedAt === null && bot.archivedAt === null;
                return (
                  <View key={project.projectId} className="min-h-8 flex-row items-center gap-3">
                    <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                      {title}
                      {project.detachedAt === null ? "" : " · Detached"}
                    </Text>
                    {opens ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${bot.name} conversation in ${title}`}
                        hitSlop={8}
                        onPress={() =>
                          selectDetail({
                            name: "Thread",
                            params: {
                              environmentId: String(environmentId),
                              threadId: String(project.homeThreadId),
                            },
                          })
                        }
                        className="active:opacity-70"
                      >
                        <Text className="text-sm text-primary-text">Open conversation</Text>
                      </Pressable>
                    ) : null}
                  </View>
                );
              })
            )}
          </View>
        ))
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !canCreate }}
        disabled={!canCreate}
        onPress={() => {
          startNewBotEditor(
            environmentId,
            newBotDraft(BotId.make(uuidv4()), defaultBotModelSelection(config)),
          );
          navigation.navigate("SettingsBotNew");
        }}
        className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
      >
        <Text textRole="body" className="min-w-0 flex-1 text-foreground">
          New Bot
        </Text>
        <SymbolView name="plus" size={16} tintColorClassName="accent-icon" />
      </Pressable>
    </>
  );
}

export function SettingsBotNewRouteScreen() {
  return <BotEditorScreen title="New Bot" />;
}

export function SettingsBotEditRouteScreen() {
  return <BotEditorScreen title="Edit Bot" />;
}

function BotEditorScreen({ title }: { readonly title: string }) {
  const editor = useBotEditor();
  const { availableTargets } = useSettingsEnvironmentFilter();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  // Set once a save or archive lands, so the removal guard lets the editor close.
  const done = useRef(false);
  const preventRemove = editor.hasChanges || saving;
  usePreventRemove(preventRemove, ({ data }) => {
    if (done.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (saving) {
      Dialog.alert("Saving Bot", "Wait for the Bot to finish saving before leaving.");
      return;
    }
    Dialog.alert("Discard changes?", "Your unsaved changes will be lost.", [
      { text: "Keep editing", style: "cancel" },
      {
        text: "Discard changes",
        style: "destructive",
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });
  const finish = () => {
    done.current = true;
    if (navigation.isFocused()) navigation.goBack();
  };
  const target = availableTargets.find((entry) => entry.environmentId === editor.environmentId);

  return (
    <SettingsScreen title={title} guardBack={preventRemove}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {editor.environmentId && editor.baseline && editor.draft ? (
          <BotForm
            key={editor.draft.botId}
            environmentId={editor.environmentId}
            environmentLabel={target?.label ?? null}
            baseline={editor.baseline}
            draft={editor.draft}
            setDraft={(update) => {
              if (!saving) editor.setDraft(update);
            }}
            setBaseline={editor.setBaseline}
            saving={saving}
            setSaving={setSaving}
            onDone={finish}
          />
        ) : (
          <Text
            className={
              editor.loadError
                ? "px-2 text-base text-danger-foreground"
                : "px-2 text-base text-foreground-muted"
            }
          >
            {editor.loadError ??
              (editor.environmentId ? "Loading Bot…" : "Open a Bot from Settings first.")}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function BotForm({
  environmentId,
  environmentLabel,
  baseline,
  draft,
  setDraft,
  setBaseline,
  saving,
  setSaving,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly baseline: BotDraft;
  readonly draft: BotDraft;
  readonly setDraft: (update: (current: BotDraft) => BotDraft) => void;
  readonly setBaseline: (next: BotDraft) => void;
  readonly saving: boolean;
  readonly setSaving: (saving: boolean) => void;
  readonly onDone: () => void;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<BotRoutes>>();
  const summaries = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const archived = summaries.data?.bots.find((bot) => bot.id === draft.botId)?.archivedAt != null;
  const config = useEnvironmentServerConfig(environmentId);
  const routinesSupported = config?.environment.capabilities.botRoutines === true;
  const notesSupported = config?.environment.capabilities.botContinuation === true;
  const maintenanceSupported = config?.environment.capabilities.botMaintenance === true;
  const canOperate = useAtomValue(serverEnvironment.updateBot.permissionAtom(environmentId));
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectTitle = (projectId: ProjectId) =>
    projects.find((project) => project.id === projectId)?.title ?? "Unknown project";
  const attachable = projects.filter(
    (project) =>
      project.archivedAt == null && !draft.projects.some((entry) => entry.projectId === project.id),
  );
  // Failures surface in this form's own alerts.
  const create = useAtomCommand(serverEnvironment.createBot, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateBot, { reportFailure: false });
  const attach = useAtomCommand(serverEnvironment.attachBotProject, { reportFailure: false });
  const updateContext = useAtomCommand(serverEnvironment.updateBotProjectContext, {
    reportFailure: false,
  });
  const detach = useAtomCommand(serverEnvironment.detachBotProject, { reportFailure: false });
  const setArchived = useAtomCommand(serverEnvironment.setBotArchived, { reportFailure: false });
  const submissionPending = useRef(false);
  const [archiving, setArchiving] = useState(false);
  const environmentUnavailable = environmentLabel === null;
  const readOnly = saving || archiving || archived || !canOperate || environmentUnavailable;
  const appearanceSupported = config?.environment.capabilities.botAppearance === true;

  const runStep = (step: BotSaveStep): Promise<AtomCommandResult<BotDetail, unknown>> => {
    switch (step.type) {
      case "create":
        return create({ environmentId, input: step.input });
      case "update":
        return update({ environmentId, input: step.input });
      case "attach":
        return attach({ environmentId, input: step.input });
      case "updateProjectContext":
        return updateContext({ environmentId, input: step.input });
      case "detach":
        return detach({ environmentId, input: step.input });
    }
  };

  const save = async () => {
    if (submissionPending.current || readOnly) return;
    const plan = planBotSave(baseline, draft);
    if ("error" in plan) {
      Dialog.alert("Incomplete Bot", plan.error);
      return;
    }
    submissionPending.current = true;
    setSaving(true);
    for (const step of plan.steps) {
      const result = await runStep(step);
      if (result._tag === "Failure") {
        submissionPending.current = false;
        setSaving(false);
        reportBotFailure("Could not save Bot", result);
        return;
      }
      // Later steps and a retry after a failure diff against what the server now has.
      setBaseline(botDraftFromDetail(result.value));
    }
    setSaving(false);
    onDone();
  };

  const changeArchived = async (next: boolean) => {
    setArchiving(true);
    const result = await setArchived({
      environmentId,
      input: { botId: draft.botId, archived: next },
    });
    setArchiving(false);
    if (result._tag === "Failure") {
      reportBotFailure(next ? "Could not archive Bot" : "Could not restore Bot", result);
      return;
    }
    if (next) onDone();
  };

  const updateProject = (
    projectId: ProjectId,
    patch: Partial<Omit<BotProjectDraft, "projectId">>,
  ) => setDraft((current) => updateBotProjectDraft(current, projectId, patch));

  return (
    <View className="gap-5">
      {archived ? (
        <Text className="px-1 text-base text-foreground-muted">
          This Bot is archived, along with its conversations. Restore it to edit it or talk to it.
        </Text>
      ) : null}
      {environmentUnavailable ? (
        <Text className="px-1 text-base text-danger-foreground">
          This environment is disconnected. Reconnect before saving.
        </Text>
      ) : null}
      <View
        className="gap-5"
        pointerEvents={saving ? "none" : "auto"}
        accessibilityElementsHidden={saving}
        importantForAccessibility={saving ? "no-hide-descendants" : "auto"}
      >
        <View className="items-center gap-1">
          <BotAvatar appearance={draft.appearance ?? defaultBotAppearance(draft.botId)} size={72} />
          {appearanceSupported ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Change appearance"
              accessibilityState={{ disabled: readOnly }}
              disabled={readOnly}
              onPress={() => navigation.navigate("SettingsBotLook")}
              className="px-3 py-1 active:opacity-70"
            >
              <Text
                className={readOnly ? "text-sm text-foreground-muted" : "text-sm text-primary-text"}
              >
                Change look
              </Text>
            </Pressable>
          ) : (
            <Text className="px-4 text-center text-sm text-foreground-muted">
              Update T3 Code on {environmentLabel ?? "this environment"} to change how this Bot
              looks.
            </Text>
          )}
        </View>
        <SettingsSection>
          <SelectRow
            label="Runs on"
            value={environmentLabel ?? "Disconnected"}
            actions={[]}
            onSelect={() => {}}
          />
        </SettingsSection>
        <SettingsSection title="Bot">
          <FormField
            label="Name"
            value={draft.name}
            placeholder="Docs helper"
            maxLength={BOT_NAME_MAX}
            disabled={readOnly}
            onChange={(name) => setDraft((current) => ({ ...current, name }))}
          />
          <FormField
            label="Instructions"
            value={draft.instructions}
            placeholder="How the Bot should work and answer"
            multiline
            maxLength={BOT_TEXT_MAX}
            borderTop
            disabled={readOnly}
            onChange={(instructions) => setDraft((current) => ({ ...current, instructions }))}
          />
          <PickerRow
            label="Model"
            borderTop
            value={
              modelLabel(botModelOptions(config, draft.modelSelection), draft.modelSelection) ??
              "Choose model"
            }
            disabled={readOnly}
            onPress={() => navigation.navigate("SettingsBotModel")}
          />
        </SettingsSection>
        <SettingsSection
          title="Learning"
          footer="When lessons from your corrections take effect. Your own standing instructions apply right away either way."
        >
          {BOT_LEARNING_POLICIES.map((policy, index) => (
            <Pressable
              key={policy.value}
              accessibilityRole="radio"
              accessibilityState={{
                checked: draft.learningPolicy === policy.value,
                disabled: readOnly,
              }}
              disabled={readOnly}
              onPress={() => setDraft((current) => ({ ...current, learningPolicy: policy.value }))}
              className={
                index === 0
                  ? "min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
                  : "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70"
              }
            >
              <Text textRole="body" className="min-w-0 flex-1 text-foreground">
                {policy.label}
              </Text>
              {draft.learningPolicy === policy.value ? (
                <SymbolView name="checkmark" size={16} tintColorClassName="accent-primary" />
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>
        {draft.projects.map((project) => (
          <Fragment key={project.projectId}>
            <BotProjectSection
              title={projectTitle(project.projectId)}
              project={project}
              disabled={readOnly}
              onChange={(patch) => updateProject(project.projectId, patch)}
              onDetach={() =>
                setDraft((current) => detachBotProjectDraft(current, baseline, project.projectId))
              }
            />
            {notesSupported &&
            baseline.projects.some((saved) => saved.projectId === project.projectId) ? (
              <BotContinuationSection
                environmentId={environmentId}
                botId={draft.botId}
                projectId={project.projectId}
                title={`${projectTitle(project.projectId)} · Working notes`}
                disabled={readOnly || !project.attached}
              />
            ) : null}
            {/* Shown while archived or detached so pausing stays reachable. */}
            {maintenanceSupported &&
            baseline.projects.some((saved) => saved.projectId === project.projectId) ? (
              <BotMaintenanceSection
                environmentId={environmentId}
                botId={draft.botId}
                projectId={project.projectId}
                title={`${projectTitle(project.projectId)} · Maintenance`}
                formLocked={readOnly || !project.attached}
              />
            ) : null}
            {maintenanceSupported &&
            baseline.projects.some((saved) => saved.projectId === project.projectId) ? (
              <BotHomeCheckSection
                environmentId={environmentId}
                botId={draft.botId}
                projectId={project.projectId}
                title={`${projectTitle(project.projectId)} · Home check`}
                formLocked={readOnly || !project.attached}
              />
            ) : null}
            {routinesSupported &&
            !archived &&
            project.attached &&
            baseline.projects.some(
              (saved) => saved.projectId === project.projectId && saved.attached,
            ) ? (
              <BotRoutinesSection
                environmentId={environmentId}
                botId={draft.botId}
                projectId={project.projectId}
                projectTitle={projectTitle(project.projectId)}
                timeZone={config?.environment.timeZone}
                disabled={readOnly}
              />
            ) : null}
            {/* Learning needs the saved attachment, not a draft one. */}
            {project.attached &&
            baseline.projects.some(
              (saved) => saved.projectId === project.projectId && saved.attached,
            ) ? (
              <BotLearningSection
                environmentId={environmentId}
                botId={draft.botId}
                projectId={project.projectId}
                title={`${projectTitle(project.projectId)} · Learning`}
                disabled={readOnly}
              />
            ) : null}
          </Fragment>
        ))}
        {baseline.created ? (
          <BotLearningSection
            environmentId={environmentId}
            botId={draft.botId}
            projectId={null}
            title="Learning for all projects"
            disabled={readOnly}
          />
        ) : null}
        <SettingsSection footer="Each project gets its own conversation with this Bot.">
          <SelectRow
            label="Attach project"
            value={attachable.length ? "Choose project" : "No other projects"}
            actions={
              readOnly
                ? []
                : attachable.map((project) => ({ id: project.id, title: project.title }))
            }
            onSelect={(id) => {
              const project = attachable.find((entry) => entry.id === id);
              if (project) setDraft((current) => attachBotProjectDraft(current, project.id));
            }}
          />
        </SettingsSection>
      </View>
      {archived ? (
        <Button
          tone="primary"
          fullWidth
          loading={archiving}
          disabled={!canOperate || environmentUnavailable}
          onPress={() => void changeArchived(false)}
          label={archiving ? "Restoring…" : "Restore Bot"}
        />
      ) : (
        <>
          <Button
            tone="primary"
            fullWidth
            loading={saving}
            disabled={!canOperate || environmentUnavailable || archiving}
            onPress={() => void save()}
            label={saving ? "Saving…" : draft.created ? "Save changes" : "Create Bot"}
          />
          {baseline.created ? (
            <Button
              tone="danger"
              fullWidth
              loading={archiving}
              disabled={readOnly}
              onPress={() =>
                Dialog.alert(
                  "Archive Bot?",
                  "Its project conversations are archived too. Unsaved changes are discarded. You can restore it later.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Archive",
                      style: "destructive",
                      onPress: () => void changeArchived(true),
                    },
                  ],
                )
              }
              label={archiving ? "Archiving…" : "Archive Bot"}
            />
          ) : null}
        </>
      )}
    </View>
  );
}

function BotProjectSection({
  title,
  project,
  disabled,
  onChange,
  onDetach,
}: {
  readonly title: string;
  readonly project: BotProjectDraft;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<Omit<BotProjectDraft, "projectId">>) => void;
  readonly onDetach: () => void;
}) {
  const updateSource = (id: string, patch: { label?: string; location?: string }) =>
    onChange({
      sources: project.sources.map((source) =>
        source.id === id ? { ...source, ...patch } : source,
      ),
    });
  return (
    <SettingsSection
      title={project.attached ? title : `${title} · Detached`}
      trailing={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={project.attached ? `Detach ${title}` : `Reattach ${title}`}
          disabled={disabled}
          hitSlop={8}
          onPress={project.attached ? onDetach : () => onChange({ attached: true })}
          className="px-2 active:opacity-70 disabled:opacity-50"
        >
          <Text
            textRole="footnote"
            className={project.attached ? "text-danger-foreground" : "text-primary-text"}
          >
            {project.attached ? "Detach" : "Reattach"}
          </Text>
        </Pressable>
      }
      footer={
        project.attached
          ? "Preferred sources tell the Bot where to look first. It can still use other sources when these don't answer the question."
          : "Reattaching restores this project's conversation and context."
      }
    >
      {project.attached ? (
        <>
          <FormField
            label="Guidance"
            value={project.guidance}
            placeholder="What the Bot should know about this project"
            multiline
            maxLength={BOT_TEXT_MAX}
            disabled={disabled}
            onChange={(guidance) => onChange({ guidance })}
          />
          {project.sources.map((source, index) => (
            <View key={source.id}>
              <View className="flex-row items-center gap-3 border-t border-border-subtle px-4 pt-3">
                <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
                  Preferred source {index + 1}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove preferred source ${index + 1}`}
                  disabled={disabled}
                  hitSlop={8}
                  onPress={() =>
                    onChange({ sources: project.sources.filter((entry) => entry.id !== source.id) })
                  }
                  className="active:opacity-70"
                >
                  <SymbolView
                    name="trash"
                    size={16}
                    tintColorClassName="accent-danger-foreground"
                  />
                </Pressable>
              </View>
              <FormField
                label="Label"
                value={source.label}
                placeholder="Team handbook"
                maxLength={SOURCE_LABEL_MAX}
                disabled={disabled}
                onChange={(label) => updateSource(source.id, { label })}
              />
              <FormField
                label="Location"
                value={source.location}
                placeholder="Path, URL or tool name"
                maxLength={SOURCE_LOCATION_MAX}
                disabled={disabled}
                onChange={(location) => updateSource(source.id, { location })}
              />
            </View>
          ))}
          {project.sources.length < SOURCES_MAX ? (
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => onChange({ sources: [...project.sources, emptyBotSourceDraft()] })}
              className="min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
            >
              <Text textRole="body" className="min-w-0 flex-1 text-foreground">
                Add preferred source
              </Text>
              <SymbolView name="plus" size={16} tintColorClassName="accent-icon" />
            </Pressable>
          ) : null}
        </>
      ) : (
        <Text className="p-4 text-base text-foreground-muted">
          The Bot no longer works in this project. Its conversation is archived.
        </Text>
      )}
    </SettingsSection>
  );
}

export function BotModelPickerRouteScreen() {
  const navigation = useNavigation();
  const { environmentId, draft, setDraft } = useBotEditor();
  const config = useEnvironmentServerConfig(environmentId);
  const selectedModel = draft?.modelSelection ?? null;
  const models = botModelOptions(config, selectedModel);
  const selectedOption = models.find(
    (option) =>
      option.selection.instanceId === selectedModel?.instanceId &&
      option.selection.model === selectedModel.model,
  );

  if (!environmentId || !draft) {
    return (
      <SettingsScreen title="Bot">
        <Text className="p-5 text-base text-foreground-muted">Open a Bot form first.</Text>
      </SettingsScreen>
    );
  }

  return (
    <ThreadSettingsPickerScreen
      environmentId={environmentId}
      projectId={null}
      providerGroups={groupByProvider(models)}
      isModelOptionEligible={isBotModelOption}
      selectedModel={selectedModel}
      // Bots have no prompt here; Codex has no prompt-controlled options.
      prompt=""
      onPromptChange={() => {}}
      onSelectModel={(option) =>
        setDraft((current) => ({ ...current, modelSelection: option.selection }))
      }
      optionDescriptors={resolveProviderOptionDescriptors({
        capabilities: selectedOption?.capabilities,
        selections: selectedModel?.options,
      })}
      onUpdateOptionSelections={(options) =>
        setDraft((current) =>
          current.modelSelection
            ? { ...current, modelSelection: { ...current.modelSelection, options } }
            : current,
        )
      }
      onClose={() => navigation.goBack()}
    />
  );
}
