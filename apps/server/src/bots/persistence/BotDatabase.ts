import * as Context from "effect/Context";
import type * as SqlClient from "effect/sql/SqlClient";

export class BotDatabase extends Context.Service<BotDatabase, SqlClient.SqlClient>()(
  "t3/bots/persistence/BotDatabase",
) {}
