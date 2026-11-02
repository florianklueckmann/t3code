import { sameBotAppearance, savedBotAppearance } from "@t3tools/client-runtime/bot-appearance";
import type {
  BotAppearance,
  BotAttachProjectInput,
  BotCreateInput,
  BotDetachProjectInput,
  BotDetail,
  BotId,
  BotLearningPolicy,
  BotSourcePreference,
  BotUpdateInput,
  BotUpdateProjectContextInput,
  ModelSelection,
  ProjectId,
  ServerConfig,
} from "@t3tools/contracts";

import { buildModelOptions, type ModelOption } from "../../lib/modelOptions";

/** The server accepts Bots on Codex provider instances only. */
const BOT_PROVIDER_DRIVER = "codex";

export const BOT_LEARNING_POLICIES: ReadonlyArray<{
  readonly value: BotLearningPolicy;
  readonly label: string;
}> = [
  { value: "automatic", label: "Learn automatically" },
  { value: "after_adoption", label: "Only after I adopt it" },
];

export type BotSourceDraft = {
  readonly id: string;
  readonly label: string;
  readonly location: string;
};

export type BotProjectDraft = {
  readonly projectId: ProjectId;
  /** False for a project the Bot left; its conversation stays archived until reattached. */
  readonly attached: boolean;
  readonly guidance: string;
  readonly sources: ReadonlyArray<BotSourceDraft>;
};

export type BotDraft = {
  readonly botId: BotId;
  /** False until the server has the Bot, so a retried save does not create it twice. */
  readonly created: boolean;
  readonly name: string;
  readonly instructions: string;
  readonly modelSelection: ModelSelection | null;
  /** Unset on a new Bot: the user chooses it explicitly. */
  readonly learningPolicy: BotLearningPolicy | null;
  /** Null keeps the default look derived from the Bot id. */
  readonly appearance: BotAppearance | null;
  readonly projects: ReadonlyArray<BotProjectDraft>;
};

export function isBotModelOption(option: ModelOption): boolean {
  return option.providerDriver === BOT_PROVIDER_DRIVER;
}

export function botModelOptions(
  config: ServerConfig | null,
  selected: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  return buildModelOptions(config, selected, undefined, null).filter(isBotModelOption);
}

export function defaultBotModelSelection(config: ServerConfig | null): ModelSelection | null {
  const options = botModelOptions(config, null).filter((option) => !option.isUnavailable);
  return (options.find((option) => option.isDefault) ?? options[0])?.selection ?? null;
}

export function newBotDraft(botId: BotId, modelSelection: ModelSelection | null): BotDraft {
  return {
    botId,
    created: false,
    name: "",
    instructions: "",
    modelSelection,
    learningPolicy: null,
    appearance: null,
    projects: [],
  };
}

/** Source ids derive from their position, so a draft read twice from one detail matches itself. */
export function botDraftFromDetail(detail: BotDetail): BotDraft {
  return {
    botId: detail.id,
    created: true,
    name: detail.name,
    instructions: detail.instructions,
    modelSelection: detail.modelSelection,
    learningPolicy: detail.learningPolicy,
    appearance: savedBotAppearance(detail),
    projects: detail.projects.map((project) => ({
      projectId: project.projectId,
      attached: project.detachedAt === null,
      guidance: project.guidance,
      sources: project.sources.map((source, index) => ({
        id: `${project.projectId}:${index}`,
        label: source.label,
        location: source.location,
      })),
    })),
  };
}

let nextSourceId = 0;

export function emptyBotSourceDraft(): BotSourceDraft {
  nextSourceId += 1;
  return { id: `new:${nextSourceId}`, label: "", location: "" };
}

/** Attaches a new project, or reattaches one the Bot left with its earlier context. */
export function attachBotProjectDraft(draft: BotDraft, projectId: ProjectId): BotDraft {
  return draft.projects.some((project) => project.projectId === projectId)
    ? updateBotProjectDraft(draft, projectId, { attached: true })
    : {
        ...draft,
        projects: [...draft.projects, { projectId, attached: true, guidance: "", sources: [] }],
      };
}

/** A project the server never saw is dropped; a saved one is detached on save. */
export function detachBotProjectDraft(
  draft: BotDraft,
  baseline: BotDraft,
  projectId: ProjectId,
): BotDraft {
  return baseline.projects.some((project) => project.projectId === projectId)
    ? updateBotProjectDraft(draft, projectId, { attached: false })
    : { ...draft, projects: draft.projects.filter((project) => project.projectId !== projectId) };
}

export function updateBotProjectDraft(
  draft: BotDraft,
  projectId: ProjectId,
  patch: Partial<Omit<BotProjectDraft, "projectId">>,
): BotDraft {
  return {
    ...draft,
    projects: draft.projects.map((project) =>
      project.projectId === projectId ? { ...project, ...patch } : project,
    ),
  };
}

