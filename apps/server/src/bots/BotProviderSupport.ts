import type { BotCapabilities } from "@t3tools/contracts";

export const BOT_DRIVERS_MESSAGE = "Bots run on Codex, Claude and Pi providers only.";

/** The drivers a Bot, its tasks and every thread of its lineage may run on. */
export const BOT_DRIVERS: ReadonlyArray<string> = ["codex", "claudeAgent", "pi"];

export const isBotDriver = (driver: string | undefined): boolean =>
  botDriverSupport(driver).mcpIsolation;

/** Why a feature is unavailable on a Claude or Pi Bot; clients name the provider from it. */
export const CLAUDE_UNSUPPORTED = "claude_unsupported";
export const PI_UNSUPPORTED = "pi_unsupported";

export const unsupportedReason = (driver: string | undefined) =>
  driver === "claudeAgent" ? CLAUDE_UNSUPPORTED : driver === "pi" ? PI_UNSUPPORTED : "provider";

/**
 * What a driver can enforce for a Bot, before any platform or sign-in check. Every Bot driver keeps
 * a Bot's threads to T3 Code's own MCP server and its grants. Claude also seals No changes runs and
 * the Home's scoped turns and generates sealed; Pi does none of that. The user's own servers are Codex's.
 */
export function botDriverSupport(driver: string | undefined) {
  const codex = driver === "codex";
  const mcpIsolation = driver !== undefined && BOT_DRIVERS.includes(driver);
  const seals = codex || driver === "claudeAgent";
  return {
    mcpGrants: mcpIsolation,
    ownMcpServers: codex,
    /** No changes ("readOnly"): routines and failure diagnosis. */
    readOnlySeal: seals,
    /** The Home's scoped turns ("t3BotOnly"): the Home check and maintenance's note refresh. */
    homeSeal: seals,
    /** Maintenance's learning step, and with the Home seal its deliberate compaction. */
    sealedGeneration: seals,
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
