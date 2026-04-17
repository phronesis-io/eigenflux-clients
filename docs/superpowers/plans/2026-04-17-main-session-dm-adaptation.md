# `main`-shaped Session DM Adaptation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plugin correctly auto-route to a Feishu DM when OpenClaw's session store places that DM in `agent:<agentId>:main` (legacy `dmScope=per-channel-peer` or OpenClaw 2026.4.14), while still never auto-posting to a group chat.

**Architecture:** Two orthogonal fixes in `src/notification-route-resolver.ts` — (1) tighten `isInternalSessionKey` to cover heartbeat sessions but stop catching legacy DMs, (2) add a group-exclusion filter to the auto-scan path of `selectBestRoute`. Knock out the three shape-based `:main` rejections downstream (`index.ts` twice, `notifier.ts` once) and replace them with real-capability checks (`replyChannel` + `replyTo`). Expand `isDirectSessionKey` to read entry-level `chatType` / target prefix as a sort tiebreaker.

**Tech Stack:** TypeScript, Jest with ts-jest, `pnpm test` / `pnpm build`.

**Spec:** [`docs/superpowers/specs/2026-04-17-main-session-dm-adaptation-design.md`](../specs/2026-04-17-main-session-dm-adaptation-design.md)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/notification-route-resolver.ts` | modify | Add `export` to `isInternalSessionKey` (update semantics), add `isGroupEntry`, expand `isDirectSessionKey`, wire group/internal filters into `selectBestRoute` auto-scan |
| `src/notifier.ts` | modify | Delete local `isInternalSessionKey` duplicate, import from resolver, update remembered-write gate |
| `src/index.ts` | modify | Replace `endsWith(':main')` rejections in `buildHereText` and `rememberCurrentCommandRouteIfPossible` with replyChannel+replyTo checks |
| `src/notification-route-resolver.test.ts` | modify | New unit + integration tests for `isInternalSessionKey`, `isDirectSessionKey`, `isGroupEntry`, auto-scan group exclusion, CLI-overwrite fall-through |
| `src/index.test.ts` | modify | New test for `/eigenflux here` succeeding on `agent:<id>:main` legacy DM |
| `src/notifier.test.ts` | modify | New tests for remembered-write: heartbeat rejected, legacy DM persisted |

No new files. No production code duplication after Task 2 (notifier pulls `isInternalSessionKey` from the resolver).

---

## Task 1: Update `isInternalSessionKey` semantics and export it

**Files:**
- Modify: `src/notification-route-resolver.ts:117-128`
- Test: `src/notification-route-resolver.test.ts` (new `describe('isInternalSessionKey')` block)

- [ ] **Step 1.1: Write the failing test**

Append to `src/notification-route-resolver.test.ts` (after existing top-level imports, before or inside the last `describe`):

```typescript
import { isInternalSessionKey } from './notification-route-resolver';