/** Rows left fully blank are ignored; a half-filled row is an error. */
export function parseBotSourceDrafts(
  sources: ReadonlyArray<BotSourceDraft>,
): { readonly sources: ReadonlyArray<BotSourcePreference> } | { readonly error: string } {
  const parsed: BotSourcePreference[] = [];
  for (const source of sources) {
    const label = source.label.trim();
    const location = source.location.trim();
    if (!label && !location) continue;
    if (!label || !location) {
      return { error: "Each preferred source needs a label and a location." };
    }
    parsed.push({ label, location });
  }
  return { sources: parsed };
}

function sourcesKey(sources: ReadonlyArray<BotSourceDraft>): string {
  const parsed = parseBotSourceDrafts(sources);
  return JSON.stringify(
    "error" in parsed
      ? sources.map((source) => [source.label.trim(), source.location.trim()])
      : parsed.sources.map((source) => [source.label, source.location]),
  );
}

function sameModel(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectContextChanged(left: BotProjectDraft, right: BotProjectDraft): boolean {
  return (
    left.guidance.trim() !== right.guidance.trim() ||
    sourcesKey(left.sources) !== sourcesKey(right.sources)
  );
}

export function hasBotDraftChanges(baseline: BotDraft, draft: BotDraft): boolean {
  if (
    baseline.created !== draft.created ||
    baseline.name.trim() !== draft.name.trim() ||
    baseline.instructions.trim() !== draft.instructions.trim() ||
    baseline.learningPolicy !== draft.learningPolicy ||
    !sameModel(baseline.modelSelection, draft.modelSelection) ||
    !sameBotAppearance(baseline.appearance, draft.appearance)
  ) {
    return true;
  }
  const projectIds = new Set(
    [...baseline.projects, ...draft.projects].map((project) => project.projectId),
  );
  for (const projectId of projectIds) {
    const before = baseline.projects.find((project) => project.projectId === projectId);
    const after = draft.projects.find((project) => project.projectId === projectId);
    if (!before || !after) return true;
    if (before.attached !== after.attached) return true;
    if (after.attached && projectContextChanged(before, after)) return true;
  }
  return false;
}

export type BotSaveStep =
  | { readonly type: "create"; readonly input: BotCreateInput }
  | { readonly type: "update"; readonly input: BotUpdateInput }
  | { readonly type: "attach"; readonly input: BotAttachProjectInput }
  | { readonly type: "updateProjectContext"; readonly input: BotUpdateProjectContextInput }
  | { readonly type: "detach"; readonly input: BotDetachProjectInput };

/**
 * The requests that take the server from `baseline` to `draft`: the Bot first, so a new Bot
 * exists before its projects attach. Detaching drops unsaved context edits for that project.
 */
export function planBotSave(
  baseline: BotDraft,
  draft: BotDraft,
): { readonly steps: ReadonlyArray<BotSaveStep> } | { readonly error: string } {
  const name = draft.name.trim();
  const instructions = draft.instructions.trim();
  if (!name || !draft.modelSelection || !draft.learningPolicy) {
    return { error: "Add a name, choose a model, and choose how the Bot learns." };
  }
  const botId = draft.botId;
  const steps: BotSaveStep[] = [];
  if (!draft.created) {
    steps.push({
      type: "create",
      input: {
        botId,
        name,
        instructions,
        modelSelection: draft.modelSelection,
        learningPolicy: draft.learningPolicy,
        ...(draft.appearance === null ? {} : { appearance: draft.appearance }),
      },
    });
  } else {
    const changes = {
      ...(name === baseline.name.trim() ? {} : { name }),
      ...(instructions === baseline.instructions.trim() ? {} : { instructions }),
      ...(sameModel(baseline.modelSelection, draft.modelSelection)
        ? {}
        : { modelSelection: draft.modelSelection }),
      ...(draft.learningPolicy === baseline.learningPolicy
        ? {}
        : { learningPolicy: draft.learningPolicy }),
      ...(sameBotAppearance(baseline.appearance, draft.appearance)
        ? {}
        : { appearance: draft.appearance }),
    };
    if (Object.keys(changes).length > 0) {
      steps.push({ type: "update", input: { botId, ...changes } });
    }
  }
  for (const project of draft.projects) {
    const before = baseline.projects.find((entry) => entry.projectId === project.projectId);
    const { projectId } = project;
    if (!project.attached) {
      if (before?.attached) steps.push({ type: "detach", input: { botId, projectId } });
      continue;
    }
    const parsed = parseBotSourceDrafts(project.sources);
    if ("error" in parsed) return parsed;
    const context = {
      botId,
      projectId,
      guidance: project.guidance.trim(),
      sources: parsed.sources,
    };
    if (!before?.attached) {
      steps.push({ type: "attach", input: context });
    } else if (projectContextChanged(before, project)) {
      steps.push({ type: "updateProjectContext", input: context });
    }
  }
  return { steps };
}
