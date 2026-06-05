# Provider Usage Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add detailed provider subscription usage limits in `settings/providers` and a compact usage summary popover in the chat header.

**Architecture:** Add schema-only usage contracts to `packages/contracts`, then add a server-side in-memory projection that normalizes provider runtime `account.rate-limits.updated` events into one latest snapshot per provider instance. The existing `server.getConfig` and `subscribeServerConfig` paths carry the projected usage data to the web app, where a pure view-model module feeds both the settings section and the header popover.

**Tech Stack:** TypeScript, Effect Schema, Effect services/streams, React, TanStack Router, Vite+ tests, existing shadcn-style UI primitives.

---

## File Structure

- Modify `packages/contracts/src/server.ts`: add provider usage schemas and include usage in server config stream contracts.
- Modify `packages/contracts/src/server.test.ts`: add contract decode tests.
- Create `apps/server/src/provider/ProviderUsageProjection.ts`: pure normalization helpers and an Effect service/layer that subscribes to `ProviderService.streamEvents`.
- Create `apps/server/src/provider/ProviderUsageProjection.test.ts`: projection normalization and stream tests.
- Modify `apps/server/src/server.ts`: provide the usage projection layer alongside provider services.
- Modify `apps/server/src/ws.ts`: include usage in `server.getConfig` and merge usage updates into `subscribeServerConfig`.
- Modify `apps/web/src/rpc/serverState.ts`: store `providerUsage` in the client server config atom and expose `useProviderUsage`.
- Modify `apps/web/src/rpc/serverState.test.ts`: verify snapshot and streamed usage updates.
- Create `apps/web/src/providerUsagePresentation.ts`: pure formatting, stale-state, severity, and summary derivation.
- Create `apps/web/src/providerUsagePresentation.test.ts`: web view-model tests.
- Create `apps/web/src/components/settings/ProviderUsageLimitsSection.tsx`: detailed settings UI.
- Modify `apps/web/src/components/settings/SettingsPanels.tsx`: render the new section above provider cards.
- Create `apps/web/src/components/chat/ProviderUsageSummaryPopover.tsx`: compact header popover.
- Modify `apps/web/src/components/chat/ChatHeader.tsx`: add the usage action inside the existing header-actions container.

## Task 1: Contracts

**Files:**

- Modify: `packages/contracts/src/server.ts`
- Test: `packages/contracts/src/server.test.ts`

- [ ] **Step 1: Write the failing contract test**

Add imports and tests to `packages/contracts/src/server.test.ts`:

```ts
import * as Schema from "effect/Schema";
import { ServerConfig, ServerProvider, ServerProviderUsageSnapshot } from "./server.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { DEFAULT_SERVER_SETTINGS } from "./settings.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerConfig = Schema.decodeUnknownSync(ServerConfig);
const decodeProviderUsageSnapshot = Schema.decodeUnknownSync(ServerProviderUsageSnapshot);

describe("ServerProviderUsageSnapshot", () => {
  it("decodes a known 5h and weekly usage snapshot", () => {
    const parsed = decodeProviderUsageSnapshot({
      providerInstanceId: "codex_personal",
      driverKind: "codex",
      displayName: "Codex Personal",
      state: "known",
      updatedAt: "2026-06-05T10:00:00.000Z",
      planType: "plus",
      source: "runtime-event",
      limits: [
        {
          window: "5h",
          usedPercent: 35,
          remainingPercent: 65,
          resetsAt: "2026-06-05T15:00:00.000Z",
          isExceeded: false,
        },
        {
          window: "weekly",
          usedPercent: 12,
          remainingPercent: 88,
          resetsAt: "2026-06-12T00:00:00.000Z",
          isExceeded: false,
        },
      ],
    });

    expect(parsed.providerInstanceId).toBe(ProviderInstanceId.make("codex_personal"));
    expect(parsed.driverKind).toBe(ProviderDriverKind.make("codex"));
    expect(parsed.state).toBe("known");
    expect(parsed.limits).toHaveLength(2);
  });

  it("decodes unknown usage without pretending limits are zero", () => {
    const parsed = decodeProviderUsageSnapshot({
      providerInstanceId: "claude",
      driverKind: "claude",
      displayName: "Claude",
      state: "unknown",
      updatedAt: "2026-06-05T10:00:00.000Z",
      limits: [],
    });

    expect(parsed.state).toBe("unknown");
    expect(parsed.limits).toEqual([]);
  });
});

describe("ServerConfig provider usage", () => {
  it("decodes providerUsage on the server config snapshot", () => {
    const parsed = decodeServerConfig({
      environment: {
        environmentId: "environment-local",
        label: "Local environment",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
      cwd: "/tmp/workspace",
      keybindingsConfigPath: "/tmp/keybindings.json",
      keybindings: [],
      issues: [],
      providers: [],
      providerUsage: [
        {
          providerInstanceId: "codex",
          driverKind: "codex",
          displayName: "Codex",
          state: "unsupported",
          updatedAt: "2026-06-05T10:00:00.000Z",
          limits: [],
        },
      ],
      availableEditors: [],
      observability: {
        logsDirectoryPath: "/tmp/logs",
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: DEFAULT_SERVER_SETTINGS,
    });

    expect(parsed.providerUsage).toHaveLength(1);
    expect(parsed.providerUsage[0]?.state).toBe("unsupported");
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
vp test packages/contracts/src/server.test.ts
```

