import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Receipts name the run that consumed them, so they outlive pruned run summaries.
  yield* sql`ALTER TABLE bot_maintenance_sources ADD COLUMN run_id TEXT`;
  yield* sql`ALTER TABLE bot_maintenance_sources ADD COLUMN digest TEXT`;
  yield* sql`ALTER TABLE bot_maintenance_sources ADD COLUMN exclusion_reason TEXT`;
  yield* sql`ALTER TABLE bot_maintenance_runs ADD COLUMN outcome_json TEXT`;
});
