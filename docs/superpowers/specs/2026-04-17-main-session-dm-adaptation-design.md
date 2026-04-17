# `main`-shaped Session DM Adaptation

**Date:** 2026-04-17
**Status:** Approved — ready for implementation plan

## Background

OpenClaw supports a session configuration option `"session": { "dmScope": "per-channel-peer" }` (and other scopes). Under some configurations — and in older runtime versions — a Feishu direct-message conversation lands in `agent:<agentId>:main` rather than a channel-scoped key like `agent:<agentId>:feishu:direct:<user>`.

A real user backup (OpenClaw `2026.4.14`, `zhaoweiciwork`) shows:

| sessionKey | chatType | deliveryContext |
|---|---|---|
| `agent:main:main` | `direct` | `{ channel: "feishu", to: "user:ou_…", accountId: "default" }` |
| `agent:main:feishu:group:oc_907200a7962a5d4c952eeedc6e217069` | `group` | `{ channel: "feishu", to: "chat:oc_…" }` |

Even though `agent:main:main`'s `deliveryContext` correctly describes a Feishu DM, the plugin rejects it, producing two user-visible symptoms:

1. `/eigenflux here` inside the DM returns `Unable to resolve the current external session`.
2. Notifications land in the group chat instead of the DM.

## Root causes

| File:line | Check | Failure on legacy key |
|---|---|---|
| `src/notification-route-resolver.ts:117-128` | `isInternalSessionKey` treats `agent:*:main` as internal | blocks `hasExplicitConfig` and remembered-direct-return for a legitimate DM |
| `src/notification-route-resolver.ts:134-137` | `isDirectSessionKey` reads only sessionKey parts | ignores `chatType=direct` evidence carried on the entry |
| `src/index.ts:595, 626` | `route.sessionKey.endsWith(':main')` hard-reject inside `buildHereText` and `rememberCurrentCommandRouteIfPossible` | rejects a valid DM route that `findSessionRouteForBinding` already resolved |
| `src/notifier.ts:440` | `isInternalSessionKey` gate on remembered-route write | prevents persisting a valid DM route after `/eigenflux here` |

Additionally, `agent:main:main` is volatile: any `openclaw agent` CLI invocation rewrites its `deliveryContext` to the CLI's own context. When that happens, the DM entry ceases to look external, `extractRouteFromEntry` returns `undefined`, and auto-scan picks the group as the only remaining external candidate.

## Design

Two orthogonal changes plus one semantic clarification on `isInternalSessionKey`.

### 1. Group exclusion in auto-scan

Introduce a `isGroupEntry(sessionKey, entry)` helper in `notification-route-resolver.ts`. In `selectBestRoute`, when invoked with **no** `preferred` argument (pure auto-scan), exclude any entry where `isGroupEntry` returns true. Call sites that pass `preferred` (`findSessionRouteForBinding`, config-pinned channel+to, remembered-route peer match) are unaffected — explicit user intent still wins.

**Group detection signals (any hit ⇒ group):**

- sessionKey parts contain one of `group`, `channel`, `room` as a peer-shape token
- `entry.chatType ∈ {group, channel, room}` or `entry.origin.chatType ∈ {group, channel, room}`
- `entry.deliveryContext.to` / `entry.lastTo` / `entry.origin.to` starts with `chat:`, `channel:`, or `room:`

**DM peer-shapes kept eligible:** `direct`, `dm`, `to` starting with `user:`, `chatType = direct`.

**Motivating rule (user-approved):** the plugin must never auto-deliver to a group. Only an explicit `/eigenflux here` inside the group creates a remembered override; in that case the remembered route carries through all paths that accept `preferred`.

### 2. `isInternalSessionKey` semantics clarified

`isInternalSessionKey` now means *"OpenClaw's own self-triggered session; never a user conversation."*

**After change:**

| sessionKey | internal? | note |
|---|---|---|
| `main` (bare) | yes | unchanged |
| `heartbeat` (bare) | **yes (new)** | OpenClaw heartbeat scheduler occasionally spawns a session with this bare name |
| `agent:<id>:heartbeat` | **yes (new)** | same reason |
| `agent:<id>:main` | **no (changed)** | legacy DM scope legitimately uses this key |
| anything with a `group`/`channel`/`room` peer shape | no | groups are not internal; group exclusion lives in `selectBestRoute`, not here |
| all other channel-scoped keys | no | unchanged |

Groups are deliberately *not* considered internal here — the two concerns are kept orthogonal so `/eigenflux here` inside a group still works.

### 3. Remove shape-based `:main` rejections