Expected: FAIL because `ServerProviderUsageSnapshot` and `providerUsage` do not exist yet.

- [ ] **Step 3: Add usage schemas to `packages/contracts/src/server.ts`**

Add these schemas after `ServerProviderUpdateState`:

```ts
export const ServerProviderUsageState = Schema.Literals("known", "unknown", "unsupported", "error");
export type ServerProviderUsageState = typeof ServerProviderUsageState.Type;

export const ServerProviderUsageLimitWindow = Schema.Literals("5h", "weekly");
export type ServerProviderUsageLimitWindow = typeof ServerProviderUsageLimitWindow.Type;

export const ServerProviderUsageSource = Schema.Literals("runtime-event", "snapshot-read");
export type ServerProviderUsageSource = typeof ServerProviderUsageSource.Type;

export const ServerProviderUsageLimit = Schema.Struct({
  window: ServerProviderUsageLimitWindow,
  usedPercent: Schema.optional(Schema.Number),
  remainingPercent: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(IsoDateTime),
  isExceeded: Schema.optional(Schema.Boolean),
  raw: Schema.optional(Schema.Unknown),
});
export type ServerProviderUsageLimit = typeof ServerProviderUsageLimit.Type;

export const ServerProviderUsageSnapshot = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  state: ServerProviderUsageState,
  updatedAt: IsoDateTime,
  planType: Schema.optional(TrimmedNonEmptyString),
  source: Schema.optional(ServerProviderUsageSource),
  limits: Schema.Array(ServerProviderUsageLimit).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderUsageSnapshot = typeof ServerProviderUsageSnapshot.Type;

export const ServerProviderUsageSnapshots = Schema.Array(ServerProviderUsageSnapshot);
export type ServerProviderUsageSnapshots = typeof ServerProviderUsageSnapshots.Type;
```

Add `providerUsage: ServerProviderUsageSnapshots` to `ServerConfig`.

Add `providerUsage: ServerProviderUsageSnapshots` to `ServerConfigUpdatedPayload`.

Add:

```ts
export const ServerConfigProviderUsagePayload = Schema.Struct({
  providerUsage: ServerProviderUsageSnapshots,
});
export type ServerConfigProviderUsagePayload = typeof ServerConfigProviderUsagePayload.Type;

export const ServerConfigStreamProviderUsageEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerUsage"),
  payload: ServerConfigProviderUsagePayload,
});
export type ServerConfigStreamProviderUsageEvent = typeof ServerConfigStreamProviderUsageEvent.Type;
```

Include `ServerConfigStreamProviderUsageEvent` in `ServerConfigStreamEvent`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
vp test packages/contracts/src/server.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/contracts/src/server.ts packages/contracts/src/server.test.ts
git commit -m "feat: add provider usage contracts"
```

## Task 2: Server Usage Projection

**Files:**

- Create: `apps/server/src/provider/ProviderUsageProjection.ts`
- Test: `apps/server/src/provider/ProviderUsageProjection.test.ts`
- Modify: `apps/server/src/provider/Services/ProviderService.ts`
- Modify: `apps/server/src/provider/Layers/ProviderService.ts`

- [ ] **Step 1: Write failing projection tests**

Create `apps/server/src/provider/ProviderUsageProjection.test.ts`:

```ts
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildUnknownProviderUsageSnapshot,
  normalizeProviderUsageEvent,
} from "./ProviderUsageProjection.ts";

const baseEvent = {
  eventId: "event-1",
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex_personal"),
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-06-05T10:00:00.000Z",
} satisfies Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt"
>;

describe("normalizeProviderUsageEvent", () => {
  it("normalizes Codex primary and secondary limits", () => {
    const normalized = normalizeProviderUsageEvent({
      event: {
        ...baseEvent,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: {
            rateLimits: {
              planType: "plus",
              primary: {
                percentUsed: 35,
                resetsAt: "2026-06-05T15:00:00.000Z",
              },
              secondary: {
                percentUsed: 12,
                resetsAt: "2026-06-12T00:00:00.000Z",
              },
            },
          },
        },
      } as ProviderRuntimeEvent,
      displayName: "Codex Personal",
    });

    expect(normalized?.state).toBe("known");
    expect(normalized?.planType).toBe("plus");
    expect(normalized?.limits).toEqual([
      {
        window: "5h",
        usedPercent: 35,
        remainingPercent: 65,
        resetsAt: "2026-06-05T15:00:00.000Z",
        isExceeded: false,
      },
      {
        window: "weekly",
        usedPercent: 12,
        remainingPercent: 88,
        resetsAt: "2026-06-12T00:00:00.000Z",
        isExceeded: false,
      },
    ]);
  });

  it("normalizes Claude rate limit reset messages as known reset-only data", () => {
    const normalized = normalizeProviderUsageEvent({
      event: {
        ...baseEvent,
        provider: ProviderDriverKind.make("claude"),
        providerInstanceId: ProviderInstanceId.make("claude"),
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: {
            type: "rate_limit_event",
            resetsAt: "2026-06-05T15:00:00.000Z",
            limitType: "five_hour",
          },
        },
      } as ProviderRuntimeEvent,
      displayName: "Claude",
    });

    expect(normalized?.state).toBe("known");
    expect(normalized?.limits).toEqual([
      {
        window: "5h",
        resetsAt: "2026-06-05T15:00:00.000Z",
        isExceeded: true,
      },
    ]);
  });

  it("returns null for unrelated runtime events", () => {
    const normalized = normalizeProviderUsageEvent({
      event: {
        ...baseEvent,
        type: "session.started",
        payload: { cwd: "/tmp/workspace" },
      } as ProviderRuntimeEvent,
      displayName: "Codex Personal",
    });

    expect(normalized).toBeNull();
  });
});

