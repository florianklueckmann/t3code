import {
  BOT_CONTINUATION_LIMITS,
  BotContinuationView,
  BotSaveContinuationInput,
  BotSaveContinuationResult,
} from "@t3tools/contracts";
import * as BotContinuation from "../../../bots/BotContinuation.ts";
import {
  BotAttachProjectInput,
  BotDetail,
  BotLearningEntryId,
  BotLearningOrigin,
  BotLearningRevisionRef,
  BotLearningStatus,
  BotRecordLearningInput,
  BotStartTaskInput,
  BotSummary,
  BotTaskId,
  BotTaskSummary,
  BotUpdateInput,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BotService from "../../../bots/BotService.ts";
import * as BotTaskService from "../../../bots/BotTaskService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpCallerChanges from "../../McpCallerChanges.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const BotToolParameters = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  action: Schema.Literals([
    "list",
    "read",
    "create",
    "update",
    "archive",
    "restore",
    "attach",
    "detach",
    "start_task",
    "list_tasks",
    "read_continuation",
    "save_continuation",
    "cancel_task",
    "learn",
    "adopt",
    "reject",
    "retire",
    "reinstate",
  ]),
  botId: Schema.optional(BotUpdateInput.fields.botId),
  projectId: Schema.optional(BotAttachProjectInput.fields.projectId),
  task: Schema.optional(BotStartTaskInput.fields.prompt).annotate({
    description: "`start_task`: what the task should do, as the first message of its work thread.",
  }),
  title: BotStartTaskInput.fields.title,
  returnToHome: Schema.optional(Schema.Boolean).annotate({
    description:
      "`start_task`: opt in to one automatic successful-result turn in this project's Home, to reconcile and continue already authorized work. Default false. Only from that Home during a direct UI or external MCP input turn, never an automatic result turn. At most one pending return per Home input turn; a second opt-in is refused before launch. Newer direct Home input expires a pending return. A completed run does not prove fulfillment or grant new permissions. `cancel_task` also revokes a pending return.",
  }),
  taskId: Schema.optional(BotTaskId),
  afterTaskId: Schema.optional(BotTaskId).annotate({
    description:
      "`read_continuation`: pass nextActiveTaskId from the previous page to inspect further active work.",
  }),
  name: BotUpdateInput.fields.name,
  instructions: BotUpdateInput.fields.instructions,
  modelSelection: BotStartTaskInput.fields.modelSelection.annotate({
    description:
      "`create`/`update`: the Bot's model. `start_task`: this task's model and options only, such as reasoningEffort; the Bot keeps its own. Omit to use the Bot's. To change only options, copy `instanceId` and `model` from `read`.",
  }),
  learningPolicy: BotUpdateInput.fields.learningPolicy,
  guidance: BotAttachProjectInput.fields.guidance,
  sources: BotAttachProjectInput.fields.sources,
  learning: Schema.optional(
    Schema.Struct({
      origin: BotLearningOrigin,
      kind: BotRecordLearningInput.fields.kind,
      text: BotRecordLearningInput.fields.text,
      rationale: BotRecordLearningInput.fields.rationale,
      evidence: BotRecordLearningInput.fields.evidence,
      scope: BotRecordLearningInput.fields.scope,
      replaces: BotRecordLearningInput.fields.replaces,
    }),
  ),
  continuation: Schema.optional(
    Schema.Struct({
      baseRevision: BotSaveContinuationInput.fields.baseRevision,
      updateId: BotSaveContinuationInput.fields.updateId,
      note: BotSaveContinuationInput.fields.note,
      basis: BotSaveContinuationInput.fields.basis,
      acks: BotSaveContinuationInput.fields.acks,
    }),
  ).annotate({
    description: `Before save_continuation, preflight the full replacement note: at most ${BOT_CONTINUATION_LIMITS.items} items across sections, ${BOT_CONTINUATION_LIMITS.textChars} total text UTF-16 code units (JavaScript string.length), and ${BOT_CONTINUATION_LIMITS.itemChars} per text or quote. Quotes are outside the total text budget. Shorten and merge items rather than retrying an unchanged rejected draft.`,
  }),
  entryId: Schema.optional(BotLearningEntryId),
  revision: Schema.optional(BotLearningRevisionRef.fields.revision),
});
export type BotToolInput = typeof BotToolParameters.Type;

// Appearance is client presentation; agents neither edit nor read it yet.
const { appearance: _summaryAppearance, ...botToolSummaryFields } = BotSummary.fields;
const { appearance: _detailAppearance, ...botToolDetailFields } = BotDetail.fields;

const BotTool = Tool.make("t3_bot", {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    McpCallerChanges.McpCallerChanges,
    BotService.BotService,
    BotContinuation.BotContinuation,
    BotTaskService.BotTaskService,
  ],
  description:
    "Bots: named identities with one home conversation per attached project. `update` with `projectId` sets that project's guidance and preferred sources (preferred, not exclusive); without it, the Bot. `guidance` and `sources` replace the stored values, so send the full list. `start_task` runs `task` in a new work thread of the Bot's project; its result shows as a card in the home conversation. For a different model or reasoning for one task, pass `modelSelection` to `start_task`, not `update`. `learn` (with `projectId`, `learning`) records a user's standing instruction or proposes a lesson from their correction. `adopt`, `reject` and `reinstate` (an earlier revision) take `entryId` and `revision`; `retire` takes `entryId`. `read_continuation` reads project working notes and active Bot tasks, not Home's delegated/background work; inspect Home activity with `t3_thread_read` for owned delegate references and await their completion without polling. `save_continuation` replaces the working notes from this active Home with `continuation` {baseRevision, updateId (stable retry id), note (requests/waiting/decided/context arrays of {text, quote?, taskIds?}), basis (copy exactly from instructions/read)}. On conflict reconcile with current; proposals stay waiting and a new decided item requires a genuine direct user quote. Codex models only.",
  parameters: BotToolParameters,
  success: Schema.Struct({
    bots: Schema.optional(Schema.Array(Schema.Struct(botToolSummaryFields))),
    bot: Schema.optional(Schema.Struct(botToolDetailFields)),
    continuation: Schema.optional(BotContinuationView),
    savedContinuation: Schema.optional(BotSaveContinuationResult),
    tasks: Schema.optional(Schema.Array(BotTaskSummary)),
    task: Schema.optional(BotTaskSummary),
    learned: Schema.optional(
      Schema.Struct({
        entryId: BotLearningEntryId,
        revision: BotLearningRevisionRef.fields.revision,
        status: BotLearningStatus,
        duplicate: Schema.Boolean,
      }),
    ),
  }),
}).annotate(Tool.Destructive, false);

export const BotToolkit = Toolkit.make(BotTool);
