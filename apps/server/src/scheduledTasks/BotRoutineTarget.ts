import type {
  BotId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Routines run unattended, so they cannot wait on approvals nobody is there to give. */
export const BOT_ROUTINE_RUNTIME_MODE: RuntimeMode = "full-access";

export interface BotRoutineOccurrence {
  readonly scheduledTaskId: ScheduledTaskId;
  /** Stable for a scheduled occurrence, so a retry after a crash admits the same task. */
  readonly occurrenceKey: string;
  readonly dueAt: string;
  readonly sessionAt: string | null;
  readonly botId: BotId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
}

export type BotRoutineAdmission =
  | { readonly _tag: "admitted"; readonly workThreadId: ThreadId }
  | { readonly _tag: "skipped"; readonly reason: string }
  /** The Bot is archived or detached from the project; the routine must pause. */
  | { readonly _tag: "inactive"; readonly reason: string };

/**
 * Lets scheduled tasks run Bot routines through the Bot task admission without depending on
 * the Bot services, which themselves pause routines through the scheduled task service.
 */
export interface BotRoutineTargetShape {
  /**
   * The Bot's model, which its routines run on; fails with a user-facing reason when the Bot
   * cannot run routines in this project.
   */
  readonly requireRunnable: (input: {
    readonly botId: BotId;
    readonly projectId: ProjectId;
  }) => Effect.Effect<{ readonly modelSelection: ModelSelection }, string>;
  readonly admit: (occurrence: BotRoutineOccurrence) => Effect.Effect<BotRoutineAdmission, string>;
}

export class BotRoutineTarget extends Context.Reference<BotRoutineTargetShape>(
  "t3/scheduledTasks/BotRoutineTarget",
  {
    defaultValue: () => ({
      requireRunnable: () => Effect.fail("This server cannot run Bot routines."),
      admit: () => Effect.fail("This server cannot run Bot routines."),
    }),
  },
) {}
