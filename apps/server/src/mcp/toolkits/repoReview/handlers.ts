import * as Effect from "effect/Effect";

import * as RepoReviewController from "../../../repoReview/RepoReviewController.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { RepoReviewToolkit } from "./tools.ts";

/**
 * Owner control posts publicly and merges, so it needs a full-access caller, and a review job
 * may never steer the controller that judges it. Submitting a result acts as the job's thread.
 */
const handlers = {
  repo_review_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const controller = yield* RepoReviewController.RepoReviewController;
      return yield* controller.status(input);
    }),
  ),
  repo_review_start: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const controller = yield* RepoReviewController.RepoReviewController;
      yield* controller.assertNotReviewJob(scope.thread?.threadId);
      return yield* controller.start(input);
    }),
  ),
  repo_review_control: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const controller = yield* RepoReviewController.RepoReviewController;
      return yield* controller.control(input, scope.thread?.threadId);
    }),
  ),
  repo_review_import: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const controller = yield* RepoReviewController.RepoReviewController;
      yield* controller.assertNotReviewJob(scope.thread?.threadId);
      return yield* controller.importLedger(input);
    }),
  ),
  repo_review_submit_result: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const thread = yield* McpInvocationContext.requireThreadScope(
        scope,
        "repo_review_submit_result",
      );
      const controller = yield* RepoReviewController.RepoReviewController;
      return yield* controller.submitResult(thread.thread.threadId, input);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof RepoReviewToolkit.tools>;

export const layer = McpToolAccess.toLayer(RepoReviewToolkit, handlers);
