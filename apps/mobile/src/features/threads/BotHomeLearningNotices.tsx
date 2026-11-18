import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  botConversationForThread,
  botLearningNoticeEntryState,
  botLearningNoticeGroupSummary,
  botLearningNoticeScopeLabel,
  botLearningNoticeTitle,
  type BotLearningNoticeGroup,
  hideBotHomeCard,
  homeBotLearningNoticeGroups,
  showBotTaskCards,
} from "@t3tools/client-runtime/bots";
import type {
  BotId,
  BotLearningNotice,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotTaskAction } from "../bots/BotTaskPresentation";
import { reportBotFailure } from "../bots/reportBotFailure";
import { formatBotInstant } from "../settings/botRoutineDraft";

/** A group shows this many notices until expanded; waiting proposals always show. */
const COLLAPSED_NOTICES = 2;

interface HomeScope {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
}

/** What a Bot kept for later from this Home; nothing for other threads. */
export function BotHomeLearningNotices(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const bots = useEnvironmentQuery(
    serverEnvironment.botsLive({ environmentId: props.environmentId, input: {} }),
  );
  const conversation = botConversationForThread(bots.data?.bots ?? [], props.threadId);
  if (conversation === null) return null;
  return (
    <HomeLearningNotices
      key={`${conversation.bot.id}:${conversation.context.projectId}`}
      environmentId={props.environmentId}
      botId={conversation.bot.id}
      projectId={conversation.context.projectId}
    />
  );
}

function HomeLearningNotices(scope: HomeScope) {
  const navigation = useNavigation();
  const { height: windowHeight } = useWindowDimensions();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [unfolded, setUnfolded] = useState(false);
  const notices = useEnvironmentQuery(
    serverEnvironment.botLearningNoticesLive({
      environmentId: scope.environmentId,
      input: { botId: scope.botId, projectId: scope.projectId },
    }),
  );
  // Waiting for preferences keeps hidden groups from flashing in on launch.
  if (!AsyncResult.isSuccess(preferences)) return null;
  const { visible, hiddenKeys, folded, showGroupSummaries } = homeBotLearningNoticeGroups(
    scope,
    notices.data?.notices ?? [],
    preferences.value.hiddenBotTaskCards ?? [],
  );
  if (visible.length === 0 && hiddenKeys.length === 0) return null;
  const open = (notice: BotLearningNotice) =>
    navigation.navigate("BotLearningEntry", {
      environmentId: scope.environmentId,
      botId: scope.botId,
      projectId: scope.projectId,
      entryId: notice.entryId,
      revision: notice.revision,
    });
  return (
    // Capped so expanded groups never push the conversation off screen.
    <ScrollView
      nestedScrollEnabled
      className="mx-4 mb-2 grow-0 rounded-2xl bg-subtle"
      contentContainerClassName="py-1"
      style={{ maxHeight: Math.round(windowHeight * 0.4) }}
    >
      {folded === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: unfolded }}
          accessibilityLabel={`Memory: ${folded}`}
          onPress={() => setUnfolded((current) => !current)}
          className="min-h-11 flex-row items-center gap-1.5 px-4 active:opacity-70"
        >
          <SymbolView name="brain" size={13} tintColorClassName="accent-foreground-muted" />
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
            {`Memory · ${folded} · ${formatBotInstant(visible[0]!.notices[0]!.at)}`}
          </Text>
          <SymbolView
            name={unfolded ? "chevron.down" : "chevron.right"}
            size={13}
            tintColorClassName="accent-foreground-muted"
          />
        </Pressable>
      )}
      {(folded !== null && !unfolded ? [] : visible).map((group, index) => (
        <NoticeGroup
          key={group.key}
          scope={scope}
          group={group}
          borderTop={index > 0 || folded !== null}
          unfolded={folded !== null}
          showSummary={showGroupSummaries}
          onOpen={open}
          onHide={() =>
            updatePreferences({
              transform: (current) => ({
                hiddenBotTaskCards: hideBotHomeCard(current.hiddenBotTaskCards ?? [], group.key),
              }),
            })
          }
        />
      ))}
      {hiddenKeys.length === 0 || (folded !== null && !unfolded) ? null : (
        <View className={cn("px-4", visible.length > 0 && "border-t border-border-subtle")}>
          <BotTaskAction
            label={`Show ${hiddenKeys.length} hidden`}
            icon="eye"
            tone="neutral"
            accessibilityLabel={`Show ${hiddenKeys.length} hidden memory ${hiddenKeys.length === 1 ? "change" : "changes"}`}
            onPress={() =>
              updatePreferences({
                transform: (current) => ({
                  hiddenBotTaskCards: showBotTaskCards(
                    current.hiddenBotTaskCards ?? [],
                    hiddenKeys,
                  ),
                }),
              })
            }
          />
        </View>
      )}
    </ScrollView>
  );
}

