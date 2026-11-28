# Bot sources

Runs real Bot turns end to end: a T3 Code dev server, its configured Codex provider, the Bot's real application context and T3's real MCP tools. It checks whether a Bot prefers its project's established sources, names missing and conflicting sources, keeps one-off research out of its defaults, and makes standing source changes through `t3_bot` with its own ids. Its learning cases check that the Bot records standing instructions and lessons from corrections under the right policy and scope, and that learning it never saw in the conversation changes later answers only when it is active and in scope.

Unlike [mcp-tool-use](../mcp-tool-use/), nothing is replayed or simulated, and it calls no model API directly. It uses whatever login the dev server's Codex provider has, so turns count against that account's usage.

## Run

1. Start an isolated dev server from the repo root: `vp run dev --no-seed`. Its state lives in the checkout's `.t3`. Bot conversations turn off Codex memories per thread, so your own memories neither reach the synthetic campaigns nor learn from them. Codex still loads your other global config, such as `~/.codex/AGENTS.md`, skills and MCP servers, on both sides of a comparison.
2. From `evals/`, run one case first:

   ```sh
   pnpm bot-sources --base-dir ../.t3 --out runs/check --case source-first --samples 1
   ```

3. Then the full set: `pnpm bot-sources --base-dir ../.t3 --out runs/<name>`.

Flags: `--instance` (the Bot's provider instance, default `codex`; a Claude instance such as `claudeAgent` runs the same cases on a Claude Bot), `--model` (default `gpt-6.1-terra`), `--effort` (default `high`), `--samples` (default 3), `--concurrency` (default 2), `--case <id>` (repeatable), `--work <dir>` for the synthetic project folders (default `<out>/work`).

The run stops before any turn when the instance's catalog does not offer the model with that effort; it never falls back to another model. Each row records the model the home conversation actually ran on.

The script signs in as a short-lived MCP client of the server, as `t3 thread` does, and revokes that session when it ends. Each sample creates its own synthetic projects and Bots, so samples do not share conversation history. A sample that does not finish, for example on a rate limit or a pending approval, is kept in `results.jsonl` with its `error` and counts as a failure.

To compare a Bot context change, run the same cases with the same model and effort against a server on the old revision of `apps/server/src/bots/BotTurnContext.ts` and `apps/server/src/mcp/toolkits/bot/tools.ts`, then against the new one. The dev server restarts by itself when those files change.

## Cases

`cases.ts` holds one synthetic world and the cases that run in it. Two projects are both titled "Faerun", one Bot is attached to both, and a second Bot with the same name is attached to the first, so only ids tell them apart. A case checks the Bot's answers with case-insensitive regexes, the `t3_bot` update calls it made, and the sources the server stored afterwards for every Bot and project. It also checks the learning the Bot recorded (a case without `learningAfter` expects none). A `seed` records learning through the eval's own MCP session before the turns, so the conversation never sees it; `adoptSeedFirst` adopts it before a turn, as the user would in settings. A turn with `freshContext` starts a new provider conversation, so earlier turns reach the Bot only through its tools; `citesTurn` then requires the answer to link a message of that earlier turn, as `t3_bot_history_search` returns it. Each row also records the working note, which the grader ignores: a fact the note carries was still in the Bot's context.

Add a case to `CASES`. Run it against the old context, where a `bad` case should fail, and against the new one.

The `route-thread-extraction` and `route-durable-script` cases use a Terra or Sonnet Home and a provider account that offers both a faster and a stronger model. They grade the model returned by the delegation or task tool. `source-first` checks that a simple lookup stays in Home.

The `bot-home-*` cases run in the Bot-level Home, which the sample opens with `t3_bot` `open_home`. `bot-home-distributes` requires exactly one started task per named project, each brief with a "Done when" condition, no task attempt elsewhere and no change in the Home: no file change in its activity and no added, deleted or changed file in the project checkouts. Their project folders are Git repositories, so the started tasks write in their own worktrees. `bot-home-asks-first` requires a question and no task attempt. Tasks start while the Home's turn runs; the eval cancels them after it, which limits their ungraded work. These cases grade only the Home's choice; where task cards and results land is outside them.

## A day of ten tasks

`bot-home-ten-tasks` (T3B-123, `homeDay.ts`) runs the Bot's own Home through a scripted day: ten tasks across four projects in two batches, with a fresh conversation (`freshContext`) once three tasks of the first batch have ended. Two tasks come back with an open question, one fails to start, the user cancels one while it runs, and one result names no evidence. The case runs only when named, because one sample costs about as much as the rest of the set:

```sh
pnpm bot-sources --base-dir ../.t3 --out runs/day --case bot-home-ten-tasks --model gpt-6-luna --effort medium
```

The Home runs on `--instance`/`--model`. The work threads are real turns on Codex `gpt-6-luna`, the Bot's model, whatever the Home runs on: the sample switches the Home's thread to the model under test as a user can in its composer, and the server needs a `codex` instance. Each fixture repository's `AGENTS.md` tells the workers to wait 30 seconds, as real work outlasts the turn that started it, and which `T3_RESULT` line to end with, so the Home sees the task records and "Task update" turns a real day produces. The failing task's project has its commits on `trunk` while HEAD names an unborn `main`, so its task fails with "The project has no commit to start a task branch from." The scripted workers do not cover a worker that wanders off, a native question card, or a run that fails midway.

It grades what the Home tells the user against the task records: one task per request and none started twice or beyond the ten, the final summary gives every task its record's status, the failed, cancelled and unproven tasks are never reported as done (also not in their update turn), each question reaches the user once before the summary, with its task and project, and the Home edits nothing and delegates nothing. `scenario held` fails a sample whose tasks did not end as scripted, for example when a worker ignored its script. `summary.md` records each sample's Home turns and token usage, read from the server's `statev2.sqlite` without writing to it.

To compare with a Home that gets its conversation history but not the task list, empty the turn sections of `buildBotHomeInstructions` in `apps/server/src/bots/BotTurnContext.ts` on a scratch server and run the case against it. `gradeDay` reads only a stored row, so a grader change can be checked against an earlier `results.jsonl` without new turns.

## Output

`results.jsonl` has one row per sample: checks, answers, the thread's tool activity, the stored sources, and the ids. `summary.md` has the pass counts per case and how many samples ran a tool call that touched your home directory. Those samples are not fully synthetic; check what they read before trusting their score. The rows hold the Bot's full answers; read them before quoting any.
