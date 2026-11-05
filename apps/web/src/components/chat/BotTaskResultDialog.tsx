import {
  BOT_TASK_RESULT_UNSUPPORTED,
  BOT_TASK_STATUS_LABELS,
  botTaskResultNotice,
} from "@t3tools/client-runtime/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BotTaskSummary, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function BotTaskResultDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly task: BotTaskSummary;
  readonly onOpenThread: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>View result</DialogTrigger>
      <DialogPopup className="flex min-h-0 flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{props.task.title}</DialogTitle>
          <DialogDescription>Final response from the completed run.</DialogDescription>
        </DialogHeader>
        {open ? (
          <BotTaskResultContent environmentId={props.environmentId} task={props.task} />
        ) : null}
        <DialogFooter>
          {props.task.workThreadId === null ? null : (
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                props.onOpenThread();
              }}
            >
              Open thread
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function BotTaskResultContent(props: {
  readonly environmentId: EnvironmentId;
  readonly task: BotTaskSummary;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.botTaskResult({
      environmentId: props.environmentId,
      input: { taskId: props.task.id },
    }),
  );
  const project = useProject({
    environmentId: props.environmentId,
    projectId: props.task.projectId,
  });
  const data = query.data;
  return (
    <DialogPanel>
      <p className="text-sm font-medium">
        {BOT_TASK_STATUS_LABELS[data?.task.status ?? props.task.status]}
      </p>
      {query.error !== null ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{query.error}</p>
          <Button size="sm" variant="outline" onClick={query.refresh}>
            Retry
          </Button>
        </div>
      ) : data === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {query.isSuccess ? BOT_TASK_RESULT_UNSUPPORTED : "Loading saved result…"}
        </p>
      ) : (
        <>
          {data.task.detail === null ? null : (
            <p className="text-sm text-muted-foreground">{data.task.detail}</p>
          )}
          {data.result.state === "available" ? (
            <ChatMarkdown
              text={data.result.text}
              cwd={project?.workspaceRoot}
              environmentId={props.environmentId}
              threadRef={
                data.task.workThreadId === null
                  ? undefined
                  : scopeThreadRef(props.environmentId, data.task.workThreadId)
              }
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {botTaskResultNotice(data)}
            </p>
          )}
        </>
      )}
    </DialogPanel>
  );
}
