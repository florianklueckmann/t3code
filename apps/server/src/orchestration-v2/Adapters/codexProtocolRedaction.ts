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

interface RedactionContext {
  readonly configPath?: ReadonlyArray<string> | undefined;
  readonly mode?: "secret" | "reference" | undefined;
  readonly oauth?: "fields" | "table" | undefined;
}

export function redactCodexProtocolValue(value: unknown): unknown {
  const ancestors = new WeakSet<object>();
  const redact = (value: unknown, context: RedactionContext, depth: number): unknown => {
    // Redaction precedes the logger's bounds, so guard cycles and depth here too.
    if (depth > 64) return OMITTED_VALUE;
    if (typeof value === "string") {
      if (context.mode === undefined && /^Bearer\s+/i.test(value)) return REDACTED;
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const decoded: unknown = JSON.parse(trimmed);
          return JSON.stringify(redact(decoded, context, depth + 1));
        } catch {
          if (context.mode === "secret") return REDACTED;
          if (
            context.configPath !== undefined ||
            /^\[\s*mcp_servers(?:\.|\])/.test(trimmed) ||
            /"(?:config|mcp_servers[^"\n]*|oauth|authorizationUrl|client_secret|access_token|refresh_token)"\s*:/.test(
              trimmed,
            )
          ) {
            return OMITTED_CONFIG;
          }
        }
      }
      if (context.mode === "secret") return REDACTED;
      const mcpIndex = context.configPath?.indexOf("mcp_servers") ?? -1;
      if (
        context.mode !== "reference" &&
        (context.oauth === "table" ||
          context.configPath?.length === 0 ||
          (mcpIndex >= 0 && (context.configPath?.length ?? 0) <= mcpIndex + 2))
      )
        return OMITTED_CONFIG;
      return value;
    }
    if (
      context.oauth === "table" &&
      (value === null || typeof value !== "object" || Array.isArray(value))
    ) {
      return OMITTED_CONFIG;
    }
    if (value === null || typeof value !== "object") {
      return context.mode === "secret" ? REDACTED : value;
    }
    if (ancestors.has(value)) return OMITTED_VALUE;
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((nested) => redact(nested, context, depth + 1));
      }
      const oauth =
        context.oauth !== undefined ||
        ("method" in value && typeof value.method === "string" && /oauth/i.test(value.method));
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => {
          if (context.mode !== undefined) {
            return [key, redact(nested, context, depth + 1)];
          }
          const isConfig = key === "config" && context.configPath === undefined;
          const isMcp = key === "mcp_servers" || key.startsWith("mcp_servers.");
          const segments =
            context.configPath !== undefined || isMcp ? configKeySegments(key) : [key];
          if (segments === undefined) return [key, OMITTED_CONFIG];
          const configPath = isConfig
            ? []
            : context.configPath !== undefined || isMcp
              ? [...(context.configPath ?? []), ...segments]
              : undefined;
          const mcpIndex = configPath?.indexOf("mcp_servers") ?? -1;
          const fields = mcpIndex < 0 ? [] : (configPath ?? []).slice(mcpIndex + 2);
          const mode = fields.some((field) => field === "env" || field === "http_headers")
            ? "secret"
            : fields.some(
                  (field) => field === "env_http_headers" || field === "bearer_token_env_var",
                )
              ? "reference"
              : undefined;
          const nestedOauth = oauth || segments.includes("oauth");
          return [
            key,
            mode === undefined &&
            (isSensitiveKey(key, nestedOauth) ||
              isSensitiveKey(segments.at(-1) ?? key, nestedOauth))
              ? REDACTED
              : redact(
                  nested,
                  {
                    configPath,
                    mode,
                    oauth:
                      segments.at(-1) === "oauth" ? "table" : nestedOauth ? "fields" : undefined,
                  },
                  depth + 1,
                ),
          ];
        }),
      );
    } finally {
      ancestors.delete(value);
    }
  };
  try {
    return redact(value, {}, 0);
  } catch {
    return OMITTED_VALUE;
  }
}
