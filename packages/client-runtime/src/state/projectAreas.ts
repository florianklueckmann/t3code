import {
  BOT_HOME_THREAD_ID_PREFIX,
  mayBeBotHomeThreadId,
  PROJECT_AREA_MAX_LENGTH,
  type ScopedProjectRef,
} from "@t3tools/contracts";

interface AreaGroup {
  readonly memberProjects: ReadonlyArray<{ readonly area?: string | null | undefined }>;
}

/** A project filter's area choice; `{ area: null }` lists projects without an area. */
export interface ProjectAreaScope {
  readonly area: string | null;
}

/** Checkouts on machines that were offline during a change can disagree, so a group can hold several. */
export function projectGroupAreas(group: AreaGroup): string[] {
  return [...new Set(group.memberProjects.flatMap((member) => (member.area ? [member.area] : [])))];
}

export function listProjectAreas(groups: ReadonlyArray<AreaGroup>): string[] {
  return [...new Set(groups.flatMap(projectGroupAreas))].sort((left, right) =>
    left.localeCompare(right),
  );
}

/** "No area" is offered only when it narrows the list: some project has an area and some has none. */
export function offersNoAreaFilter(groups: ReadonlyArray<AreaGroup>): boolean {
  return (
    groups.some((group) => projectGroupAreas(group).length > 0) &&
    groups.some((group) => projectGroupAreas(group).length === 0)
  );
}

/** `null` is "No area". */
export function isProjectGroupInArea(group: AreaGroup, area: string | null): boolean {
  const areas = projectGroupAreas(group);
  return area === null ? areas.length === 0 : areas.includes(area);
}

/**
 * The saved area as it applies to the listed projects. Like a missing project, an area no listed
 * project carries reads as all projects, and so does "No area" while no project has an area. The
 * saved value is left alone, so the area returns with its projects.
 */
export function resolveProjectAreaScope(
  groups: ReadonlyArray<AreaGroup>,
  saved: ProjectAreaScope | null,
): ProjectAreaScope | null {
  if (saved === null) return null;
  if (!groups.some((group) => isProjectGroupInArea(group, saved.area))) return null;
  if (saved.area === null && listProjectAreas(groups).length === 0) return null;
  return saved;
}

/** The area a project added under this scope starts in: the selected area, never "No area". */
export function newProjectAreaFor(scope: ProjectAreaScope | null): string | undefined {
  return scope?.area ?? undefined;
}

/** `environmentId:projectId` keys an area lists, or null when it lists no project and so filters nothing. */
export function resolveAreaScopedProjectKeys(
  groups: ReadonlyArray<AreaGroup & { readonly memberProjectRefs: readonly ScopedProjectRef[] }>,
  area: string | null,
): ReadonlySet<string> | null {
  const keys = new Set(
    groups
      .filter((group) => isProjectGroupInArea(group, area))
      .flatMap((group) =>
        group.memberProjectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`),
      ),
  );
  return keys.size === 0 ? null : keys;
}

/** `environmentId:projectId` keys of the projects a Bot is attached to. */
export function botProjectKeys(
  bot: {
    readonly projects: ReadonlyArray<{ readonly projectId: string; readonly detachedAt: unknown }>;
  },
  environmentId: string,
): string[] {
  return bot.projects.flatMap((context) =>
    context.detachedAt === null ? [`${environmentId}:${context.projectId}`] : [],
  );
}

/** A Bot shows while any project it works in is listed. A Bot without a project always shows. */
export function isBotInProjectScope(
  botProjectKeys: readonly string[],
  scopedProjectKeys: ReadonlySet<string> | null,
): boolean {
  return (
    scopedProjectKeys === null ||
    botProjectKeys.length === 0 ||
    botProjectKeys.some((key) => scopedProjectKeys.has(key))
  );
}

interface ScopedBot {
  readonly environmentId: string;
  readonly bot: {
    readonly id: string;
    readonly archivedAt: unknown;
    readonly projects: ReadonlyArray<{ readonly projectId: string; readonly detachedAt: unknown }>;
  };
}

/** `environmentId:botId` of the Bots a Bot rail shows under the scope. */
export function botRailKeys(
  bots: ReadonlyArray<ScopedBot>,
  scopedProjectKeys: ReadonlySet<string> | null,
): ReadonlySet<string> {
  return new Set(
    bots.flatMap(({ environmentId, bot }) =>
      bot.archivedAt === null &&
      isBotInProjectScope(botProjectKeys(bot, environmentId), scopedProjectKeys)
        ? [`${environmentId}:${bot.id}`]
        : [],
    ),
  );
}

interface ScopedThread {
  readonly environmentId: string;
  readonly id: string;
  readonly projectId: string;
  readonly archivedAt: unknown;
}

// Home ids are `bot-home:<botId>:<projectId>`.
const botKeyOfHome = (thread: ScopedThread) =>
  `${thread.environmentId}:${thread.id.slice(BOT_HOME_THREAD_ID_PREFIX.length).split(":")[0]}`;

const inProjectScope = (thread: ScopedThread, scopedProjectKeys: ReadonlySet<string>) =>
  scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`);

/**
 * Unarchived threads an area hides, for the dot on the filter. A Home counts only while its Bot is
 * off the rail, which shows that Bot's own dot: judged by the rail's Bots, and by a loaded Home in
 * scope while an environment's Bots are still loading.
 */
export function threadsHiddenByProjectScope<T extends ScopedThread>(
  threads: readonly T[],
  scopedProjectKeys: ReadonlySet<string>,
  railBotKeys: ReadonlySet<string>,
): T[] {
  const shownBots = new Set(railBotKeys);
  for (const thread of threads) {
    if (
      thread.archivedAt === null &&
      mayBeBotHomeThreadId(thread.id) &&
      inProjectScope(thread, scopedProjectKeys)
    ) {
      shownBots.add(botKeyOfHome(thread));
    }
  }
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      !inProjectScope(thread, scopedProjectKeys) &&
      !(mayBeBotHomeThreadId(thread.id) && shownBots.has(botKeyOfHome(thread))),
  );
}

export type ProjectAreaInput =
  | { readonly ok: true; readonly area: string }
  | { readonly ok: false; readonly error: string };

/** Typing an existing area in other letter case reuses its spelling instead of adding a near-duplicate. */
export function parseProjectAreaInput(
  text: string,
  existingAreas: readonly string[],
): ProjectAreaInput {
  const area = text.trim();
  if (area.length === 0) return { ok: false, error: "Enter an area name." };
  if (/[\r\n\u2028\u2029]/.test(area)) return { ok: false, error: "Use a single line." };
  if (area.length > PROJECT_AREA_MAX_LENGTH) {
    return { ok: false, error: `Use at most ${PROJECT_AREA_MAX_LENGTH} characters.` };
  }
  const existing = existingAreas.find(
    (candidate) => candidate.localeCompare(area, undefined, { sensitivity: "accent" }) === 0,
  );
  return { ok: true, area: existing ?? area };
}

export type ProjectAreaChoice =
  | { readonly kind: "set"; readonly area: string }
  | { readonly kind: "new" }
  | { readonly kind: "clear" };