describe('isInternalSessionKey', () => {
  test('bare "main" is internal', () => {
    expect(isInternalSessionKey('main')).toBe(true);
  });

  test('bare "heartbeat" is internal', () => {
    expect(isInternalSessionKey('heartbeat')).toBe(true);
  });

  test('empty / whitespace is internal', () => {
    expect(isInternalSessionKey('')).toBe(true);
    expect(isInternalSessionKey('   ')).toBe(true);
  });

  test('agent:<id>:heartbeat is internal', () => {
    expect(isInternalSessionKey('agent:main:heartbeat')).toBe(true);
    expect(isInternalSessionKey('agent:mengtian:heartbeat')).toBe(true);
  });

  test('agent:<id>:main is NOT internal (legacy DM scope)', () => {
    expect(isInternalSessionKey('agent:main:main')).toBe(false);
    expect(isInternalSessionKey('agent:mengtian:main')).toBe(false);
  });

  test('channel-scoped keys are not internal', () => {
    expect(isInternalSessionKey('agent:main:feishu:direct:ou_123')).toBe(false);
    expect(isInternalSessionKey('agent:main:feishu:group:oc_456')).toBe(false);
    expect(isInternalSessionKey('agent:main:discord:direct:user789')).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run the test to confirm it fails**

Run: `pnpm test -- -t "isInternalSessionKey"`

Expected:
- `isInternalSessionKey` is not exported — compile error `Module './notification-route-resolver' has no exported member 'isInternalSessionKey'`, OR once export is added, the `agent:<id>:heartbeat` cases FAIL because the current implementation doesn't recognize heartbeat, and the `agent:<id>:main` cases FAIL because the current implementation says `true`.

- [ ] **Step 1.3: Update the implementation and export it**

In `src/notification-route-resolver.ts`, replace the existing `isInternalSessionKey` (lines 117-128) with:

```typescript
export function isInternalSessionKey(sessionKey: string): boolean {
  const trimmed = readNonEmptyString(sessionKey);
  if (!trimmed) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'main' || lower === 'heartbeat') {
    return true;
  }

  const parts = lower.split(':').filter((part) => part.length > 0);
  return parts[0] === 'agent' && parts[2] === 'heartbeat';
}
```

- [ ] **Step 1.4: Run the test to confirm it passes**

Run: `pnpm test -- -t "isInternalSessionKey"`

Expected: all six cases PASS.

- [ ] **Step 1.5: Commit**

```bash
git add src/notification-route-resolver.ts src/notification-route-resolver.test.ts
git commit -m "feat(resolver): relax isInternalSessionKey for legacy DM, add heartbeat"
```

---

## Task 2: Deduplicate `isInternalSessionKey` in notifier.ts

**Files:**
- Modify: `src/notifier.ts:440` (remove call to local function), `src/notifier.ts:470-478` (delete local function)

- [ ] **Step 2.1: Replace the duplicate function with an import**

In `src/notifier.ts`, change the import block at the top of the file:

```typescript
import {
  resolveNotificationRoute,
  isInternalSessionKey,
  type NotificationRouteConfig,
  type NotificationRouteSource,
  type ResolvedNotificationRoute,
  type ResolvedNotificationRouteResult,
} from './notification-route-resolver';
```

Then delete lines 470-478 entirely (the local `function isInternalSessionKey(...)`).

- [ ] **Step 2.2: Run the full test suite to confirm no regression**

Run: `pnpm test`

Expected: all tests pass; no TypeScript errors.

- [ ] **Step 2.3: Commit**

```bash
git add src/notifier.ts
git commit -m "refactor(notifier): import isInternalSessionKey from resolver"
```

---

## Task 3: Add `isGroupEntry` helper

**Files:**
- Modify: `src/notification-route-resolver.ts` (add helper near `isDirectSessionKey`)
- Test: `src/notification-route-resolver.test.ts` (new `describe('isGroupEntry')` block)

- [ ] **Step 3.1: Write the failing test**

Append to `src/notification-route-resolver.test.ts`:

```typescript
import { isGroupEntry } from './notification-route-resolver';

describe('isGroupEntry', () => {
  test('sessionKey with :group: is a group', () => {
    expect(isGroupEntry('agent:main:feishu:group:oc_123', {})).toBe(true);
  });

  test('sessionKey with :channel: is a group', () => {
    expect(isGroupEntry('agent:main:discord:channel:c_123', {})).toBe(true);
  });

  test('sessionKey with :room: is a group', () => {
    expect(isGroupEntry('agent:main:matrix:room:r_123', {})).toBe(true);
  });

  test('entry.chatType=group overrides DM-shaped key', () => {
    expect(
      isGroupEntry('agent:main:main', {
        deliveryContext: { channel: 'feishu', to: 'user:ou_1' },
        // simulating a pathological case
        chatType: 'group' as any,
      } as any)
    ).toBe(true);
  });

  test('entry.origin.chatType=group', () => {
    expect(
      isGroupEntry('agent:main:main', {
        origin: { provider: 'feishu', chatType: 'group' as any },
      } as any)
    ).toBe(true);
  });

  test('deliveryContext.to with chat: prefix is a group', () => {
    expect(
      isGroupEntry('agent:main:main', {
        deliveryContext: { channel: 'feishu', to: 'chat:oc_123' },
      } as any)
    ).toBe(true);
  });

  test('lastTo with channel: prefix is a group', () => {
    expect(
      isGroupEntry('agent:main:main', { lastTo: 'channel:c_123' } as any)
    ).toBe(true);
  });

  test('origin.to with room: prefix is a group', () => {
    expect(
      isGroupEntry('agent:main:main', { origin: { to: 'room:r_123' } } as any)
    ).toBe(true);
  });

  test('DM session is NOT a group', () => {
    expect(
      isGroupEntry('agent:main:main', {
        deliveryContext: { channel: 'feishu', to: 'user:ou_1' },
      } as any)
    ).toBe(false);
  });

  test('channel-scoped DM is NOT a group', () => {
    expect(
      isGroupEntry('agent:main:feishu:direct:ou_1', {
        deliveryContext: { channel: 'feishu', to: 'user:ou_1' },
      } as any)
    ).toBe(false);
  });

  test('empty entry with plain DM-shaped key is NOT a group', () => {
    expect(isGroupEntry('agent:main:main', {})).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run the test to confirm it fails**

Run: `pnpm test -- -t "isGroupEntry"`

Expected: compile error — `isGroupEntry` does not exist on the module.

- [ ] **Step 3.3: Implement the helper**

In `src/notification-route-resolver.ts`, add near the other shape helpers (right after `isDirectSessionKey`, around line 138):

```typescript
const GROUP_PEER_SHAPES = new Set(['group', 'channel', 'room']);
const GROUP_TARGET_PREFIXES = new Set(['chat', 'channel', 'room']);

function readChatTypeSignal(value: unknown): string | undefined {
  const normalized = readNonEmptyString(value)?.toLowerCase();
  return normalized && GROUP_PEER_SHAPES.has(normalized) ? normalized : undefined;
}

function readTargetPrefixSignal(value: unknown): string | undefined {
  const trimmed = readNonEmptyString(value);
  if (!trimmed) {
    return undefined;
  }
  const colonAt = trimmed.indexOf(':');
  if (colonAt <= 0) {
    return undefined;
  }
  const prefix = trimmed.slice(0, colonAt).toLowerCase();
  return GROUP_TARGET_PREFIXES.has(prefix) ? prefix : undefined;
}

export function isGroupEntry(sessionKey: string, entry: SessionStoreEntry): boolean {
  const parts = sessionKey.toLowerCase().split(':').filter(Boolean);
  if (parts.some((part) => GROUP_PEER_SHAPES.has(part))) {
    return true;
  }

  if (
    readChatTypeSignal((entry as { chatType?: unknown }).chatType) ||
    readChatTypeSignal(entry.origin?.chatType as unknown)
  ) {
    return true;
  }

  const toCandidates = [entry.deliveryContext?.to, entry.lastTo, entry.origin?.to];
  if (toCandidates.some((candidate) => readTargetPrefixSignal(candidate))) {
    return true;
  }

  return false;
}
```

Then extend the `SessionStoreEntry` type (around line 27-33) to include the optional fields we read:

```typescript
type SessionOriginLike = {
  provider?: unknown;
  to?: unknown;
  accountId?: unknown;
  chatType?: unknown;
};

type SessionStoreEntry = {
  updatedAt?: unknown;
  deliveryContext?: DeliveryContextLike;
  lastTo?: unknown;
  lastAccountId?: unknown;
  origin?: SessionOriginLike;
  chatType?: unknown;
};
```

- [ ] **Step 3.4: Run the test to confirm it passes**

Run: `pnpm test -- -t "isGroupEntry"`

Expected: all 10 cases PASS.

- [ ] **Step 3.5: Commit**

```bash
git add src/notification-route-resolver.ts src/notification-route-resolver.test.ts
git commit -m "feat(resolver): add isGroupEntry detection helper"
```

---

## Task 4: Auto-scan excludes groups and internal sessions

**Files:**
- Modify: `src/notification-route-resolver.ts:487-531` (`selectBestRoute` function)
- Test: `src/notification-route-resolver.test.ts` (new `describe('selectBestRoute auto-scan')` integration block using `resolveNotificationRoute`)

- [ ] **Step 4.1: Write the failing test**

Append to `src/notification-route-resolver.test.ts`:

```typescript
describe('auto-scan group exclusion', () => {
  function writeStore(entries: Record<string, unknown>): string {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-group-exclusion-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(sessionStorePath, JSON.stringify(entries), 'utf-8');
    return sessionStorePath;
  }

  test('legacy agent:<id>:main DM wins over a more recent group', async () => {
    const sessionStorePath = writeStore({
      'agent:main:main': {
        updatedAt: 1000,
        chatType: 'direct',
        deliveryContext: {
          channel: 'feishu',
          to: 'user:ou_dm',
          accountId: 'default',
        },
        origin: { provider: 'feishu', chatType: 'direct' },
        lastTo: 'user:ou_dm',
      },
      'agent:main:feishu:group:oc_group': {
        updatedAt: 9999,
        chatType: 'group',
        deliveryContext: {
          channel: 'feishu',
          to: 'chat:oc_group',
          accountId: 'default',
        },
      },
    });

    const { route, source } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(source).toBe('session-store');
    expect(route.sessionKey).toBe('agent:main:main');
    expect(route.replyTo).toBe('user:ou_dm');
  });

  test('when the only external entry is a group, auto-scan returns default', async () => {
    const sessionStorePath = writeStore({
      'agent:main:feishu:group:oc_group': {
        updatedAt: 9999,
        chatType: 'group',
        deliveryContext: {
          channel: 'feishu',
          to: 'chat:oc_group',
          accountId: 'default',
        },
      },
    });

    const { route, source } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(source).toBe('default');
    expect(route.sessionKey).toBe('main');
  });

  test('heartbeat entries with external deliveryContext are ignored', async () => {
    const sessionStorePath = writeStore({
      'agent:main:heartbeat': {
        updatedAt: 9999,
        deliveryContext: {
          channel: 'feishu',
          to: 'user:ou_dm',
          accountId: 'default',
        },
      },
    });

    const { source } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(source).toBe('default');
  });
});
```

- [ ] **Step 4.2: Run the test to confirm it fails**

Run: `pnpm test -- -t "auto-scan group exclusion"`

Expected:
- First test FAILS — today the group's `updatedAt=9999` wins over the DM's `updatedAt=1000`, so `route.sessionKey` comes back as `agent:main:feishu:group:oc_group`.
- Second test FAILS — today the group route gets returned as `source='session-store'`.
- Third test FAILS — today `agent:main:heartbeat` with feishu `deliveryContext` is selected.

- [ ] **Step 4.3: Add the group+internal filters to `selectBestRoute`**

In `src/notification-route-resolver.ts`, replace the `selectBestRoute` function body (lines 487-531) with:

```typescript
function selectBestRoute(
  snapshots: SessionStoreSnapshot[],
  preferred: PreferredRoute | undefined,
  preferredAgentId?: string
): RouteSelection | undefined {
  const candidates: RouteCandidate[] = [];
  const autoScan = preferred === undefined;

  for (const snapshot of snapshots) {
    const pathAgentId = tryDeriveAgentIdFromStorePath(snapshot.path);
    for (const [sessionKey, entry] of Object.entries(snapshot.store)) {
      if (sessionKey.includes(':subagent:')) {
        continue;
      }
      if (isInternalSessionKey(sessionKey)) {
        continue;
      }
      if (autoScan && isGroupEntry(sessionKey, entry)) {
        continue;
      }

      const route = extractRouteFromEntry(sessionKey, entry);
      if (!route || !routeMatchesPreferred(route, preferred)) {
        continue;
      }

      if (preferredAgentId && route.agentId !== preferredAgentId && pathAgentId !== preferredAgentId) {
        continue;
      }

      candidates.push({
        route,
        updatedAt: normalizeUpdatedAt(entry.updatedAt),
        isExternal: isExternalChannel(route.replyChannel),
        isDirect: isDirectSessionKey(sessionKey, entry),
      });
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const externalPool = candidates.filter((c) => c.isExternal);
  const channelPool = externalPool.length > 0 ? externalPool : candidates;

  const directPool = channelPool.filter((c) => c.isDirect);
  const finalPool = directPool.length > 0 ? directPool : channelPool;

  const chosen = finalPool.reduce((best, c) => (c.updatedAt > best.updatedAt ? c : best));
  return { route: chosen.route, updatedAt: chosen.updatedAt };
}
```

Note: `isDirectSessionKey(sessionKey, entry)` — the two-argument form — will be implemented in Task 5. For this step the one-argument form still exists; update the call site to pass both arguments (entry is the loop variable), and ensure Task 5's signature change lands before this compiles. If running tasks in order, perform Task 5 first if TypeScript complains here.

**If TypeScript complains about `isDirectSessionKey` arity before Task 5:** swap Task 4 and Task 5. The test in Step 4.1 still works once Task 5 lands and Task 4's filter is wired.

(Spec note: `isInternalSessionKey` is now applied in auto-scan too, catching any future edge case where a heartbeat session carries external deliveryContext. Keep this filter unconditional — preferred-mode callers shouldn't match heartbeat either.)

- [ ] **Step 4.4: Run the test to confirm it passes**

Run: `pnpm test -- -t "auto-scan group exclusion"`

Expected: all 3 cases PASS.

- [ ] **Step 4.5: Run the full resolver test file to catch regressions**

Run: `pnpm test src/notification-route-resolver.test.ts`

Expected: all tests in the file pass, including the existing `prefers remembered session route over dynamically fresher session when config is automatic` (which has a `agent:main:feishu:group:oc_newer` group entry that should now be filtered out in the auto-scan path — verify that test still passes because the remembered route is returned before auto-scan runs).

- [ ] **Step 4.6: Commit**

```bash
git add src/notification-route-resolver.ts src/notification-route-resolver.test.ts
git commit -m "feat(resolver): exclude groups and internal sessions from auto-scan"
```

---

## Task 5: Expand `isDirectSessionKey` with entry signals

**Files:**
- Modify: `src/notification-route-resolver.ts:134-137`
- Test: `src/notification-route-resolver.test.ts` (new cases)

(Execute this task **before** Task 4 if TypeScript errors during Task 4.3 about `isDirectSessionKey` arity.)

- [ ] **Step 5.1: Write the failing test**

Append to `src/notification-route-resolver.test.ts`:

```typescript
import { isDirectSessionKey } from './notification-route-resolver';

describe('isDirectSessionKey', () => {
  test('sessionKey parts contain "direct"', () => {
    expect(isDirectSessionKey('agent:main:feishu:direct:ou_1', {})).toBe(true);
  });

  test('sessionKey parts contain "dm"', () => {
    expect(isDirectSessionKey('agent:main:discord:dm:user1', {})).toBe(true);
  });

  test('entry.chatType=direct marks key as direct even without "direct" in sessionKey', () => {
    expect(
      isDirectSessionKey('agent:main:main', { chatType: 'direct' } as any)
    ).toBe(true);
  });

  test('entry.origin.chatType=direct is recognized', () => {
    expect(
      isDirectSessionKey('agent:main:main', { origin: { chatType: 'direct' } } as any)
    ).toBe(true);
  });

  test('deliveryContext.to with user: prefix is direct', () => {
    expect(
      isDirectSessionKey('agent:main:main', {
        deliveryContext: { to: 'user:ou_1' },
      } as any)
    ).toBe(true);
  });

  test('lastTo with user: prefix is direct', () => {
    expect(
      isDirectSessionKey('agent:main:main', { lastTo: 'user:ou_1' } as any)
    ).toBe(true);
  });

  test('group key is not direct', () => {
    expect(isDirectSessionKey('agent:main:feishu:group:oc_1', {})).toBe(false);
  });

  test('empty entry with plain key is not direct', () => {
    expect(isDirectSessionKey('agent:main:main', {})).toBe(false);
  });
});
```

- [ ] **Step 5.2: Run the test to confirm it fails**

Run: `pnpm test -- -t "isDirectSessionKey"`

Expected: compile error (not exported) + signature mismatch until we update.

- [ ] **Step 5.3: Update the implementation and export it**

Replace lines 134-137 of `src/notification-route-resolver.ts` with:

```typescript
export function isDirectSessionKey(sessionKey: string, entry: SessionStoreEntry): boolean {
  const parts = sessionKey.toLowerCase().split(':').filter(Boolean);
  if (parts.includes('direct') || parts.includes('dm')) {
    return true;
  }

  const chatType =
    readNonEmptyString((entry as { chatType?: unknown }).chatType)?.toLowerCase() ??
    readNonEmptyString(entry.origin?.chatType as unknown)?.toLowerCase();
  if (chatType === 'direct' || chatType === 'dm') {
    return true;
  }

  const toCandidates = [entry.deliveryContext?.to, entry.lastTo, entry.origin?.to];
  return toCandidates.some((candidate) => {
    const trimmed = readNonEmptyString(candidate);
    if (!trimmed) {
      return false;
    }
    const colonAt = trimmed.indexOf(':');
    if (colonAt <= 0) {
      return false;
    }
    return trimmed.slice(0, colonAt).toLowerCase() === 'user';
  });
}
```

Update the call site at what was line 514 inside `selectBestRoute` (now changed in Task 4) to pass `entry` as the second argument — the Task 4 code block above already uses `isDirectSessionKey(sessionKey, entry)`.

- [ ] **Step 5.4: Run the test to confirm it passes**

Run: `pnpm test -- -t "isDirectSessionKey"`

Expected: all 8 cases PASS.

- [ ] **Step 5.5: Commit**

```bash
git add src/notification-route-resolver.ts src/notification-route-resolver.test.ts
git commit -m "feat(resolver): accept entry signals in isDirectSessionKey"
```

---

## Task 6: Direct tiebreaker integration test

**Files:**
- Test: `src/notification-route-resolver.test.ts` (new integration case)

- [ ] **Step 6.1: Write the test**

Append to the `describe('auto-scan group exclusion')` block (or a new `describe('direct tiebreaker')` block):

```typescript
describe('direct tiebreaker', () => {
  test('most-recent DM wins regardless of key shape', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-direct-tiebreaker-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 100,
          chatType: 'direct',
          deliveryContext: { channel: 'feishu', to: 'user:ou_older', accountId: 'default' },
        },
        'agent:main:feishu:direct:ou_newer': {
          updatedAt: 500,
          chatType: 'direct',
          deliveryContext: { channel: 'feishu', to: 'user:ou_newer', accountId: 'default' },
        },
      }),
      'utf-8'
    );

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(route.replyTo).toBe('user:ou_newer');
  });

  test('channel-scoped DM beats legacy main DM when fresher', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-direct-tiebreaker-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 500,
          chatType: 'direct',
          deliveryContext: { channel: 'feishu', to: 'user:ou_older', accountId: 'default' },
        },
        'agent:main:feishu:direct:ou_newer': {
          updatedAt: 100,
          chatType: 'direct',
          deliveryContext: { channel: 'feishu', to: 'user:ou_newer', accountId: 'default' },
        },
      }),
      'utf-8'
    );

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(route.replyTo).toBe('user:ou_older');
    expect(route.sessionKey).toBe('agent:main:main');
  });
});
```

- [ ] **Step 6.2: Run the test**

Run: `pnpm test -- -t "direct tiebreaker"`

Expected: both cases PASS (Tasks 4+5 already delivered the behavior).

- [ ] **Step 6.3: Commit**

```bash
git add src/notification-route-resolver.test.ts
git commit -m "test(resolver): cover direct tiebreaker across key shapes"
```

---

## Task 7: Remove `:main` rejection in `buildHereText`

**Files:**
- Modify: `src/index.ts:594-600`
- Test: `src/index.test.ts` (new test for `/eigenflux here` in a legacy DM)

- [ ] **Step 7.1: Write the failing test**

Inside the `describe` block where the existing `/eigenflux here` test lives, add:

```typescript
test('succeeds for a legacy agent:<id>:main DM route', async () => {
  const serverDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
  fs.mkdirSync(serverDir, { recursive: true });

  // The harness mocks os.homedir() to homeDir (see the jest.mock at the top
  // of this file), so listSessionStorePaths will scan homeDir/.openclaw/agents/*.
  const sessionsRoot = path.join(homeDir, '.openclaw', 'agents', 'main', 'sessions');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsRoot, 'sessions.json'),
    JSON.stringify({
      'agent:main:main': {
        updatedAt: Date.now(),
        chatType: 'direct',
        deliveryContext: {
          channel: 'feishu',
          to: 'user:ou_legacy',
          accountId: 'default',
        },
        origin: { provider: 'feishu', chatType: 'direct', to: 'user:ou_legacy' },
        lastTo: 'user:ou_legacy',
      },
    }),
    'utf-8'
  );

  discoverServersMock.mockResolvedValue({
    kind: 'ok',
    servers: [{ name: 'eigenflux', endpoint: 'http://127.0.0.1:18080', current: true }],
  });

  const { default: plugin } = await import('./index');
  const services: any[] = [];
  const commands: any[] = [];
  plugin.register({
    config: {},
    pluginConfig: {
      serverRouting: {
        eigenflux: { agentId: 'main' },
      },
    },
    runtime: {},
    logger: createLogger(),
    registerService: (service: any) => services.push(service),
    registerCommand: (command: any) => commands.push(command),
    registerHook: jest.fn(),
    on: jest.fn(),
  } as any);

  await services[0].start();

  const hereResp = await commands[0].handler({
    args: 'here',
    channel: 'feishu',
    to: 'user:ou_legacy',
    accountId: 'default',
    getCurrentConversationBinding: jest.fn().mockResolvedValue({
      channel: 'feishu',
      accountId: 'default',
      conversationId: 'user:ou_legacy',
    }),
  });

  expect(hereResp.text).not.toContain('Unable to resolve');
  expect(hereResp.text).toContain('sessionKey: agent:main:main');
  expect(hereResp.text).toContain('target: user:ou_legacy');
});
```

- [ ] **Step 7.2: Run the test to confirm it fails**

Run: `pnpm test src/index.test.ts -- -t "legacy agent"`

Expected: FAIL because `buildHereText` returns `Unable to resolve the current external session…` due to the `endsWith(':main')` guard.

- [ ] **Step 7.3: Update `buildHereText`**

In `src/index.ts`, replace the guard at line 594-600:

```typescript
async function buildHereText(
  ctx: CommandRouteContext,
  runtime: ServerRuntime,
  eigenfluxBin: string,
  logger: Logger
): Promise<string> {
  const route = await resolveCurrentCommandRoute(ctx, runtime, logger);
  if (!route || !route.replyChannel || !route.replyTo) {
    return [
      `Unable to resolve the current external session for server=${runtime.server.name}.`,
      'Run `/eigenflux here` inside the target conversation after OpenClaw has already created a session for it.',
    ].join('\n');
  }
```

(Everything after the `if` block stays identical.)

- [ ] **Step 7.4: Update `rememberCurrentCommandRouteIfPossible` (line 626)**

Replace:

```typescript
async function rememberCurrentCommandRouteIfPossible(
  ctx: CommandRouteContext,
  runtime: ServerRuntime,
  eigenfluxBin: string,
  logger: Logger
): Promise<void> {
  const route = await resolveCurrentCommandRoute(ctx, runtime, logger);
  if (!route || !route.replyChannel || !route.replyTo) {
    return;
  }
```

(Everything after the `if` block stays identical.)

- [ ] **Step 7.5: Remove the now-unused local `isInternalSessionKey` if present**

Grep: `grep -n "isInternalSessionKey" src/index.ts`

If a local copy exists in `index.ts` (around lines 535-542 based on earlier inspection), delete it — no callers remain after Task 7.3/7.4.

- [ ] **Step 7.6: Run the test to confirm it passes**

Run: `pnpm test src/index.test.ts -- -t "legacy agent"`

Expected: PASS.

- [ ] **Step 7.7: Run the full test suite**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 7.8: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat(commands): accept legacy agent:<id>:main DM in /eigenflux here"
```

---

## Task 8: Update notifier remembered-write gate

**Files:**
- Modify: `src/notifier.ts:437-448`
- Test: `src/notifier.test.ts` (new cases)

- [ ] **Step 8.1: Write the failing tests**

Inspect the existing `describe('EigenFluxNotifier')` block to find how the notifier is exercised. Append two new cases testing `rememberRouteIfChanged` behavior via a successful delivery. A minimal form:

```typescript
test('persists a legacy agent:<id>:main DM route after delivery', async () => {
  const runSpy = jest.fn().mockResolvedValue({ runId: 'run-1' });
  const waitSpy = jest.fn().mockResolvedValue({ status: 'ok' });
  const api = createApi({
    runtime: {
      subagent: { run: runSpy, waitForRun: waitSpy },
    } as any,
  });

  const notifier = new EigenFluxNotifier(api, createLogger(), {
    ...createConfig(),
    sessionKey: 'agent:main:main',
    replyChannel: 'feishu',
    replyTo: 'user:ou_legacy',
    replyAccountId: 'default',
    openclawCliBin: 'openclaw',
    routeOverrides: {
      sessionKey: true,
      agentId: true,
      replyChannel: true,
      replyTo: true,
      replyAccountId: true,
    },
  } as any);

  const ok = await notifier.deliver('hello');
  expect(ok).toBe(true);
  expect(writeStoredNotificationRouteMock).toHaveBeenCalled();
  const savedRoute = writeStoredNotificationRouteMock.mock.calls[0][2];
  expect(savedRoute.sessionKey).toBe('agent:main:main');
  expect(savedRoute.replyTo).toBe('user:ou_legacy');
});

test('does NOT persist a route with an internal sessionKey (heartbeat)', async () => {
  const runSpy = jest.fn().mockResolvedValue({ runId: 'run-2' });
  const waitSpy = jest.fn().mockResolvedValue({ status: 'ok' });
  const api = createApi({
    runtime: {
      subagent: { run: runSpy, waitForRun: waitSpy },
    } as any,
  });

  const notifier = new EigenFluxNotifier(api, createLogger(), {
    ...createConfig(),
    sessionKey: 'agent:main:heartbeat',
    replyChannel: 'feishu',
    replyTo: 'user:ou_x',
    replyAccountId: 'default',
    openclawCliBin: 'openclaw',
    routeOverrides: {
      sessionKey: true,
      agentId: true,
      replyChannel: true,
      replyTo: true,
      replyAccountId: true,
    },
  } as any);

  await notifier.deliver('hello');
  expect(writeStoredNotificationRouteMock).not.toHaveBeenCalled();
});

test('does NOT persist a route missing replyChannel', async () => {
  const runSpy = jest.fn().mockResolvedValue({ runId: 'run-3' });
  const waitSpy = jest.fn().mockResolvedValue({ status: 'ok' });
  const api = createApi({
    runtime: {
      subagent: { run: runSpy, waitForRun: waitSpy },
    } as any,
  });

  const notifier = new EigenFluxNotifier(api, createLogger(), {
    ...createConfig(),
    sessionKey: 'agent:main:main',
    replyChannel: undefined,
    replyTo: undefined,
    replyAccountId: undefined,
    openclawCliBin: 'openclaw',
    routeOverrides: {
      sessionKey: true,
      agentId: true,
      replyChannel: true,
      replyTo: true,
      replyAccountId: true,
    },
  } as any);

  await notifier.deliver('hello');
  expect(writeStoredNotificationRouteMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 8.2: Run the tests to confirm behavior**

Run: `pnpm test src/notifier.test.ts -- -t "persists a legacy"`

Expected: the first test FAILS (after Tasks 1-7, `agent:main:main` is no longer internal — but the current notifier gate only blocks on `isInternalSessionKey`. So this test may PASS already. The failing test is really the third one: a route missing `replyChannel` should not be persisted; under current code it might be). Inspect actual failure and match the fix.

- [ ] **Step 8.3: Update `rememberRouteIfChanged`**

Replace `src/notifier.ts:433-455`:

```typescript
  private async rememberRouteIfChanged(
    route: ResolvedNotificationRoute,
    source: NotificationRouteSource
  ): Promise<void> {
    if (!route.sessionKey || !route.agentId) {
      return;
    }
    if (isInternalSessionKey(route.sessionKey)) {
      return;
    }
    if (!route.replyChannel || !route.replyTo) {
      return;
    }
    if (source === 'remembered') {
      this.logger.debug(
        `Skipping remembered-route write; route came from config (session_key=${route.sessionKey})`
      );
      return;
    }
    await writeStoredNotificationRoute(
      this.config.eigenfluxBin,
      this.config.serverName,
      route,
      this.logger
    );
  }
```

- [ ] **Step 8.4: Run the three notifier tests**

Run: `pnpm test src/notifier.test.ts -- -t "persists a legacy|does NOT persist"`

Expected: all three PASS.

- [ ] **Step 8.5: Run the full suite**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 8.6: Commit**

```bash
git add src/notifier.ts src/notifier.test.ts
git commit -m "feat(notifier): gate remembered-write on real capability, not shape"
```

---

## Task 9: Integration test — CLI overwrite fall-through

**Files:**
- Test: `src/notification-route-resolver.test.ts`

Covers spec case #2: `agent:main:main` has been overwritten by a non-external `deliveryContext` (CLI work), and the group is the only external candidate but must be filtered. Resolver should fall back to `source=default`; remembered route (if previously saved) still resolves correctly.

- [ ] **Step 9.1: Write the test**

Append to `src/notification-route-resolver.test.ts`:

```typescript
describe('CLI-overwritten main session fall-through', () => {
  test('auto-scan returns default when main is non-external and only groups remain', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-cli-overwrite-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 9000,
          // CLI overwrote deliveryContext — no external channel anymore
          deliveryContext: { channel: 'webchat' },
        },
        'agent:main:feishu:group:oc_group': {
          updatedAt: 500,
          chatType: 'group',
          deliveryContext: {
            channel: 'feishu',
            to: 'chat:oc_group',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const { source, route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(source).toBe('default');
    expect(route.sessionKey).toBe('main');
  });

  test('remembered DM route survives a main-session overwrite', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-cli-overwrite-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 9000,
          deliveryContext: { channel: 'webchat' },
        },
        'agent:main:feishu:group:oc_group': {
          updatedAt: 500,
          chatType: 'group',
          deliveryContext: {
            channel: 'feishu',
            to: 'chat:oc_group',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    readStoredNotificationRouteMock.mockResolvedValue({
      sessionKey: 'agent:main:main',
      agentId: 'main',
      replyChannel: 'feishu',
      replyTo: 'user:ou_dm',
      replyAccountId: 'default',
      updatedAt: 0,
    });

    const { source, route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(source).toBe('remembered');
    expect(route.sessionKey).toBe('agent:main:main');
    expect(route.replyTo).toBe('user:ou_dm');
  });
});
```

- [ ] **Step 9.2: Run the tests**

Run: `pnpm test -- -t "CLI-overwritten main session fall-through"`

Expected: both PASS. If the remembered case fails, inspect whether the remembered path (`resolveNotificationRoute` lines 665-706) correctly accepts `agent:main:main` — after Task 1's `isInternalSessionKey` relaxation it should.

- [ ] **Step 9.3: Commit**

```bash
git add src/notification-route-resolver.test.ts
git commit -m "test(resolver): cover CLI-overwritten main session fall-through"
```

---

## Task 10: Full build and suite verification

- [ ] **Step 10.1: Run the TypeScript build**

Run: `pnpm build`

Expected: success, no type errors.

- [ ] **Step 10.2: Run the full test suite**

Run: `pnpm test`

Expected: all tests pass, including the pre-existing tests.

- [ ] **Step 10.3: Manual log review (optional, if a real OpenClaw install is available)**

Drop the built `dist/` into an OpenClaw install that exhibits the bug, or run the plugin against a fixture that mirrors the user's `agents/main/sessions/sessions.json`. Look for log lines:

- `Route resolve from session store: session_key=agent:main:main, …, to=user:…` (DM chosen over group)
- `/eigenflux here` returns `sessionKey: agent:main:main, target: user:…` instead of the Unable-to-resolve error

- [ ] **Step 10.4: Version bump and final commit**

If this change ships as a new plugin version, run:

```bash
pnpm bump-version 0.0.8
git add package.json openclaw.plugin.json src/version.ts
git commit -m "chore: bump plugin version to 0.0.8"
```

(Skip this step if the user hasn't requested a release.)

---

## Self-Review Notes

- **Spec coverage.** All six testing cases from the spec map to tasks: #1 → Task 4.1; #2 → Task 9.1; #3 → existing `findSessionRouteForBinding` tests (unchanged, verified in Task 10.2); #4 → Task 7.1; #5 → Task 4.1 (third case) + Task 8.1 (heartbeat reject); #6 → Task 6.1.
- **Shape vs. entry checks.** `isDirectSessionKey` in Task 5 and `isGroupEntry` in Task 3 both take `(sessionKey, entry)` — consistent naming and arity.
- **Ordering.** Task 4.3 references the two-arg form of `isDirectSessionKey` introduced in Task 5. The plan notes this and suggests swapping if TypeScript complains; subagent-driven execution will naturally surface the compile error on Task 4.3 and switch.
- **DRY.** Task 2 removes the duplicate `isInternalSessionKey`, consolidating semantics in one file.
- **No placeholders.** Every step contains either exact code or an exact command with expected output.
