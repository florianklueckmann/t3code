import type { BotCapabilities } from "@t3tools/contracts";

export const BOT_DRIVERS_MESSAGE = "Bots run on Codex and Claude providers only.";

/** The drivers a Bot, its tasks and every thread of its lineage may run on. */
export const BOT_DRIVERS: ReadonlyArray<string> = ["codex", "claudeAgent"];

export const isBotDriver = (driver: string | undefined): boolean =>
  botDriverSupport(driver).mcpIsolation;

/** Why a feature is unavailable on a Claude Bot; clients name Claude from it. "provider" otherwise. */
export const CLAUDE_UNSUPPORTED = "claude_unsupported";

export const unsupportedReason = (driver: string | undefined) =>
  driver === "claudeAgent" ? CLAUDE_UNSUPPORTED : "provider";

/**
 * What a driver can enforce for a Bot, before any platform or sign-in check. Claude keeps a Bot's
 * threads to T3 Code's own MCP server and its grants and seals No changes runs and the Home's
 * scoped turns, but has no sealed generation yet, and the user's own servers are Codex's.
 */
export function botDriverSupport(driver: string | undefined) {
  const codex = driver === "codex";
  const mcpIsolation = driver !== undefined && BOT_DRIVERS.includes(driver);
  return {
    mcpGrants: mcpIsolation,
    ownMcpServers: codex,
    /** No changes ("readOnly"): routines and failure diagnosis. */
    readOnlySeal: mcpIsolation,
    /** The Home's scoped turns ("t3BotOnly"): the Home check and maintenance's note refresh. */
    homeSeal: mcpIsolation,
    sealedGeneration: codex,
    /** Loads no MCP server but T3 Code's own and the Bot's grants. */
    mcpIsolation,
  };
}

/** The Bot's model's verdict per feature: null where available, else why not. */
export function botCapabilities(driver: string | undefined): BotCapabilities {
  const support = botDriverSupport(driver);
  const reason = (supported: boolean) => (supported ? null : unsupportedReason(driver));
  return {
    mcpGrants: reason(support.mcpGrants),
    ownMcpServers: reason(support.ownMcpServers),
    noChangesRoutines: reason(support.readOnlySeal),
    maintenance: reason(support.homeSeal && support.sealedGeneration),
    homeCheck: reason(support.homeSeal),
    failureDiagnosis: reason(support.readOnlySeal),
  };
}