Three downstream gates currently reject any route whose sessionKey ends in `:main`. Replace each with a real-capability check (`route.replyChannel` + `route.replyTo` present and external).

- `src/index.ts:595` in `buildHereText` — current: `!route || route.sessionKey === 'main' || route.sessionKey.endsWith(':main')`; new: `!route || !route.replyChannel || !route.replyTo`.
- `src/index.ts:626` in `rememberCurrentCommandRouteIfPossible` — same replacement.
- `src/notifier.ts:440` remembered-route write gate — keep `isInternalSessionKey(route.sessionKey)` as one condition (so bare `main`, bare `heartbeat`, `agent:*:heartbeat` are still never persisted), and additionally require `route.replyChannel` to be external and `route.replyTo` to be present. Under the new `isInternalSessionKey` semantics, `agent:*:main` is no longer internal, so a legacy DM will pass this gate.

### 4. Direct-signal tiebreaker

Expand `isDirectSessionKey` to accept entry-level signals when sessionKey parts give no answer:

- `entry.chatType === 'direct'` or `entry.origin.chatType === 'direct'`
- `entry.deliveryContext.to` / `lastTo` / `origin.to` starts with `user:`

After group exclusion, the remaining pool is mostly DMs already, so this is a defense-in-depth tiebreaker for mixed scenarios where a legacy `agent:<id>:main` DM coexists with one or more channel-scoped DMs.

### 5. Delivery side unchanged

`runtime.subagent.run({ sessionKey })` and `runtime.system.enqueueSystemEvent({ sessionKey, deliveryContext })` accept `agent:main:main` verbatim — OpenClaw itself created that session and knows how to reply through Feishu. The notifier already passes an explicit `deliveryContext` on the heartbeat path (`notifier.ts:280`), which provides resilience when the session's own `deliveryContext` has been overwritten between persist and deliver.

## Non-goals

- **No synthetic sessionKey fabrication.** The legacy key is honored verbatim.
- **No feature flag.** Changes are purely additive-compatible; no previously-accepted route becomes rejected.
- **No OpenClaw version gating.** Logic observes entry shape, not runtime version.

## Testing

New cases across `src/notification-route-resolver.test.ts`, `src/index.test.ts`, and `src/notifier.test.ts`:

1. **Legacy DM auto-scan.** Snapshot contains `agent:main:main` (DM, Feishu `deliveryContext`) + `agent:main:feishu:group:<id>` (group, more recent `updatedAt`). Auto-scan must return the DM.
2. **Legacy DM overwritten by CLI.** `agent:main:main` carries a non-external `deliveryContext`; the group is the only remaining external candidate but is excluded by group-filter. `selectBestRoute` returns `undefined`, the resolver returns `source = "default"`. A previously-persisted remembered route continues to resolve to the DM via the remembered path.
3. **Explicit group binding is respected.** `/eigenflux here` inside a group persists the group route; subsequent notifications deliver to the group (remembered overrides auto-scan).
4. **`:main` no longer rejected at the command.** `buildHereText` returns the success text (not `Unable to resolve…`) when `findSessionRouteForBinding` returns a route with real channel+to and sessionKey `agent:main:main`.
5. **`heartbeat` skipped.** Snapshot contains `agent:main:heartbeat` with `deliveryContext.channel = feishu` and `to = user:ou_…`; it must not be selected by auto-scan and must not pass the notifier remembered-write gate.
6. **Direct-signal tiebreaker.** Two external DM candidates, one channel-scoped, one `agent:<id>:main`; the more-recently-updated one wins regardless of key shape.

## Backward compatibility

All channel-scoped flows (`agent:<id>:feishu:direct:<user>`, `agent:<id>:discord:direct:<user>`, etc.) continue to select and deliver exactly as before — the group filter is a no-op on entries that were already DMs, and removing the `:main` rejections cannot change behavior for keys that don't end in `:main`.

## Migration

No user action required. On next plugin load:

- Users whose notifications were misrouted to groups see delivery return to the DM automatically.
- Users who explicitly pinned a group via `/eigenflux here` keep that binding (remembered override is respected).
- `/eigenflux here` now succeeds inside a legacy DM and persists the route.

## Out-of-scope observations

- OpenClaw versions that eventually migrate to channel-scoped DM keys will produce `agent:<id>:feishu:direct:<user>` entries alongside the legacy `agent:main:main`. Both will co-exist in the store; the direct-signal tiebreaker plus `updatedAt` ordering handles the overlap naturally.
- If OpenClaw begins marking heartbeat sessions with a different sentinel name in the future, `isInternalSessionKey` will need another entry. This is not designed as an extensible list today (two sentinels are plenty); revisit when it grows.
