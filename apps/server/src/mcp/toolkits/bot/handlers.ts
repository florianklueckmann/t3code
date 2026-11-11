import * as BotContinuation from "../../../bots/BotContinuation.ts";
import { type BotError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotService from "../../../bots/BotService.ts";
import * as BotTaskService from "../../../bots/BotTaskService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
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
  if (input.action === "read_continuation") {
    const continuation = yield* BotContinuation.BotContinuation;
    const botId = yield* requireBotId(input);
    const projectId = yield* requireProjectId(input);
    return {
      continuation: yield* continuation
        .get(
          {
            botId,
            projectId,
            ...(input.afterTaskId === undefined ? {} : { afterTaskId: input.afterTaskId }),
          },
          { page: true },
        )
        .pipe(Effect.mapError(botFailure)),
    };
  }
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

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** Provenance comes from the caller, never from ids the caller supplies. */
const learningCaller = Effect.fn("mcp.bot.learningCaller")(function* () {
  const bots = yield* BotService.BotService;
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) {
    return {
      bot: undefined,
      source: { kind: "agent", label: scope.client?.label ?? "MCP client" } as const,
    };
  }
  const bot = yield* bots.scopeOfThread(scope.thread.threadId).pipe(Effect.mapError(botFailure));
  if (bot === "inactive") {
    return yield* invalid(
      "This Bot conversation is inactive. Restore the Bot or reattach the project first.",
    );
  }
  return {
    bot,
    source:
      bot?.taskId == null
        ? ({ kind: "thread", threadId: scope.thread.threadId } as const)
        : ({ kind: "task", taskId: bot.taskId } as const),
  };
});

const changeLearning = Effect.fn("mcp.bot.changeLearning")(function* (input: BotToolInput) {
  const bots = yield* BotService.BotService;
  const botId = yield* requireBotId(input);
  const caller = yield* learningCaller();
  if (input.action === "learn") {
    const projectId = yield* requireProjectId(input);
    if (input.learning === undefined) return yield* invalid("`learn` needs `learning`.");
    if (
      caller.bot !== undefined &&
      (caller.bot.botId !== botId || caller.bot.projectId !== projectId)
    ) {
      return yield* invalid("A Bot records learning only in its own project conversation.");
    }
    const recorded = yield* bots
      .recordLearning({ ...input.learning, botId, projectId, source: caller.source })
      .pipe(Effect.mapError(botFailure));
    return { bot: recorded.bot, learned: recorded.learned };
  }
  if (caller.bot?.botId === botId) {
    return yield* invalid(
      "A Bot cannot adopt, reject, retire or reinstate its own learning. Ask the user to do it in Settings → Bots.",
    );
  }
  const entryId = input.entryId;
  if (entryId === undefined) return yield* invalid(`\`${input.action}\` needs \`entryId\`.`);
  if (input.action === "retire") {
    return {
      bot: yield* bots.retireLearning({ botId, entryId }).pipe(Effect.mapError(botFailure)),
    };
  }
  const revision = input.revision;
  if (revision === undefined) return yield* invalid(`\`${input.action}\` needs \`revision\`.`);
  const changed =
    input.action === "reinstate"
      ? bots.restoreLearning({ botId, entryId, revision, source: caller.source })
      : bots.decideLearning({
          botId,
          entryId,
          revision,
          decision: input.action === "adopt" ? "adopt" : "reject",
        });
  return { bot: yield* changed.pipe(Effect.mapError(botFailure)) };
});

const write = Effect.fn("mcp.bot.write")(function* (input: BotToolInput) {
  const bots = yield* BotService.BotService;
  const tasks = yield* BotTaskService.BotTaskService;
  if (input.action === "save_continuation") {
    const continuation = yield* BotContinuation.BotContinuation;
    const caller = yield* McpInvocationContext.McpInvocationContext;
    if (caller.thread === undefined || caller.thread.subagent === true)
      return yield* invalid(
        "Working-note writes require this project's active Home thread credential.",
      );
    const botId = yield* requireBotId(input);
    const projectId = yield* requireProjectId(input);
    if (input.continuation === undefined)
      return yield* invalid(
        "save_continuation needs continuation with baseRevision, updateId, note and the exact supplied basis.",
      );
    return {
      savedContinuation: yield* continuation
        .save(
          { ...input.continuation, botId, projectId },
          { kind: "bot", threadId: caller.thread.threadId },
        )
        .pipe(Effect.mapError(botFailure)),
    };
  }
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
  if (
    input.action === "learn" ||
    input.action === "adopt" ||
    input.action === "reject" ||
    input.action === "retire" ||
    input.action === "reinstate"
  ) {
    return yield* changeLearning(input);
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
    const caller = yield* McpInvocationContext.McpInvocationContext;
    if (input.returnToHome === true && caller.thread === undefined) {
      return yield* invalid("`returnToHome` is available only from the Bot's Home conversation.");
    }
    const started = tasks.start(
      {
        botId,
        projectId: project.projectId,
        prompt: input.task,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      },
      input.returnToHome === true ? { returnToHomeFrom: caller.thread!.threadId } : undefined,
    );
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
    (input) =>
      input.action === "list" ||
      input.action === "read" ||
      input.action === "list_tasks" ||
      input.action === "read_continuation",
    McpToolAccess.reads(read),
    McpToolAccess.either(
      (input) => input.action === "save_continuation",
      McpToolAccess.writesOwnHomeNote((input) => write(input)),
      McpToolAccess.writesEnvironment((input) => write(input)),
    ),
  ),
});
