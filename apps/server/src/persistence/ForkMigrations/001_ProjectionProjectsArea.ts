import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Null means no area.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Databases that ran this as upstream-ledger migration 97 already have the column.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (columns.some((column) => column.name === "area")) return;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN area TEXT`;
});
