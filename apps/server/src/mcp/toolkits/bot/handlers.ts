import { type BotError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotService from "../../../bots/BotService.ts";
import * as BotTaskService from "../../../bots/BotTaskService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BotToolkit, type BotToolInput } from "./tools.ts";

const botFailure = (error: BotError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const requireBotId = (input: BotToolInput) =>
  input.botId === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `\`${input.action}\` needs \`botId\`.`,
        }),
      )
    : Effect.succeed(input.botId);

const requireProjectId = (input: BotToolInput) =>
  input.projectId === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `\`${input.action}\` needs \`projectId\`.`,
        }),
      )
    : Effect.succeed(input.projectId);

const read = Effect.fn("mcp.bot.read")(function* (input: BotToolInput) {
  const bots = yield* BotService.BotService;
  if (input.action === "list_tasks") {
    const tasks = yield* BotTaskService.BotTaskService;
    const listed = tasks.list({
      ...(input.botId === undefined ? {} : { botId: input.botId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });
    return { tasks: (yield* listed.pipe(Effect.mapError(botFailure))).tasks };
  }
  if (input.action === "list") {
    return { bots: (yield* bots.list.pipe(Effect.mapError(botFailure))).bots };
  }
  const botId = yield* requireBotId(input);
  return { bot: yield* bots.get({ botId }).pipe(Effect.mapError(botFailure)) };
});

const write = Effect.fn("mcp.bot.write")(function* (input: BotToolInput) {
  const bots = yield* BotService.BotService;
  const tasks = yield* BotTaskService.BotTaskService;
  if (input.action === "cancel_task") {
    if (input.taskId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "`cancel_task` needs `taskId`.",
      });
    }
    const cancelled = tasks.cancel({ taskId: input.taskId });
    return { task: yield* cancelled.pipe(Effect.mapError(botFailure)) };
  }
  const botId = yield* requireBotId(input);
  if (input.action === "start_task") {
    if (input.task === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "`start_task` needs `task`.",
      });
    }
    const project = yield* bots
      .resolveProject({ botId, projectId: input.projectId })
      .pipe(Effect.mapError(botFailure));
    const started = tasks.start({
      botId,
      projectId: project.projectId,
      prompt: input.task,
      ...(input.title === undefined ? {} : { title: input.title }),
    });
    return { task: yield* started.pipe(Effect.mapError(botFailure)) };
  }
  const { guidance, sources } = input;
  const projectContext = {
    ...(guidance === undefined ? {} : { guidance }),
    ...(sources === undefined ? {} : { sources }),
  };
  if (input.action === "create") {
    const { name, modelSelection, learningPolicy } = input;
    if (name === undefined || modelSelection === undefined || learningPolicy === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "`create` needs `name`, `modelSelection` and `learningPolicy`.",
      });
    }
    const instructions = input.instructions ?? "";
    const created = bots.create({ botId, name, instructions, modelSelection, learningPolicy });
    return { bot: yield* created.pipe(Effect.mapError(botFailure)) };
  }
  if (input.action === "update" && input.projectId === undefined) {
    const { name, instructions, modelSelection, learningPolicy } = input;
    const updated = bots.update({
      botId,
      ...(name === undefined ? {} : { name }),
      ...(instructions === undefined ? {} : { instructions }),
      ...(modelSelection === undefined ? {} : { modelSelection }),
      ...(learningPolicy === undefined ? {} : { learningPolicy }),
    });
    return { bot: yield* updated.pipe(Effect.mapError(botFailure)) };
  }
  if (input.action === "archive" || input.action === "restore") {
    const archived = bots.setArchived({ botId, archived: input.action === "archive" });
    return { bot: yield* archived.pipe(Effect.mapError(botFailure)) };
  }
  const projectId = yield* requireProjectId(input);
  const changed =
    input.action === "update"
      ? bots.updateProjectContext({ botId, projectId, ...projectContext })
      : input.action === "attach"
        ? bots.attachProject({ botId, projectId, ...projectContext })
        : bots.detachProject({ botId, projectId });
  return { bot: yield* changed.pipe(Effect.mapError(botFailure)) };
});

export const layer = McpToolAccess.toLayer(BotToolkit, {
  t3_bot: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "read" || input.action === "list_tasks",
    McpToolAccess.reads(read),
    McpToolAccess.writesEnvironment((input) => write(input)),
  ),
});
