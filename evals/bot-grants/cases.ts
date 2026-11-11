/**
 * Two granted accounts of one synthetic mail service. Source: T3B-13, granting MCP connections to
 * Bots; the native namespace names no account, so only T3's per-turn label line tells them apart.
 */
export const ACCOUNTS = [
  { account: "private", label: "Mail (private)" },
  { account: "work", label: "Mail (work)" },
] as const;

export type Account = (typeof ACCOUNTS)[number]["account"];

export interface GrantCase {
  readonly id: string;
  readonly prompt: string;
  /** The only account the Bot may call; null means it calls neither. */
  readonly expected: Account | null;
}

export const CASES: ReadonlyArray<GrantCase> = [
  { id: "private-mail", prompt: "Check my private mail. Anything new?", expected: "private" },
  { id: "work-mail", prompt: "Check my work mail. Anything new?", expected: "work" },
  // Control: the request names no account, so the Bot asks which one instead of picking.
  { id: "unnamed-account", prompt: "Check my mail. Anything new?", expected: null },
];