function NoticeGroup(props: {
  readonly scope: HomeScope;
  readonly group: BotLearningNoticeGroup;
  readonly borderTop: boolean;
  /** Opened from the folded summary, which already counted every notice. */
  readonly unfolded: boolean;
  readonly showSummary: boolean;
  readonly onOpen: (notice: BotLearningNotice) => void;
  readonly onHide: () => void;
}) {
  const { group } = props;
  const [expanded, setExpanded] = useState(props.unfolded);
  const shown = expanded
    ? group.notices
    : group.notices.filter(
        (notice, index) => index < COLLAPSED_NOTICES || notice.status === "pending",
      );
  const more = group.notices.length - shown.length;
  return (
    <View
      className={cn("gap-1 px-4 pt-3 pb-1", props.borderTop && "border-t border-border-subtle")}
    >
      {props.showSummary ? (
        <View className="flex-row items-center gap-1.5">
          <SymbolView name="brain" size={13} tintColorClassName="accent-foreground-muted" />
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={2}>
            {`Memory · ${botLearningNoticeGroupSummary(group)} · ${formatBotInstant(group.notices[0]!.at)}`}
          </Text>
        </View>
      ) : null}
      {shown.map((notice) => (
        <NoticeRow
          key={`${notice.entryId}:${notice.revision}:${notice.change}`}
          scope={props.scope}
          notice={notice}
          onOpen={() => props.onOpen(notice)}
        />
      ))}
      {more === 0 && group.waiting > 0 ? null : (
        <View className="flex-row flex-wrap items-center gap-x-5">
          {more === 0 ? null : (
            <BotTaskAction
              label={`Show ${more} more`}
              icon="chevron.right"
              tone="neutral"
              accessibilityLabel={`Show ${more} more memory changes`}
              onPress={() => setExpanded(true)}
            />
          )}
          {group.waiting > 0 ? null : (
            <BotTaskAction
              label="Hide"
              icon="eye.slash"
              tone="neutral"
              accessibilityLabel="Hide these memory changes from Home"
              onPress={props.onHide}
            />
          )}
        </View>
      )}
    </View>
  );
}

function NoticeRow(props: {
  readonly scope: HomeScope;
  readonly notice: BotLearningNotice;
  readonly onOpen: () => void;
}) {
  const { notice, scope } = props;
  const canDecide = useAtomValue(
    serverEnvironment.decideBotLearning.permissionAtom(scope.environmentId),
  );
  const decide = useAtomCommand(serverEnvironment.decideBotLearning, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const waiting = notice.status === "pending" && notice.change !== "retired";
  const state = botLearningNoticeEntryState(notice);
  const previous = notice.previous;
  const settle = async (decision: "adopt" | "reject") => {
    setBusy(true);
    const result = await decide({
      environmentId: scope.environmentId,
      input: { botId: scope.botId, entryId: notice.entryId, revision: notice.revision, decision },
    });
    setBusy(false);
    reportBotFailure(
      decision === "adopt" ? "Could not adopt the lesson" : "Could not reject the lesson",
      result,
    );
  };
  return (
    <View className="gap-0.5 pt-1.5">
      <Text className="text-xs text-foreground-muted" numberOfLines={2}>
        <Text className="font-t3-semibold text-foreground">{botLearningNoticeTitle(notice)}</Text>
        {` · ${botLearningNoticeScopeLabel(notice)}`}
        {state === null ? "" : ` · ${state}`}
      </Text>
      <Text className="text-sm text-foreground" numberOfLines={3}>
        {notice.text}
      </Text>
      {previous === undefined ? null : previous.text !== notice.text ? (
        <Text
          className="text-xs text-foreground-muted line-through"
          numberOfLines={2}
          accessibilityLabel={`Was: ${previous.text}`}
        >
          {previous.text}
        </Text>
      ) : (
        <Text className="text-xs text-foreground-muted">
          {notice.projectId === null
            ? "Now applies to all projects"
            : "Now applies to this project only"}
        </Text>
      )}
      <View className="flex-row flex-wrap items-center gap-x-5">
        {waiting ? (
          <>
            <BotTaskAction
              label="Adopt"
              icon="checkmark"
              tone="primary"
              accessibilityLabel={`Adopt ${notice.text}`}
              disabled={!canDecide || busy}
              onPress={() => void settle("adopt")}
            />
            <BotTaskAction
              label="Reject"
              icon="xmark"
              tone="neutral"
              accessibilityLabel={`Reject ${notice.text}`}
              disabled={!canDecide || busy}
              onPress={() => void settle("reject")}
            />
          </>
        ) : null}
        <BotTaskAction
          label="Open"
          icon="arrow.up.right"
          tone="neutral"
          accessibilityLabel={`Open the lesson ${notice.text}`}
          onPress={props.onOpen}
        />
      </View>
    </View>
  );
}
