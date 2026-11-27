import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // 'bot': the Bot-level Home in the Bot's hidden project, which no attached-project query counts.
  yield* sql`ALTER TABLE bot_project_contexts
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project', 'bot'))`;
  yield* sql`CREATE UNIQUE INDEX idx_bot_project_contexts_one_home
    ON bot_project_contexts(bot_id) WHERE kind = 'bot'`;
  yield* sql`ALTER TABLE bots
    ADD COLUMN home_access TEXT NOT NULL DEFAULT 'read' CHECK (home_access IN ('read', 'full'))`;
});
