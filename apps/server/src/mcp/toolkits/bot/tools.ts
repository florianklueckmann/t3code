import {
  BotAttachProjectInput,
  BotDetail,
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
    "cancel_task",
  ]),
  botId: Schema.optional(BotUpdateInput.fields.botId),
  projectId: Schema.optional(BotAttachProjectInput.fields.projectId),
  task: Schema.optional(BotStartTaskInput.fields.prompt).annotate({
    description: "`start_task`: what the task should do, as the first message of its work thread.",
  }),
  title: BotStartTaskInput.fields.title,
  taskId: Schema.optional(BotTaskId),
  name: BotUpdateInput.fields.name,
  instructions: BotUpdateInput.fields.instructions,
  modelSelection: BotUpdateInput.fields.modelSelection,
  learningPolicy: BotUpdateInput.fields.learningPolicy,
  guidance: BotAttachProjectInput.fields.guidance,
  sources: BotAttachProjectInput.fields.sources,
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
    BotService.BotService,
    BotTaskService.BotTaskService,
  ],
  description:
    "Bots: named identities with one home conversation per attached project. `update` with `projectId` sets that project's guidance and preferred sources (preferred, not exclusive); without it, the Bot. `guidance` and `sources` replace the stored values, so send the full list. `start_task` runs `task` in a new work thread of the Bot's project; its result shows as a card in the home conversation. Codex models only.",
  parameters: BotToolParameters,
  success: Schema.Struct({
    bots: Schema.optional(Schema.Array(Schema.Struct(botToolSummaryFields))),
    bot: Schema.optional(Schema.Struct(botToolDetailFields)),
    tasks: Schema.optional(Schema.Array(BotTaskSummary)),
    task: Schema.optional(BotTaskSummary),
  }),
}).annotate(Tool.Destructive, false);

export const BotToolkit = Toolkit.make(BotTool);
