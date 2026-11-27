import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type BotTaskEvidenceCheck, type Project, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Acceptance from "./BotTaskAcceptance.ts";

const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const gitLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "bot-acceptance-test-" }).pipe(
      Layer.provide(platform),
    ),
  ),
  Layer.provideMerge(platform),
);

describe("readResultReport", () => {
  it("reads the report that ends the result and leaves the answer without it", () => {
    const line = `T3_RESULT {"result":"Fixed it.","status":"done","evidence":["branch: bot/fix"],"openQuestions":[]}`;
    for (const text of [`Fixed the typo.\n${line}`, `Fixed the typo. \`${line}\``]) {
      const read = Acceptance.readResultReport(text);
      assert.deepEqual(read.report, {
        result: "Fixed it.",
        status: "done",
        evidence: ["branch: bot/fix"],
        openQuestions: [],
      });
      assert.equal(read.text, "Fixed the typo.");
    }
  });

  it("reads no report from text after it, an unknown status or a missing field", () => {
    for (const text of [
      `T3_RESULT {"result":"a","status":"done","evidence":[],"openQuestions":[]}\nMore text.`,
      `T3_RESULT {"result":"a","status":"completed","evidence":[],"openQuestions":[]}`,
      `T3_RESULT {"result":"a","status":"done","evidence":[]}`,
    ])
      assert.isNull(Acceptance.readResultReport(text).report);
  });
});

describe("classifyEvidence", () => {
  it("names a branch, commit, file or link by its prefix, and anything else as unchecked", () => {
    assert.deepEqual(
      [
        "branch: bot/fix",
        "Commit = abc1234",
        "file: `src/a.ts:10-20`",
        "file: src/a.ts#L4",
        "link: https://example.com",
        "https://example.com/pr/1",
        "The session log",
      ].map(Acceptance.classifyEvidence),
      [
        { kind: "branch", target: "bot/fix" },
        { kind: "commit", target: "abc1234" },
        { kind: "file", target: "src/a.ts" },
        { kind: "file", target: "src/a.ts" },
        { kind: "link" },
        { kind: "link" },
        { kind: "other" },
      ],
    );
  });
});

it.layer(gitLayer)("BotTaskEvidence", (it) => {
  it.effect("finds branches, commits and files that exist in the worktree, never others", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bot-acceptance-" });
      const git = (...args: ReadonlyArray<string>) =>
        driver.execute({ operation: "test.git", cwd: root, args }).pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.orDie,
        );
      yield* git("init", "-b", "main");
      yield* git("config", "user.email", "test@example.com");
      yield* git("config", "user.name", "Test");
      yield* fs.writeFileString(path.join(root, "notes.md"), "notes\n");
      yield* git("add", "-A");
      yield* git("commit", "-m", "notes");
      yield* git("branch", "bot/fix");
      yield* git("tag", "v1");
      yield* git("update-ref", "refs/remotes/origin/bot/pushed", "HEAD");
      const commit = (yield* git("rev-parse", "HEAD")).slice(0, 10);
      const evidence = yield* Acceptance.BotTaskEvidence.pipe(
        Effect.provide(
          Acceptance.layer.pipe(
            Layer.provide(
              Layer.mock(ProjectService.ProjectService)({
                getById: () => Effect.succeedSome({ workspaceRoot: root } as Project),
              }),
            ),
          ),
        ),
      );
      const items = [
        "branch: bot/fix",
        "branch: origin/bot/pushed",
        "branch: bot/missing",
        "branch: HEAD",
        "branch: v1",
        "branch: --all",
        `commit: ${commit}`,
        "commit: 0000000",
        "commit: HEAD",
        "file: notes.md:2",
        "file: missing.md",
        "link: https://example.com",
        "The session log",
      ].map(Acceptance.classifyEvidence);
      const expected: ReadonlyArray<BotTaskEvidenceCheck> = [
        "found",
        "found",
        "missing",
        "missing",
        "missing",
        "missing",
        "found",
        "missing",
        "missing",
        "found",
        "missing",
        "link",
        "unchecked",
      ];
      const projectId = ProjectId.make("project");
      // A released worktree is gone; the project folder answers instead.
      for (const worktreePath of [root, path.join(root, "gone")])
        assert.deepEqual(yield* evidence.check({ projectId, worktreePath, items }), expected);
    }).pipe(Effect.scoped),
  );
});
