import { useAtomValue } from "@effect/atom-react";
import {
  BOT_WORKTREE_POOL_DESCRIPTION,
  botWorktreePoolKeptLabel,
  botWorktreePoolLabel,
} from "@t3tools/client-runtime/bots";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportBotFailure } from "../bots/reportBotFailure";
import { SettingsSection } from "./components/SettingsSection";

/** One project's Bot task worktrees: their disk use, and a way to remove the free ones. */
export function BotWorktreePoolSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
}) {
  const { environmentId, projectId } = props;
  const query = useEnvironmentQuery(
    serverEnvironment.botWorktreePool({ environmentId, input: { projectId } }),
  );
  // Failures surface in this section's own alert.
  const clear = useAtomCommand(serverEnvironment.clearBotWorktreePool, { reportFailure: false });
  const canClear = useAtomValue(
    serverEnvironment.clearBotWorktreePool.permissionAtom(environmentId),
  );
  const [clearing, setClearing] = useState(false);
  const pool = query.data;
  // Null without a pending read: this server keeps no worktrees for Bot tasks.
  if (pool === null && !query.isPending) return null;
  // A kept worktree may be clean again, and Clear checks it.
  const clearDisabled =
    clearing || !canClear || pool === null || pool.parked + (pool.kept ?? 0) === 0;
  const keptLabel = pool === null ? null : botWorktreePoolKeptLabel(pool);

  const clearPool = async () => {
    setClearing(true);
    const result = await clear({ environmentId, input: { projectId } });
    setClearing(false);
    query.refresh();
    if (result._tag === "Failure") reportBotFailure("Could not clear the worktrees", result);
  };

  return (
    <SettingsSection title={props.title}>
      <View className="min-h-14 gap-1 px-4 py-3">
        <Text textRole="body" className="text-foreground">
          Task worktrees
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {BOT_WORKTREE_POOL_DESCRIPTION}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {pool === null ? "Measuring…" : botWorktreePoolLabel(pool)}
        </Text>
        {keptLabel === null ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {keptLabel}
          </Text>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: clearDisabled, busy: clearing }}
        disabled={clearDisabled}
        onPress={() => void clearPool()}
        className="min-h-14 justify-center border-t border-border-subtle px-4 py-3 active:opacity-70 disabled:opacity-50"
      >
        <Text textRole="body" className="text-foreground">
          {clearing ? "Clearing…" : "Clear free worktrees"}
        </Text>
      </Pressable>
    </SettingsSection>
  );
}
