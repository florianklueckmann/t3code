import {
  isCompactionCommandMessage,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

export const botMaintenanceCompactionId = (home: string, sequence: number) =>
  `bot-maintenance:compact:${home}:${sequence}`;

/** Only the server authors `system` messages, so no client can send one of these. */
export function isBotMaintenanceCompaction(
  message: (Parameters<typeof isCompactionCommandMessage>[0] & { readonly id: string }) | undefined,
) {
  return (
    message !== undefined &&
    message.createdBy === "system" &&
    message.id.startsWith("bot-maintenance:compact:") &&
    isCompactionCommandMessage(message)
  );
}

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
