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
  /** The only account the Bot may call. */
  readonly expected: Account;
}

export const CASES: ReadonlyArray<GrantCase> = [
  { id: "private-mail", prompt: "Check my private mail. Anything new?", expected: "private" },
  { id: "work-mail", prompt: "Check my work mail. Anything new?", expected: "work" },
];
