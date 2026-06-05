# Provider Usage Limits Design

## Goal

Show the 5-hour and weekly usage limits for subscriptions registered in T3 Code.

The first implementation has two surfaces:

- A detailed usage-limits section in `settings/providers`.
- A compact summary popover opened from an action in the chat header actions container.

The feature should show known data accurately, preserve unknown/unsupported states, and avoid inferring usage when the provider does not expose enough information.

## Current Context

T3 Code already normalizes provider runtime events in `packages/contracts/src/providerRuntime.ts`.
Codex emits `account/rateLimits/updated` events through `apps/server/src/provider/Layers/CodexAdapter.ts`.
Claude emits rate-limit events through `apps/server/src/provider/Layers/ClaudeAdapter.ts`.

The generated Codex app-server schema also exposes `account/rateLimits/read`, which can provide a current snapshot before a new runtime event arrives.

Provider settings are rendered in `apps/web/src/components/settings/SettingsPanels.tsx`, with provider rows/cards in `ProviderInstanceCard.tsx`.
The chat header action container is in `apps/web/src/components/chat/ChatHeader.tsx`.

## Architecture

Add a server-owned provider usage projection.

The projection stores the latest known usage snapshot per `providerInstanceId`. It is updated from provider runtime `account.rate-limits.updated` events and, where supported, explicit snapshot reads such as Codex `account/rateLimits/read`.

Expose projected usage through schema-only contracts in `packages/contracts`, then include it in the existing server config/state stream. The web app should consume one normalized shape for both the detailed settings panel and the header summary popover.

## Contract Shape

Add normalized usage data keyed by provider instance:

- `providerInstanceId`
- `driverKind`
- `displayName`
- `state`: `known`, `unknown`, `unsupported`, or `error`
- `updatedAt`
- optional `planType`
- optional `source`
- `limits`: entries for `5h` and `weekly`

Each limit entry should carry the fields that are truly known:

- `window`: `5h` or `weekly`
- `usedPercent`, when provider data supports it
- `remainingPercent`, when provider data supports it
- `resetsAt`, when provider data supports it
- `isExceeded`, when provider data supports it
- `raw`, only as an opaque diagnostic payload if needed

Do not put runtime normalization logic in `packages/contracts`; it remains schema-only.

## Server Data Flow

1. Provider runtime emits or reads rate-limit data.
2. Server projection normalizes provider-specific payloads into the shared usage shape.
3. Projection emits updated server config/state events so existing web state sync receives changes.
4. On initial config snapshot, the server includes the latest known usage data.

Codex should try a current `account/rateLimits/read` snapshot when the provider runtime is available. If the read fails, preserve provider availability and mark usage as `unknown` or `error` without breaking provider status.

Claude should use live rate-limit events for the first slice unless there is a stable explicit snapshot command available in the existing adapter.

## Settings UI

Add a `Usage limits` section in `settings/providers`, before the configured provider cards.

For each registered provider instance, show:

- Provider icon, display name, driver kind, and plan type when known.
- A 5-hour row with usage/remaining state and reset time.
- A weekly row with usage/remaining state and reset time.
- A last-updated label.
- Clear states for unknown, unsupported, stale, and error data.

The UI should be dense and scannable, matching existing settings styling. It should not use large marketing-style cards or explanatory copy.

## Header Summary Popover

Add an icon action in `ChatHeader` inside the existing header actions container.

The popover should summarize:

- Overall status, based on the lowest known remaining percentage or exceeded window.
- One compact row per provider instance.
- 5-hour and weekly indicators per row.
- A navigation action to open `settings/providers`.

The summary should reuse the same formatting and derived view model as the settings section.

## Error Handling

Unknown data must be represented as unknown, not zero.

Unsupported providers should remain visible if registered, but labeled unsupported rather than missing.

Stale data should remain visible with its last update time. The stale threshold can start conservatively, for example 30 minutes for 5-hour windows and 12 hours for weekly windows, then be tuned if provider events are more frequent.

Provider usage fetch failures must not mark the provider itself unavailable.

## Testing

Add focused tests for:

- Contract decoding of provider usage snapshots.
- Server projection normalization for Codex and Claude payload examples.
- Unknown, unsupported, stale, and error state derivation.
- Web formatting for percentage, reset time, and summary severity.
- Settings/header view-model behavior with multiple provider instances.

Completion requires `vp check` and `vp run typecheck`.

## Future Extension: Weekly Budget Forecasting

The forecasting idea is clear: keep historical usage samples, estimate burn rate, and show whether the weekly budget is likely to last until the reset.

This should be a later slice because it needs persistence and confidence semantics beyond the current latest-snapshot projection.

Future work should add:

- A durable sample store keyed by provider instance and weekly window.
- Sampling on every usage update and possibly on app startup.
- A forecast model that compares historical weekly burn rate with time remaining until reset.
- Confidence labels such as low, medium, and high based on sample count and sample spacing.
- A settings/detail view that explains the estimate without overclaiming precision.

The current normalized contract should leave room for a separate `forecast` field later, but the first implementation should not calculate forecasts.
