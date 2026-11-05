import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

export function isDirectHomeInput(message: OrchestrationV2ConversationMessage | undefined) {
  return (
    message !== undefined &&
    message.role === "user" &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined &&
    message.senderThreadId === undefined &&
    message.scheduledTaskId === undefined &&
    ((message.createdBy === "user" &&
      (message.creationSource === "web" || message.creationSource === "mobile")) ||
      (message.createdBy === "agent" && message.creationSource === "mcp"))
  );
}

export function latestDirectHomeInput(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
) {
  const direct = new Map(
    projection.messages.filter(isDirectHomeInput).map((message) => [message.id, message]),
  );
  const item = projection.turnItems
    .filter((item) => item.type === "user_message" && direct.has(item.messageId))
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  return item?.type === "user_message" ? direct.get(item.messageId) : undefined;
}
