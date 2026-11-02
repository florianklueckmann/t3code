import { botConversationForThread } from "@t3tools/client-runtime/bots";
import type { BotId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { BotTaskRow } from "../bots/BotTaskRow";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

const CARDS_SHOWN = 3;

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
  const tasks = useEnvironmentQuery(
    serverEnvironment.botTasksLive({
      environmentId: props.environmentId,
      input: { botId: props.botId, projectId: props.projectId },
    }),
  );
  const cards = (tasks.data?.tasks ?? [])
    .filter((task) => task.homeThreadId === props.threadId)
    .slice(0, CARDS_SHOWN);
  if (cards.length === 0) return null;
  return (
    <View className="mx-4 mb-2 rounded-2xl bg-subtle py-1">
      {cards.map((task, index) => (
        <BotTaskRow
          key={task.id}
          environmentId={props.environmentId}
          task={task}
          borderTop={index > 0}
          onOpen={(threadId) => openLinkedThread({ environmentId: props.environmentId, threadId })}
        />
      ))}
    </View>
  );
}
