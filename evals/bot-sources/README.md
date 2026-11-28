# Bot sources

Runs real Bot turns end to end: a T3 Code dev server, its configured Codex provider, the Bot's real application context and T3's real MCP tools. It checks whether a Bot prefers its project's established sources, names missing and conflicting sources, keeps one-off research out of its defaults, and makes standing source changes through `t3_bot` with its own ids. Its learning cases check that the Bot records standing instructions and lessons from corrections under the right policy and scope, and that learning it never saw in the conversation changes later answers only when it is active and in scope.

The source and learning cases use real workers. The ten-task bookkeeping case replays worker answers. It uses whatever login the dev server's Codex provider has, so turns count against that account's usage.

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

The opt-in `bot-home-ten-tasks` case starts ten requests in four throwaway projects. Home runs on the requested model. A temporary Codex instance sends its worker requests to a loopback endpoint that returns a fixed answer at a milestone. The endpoint identifies the work thread from the provider thread record and ignores the brief. T3 checks the resulting `T3_RESULT` evidence, records acceptance, and sends its usual task update to Home. The day includes an unborn base branch, a user cancellation, two decisions, and a result without evidence.

```sh
pnpm bot-sources --base-dir ../.t3 --work /tmp/day-projects --out runs/day --case bot-home-ten-tasks --model gpt-6-luna --effort medium --samples 1
```

The runner releases the cart and image tasks after the first batch. The user requests the image question again and starts a fresh conversation for the second batch. After cancellation, the remaining workers finish. Routing requires the bracketed reference, project, and originating batch turn. A missing reference counts against Home. Each started attempt is journaled before its first Home turn. An attempt without a finish appears as interrupted in the summary, including after a restart. Use a separate output directory per model.

Bookkeeping checks use rules. The recap must contain exactly one task table outside code fences with the requested header. A separate evidence table is allowed. Task IDs and titles bind rows to records. Status, review state and evidence qualifiers are checked separately. The grader checks direct status and acceptance claims in prose and explicit denials that the first batch belongs to today. It cannot reliably detect arbitrary paraphrases, implied contradictions, or references by pronoun. Question checks recognize the two fixture decisions, including their alternatives, in the turn that received the update. A differently worded recorded question requires its specific wording. A requested repeat and the recap are labeled separately. These checks can miss valid English paraphrases.

Project, request details, condition for done and base branch use rules. For each of the two open-choice briefs, a separate ephemeral read-only Codex call asks Luna at low effort whether the brief requires an outcome or sets a default the worker applies without asking. The input includes the brief, recorded decision and alternatives. When a task has no recorded question, the grader uses its fixture question. A settled verdict must quote the brief verbatim. A missing or malformed judgment is an error. A settled choice also fails the request criterion. The summary lists each verdict, quotation and judge token usage. The human labels in `fixtures/day-choice-labels.json` are a calibration set, never judge inputs. The judge can disagree with a human even when it supplies an exact quote.

Set `CODEX_HOME="$HOME/.codex-t3-test"` and `CLAUDE_CONFIG_DIR="$HOME/.claude-t3-test"` on both the server and eval processes. The setup needs a Codex CLI with custom Responses providers, the native thread ID header and structured exec output. Budget for roughly a dozen Home turns and two short judge calls per day. Worker replay uses no model tokens. Run `--case bot-home-ten-tasks-live-workers` separately for one integration day with real Luna workers. Its result stays outside the bookkeeping pass count.

To add a request, extend `DAY_TASKS`, supply a project fixture and fixed outcome, and add positive and negative brief, question and recap examples to `homeDay.test.ts`. For a new open choice, specify its alternatives and check judge agreement on labeled briefs. Review and sanitize transcript excerpts before committing them.

## Output

`results.jsonl` records each sample’s outcome and, for ten-task days, its start. Finished rows include checks, answers, the thread's tool activity, the stored sources, and the ids. `summary.md` has the pass counts per case and how many samples ran a tool call that touched your home directory. Those samples are not fully synthetic; check what they read before trusting their score. The rows hold the Bot's full answers; read them before quoting any.
