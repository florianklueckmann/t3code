import { botTaskResultMatchesThread } from "@t3tools/client-runtime/bots";
import { BotTaskId, type EnvironmentId, type ProjectId, type ThreadId } from "@t3tools/contracts";

import { Notice } from "../../components/ui/Notice";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatBotInstant } from "../settings/botRoutineDraft";
import { BotTaskResult, BotTaskResultLoading, BotTaskResultSheet } from "./BotTaskResultSheet";

export function BotTaskNotificationResult(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly taskId: string;
  readonly onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.botTaskResult({
      environmentId: props.environmentId,
      input: { taskId: BotTaskId.make(props.taskId) },
    }),
  );
  const task = query.data?.task;
  return (
    <BotTaskResultSheet onClose={props.onClose}>
      {task !== undefined && botTaskResultMatchesThread(task, props) ? (
        <BotTaskResult
          environmentId={props.environmentId}
          task={task}
          when={formatBotInstant(task.completedAt ?? task.createdAt)}
          onClose={props.onClose}
          onOpenThread={props.onClose}
        />
      ) : query.error !== null || query.isSuccess ? (
        <Notice
          icon="info.circle"
          message="This saved task result is unavailable in this thread."
        />
      ) : (
        <BotTaskResultLoading />
      )}
    </BotTaskResultSheet>
  );
}
