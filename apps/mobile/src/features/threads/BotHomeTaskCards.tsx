import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  botConversationForThread,
  botTaskCardKey,
  hideBotTaskCard,
  homeBotTaskCards,
  showBotTaskCards,
} from "@t3tools/client-runtime/bots";
import type { BotId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { cn } from "../../lib/cn";
import { useEnvironmentQuery } from "../../state/query";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { BotTaskAction } from "../bots/BotTaskPresentation";
import { BotTaskRow } from "../bots/BotTaskRow";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

/** The newest tasks a Bot ran from this home conversation; nothing for other threads. */
export function BotHomeTaskCards(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const bots = useEnvironmentQuery(
    serverEnvironment.botsLive({ environmentId: props.environmentId, input: {} }),
  );
  const conversation = botConversationForThread(bots.data?.bots ?? [], props.threadId);
  if (conversation === null) return null;
  return (
    <HomeTaskCards
      environmentId={props.environmentId}
      threadId={props.threadId}
      botId={conversation.bot.id}
      projectId={conversation.context.projectId}
    />
  );
}

function HomeTaskCards(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly botId: BotId;
  readonly projectId: ProjectId;
}) {
  const openLinkedThread = useOpenLinkedThread();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const tasks = useEnvironmentQuery(
    serverEnvironment.botTasksLive({
      environmentId: props.environmentId,
      input: { botId: props.botId, projectId: props.projectId },
    }),
  );
  // Waiting for preferences keeps hidden cards from flashing in on launch.
  if (!AsyncResult.isSuccess(preferences)) return null;
  const loadedTasks = tasks.data?.tasks ?? [];
  const { visible, hiddenKeys } = homeBotTaskCards(
    props.environmentId,
    loadedTasks,
    props.threadId,
    preferences.value.hiddenBotTaskCards ?? [],
  );
  if (visible.length === 0 && hiddenKeys.length === 0) return null;
  return (
    <View className="mx-4 mb-2 rounded-2xl bg-subtle py-1">
      {visible.map((task, index) => (
        <BotTaskRow
          key={task.id}
          environmentId={props.environmentId}
          task={task}
          borderTop={index > 0}
          onOpen={(threadId) => openLinkedThread({ environmentId: props.environmentId, threadId })}
          onHide={
            botTaskCardKey(props.environmentId, task) === null
              ? undefined
              : () =>
                  updatePreferences({
                    transform: (current) => ({
                      hiddenBotTaskCards: hideBotTaskCard(
                        current.hiddenBotTaskCards ?? [],
                        props.environmentId,
                        task,
                        loadedTasks,
                      ),
                    }),
                  })
          }
        />
      ))}
      {hiddenKeys.length === 0 ? null : (
        <View className={cn("px-4", visible.length > 0 && "border-t border-border-subtle")}>
          <BotTaskAction
            label={`Show ${hiddenKeys.length} hidden`}
            icon="eye"
            tone="neutral"
            accessibilityLabel={`Show ${hiddenKeys.length} hidden finished ${hiddenKeys.length === 1 ? "task" : "tasks"}`}
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
    </View>
  );
}
