import type { TerminalMetadataStreamEvent, TerminalSummary } from "@t3tools/contracts";

/**
 * The terminals TerminalManager reports, kept current from its metadata stream. Storage cleanup
 * and the Bot worktree release both ask it whether a terminal still works in a folder.
 */
export const makeLiveTerminals = () => {
  const byThread = new Map<string, Map<string, TerminalSummary>>();
  const note = (terminal: TerminalSummary) => {
    const threadTerminals = byThread.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    byThread.set(terminal.threadId, threadTerminals);
  };
  return {
    /** Feeds one event of `TerminalManager.subscribeMetadata`. */
    handle: (event: TerminalMetadataStreamEvent) => {
      if (event.type === "snapshot") {
        byThread.clear();
        for (const terminal of event.terminals) note(terminal);
      } else if (event.type === "upsert") {
        note(event.terminal);
      } else {
        const threadTerminals = byThread.get(event.threadId);
        threadTerminals?.delete(event.terminalId);
        if (threadTerminals?.size === 0) byThread.delete(event.threadId);
      }
    },
    /** Terminals whose shell has not exited. */
    running: (): ReadonlyArray<TerminalSummary> =>
      [...byThread.values()]
        .flatMap((entries) => [...entries.values()])
        .filter((terminal) => terminal.status === "starting" || terminal.status === "running"),
  };
};
