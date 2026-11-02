import { useAtomValue } from "@effect/atom-react";
import type { BotDetail, BotId, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { botDraftFromDetail, hasBotDraftChanges, type BotDraft } from "./botDraft";

type BotEditorSession = {
  readonly environmentId: EnvironmentId;
  readonly botId: BotId;
  /** Null for an existing Bot until the first edit; the form shows its loaded detail until then. */
  readonly baseline: BotDraft | null;
  readonly draft: BotDraft | null;
};

/** The draft lives in an atom, so it survives while the model picker route is on top. */
const botEditorSessionAtom = Atom.make<BotEditorSession | null>(null).pipe(Atom.keepAlive);

export function startNewBotEditor(environmentId: EnvironmentId, draft: BotDraft): void {
  appAtomRegistry.set(botEditorSessionAtom, {
    environmentId,
    botId: draft.botId,
    baseline: draft,
    draft,
  });
}

export function startBotEditor(environmentId: EnvironmentId, botId: BotId): void {
  appAtomRegistry.set(botEditorSessionAtom, { environmentId, botId, baseline: null, draft: null });
  // A cached detail can predate edits made elsewhere; the form waits for the refreshed one.
  appAtomRegistry.refresh(serverEnvironment.botDetail({ environmentId, input: { botId } }));
}

/**
 * Keeps an untouched form on the detail it shows while that detail reloads, as it does after a
 * learning change; the form otherwise waits for the reload and loses its scroll position.
 */
export function pinBotEditorDraft(shown: BotDetail): void {
  const current = appAtomRegistry.get(botEditorSessionAtom);
  if (!current || current.draft !== null || current.botId !== shown.id) return;
  const draft = botDraftFromDetail(shown);
  appAtomRegistry.set(botEditorSessionAtom, {
    ...current,
    baseline: current.baseline ?? draft,
    draft,
  });
}

export function useBotEditor() {
  const session = useAtomValue(botEditorSessionAtom);
  const detail = useEnvironmentQuery(
    session && session.draft === null
      ? serverEnvironment.botDetail({
          environmentId: session.environmentId,
          input: { botId: session.botId },
        })
      : null,
  );
  const loaded = detail.successResult ? botDraftFromDetail(detail.successResult.value) : null;
  const baseline = session?.baseline ?? loaded;
  const draft = session?.draft ?? loaded;
  const setDraft = (update: (current: BotDraft) => BotDraft) => {
    const current = appAtomRegistry.get(botEditorSessionAtom);
    if (!current) return;
    const base = current.baseline ?? loaded;
    const previous = current.draft ?? loaded;
    if (!base || !previous) return;
    appAtomRegistry.set(botEditorSessionAtom, {
      ...current,
      baseline: base,
      draft: update(previous),
    });
  };
  /** The server's state after a successful save step, which later steps and retries diff against. */
  const setBaseline = (next: BotDraft) => {
    const current = appAtomRegistry.get(botEditorSessionAtom);
    if (!current) return;
    appAtomRegistry.set(botEditorSessionAtom, {
      ...current,
      baseline: next,
      draft: current.draft ? { ...current.draft, created: true } : next,
    });
  };
  return {
    environmentId: session?.environmentId ?? null,
    botId: session?.botId ?? null,
    baseline,
    draft,
    loadError: draft === null ? detail.error : null,
    hasChanges: baseline !== null && draft !== null && hasBotDraftChanges(baseline, draft),
    setDraft,
    setBaseline,
  };
}
