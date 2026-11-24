import { BotLearningNoticesResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as BotStore from "./BotStore.ts";

/** Older changes stay readable in the Bot settings; waiting proposals stay until decided. */
const HOME_LEARNING_NOTICE_LIMIT = 30;

const decodeResult = Schema.decodeUnknownEffect(BotLearningNoticesResult);

/**
 * The Bot's attached Homes, and by revision time, the Home most recently active then: where a
 * shared revision shows when the Home it was made in is not attached.
 */
export interface NoticeHomes {
  readonly attached: ReadonlySet<string>;
  readonly fallback: ReadonlyMap<string, string | null>;
}

/** A project's revision shows in that project's Home only; a shared one in one Home only. */
const showsIn = (row: BotStore.BotLearningRow, projectId: string, homes: NoticeHomes) =>
  row.project_id !== null
    ? row.project_id === projectId
    : (homes.attached.has(row.learned_in_project_id)
        ? row.learned_in_project_id
        : homes.fallback.get(row.created_at)) === projectId;

/**
 * A Home's learning notices, newest first, read from the committed revisions: when each was
 * recorded, adopted later and retired. Lessons from unfinished tasks never applied, so they have
 * none.
 */
export const forHome = Effect.fn("BotLearningNotices.forHome")(function* (
  rows: ReadonlyArray<BotStore.BotLearningRow>,
  projectId: string,
  homes: NoticeHomes,
  /** Entries with an open suggestion to apply them to all projects. */
  suggested: ReadonlySet<string>,
) {
  const byEntry = new Map<string, Array<BotStore.BotLearningRow>>();
  for (const row of rows) {
    const revisions = byEntry.get(row.entry_id);
    if (revisions === undefined) byEntry.set(row.entry_id, [row]);
    else revisions.push(row);
  }
  const notices: Array<{
    readonly at: string;
    readonly waiting: boolean;
    readonly notice: object;
  }> = [];
  for (const revisions of byEntry.values()) {
    const byRevision = new Map(revisions.map((row) => [row.revision, row]));
    const currentRevision = revisions.find((row) => row.status === "active")?.revision ?? null;
    for (const row of revisions) {
      if (row.status === "diagnostic" || !showsIn(row, projectId, homes)) continue;
      const base = row.base_revision === null ? undefined : byRevision.get(row.base_revision);
      const common = {
        entryId: row.entry_id,
        revision: row.revision,
        kind: row.kind,
        projectId: row.project_id,
        text: row.text,
        origin: row.origin,
        source: yield* BotStore.learningSourceOf(row),
        status: row.status,
        // Revisions stored before migration 019 lack activated_at; one that was in use applied.
        proposed:
          row.activated_at === null
            ? row.status !== "active" && row.status !== "superseded" && row.status !== "retired"
            : row.activated_at > row.created_at,
        currentRevision,
        ...(row.status === "active" && suggested.has(row.entry_id)
          ? { suggestedForAllProjects: true }
          : {}),
      };
      notices.push({
        at: row.created_at,
        waiting: row.status === "pending",
        notice: {
          ...common,
          change:
            row.restored_from !== null ? "restored" : row.revision === 1 ? "added" : "changed",
          at: row.created_at,
          ...(base !== undefined && (base.text !== row.text || base.project_id !== row.project_id)
            ? { previous: { revision: base.revision, text: base.text, projectId: base.project_id } }
            : {}),
          ...(row.restored_from === null ? {} : { restoredFrom: row.restored_from }),
        },
      });
      // A proposal adopted later, by the user or by its task completing.
      if (row.activated_at !== null && row.activated_at > row.created_at) {
        notices.push({
          at: row.activated_at,
          waiting: false,
          notice: { ...common, change: "adopted", at: row.activated_at },
        });
      }
      // Retired is final: nothing changes a retired revision again, so its time stays put.
      if (row.status === "retired" && row.decided_at !== null) {
        notices.push({
          at: row.decided_at,
          waiting: false,
          notice: { ...common, change: "retired", at: row.decided_at },
        });
      }
    }
  }
  notices.sort((a, b) => b.at.localeCompare(a.at));
  const kept = notices.filter(
    (candidate, index) => index < HOME_LEARNING_NOTICE_LIMIT || candidate.waiting,
  );
  return yield* decodeResult({ notices: kept.map((candidate) => candidate.notice) });
});
