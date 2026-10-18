import {
  OrchestratorMcpFailure,
  RepoReviewControlInput,
  RepoReviewFailure,
  RepoReviewImportInput,
  RepoReviewImportResult,
  RepoReviewJobResult,
  RepoReviewOwner,
  RepoReviewStartInput,
  RepoReviewStatusInput,
  RepoReviewStatusResult,
  RepoReviewSubmitResultOutput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RepoReviewController from "../../../repoReview/RepoReviewController.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  RepoReviewController.RepoReviewController,
];

const RepoReviewToolFailure = Schema.Union([RepoReviewFailure, OrchestratorMcpFailure]);

const OWNERSHIP =
  "The repository review controller is deterministic server code: it polls GitHub without model turns, launches one finite SHA-pinned review thread per pull request revision, and is the only writer of findings, approvals and merges.";

const StatusTool = Tool.make("repo_review_status", {
  description: `${OWNERSHIP} Report each repository owner's state (active, pausing, paused, stopped), tracked open pull requests with blockers, recent review jobs and their threads, open canonical findings and pending or uncertain GitHub writes.`,
  parameters: RepoReviewStatusInput,
  success: RepoReviewStatusResult,
  failure: RepoReviewToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Repository review status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const StartTool = Tool.make("repo_review_start", {
  description: `${OWNERSHIP} Create the owner for one GitHub repository. Only call this when the user asks to start monitoring a repository. The project must be a checkout of that repository and the server's GitHub credential becomes the posting account. policy.modelSelection is required. Owners start paused unless activate is true; one repository has at most one owner that is not stopped.`,
  parameters: RepoReviewStartInput,
  success: RepoReviewOwner,
  failure: RepoReviewToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Start repository review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ControlTool = Tool.make("repo_review_control", {
  description: `${OWNERSHIP} Change an owner on the user's instruction. pause stops new reviews and all GitHub writes now (writes already sent cannot be recalled). pause_after_round lets reviews already launched finish and publish, then pauses by itself. resume reactivates a paused owner. stop is final: queued and running reviews are cancelled. poll_now polls at the next tick. requeue starts a new review of one open pull request whose last review failed.`,
  parameters: RepoReviewControlInput,
  success: RepoReviewOwner,
  failure: RepoReviewToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Control repository review")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ImportTool = Tool.make("repo_review_import", {
  description: `${OWNERSHIP} Import a watch-repo session ledger (schema 1) as a paused owner, preserving canonical finding ids and URLs, verified approvals and merges, review history and handled author events. Nothing is posted to GitHub. dryRun defaults to true and only reports what would be imported and what blocks it; apply needs dryRun=false and policy.modelSelection. The previous owner must be stopped.`,
  parameters: RepoReviewImportInput,
  success: RepoReviewImportResult,
  failure: RepoReviewToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Import repository review ledger")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SubmitResultTool = Tool.make("repo_review_submit_result", {
  description:
    "Only for a repository review job running in its own review thread. Submit the structured result of this job: its jobId, the exact pins from the brief, the verdict, every new finding, a disposition for every open canonical finding, evidence labeled by provenance and coverage. The result is validated against the job; fix what a rejection names and submit again. Resubmitting the same result is harmless. After acceptance, end the turn. Never post to GitHub yourself.",
  parameters: RepoReviewJobResult,
  success: RepoReviewSubmitResultOutput,
  failure: RepoReviewToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Submit repository review result")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const RepoReviewToolkit = Toolkit.make(
  StatusTool,
  StartTool,
  ControlTool,
  ImportTool,
  SubmitResultTool,
);
