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

Flags: `--model` (default `gpt-6.1-terra`), `--effort` (default `high`), `--samples` (default 3), `--concurrency` (default 2), `--case <id>` (repeatable), `--work <dir>` for the synthetic project folders (default `<out>/work`).

The run stops before any turn when the server's Codex catalog does not offer the model with that `reasoningEffort`; it never falls back to another model. Each row records the model the home conversation actually ran on.

The script signs in as a short-lived MCP client of the server, as `t3 thread` does, and revokes that session when it ends. Each sample creates its own synthetic projects and Bots, so samples do not share conversation history. A sample that does not finish, for example on a rate limit or a pending approval, is kept in `results.jsonl` with its `error` and counts as a failure.

To compare a Bot context change, run the same cases with the same model and effort against a server on the old revision of `apps/server/src/bots/BotTurnContext.ts` and `apps/server/src/mcp/toolkits/bot/tools.ts`, then against the new one. The dev server restarts by itself when those files change.

## Cases

`cases.ts` holds one synthetic world and the cases that run in it. Two projects are both titled "Faerun", one Bot is attached to both, and a second Bot with the same name is attached to the first, so only ids tell them apart. A case checks the Bot's answers with case-insensitive regexes, the `t3_bot` update calls it made, and the sources the server stored afterwards for every Bot and project. It also checks the learning the Bot recorded (a case without `learningAfter` expects none). A `seed` records learning through the eval's own MCP session before the turns, so the conversation never sees it; `adoptSeedFirst` adopts it before a turn, as the user would in settings.

Add a case to `CASES`. Run it against the old context, where a `bad` case should fail, and against the new one.

## Output

`results.jsonl` has one row per sample: checks, answers, the thread's tool activity, the stored sources, and the ids. `summary.md` has the pass counts per case and how many samples ran a tool call that touched your home directory. Those samples are not fully synthetic; check what they read before trusting their score. The rows hold the Bot's full answers; read them before quoting any.