describe("buildUnknownProviderUsageSnapshot", () => {
  it("keeps registered providers visible before any usage event arrives", () => {
    const snapshot = buildUnknownProviderUsageSnapshot({
      providerInstanceId: ProviderInstanceId.make("codex"),
      driverKind: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      updatedAt: "2026-06-05T10:00:00.000Z",
      state: "unknown",
    });

    expect(snapshot).toEqual({
      providerInstanceId: ProviderInstanceId.make("codex"),
      driverKind: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      state: "unknown",
      updatedAt: "2026-06-05T10:00:00.000Z",
      limits: [],
    });
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
vp test apps/server/src/provider/ProviderUsageProjection.test.ts
```

Expected: FAIL because `ProviderUsageProjection.ts` does not exist.

- [ ] **Step 3: Implement pure projection helpers**

Create `apps/server/src/provider/ProviderUsageProjection.ts` with:

```ts
import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ServerProviderUsageSnapshot,
  type ServerProviderUsageState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

type RuntimeRateLimitWindow = "5h" | "weekly";

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readString(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function toLimit(
  window: RuntimeRateLimitWindow,
  rawWindow: unknown,
): ServerProviderUsageSnapshot["limits"][number] | null {
  const record = readRecord(rawWindow);
  if (!record) return null;
  const usedPercent = readNumber(record, ["percentUsed", "usedPercent", "usagePercent"]);
  const remainingPercent =
    readNumber(record, ["percentRemaining", "remainingPercent"]) ??
    (usedPercent === undefined ? undefined : Math.max(0, 100 - usedPercent));
  const resetsAt = readString(record, ["resetsAt", "resetAt", "resets_at"]);
  const isExceeded =
    typeof record.isExceeded === "boolean"
      ? record.isExceeded
      : typeof record.exceeded === "boolean"
        ? record.exceeded
        : usedPercent !== undefined
          ? usedPercent >= 100
          : undefined;
  return {
    window,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(isExceeded !== undefined ? { isExceeded } : {}),
  };
}

function normalizeCodexRateLimits(input: {
  readonly event: ProviderRuntimeEvent;
  readonly displayName?: string | undefined;
}): ServerProviderUsageSnapshot | null {
  const payload = readRecord(input.event.payload);
  const outerRateLimits = readRecord(payload?.rateLimits);
  const rateLimits = readRecord(outerRateLimits?.rateLimits) ?? outerRateLimits;
  if (!rateLimits || !input.event.providerInstanceId) return null;
  const limits = [
    toLimit("5h", rateLimits.primary),
    toLimit("weekly", rateLimits.secondary),
  ].filter((limit): limit is ServerProviderUsageSnapshot["limits"][number] => limit !== null);
  return {
    providerInstanceId: input.event.providerInstanceId,
    driverKind: input.event.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    state: limits.length > 0 ? "known" : "unknown",
    updatedAt: input.event.createdAt,
    ...(readString(rateLimits, ["planType", "plan_type"])
      ? {
          planType: readString(rateLimits, ["planType", "plan_type"])!,
        }
      : {}),
    source: "runtime-event",
    limits,
  };
}

function normalizeClaudeRateLimits(input: {
  readonly event: ProviderRuntimeEvent;
  readonly displayName?: string | undefined;
}): ServerProviderUsageSnapshot | null {
  const payload = readRecord(input.event.payload);
  const rateLimits = readRecord(payload?.rateLimits);
  if (!rateLimits || !input.event.providerInstanceId) return null;
  const rawLimitType = readString(rateLimits, ["limitType", "limit_type", "limit"]);
  const window: RuntimeRateLimitWindow =
    rawLimitType === "weekly" || rawLimitType === "week" ? "weekly" : "5h";
  const resetsAt = readString(rateLimits, ["resetsAt", "resetAt", "resets_at"]);
  return {
    providerInstanceId: input.event.providerInstanceId,
    driverKind: input.event.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    state: resetsAt ? "known" : "unknown",
    updatedAt: input.event.createdAt,
    source: "runtime-event",
    limits: resetsAt ? [{ window, resetsAt, isExceeded: true }] : [],
  };
}

export function normalizeProviderUsageEvent(input: {
  readonly event: ProviderRuntimeEvent;
  readonly displayName?: string | undefined;
}): ServerProviderUsageSnapshot | null {
  if (input.event.type !== "account.rate-limits.updated") return null;
  if (input.event.provider === "codex") return normalizeCodexRateLimits(input);
  if (input.event.provider === "claude") return normalizeClaudeRateLimits(input);
  if (!input.event.providerInstanceId) return null;
  return buildUnknownProviderUsageSnapshot({
    providerInstanceId: input.event.providerInstanceId,
    driverKind: input.event.provider,
    displayName: input.displayName,
    updatedAt: input.event.createdAt,
    state: "unsupported",
  });
}

export function buildUnknownProviderUsageSnapshot(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName?: string | undefined;
  readonly updatedAt: string;
  readonly state: ServerProviderUsageState;
}): ServerProviderUsageSnapshot {
  return {
    providerInstanceId: input.providerInstanceId,
    driverKind: input.driverKind,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    state: input.state,
    updatedAt: input.updatedAt,
    limits: [],
  };
}
```

- [ ] **Step 4: Extend ProviderService with usage stream access**

Verify that `apps/server/src/provider/Services/ProviderService.ts` still exposes the existing stream:

```ts
readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
```

No code change is required in `ProviderService.ts` or `ProviderService.ts`'s live layer for this task. The projection consumes the existing canonical stream.

- [ ] **Step 5: Add the Effect projection service**

Append to `apps/server/src/provider/ProviderUsageProjection.ts`:

```ts
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { ProviderService } from "./Services/ProviderService.ts";

export interface ProviderUsageProjectionShape {
  readonly getUsage: Effect.Effect<ReadonlyArray<ServerProviderUsageSnapshot>>;
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProviderUsageSnapshot>>;
}

export class ProviderUsageProjection extends Context.Service<
  ProviderUsageProjection,
  ProviderUsageProjectionShape
>()("t3/provider/ProviderUsageProjection") {}

export const ProviderUsageProjectionLive = Layer.scoped(
  ProviderUsageProjection,
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const providerRegistry = yield* ProviderRegistry;
    const usageRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProviderUsageSnapshot>>(
      new Map(),
    );
    const changes = yield* PubSub.unbounded<ReadonlyArray<ServerProviderUsageSnapshot>>();

    const publish = Effect.gen(function* () {
      const usage = [...(yield* Ref.get(usageRef)).values()];
      yield* PubSub.publish(changes, usage);
    });

    yield* Stream.runForEach(providerService.streamEvents, (event) =>
      Effect.gen(function* () {
        const providers = yield* providerRegistry.getProviders;
        const provider = providers.find((entry) => entry.instanceId === event.providerInstanceId);
        const normalized = normalizeProviderUsageEvent({
          event,
          displayName:
            provider?.displayName ??
            provider?.badgeLabel ??
            String(event.providerInstanceId ?? event.provider),
        });
        if (!normalized) return;
        yield* Ref.update(usageRef, (existing) => {
          const next = new Map(existing);
          next.set(normalized.providerInstanceId, normalized);
          return next;
        });
        yield* publish;
      }),
    ).pipe(Effect.forkScoped);

    return {
      getUsage: Ref.get(usageRef).pipe(Effect.map((usage) => [...usage.values()])),
      streamChanges: Stream.fromPubSub(changes),
    } satisfies ProviderUsageProjectionShape;
  }),
);
```

- [ ] **Step 6: Run the focused projection test**

Run:

```bash
vp test apps/server/src/provider/ProviderUsageProjection.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add apps/server/src/provider/ProviderUsageProjection.ts apps/server/src/provider/ProviderUsageProjection.test.ts apps/server/src/provider/Services/ProviderService.ts apps/server/src/provider/Layers/ProviderService.ts
git commit -m "feat: project provider usage limits"
```

## Task 3: Server Config Wiring

**Files:**

- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/ws.ts`
- Test: `apps/server/src/server.test.ts`

- [ ] **Step 1: Add a test harness override for usage projection**

Modify the `layers` type in `buildAppUnderTest` in `apps/server/src/server.test.ts`:

```ts
providerUsageProjection?: Partial<ProviderUsageProjectionShape>;
```

Import the new service and type:

```ts
import {
  ProviderUsageProjection,
  type ProviderUsageProjectionShape,
} from "./provider/ProviderUsageProjection.ts";
```

In `servedRoutesLayer`, after the existing `ProviderRegistry` mock layer, add:

```ts
Layer.provide(
  Layer.mock(ProviderUsageProjection)({
    getUsage: Effect.succeed([]),
    streamChanges: Stream.empty,
    ...options?.layers?.providerUsageProjection,
  }),
),
```

- [ ] **Step 2: Write failing WebSocket server config test**

In `apps/server/src/server.test.ts`, after `routes websocket rpc subscribeServerConfig emits provider status updates`, add:

```ts
it.effect("routes websocket rpc subscribeServerConfig emits provider usage updates", () =>
  Effect.gen(function* () {
    const providerUsage = [
      {
        providerInstanceId: ProviderInstanceId.make("codex"),
        driverKind: ProviderDriverKind.make("codex"),
        displayName: "Codex",
        state: "known" as const,
        updatedAt: "2026-06-05T10:00:00.000Z",
        source: "runtime-event" as const,
        limits: [{ window: "5h" as const, usedPercent: 25, remainingPercent: 75 }],
      },
    ] as const;

    yield* buildAppUnderTest({
      layers: {
        keybindings: {
          loadConfigState: Effect.succeed({
            keybindings: [],
            issues: [],
          }),
          streamChanges: Stream.empty,
        },
        providerRegistry: {
          getProviders: Effect.succeed([]),
          streamChanges: Stream.empty,
        },
        providerUsageProjection: {
          getUsage: Effect.succeed([]),
          streamChanges: Stream.succeed(providerUsage),
        },
      },
    });

    const wsUrl = yield* getWsServerUrl("/ws");
    const events = yield* Effect.scoped(
      withWsRpcClient(wsUrl, (client) =>
        client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
      ),
    );

    const [first, second] = Array.from(events);
    assert.equal(first?.type, "snapshot");
    if (first?.type === "snapshot") {
      assert.deepEqual(first.config.providerUsage, []);
    }
    assert.deepEqual(second, {
      version: 1,
      type: "providerUsage",
      payload: { providerUsage },
    });
  }).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
```

The assertion checks:

```ts
expect(events[1]).toMatchObject({
  version: 1,
  type: "providerUsage",
  payload: {
    providerUsage: [
      {
        providerInstanceId: "codex",
        driverKind: "codex",
        state: "known",
      },
    ],
  },
});
```

- [ ] **Step 3: Run the server test to verify it fails**

Run:

```bash
vp test apps/server/src/server.test.ts -- -t "providerUsage"
```

Expected: FAIL because the server config stream does not emit provider usage yet.

- [ ] **Step 4: Provide the projection layer**

Modify `apps/server/src/server.ts` to import `ProviderUsageProjectionLive`:

```ts
import { ProviderUsageProjectionLive } from "./provider/ProviderUsageProjection.ts";
```

In `RuntimeCoreDependenciesLive`, add the layer immediately after `Layer.provideMerge(ProviderRegistryLive)`:

```ts
Layer.provideMerge(ProviderRegistryLive),
Layer.provideMerge(ProviderUsageProjectionLive),
```

- [ ] **Step 5: Include usage in `loadServerConfig`**

Modify `apps/server/src/ws.ts` imports:

```ts
import { ProviderUsageProjection } from "./provider/ProviderUsageProjection.ts";
```

Read the service next to the existing provider registry service binding:

```ts
const providerUsageProjection = yield * ProviderUsageProjection;
```

Inside `loadServerConfig` add:

```ts
const providerUsage = yield * providerUsageProjection.getUsage;
```

and include:

```ts
providerUsage,
```

in the returned config object.

- [ ] **Step 6: Merge provider usage stream into `subscribeServerConfig`**

In `apps/server/src/ws.ts`, add:

```ts
const providerUsageUpdates = providerUsageProjection.streamChanges.pipe(
  Stream.map((providerUsage) => ({
    version: 1 as const,
    type: "providerUsage" as const,
    payload: { providerUsage },
  })),
);
```

Update `liveUpdates`:

```ts
const liveUpdates = Stream.merge(
  keybindingsUpdates,
  Stream.merge(providerStatuses, Stream.merge(settingsUpdates, providerUsageUpdates)),
);
```

- [ ] **Step 7: Run the focused server test**

Run:

```bash
vp test apps/server/src/server.test.ts -- -t "providerUsage"
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add apps/server/src/server.ts apps/server/src/ws.ts apps/server/src/server.test.ts
git commit -m "feat: stream provider usage in server config"
```

## Task 4: Web Server State

**Files:**

- Modify: `apps/web/src/rpc/serverState.ts`
- Test: `apps/web/src/rpc/serverState.test.ts`

- [ ] **Step 1: Write failing server-state test**

In `apps/web/src/rpc/serverState.test.ts`, add `providerUsage: []` to `baseServerConfig`.

Add a test:

```ts
it("merges provider usage updates into the cached config", async () => {
  serverApi.getConfig.mockResolvedValueOnce(baseServerConfig);
  const stop = startServerStateSync(serverApi);

  await waitFor(() => {
    expect(getServerConfig()).toEqual(baseServerConfig);
  });

  emitServerConfigEvent({
    version: 1,
    type: "providerUsage",
    payload: {
      providerUsage: [
        {
          providerInstanceId: ProviderInstanceId.make("codex"),
          driverKind: ProviderDriverKind.make("codex"),
          displayName: "Codex",
          state: "known",
          updatedAt: "2026-06-05T10:00:00.000Z",
          source: "runtime-event",
          limits: [{ window: "5h", usedPercent: 25, remainingPercent: 75 }],
        },
      ],
    },
  });

  await waitFor(() => {
    expect(getServerConfig()?.providerUsage).toEqual([
      {
        providerInstanceId: ProviderInstanceId.make("codex"),
        driverKind: ProviderDriverKind.make("codex"),
        displayName: "Codex",
        state: "known",
        updatedAt: "2026-06-05T10:00:00.000Z",
        source: "runtime-event",
        limits: [{ window: "5h", usedPercent: 25, remainingPercent: 75 }],
      },
    ]);
  });

  stop();
});
```

- [ ] **Step 2: Run the focused web state test to verify it fails**

Run:

```bash
vp test apps/web/src/rpc/serverState.test.ts -- -t "provider usage"
```

Expected: FAIL because `providerUsage` stream events are not handled.

- [ ] **Step 3: Update client server state**

Modify `apps/web/src/rpc/serverState.ts`:

```ts
const EMPTY_PROVIDER_USAGE: ServerConfig["providerUsage"] = [];
const selectProviderUsage = (config: ServerConfig | null) =>
  config?.providerUsage ?? EMPTY_PROVIDER_USAGE;
```

Add:

```ts
export function useProviderUsage(): ServerConfig["providerUsage"] {
  return selectProviderUsage(useAtomValue(serverConfigAtom));
}
```

Update `toServerConfigUpdatedPayload`:

```ts
providerUsage: config.providerUsage,
```

Handle the new stream event:

```ts
case "providerUsage": {
  const latestServerConfig = getServerConfig();
  if (!latestServerConfig) return;
  const nextConfig = {
    ...latestServerConfig,
    providerUsage: event.payload.providerUsage,
  } satisfies ServerConfig;
  resolveServerConfig(nextConfig);
  emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), event.type);
  return;
}
```

- [ ] **Step 4: Run the focused web state test**

Run:

```bash
vp test apps/web/src/rpc/serverState.test.ts -- -t "provider usage"
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/web/src/rpc/serverState.ts apps/web/src/rpc/serverState.test.ts
git commit -m "feat: sync provider usage state in web"
```

## Task 5: Web Presentation Logic

**Files:**

- Create: `apps/web/src/providerUsagePresentation.ts`
- Test: `apps/web/src/providerUsagePresentation.test.ts`

- [ ] **Step 1: Write failing presentation tests**

Create `apps/web/src/providerUsagePresentation.test.ts`:

```ts
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderUsageSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildProviderUsageSummary,
  formatUsageLimit,
  isUsageLimitStale,
} from "./providerUsagePresentation.ts";

const snapshot: ServerProviderUsageSnapshot = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  driverKind: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  state: "known",
  updatedAt: "2026-06-05T10:00:00.000Z",
  limits: [
    { window: "5h", usedPercent: 35, remainingPercent: 65, resetsAt: "2026-06-05T15:00:00.000Z" },
    {
      window: "weekly",
      usedPercent: 90,
      remainingPercent: 10,
      resetsAt: "2026-06-12T00:00:00.000Z",
    },
  ],
};

describe("providerUsagePresentation", () => {
  it("formats known limits without losing unknown fields", () => {
    expect(formatUsageLimit(snapshot.limits[0]!, "2026-06-05T10:00:00.000Z")).toEqual({
      windowLabel: "5h",
      usageLabel: "35% used",
      remainingLabel: "65% left",
      resetLabel: "resets in 5h",
      tone: "ok",
    });
  });

  it("detects stale 5h snapshots after 30 minutes", () => {
    expect(isUsageLimitStale(snapshot, "2026-06-05T10:31:00.000Z", "5h")).toBe(true);
  });

  it("summarizes by the lowest known remaining percentage", () => {
    expect(buildProviderUsageSummary([snapshot], "2026-06-05T10:00:00.000Z")).toMatchObject({
      tone: "critical",
      label: "Weekly limit low",
      lowestRemainingPercent: 10,
    });
  });
});
```

- [ ] **Step 2: Run the focused presentation test to verify it fails**

Run:

```bash
vp test apps/web/src/providerUsagePresentation.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement presentation helpers**

Create `apps/web/src/providerUsagePresentation.ts`:

```ts
import type {
  ServerProviderUsageLimit,
  ServerProviderUsageLimitWindow,
  ServerProviderUsageSnapshot,
} from "@t3tools/contracts";

export type ProviderUsageTone = "ok" | "warning" | "critical" | "muted";

export function isUsageLimitStale(
  snapshot: ServerProviderUsageSnapshot,
  nowIso: string,
  window: ServerProviderUsageLimitWindow,
): boolean {
  const ageMs = Date.parse(nowIso) - Date.parse(snapshot.updatedAt);
  const thresholdMs = window === "5h" ? 30 * 60 * 1000 : 12 * 60 * 60 * 1000;
  return Number.isFinite(ageMs) && ageMs > thresholdMs;
}

function toneFromRemaining(
  remainingPercent: number | undefined,
  isExceeded: boolean | undefined,
): ProviderUsageTone {
  if (isExceeded) return "critical";
  if (remainingPercent === undefined) return "muted";
  if (remainingPercent <= 10) return "critical";
  if (remainingPercent <= 25) return "warning";
  return "ok";
}

function formatResetLabel(resetsAt: string | undefined, nowIso: string): string {
  if (!resetsAt) return "reset unknown";
  const diffMs = Date.parse(resetsAt) - Date.parse(nowIso);
  if (!Number.isFinite(diffMs)) return "reset unknown";
  if (diffMs <= 0) return "reset due";
  const hours = Math.max(1, Math.round(diffMs / (60 * 60 * 1000)));
  return `resets in ${hours}h`;
}

export function formatUsageLimit(limit: ServerProviderUsageLimit, nowIso: string) {
  const tone = toneFromRemaining(limit.remainingPercent, limit.isExceeded);
  return {
    windowLabel: limit.window,
    usageLabel:
      limit.usedPercent === undefined ? "usage unknown" : `${Math.round(limit.usedPercent)}% used`,
    remainingLabel:
      limit.remainingPercent === undefined
        ? "remaining unknown"
        : `${Math.round(limit.remainingPercent)}% left`,
    resetLabel: formatResetLabel(limit.resetsAt, nowIso),
    tone,
  };
}

export function getLimit(
  snapshot: ServerProviderUsageSnapshot,
  window: ServerProviderUsageLimitWindow,
): ServerProviderUsageLimit | undefined {
  return snapshot.limits.find((limit) => limit.window === window);
}

export function buildProviderUsageSummary(
  snapshots: ReadonlyArray<ServerProviderUsageSnapshot>,
  nowIso: string,
) {
  const knownLimits = snapshots.flatMap((snapshot) =>
    snapshot.limits.map((limit) => ({ snapshot, limit })),
  );
  const exceeded = knownLimits.find(({ limit }) => limit.isExceeded);
  if (exceeded) {
    return {
      tone: "critical" as const,
      label: `${exceeded.limit.window} limit reached`,
      lowestRemainingPercent: exceeded.limit.remainingPercent ?? 0,
    };
  }
  const lowest = knownLimits.reduce<(typeof knownLimits)[number] | null>((current, entry) => {
    if (entry.limit.remainingPercent === undefined) return current;
    if (!current || entry.limit.remainingPercent < (current.limit.remainingPercent ?? 101)) {
      return entry;
    }
    return current;
  }, null);
  if (!lowest) {
    return { tone: "muted" as const, label: "Usage unknown", lowestRemainingPercent: null };
  }
  const tone = toneFromRemaining(lowest.limit.remainingPercent, lowest.limit.isExceeded);
  return {
    tone,
    label: `${lowest.limit.window === "weekly" ? "Weekly" : "5h"} limit ${
      tone === "critical" ? "low" : tone === "warning" ? "getting low" : "available"
    }`,
    lowestRemainingPercent: lowest.limit.remainingPercent ?? null,
    stale: isUsageLimitStale(lowest.snapshot, nowIso, lowest.limit.window),
  };
}
```

- [ ] **Step 4: Run the presentation test**

Run:

```bash
vp test apps/web/src/providerUsagePresentation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add apps/web/src/providerUsagePresentation.ts apps/web/src/providerUsagePresentation.test.ts
git commit -m "feat: add provider usage presentation logic"
```

## Task 6: Settings Providers Detailed Panel

**Files:**

- Create: `apps/web/src/components/settings/ProviderUsageLimitsSection.tsx`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`

- [ ] **Step 1: Create the detailed settings component**

Create `apps/web/src/components/settings/ProviderUsageLimitsSection.tsx`:

```tsx
import type { ServerProviderUsageSnapshot } from "@t3tools/contracts";
import { ActivityIcon } from "lucide-react";
import { getLimit, formatUsageLimit } from "../../providerUsagePresentation";
import { Badge } from "../ui/badge";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "./settingsLayout";

function UsageWindowRow(props: {
  readonly label: string;
  readonly snapshot: ServerProviderUsageSnapshot;
  readonly window: "5h" | "weekly";
  readonly nowIso: string;
}) {
  const limit = getLimit(props.snapshot, props.window);
  if (!limit) {
    return (
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground/80">{props.label}</span>
        <span className="text-muted-foreground">unknown</span>
      </div>
    );
  }
  const formatted = formatUsageLimit(limit, props.nowIso);
  return (
    <div className="grid gap-1 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-foreground/80">{props.label}</span>
        <span className="text-muted-foreground">{formatted.resetLabel}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span>{formatted.usageLabel}</span>
        <span>{formatted.remainingLabel}</span>
      </div>
      {limit.remainingPercent !== undefined ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground/70"
            style={{ width: `${Math.max(0, Math.min(100, limit.usedPercent ?? 0))}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ProviderUsageLimitsSection(props: {
  readonly providerUsage: ReadonlyArray<ServerProviderUsageSnapshot>;
}) {
  useRelativeTimeTick(60_000);
  const nowIso = new Date().toISOString();

  return (
    <SettingsSection title="Usage limits" icon={<ActivityIcon className="size-3" />}>
      {props.providerUsage.length === 0 ? (
        <SettingsRow
          title="No usage data"
          description="Usage limits appear after a registered provider reports subscription limit data."
        />
      ) : (
        props.providerUsage.map((snapshot) => (
          <SettingsRow
            key={snapshot.providerInstanceId}
            title={
              <span className="inline-flex min-w-0 items-center gap-2">
                <span className="truncate">
                  {snapshot.displayName ?? snapshot.providerInstanceId}
                </span>
                {snapshot.planType ? <Badge variant="outline">{snapshot.planType}</Badge> : null}
              </span>
            }
            description={`${snapshot.driverKind} · ${snapshot.state}`}
            status={`Updated ${new Date(snapshot.updatedAt).toLocaleString()}`}
          >
            <div className="grid gap-3 pt-3 pb-4">
              <UsageWindowRow label="5-hour" snapshot={snapshot} window="5h" nowIso={nowIso} />
              <UsageWindowRow label="Weekly" snapshot={snapshot} window="weekly" nowIso={nowIso} />
            </div>
          </SettingsRow>
        ))
      )}
    </SettingsSection>
  );
}
```

- [ ] **Step 2: Render the section in provider settings**

Modify `apps/web/src/components/settings/SettingsPanels.tsx` imports:

```ts
import {
  useProviderUsage,
  useServerObservability,
  useServerProviders,
} from "../../rpc/serverState";
import { ProviderUsageLimitsSection } from "./ProviderUsageLimitsSection";
```

Inside `ProviderSettingsPanel` add:

```ts
const providerUsage = useProviderUsage();
```

Render before the `Providers` section:

```tsx
<ProviderUsageLimitsSection providerUsage={providerUsage} />
```

- [ ] **Step 3: Run focused web checks**

Run:

```bash
vp run typecheck
```

Expected: PASS or unrelated pre-existing failures only.

- [ ] **Step 4: Commit**

Run:

```bash
git add apps/web/src/components/settings/ProviderUsageLimitsSection.tsx apps/web/src/components/settings/SettingsPanels.tsx
git commit -m "feat: show provider usage limits in settings"
```

## Task 7: Header Summary Popover

**Files:**

- Create: `apps/web/src/components/chat/ProviderUsageSummaryPopover.tsx`
- Modify: `apps/web/src/components/chat/ChatHeader.tsx`

- [ ] **Step 1: Create the header summary popover component**

Create `apps/web/src/components/chat/ProviderUsageSummaryPopover.tsx`:

```tsx
import type { ServerProviderUsageSnapshot } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ActivityIcon } from "lucide-react";
import {
  buildProviderUsageSummary,
  formatUsageLimit,
  getLimit,
} from "../../providerUsagePresentation";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function CompactProviderUsageRow(props: {
  readonly snapshot: ServerProviderUsageSnapshot;
  readonly nowIso: string;
}) {
  const fiveHour = getLimit(props.snapshot, "5h");
  const weekly = getLimit(props.snapshot, "weekly");
  const fiveHourText = fiveHour
    ? formatUsageLimit(fiveHour, props.nowIso).remainingLabel
    : "5h unknown";
  const weeklyText = weekly
    ? formatUsageLimit(weekly, props.nowIso).remainingLabel
    : "weekly unknown";

  return (
    <div className="grid gap-1 border-t border-border/60 py-2 first:border-t-0">
      <div className="truncate text-xs font-medium">
        {props.snapshot.displayName ?? props.snapshot.providerInstanceId}
      </div>
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>{fiveHourText}</span>
        <span>{weeklyText}</span>
      </div>
    </div>
  );
}

export function ProviderUsageSummaryPopover(props: {
  readonly providerUsage: ReadonlyArray<ServerProviderUsageSnapshot>;
}) {
  const nowIso = new Date().toISOString();
  const summary = buildProviderUsageSummary(props.providerUsage, nowIso);

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="outline"
                  className="shrink-0"
                  aria-label="Show provider usage limits"
                >
                  <ActivityIcon className="size-3" />
                </Button>
              }
            />
          }
        />
        <TooltipPopup side="bottom">Provider usage limits</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" className="w-72 p-3">
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Usage limits</div>
              <div className="text-xs text-muted-foreground">{summary.label}</div>
            </div>
            {summary.lowestRemainingPercent !== null ? (
              <div className="font-mono text-xs tabular-nums">
                {Math.round(summary.lowestRemainingPercent)}%
              </div>
            ) : null}
          </div>
          <div>
            {props.providerUsage.length === 0 ? (
              <div className="py-3 text-xs text-muted-foreground">No provider usage data yet.</div>
            ) : (
              props.providerUsage.map((snapshot) => (
                <CompactProviderUsageRow
                  key={snapshot.providerInstanceId}
                  snapshot={snapshot}
                  nowIso={nowIso}
                />
              ))
            )}
          </div>
          <Button render={<Link to="/settings/providers" />} size="xs" variant="outline">
            Open provider settings
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
```

- [ ] **Step 2: Add the action to `ChatHeader`**

Modify `apps/web/src/components/chat/ChatHeader.tsx` imports:

```ts
import { useProviderUsage } from "../../rpc/serverState";
import { ProviderUsageSummaryPopover } from "./ProviderUsageSummaryPopover";
```

Inside `ChatHeader`:

```ts
const providerUsage = useProviderUsage();
```

Render inside the header actions container before terminal/diff toggles:

```tsx
<ProviderUsageSummaryPopover providerUsage={providerUsage} />
```

- [ ] **Step 3: Run focused typecheck**

Run:

```bash
vp run typecheck
```

Expected: PASS or unrelated pre-existing failures only.

- [ ] **Step 4: Commit**

Run:

```bash
git add apps/web/src/components/chat/ProviderUsageSummaryPopover.tsx apps/web/src/components/chat/ChatHeader.tsx
git commit -m "feat: add provider usage header summary"
```

## Task 8: Final Verification

**Files:**

- No new files.

- [ ] **Step 1: Run repository checks**

Run:

```bash
vp check
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
vp run typecheck
```

Expected: PASS.

- [ ] **Step 3: Inspect worktree**

Run:

```bash
git status --short
```

Expected: only unrelated pre-existing user changes remain unstaged.

- [ ] **Step 4: Final commit if verification required small fixes**

If Step 1 or Step 2 required fixes, inspect the exact fixed files:

```bash
git status --short
```

Stage only files changed for provider usage limits, then commit with:

```bash
git commit -m "fix: verify provider usage limits"
```

## Self-Review

Spec coverage:

- Current 5-hour and weekly display: Tasks 1, 2, 5, 6, and 7.
- Detailed `settings/providers` panel: Task 6.
- Header-actions summary popover: Task 7.
- Unknown, unsupported, stale, and error handling: Tasks 1, 2, and 5.
- Server-owned projection and existing config stream: Tasks 2, 3, and 4.
- Forecasting as future extension only: excluded from implementation tasks by design.

Type consistency:

- Contract property name is `providerUsage` everywhere.
- Stream event type is `providerUsage`.
- Snapshot identity fields are `providerInstanceId` and `driverKind`.
- Limit windows are `5h` and `weekly`.
