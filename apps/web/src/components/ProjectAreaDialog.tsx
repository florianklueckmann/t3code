import { PROJECT_AREA_MAX_LENGTH } from "@t3tools/contracts";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { parseProjectAreaInput } from "@t3tools/client-runtime/state/project-areas";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type Request = {
  readonly projectName: string;
  readonly existingAreas: readonly string[];
  readonly resolve: (area: string | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks for a new area name; resolves null when the user cancels. */
export function requestNewProjectArea(input: {
  readonly projectName: string;
  readonly existingAreas: readonly string[];
}): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...input, resolve } }));
}

function finish(area: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(area);
}

export function ProjectAreaDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending area request promise with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? <ProjectAreaDialog request={request} /> : null;
}

function ProjectAreaDialog({ request }: { readonly request: Request }) {
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = parseProjectAreaInput(text, request.existingAreas);
            if (!parsed.ok) {
              setError(parsed.error);
              return;
            }
            finish(parsed.area);
          }}
        >
          <DialogHeader>
            <DialogTitle>New area</DialogTitle>
            <DialogDescription>Move {request.projectName} into a new area.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-area`}>Area name</Label>
              <Input
                id={`${id}-area`}
                autoFocus
                value={text}
                maxLength={PROJECT_AREA_MAX_LENGTH}
                placeholder="Work"
                onChange={(event) => {
                  setText(event.currentTarget.value);
                  setError(null);
                }}
              />
              {error ? (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">Move</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
