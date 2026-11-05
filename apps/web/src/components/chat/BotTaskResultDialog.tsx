import { BOT_TASK_RESULT_UNSUPPORTED, botTaskResultNotice } from "@t3tools/client-runtime/bots";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BotTaskSummary, EnvironmentId } from "@t3tools/contracts";
import { FileTextIcon, InfoIcon, MessageSquareIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import ChatMarkdown from "../ChatMarkdown";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
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
  DialogClose,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { BotTaskStatusBadge } from "./BotTaskStatusBadge";

export function BotTaskResultDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly task: BotTaskSummary;
  readonly when: string;
  readonly onOpenThread: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const onOpenThread = props.onOpenThread;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="xs" variant="outline" aria-label={`View result for ${props.task.title}`} />
        }
      >
        <FileTextIcon aria-hidden />
        View result
      </DialogTrigger>
      <DialogPopup className="max-h-[min(48rem,85dvh)] sm:max-w-3xl">
        {open ? (
          <BotTaskResultContent
            environmentId={props.environmentId}
            task={props.task}
            when={props.when}
          />
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
          {onOpenThread === null ? null : (
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                onOpenThread();
              }}
            >
              <MessageSquareIcon aria-hidden />
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
  readonly when: string;
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
    <>
      <DialogHeader>
        <DialogTitle>{props.task.title}</DialogTitle>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <BotTaskStatusBadge status={data?.task.status ?? props.task.status} />
          <DialogDescription>Final response of this run · {props.when}</DialogDescription>
        </div>
      </DialogHeader>
      <DialogPanel>
        {data?.task.detail ? (
          <p className="text-sm text-muted-foreground wrap-anywhere">{data.task.detail}</p>
        ) : null}
        {query.error !== null ? (
          <Alert variant="error">
            <TriangleAlertIcon aria-hidden />
            <AlertTitle>Could not load the result</AlertTitle>
            <AlertDescription>{query.error}</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={query.refresh}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : data === null ? (
          query.isSuccess ? (
            <ResultNotice text={BOT_TASK_RESULT_UNSUPPORTED} />
          ) : (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" aria-hidden />
              Loading saved result…
            </p>
          )
        ) : data.result.state !== "available" ? (
          <ResultNotice text={botTaskResultNotice(data)} />
        ) : (
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
        )}
      </DialogPanel>
    </>
  );
}

function ResultNotice(props: { readonly text: string | null }) {
  return (
    <Alert role="status">
      <InfoIcon aria-hidden />
      <AlertDescription>{props.text}</AlertDescription>
    </Alert>
  );
}
