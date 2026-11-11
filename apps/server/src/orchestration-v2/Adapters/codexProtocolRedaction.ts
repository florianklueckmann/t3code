const REDACTED = "[REDACTED]";
const OMITTED_CONFIG = "[OMITTED: unparseable config]";
const OMITTED_VALUE = "[OMITTED: protocol value]";

function configKeySegments(key: string): ReadonlyArray<string> | undefined {
  const segments: Array<string> = [];
  let segment = "";
  let quote: string | undefined;
  const appendSegment = () => {
    const trimmed = segment.trim();
    if (trimmed === "") return false;
    if (trimmed.startsWith('"')) {
      try {
        const decoded: unknown = JSON.parse(trimmed);
        if (typeof decoded !== "string") return false;
        segments.push(decoded);
      } catch {
        return false;
      }
    } else if (trimmed.startsWith("'")) {
      if (!trimmed.endsWith("'")) return false;
      segments.push(trimmed.slice(1, -1));
    } else {
      if (/["']/.test(trimmed)) return false;
      segments.push(trimmed);
    }
    segment = "";
    return true;
  };
  for (let index = 0; index < key.length; index += 1) {
    const char = key[index];
    if (quote !== undefined) {
      segment += char;
      if (char === "\\" && quote === '"') {
        index += 1;
        if (index === key.length) return undefined;
        segment += key[index];
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      segment += char;
      quote = char;
    } else if (char === ".") {
      if (!appendSegment()) return undefined;
    } else {
      segment += char;
    }
  }
  if (quote !== undefined || !appendSegment()) return undefined;
  return segments;
}

function isSensitiveKey(key: string, oauth: boolean): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized.endsWith("authorization") ||
    normalized.endsWith("authorizationurl") ||
    normalized.endsWith("authorizationuri") ||
    normalized.endsWith("authorizationcode") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret") ||
    (oauth && ["code", "devicecode", "usercode", "codeverifier"].includes(normalized))
  );
}

// The structural role of a value. Frame keys are literal; config, server and OAuth table keys
// are dotted paths; server names and header names are literal identifiers, never fields.
type Role =
  | "frame"
  | "configTable"
  | "config"
  | "servers"
  | "server"
  | "references"
  | "reference"
  | "oauth"
  | "secret";

interface Position {
  readonly role: Role;
  readonly oauth: boolean;
}

const TABLE_ROLES: ReadonlySet<Role> = new Set([
  "configTable",
  "servers",
  "server",
  "references",
  "oauth",
]);

function enter({ role, oauth }: Position, segment: string): Position {
  switch (role) {
    case "secret":
    case "reference":
      return { role: "secret", oauth };
    case "servers":
      return { role: "server", oauth };
    case "references":
      return { role: "reference", oauth };
    case "frame":
      if (segment === "config") return { role: "configTable", oauth };
      break;
    case "server":
      if (segment === "env_http_headers") return { role: "references", oauth };
      if (segment === "bearer_token_env_var") return { role: "reference", oauth };
      break;
    case "configTable":
    case "config":
    case "oauth":
      break;
    default: {
      const exhaustive: never = role;
      return exhaustive;
    }
  }
  if (segment === "oauth") return { role: "oauth", oauth: true };
  // An unquoted dotted server name can push a server's own fields deeper into its config, so
  // these container names stay secret anywhere in config.
  if (
    isSensitiveKey(segment, oauth) ||
    (role !== "frame" && (segment === "env" || segment === "http_headers"))
  ) {
    return { role: "secret", oauth };
  }
  if (role !== "frame" && segment === "mcp_servers") return { role: "servers", oauth };
  return { role: role === "frame" ? "frame" : "config", oauth };
}

function enterKey(position: Position, key: string): Position | undefined {
  switch (position.role) {
    case "frame":
      return key === "mcp_servers" || key.startsWith("mcp_servers.")
        ? configKeySegments(key)?.reduce(enter, { ...position, role: "configTable" })
        : enter(position, key);
    case "servers": {
      // A dotted server name may also be meant as a path. That reading can make the server
      // secret or OAuth-sensitive, but it never grants a reference exemption.
      const server = enter(position, key);
      const path = configKeySegments(key)?.reduce(enter, position);
      if (path?.role === "secret") return path;
      return { ...server, oauth: server.oauth || path?.oauth === true };
    }
    case "references":
    case "reference":
    case "secret":
      return enter(position, key);
    case "configTable":
    case "config":
    case "server":
    case "oauth":
      return configKeySegments(key)?.reduce(enter, position);
    default: {
      const exhaustive: never = position.role;
      return exhaustive;
    }
  }
}

export function redactCodexProtocolValue(value: unknown): unknown {
  const ancestors = new WeakSet<object>();
  const redact = (value: unknown, at: Position, depth: number): unknown => {
    // Redaction precedes the logger's bounds, so guard cycles and depth here too.
    if (depth > 64) return OMITTED_VALUE;
    // Only a string names an environment variable; anything else in a reference slot is secret.
    const position: Position =
      at.role === "reference" && typeof value !== "string" ? { ...at, role: "secret" } : at;
    if (typeof value === "string") {
      if (/^Bearer\s+/i.test(value)) return REDACTED;
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const decoded: unknown = JSON.parse(trimmed);
          return JSON.stringify(redact(decoded, position, depth + 1));
        } catch {
          if (position.role === "secret") return REDACTED;
          if (
            position.role !== "frame" ||
            /^\[\s*mcp_servers(?:\.|\])/.test(trimmed) ||
            /"(?:config|mcp_servers[^"\n]*|oauth|authorizationUrl|client_secret|access_token|refresh_token)"\s*:/.test(
              trimmed,
            )
          ) {
            return OMITTED_CONFIG;
          }
        }
      }
      if (position.role === "secret") return REDACTED;
      return TABLE_ROLES.has(position.role) ? OMITTED_CONFIG : value;
    }
    if (
      (position.role === "oauth" || position.role === "references") &&
      (value === null || typeof value !== "object" || Array.isArray(value))
    ) {
      return OMITTED_CONFIG;
    }
    if (value === null || typeof value !== "object") {
      return position.role === "secret" ? REDACTED : value;
    }
    if (ancestors.has(value)) return OMITTED_VALUE;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        // Malformed table wrappers cannot supply trusted reference positions.
        const elementPosition: Position = TABLE_ROLES.has(position.role)
          ? { ...position, role: "secret" }
          : position;
        return value.map((nested) => redact(nested, elementPosition, depth + 1));
      }
      const parent: Position =
        "method" in value && typeof value.method === "string" && /oauth/i.test(value.method)
          ? { ...position, oauth: true }
          : position;
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => {
          const child = enterKey(parent, key);
          return [key, child === undefined ? OMITTED_CONFIG : redact(nested, child, depth + 1)];
        }),
      );
    } finally {
      ancestors.delete(value);
    }
  };
  try {
    return redact(value, { role: "frame", oauth: false }, 0);
  } catch {
    return OMITTED_VALUE;
  }
}
