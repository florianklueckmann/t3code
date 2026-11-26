import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import ProjectionProjectsArea from "./097_ProjectionProjectsArea.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("097_ProjectionProjectsArea", (it) => {
  it.effect("adds a nullable area that existing projects read as no area, and reruns safely", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 96 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-1', 'Project', '/tmp/project', '[]',
          '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 97 });
      yield* ProjectionProjectsArea;
      const rows = yield* sql<{ readonly area: string | null }>`
        SELECT area FROM projection_projects
      `;
      assert.deepStrictEqual(rows, [{ area: null }]);
    }),
  );
});
