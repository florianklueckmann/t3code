import {
  BotAttachProjectInput,
  BotDetail,
  BotSummary,
  BotUpdateInput,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BotService from "../../../bots/BotService.ts";
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
  ]),
  botId: Schema.optional(BotUpdateInput.fields.botId),
  projectId: Schema.optional(BotAttachProjectInput.fields.projectId),
  name: BotUpdateInput.fields.name,
  instructions: BotUpdateInput.fields.instructions,
  modelSelection: BotUpdateInput.fields.modelSelection,
  learningPolicy: BotUpdateInput.fields.learningPolicy,
  guidance: BotAttachProjectInput.fields.guidance,
  sources: BotAttachProjectInput.fields.sources,
});
export type BotToolInput = typeof BotToolParameters.Type;

const BotTool = Tool.make("t3_bot", {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BotService.BotService,
  ],
  description:
    "Bots: named identities with one home conversation per attached project. `update` with `projectId` sets that project's guidance and preferred sources (preferred, not exclusive); without it, the Bot. `guidance` and `sources` replace the stored values, so send the full list. Codex models only.",
  parameters: BotToolParameters,
  success: Schema.Struct({
    bots: Schema.optional(Schema.Array(BotSummary)),
    bot: Schema.optional(BotDetail),
  }),
}).annotate(Tool.Destructive, false);

export const BotToolkit = Toolkit.make(BotTool);
