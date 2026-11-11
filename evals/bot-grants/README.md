# Bot grants

Checks that a Bot granted two accounts of one MCP service calls the account the user means. Each sample gives a fresh Bot two connections, "Mail (private)" and "Mail (work)". Both run `mailServer.ts`, a stdio fixture with the same tool and the same text, so the only thing telling them apart is the line T3 adds to each Bot turn that maps a connection's label to its Codex tool namespace (`grantedConnectionsInstructions` in `apps/server/src/mcpConnections/McpConnectionDelivery.ts`). The eval copies none of that text. The server sends it.

Turns run in the Bot's Home through a dev server's Codex login. Nothing is replayed.

## Run

1. Start an isolated dev server from the repo root: `T3CODE_CODEX_LAUNCH_ARGS="--disable memories" vp run dev --home-dir <scratch> --no-seed`.
2. From `evals/`, check the setup with one sample:

   ```sh
   pnpm bot-grants --base-dir <scratch> --out runs/check --case private-mail --samples 1
   ```

3. Then the full set: `pnpm bot-grants --base-dir <scratch> --out runs/<name>`.

Flags: `--model` (default `gpt-6.1-terra`), `--effort` (default `high`), `--samples` (default 3), `--concurrency` (default 2), `--case <id>` (repeatable), `--work <dir>` (default `<out>/work`). The run stops when the server's Codex catalog does not offer the model at that effort.

The connections and grants are written through the `mcpConnections.create` and `bots.setMcpGrants` RPCs, as Settings does, and each sample removes its connections afterwards.

## Cases

`private-mail` and `work-mail` name one account and pass when the fixtures record calls on that account and no other. Grades come from the fixtures' call records, never from the reply. A request that names no account has no case: reading both accounts is an acceptable answer to a read-only request.

To compare a change to the label line, run the same cases and model against a server on the old and new revision of `McpConnectionDelivery.ts`.

## Output

`results.jsonl` has one row per sample with its checks, the reply, the accounts called and the tool activity. `summary.md` has the pass counts per case. A run of nine samples costs nine Codex turns.
