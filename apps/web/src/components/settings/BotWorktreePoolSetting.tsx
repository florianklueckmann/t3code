import { useAtomValue } from "@effect/atom-react";
import { BOT_WORKTREE_POOL_DESCRIPTION, botWorktreePoolLabel } from "@t3tools/client-runtime/bots";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** One project's Bot task worktrees: their disk use, and a way to remove the free ones. */
export function BotWorktreePoolSetting({
  environmentId,
  projectId,
  title,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.botWorktreePool({ environmentId, input: { projectId } }),
  );
  const clear = useAtomCommand(serverEnvironment.clearBotWorktreePool, {
    label: "bot worktree pool clear",
  });
  const canClear = useAtomValue(
    serverEnvironment.clearBotWorktreePool.permissionAtom(environmentId),
  );
  const [clearing, setClearing] = useState(false);
  const pool = query.data;
  // Null without a pending read: this server keeps no worktrees for Bot tasks.
  if (pool === null && !query.isPending) return null;
  const labelId = `bot-worktree-pool-${projectId}`;

  const clearPool = async () => {
    setClearing(true);
    const result = await clear({ environmentId, input: { projectId } });
    setClearing(false);
    query.refresh();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not clear the worktrees",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <Label id={labelId}>{`${title} · Task worktrees`}</Label>
        <p className="text-xs text-muted-foreground">{BOT_WORKTREE_POOL_DESCRIPTION}</p>
        <p className="text-xs text-muted-foreground">
          {pool === null ? "Measuring…" : botWorktreePoolLabel(pool)}
        </p>
      </div>
      <Button
        size="xs"
        variant="outline"
        aria-describedby={labelId}
        disabled={clearing || !canClear || pool === null || pool.parked === 0}
        onClick={() => void clearPool()}
      >
        Clear free worktrees
      </Button>
    </div>
  );
}
