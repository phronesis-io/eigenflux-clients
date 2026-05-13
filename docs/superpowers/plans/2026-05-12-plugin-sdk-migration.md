# OpenClaw Plugin SDK Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the openclaw-eigenflux plugin from a legacy manual export to the official OpenClaw Plugin SDK (`definePluginEntry`), adopt SDK utilities (`runtime-store`, `channel-route`), and modernize types.

**Architecture:** Replace the hand-rolled plugin object with `definePluginEntry()` from `openclaw/plugin-sdk/plugin-entry`. Guard side effects behind `registrationMode === 'full'`. Replace CLI-based session route persistence with `plugin-sdk/runtime-store`. Delegate generic route normalization to `plugin-sdk/channel-route` while keeping EigenFlux-specific logic. Remove the hand-rolled `.d.ts` stubs in favor of the official SDK types.

**Tech Stack:** TypeScript 5.x, OpenClaw SDK 2026.5.x, tsup, Jest

---

## File Structure

| File | Role | Change |
|------|------|--------|
| `package.json` | Package metadata | Add `openclaw` devDep, `runtimeExtensions`, bump compat |
| `openclaw.plugin.json` | Plugin manifest | Add `activation`, `contracts` |
| `src/openclaw-plugin-sdk.d.ts` | Hand-rolled type stubs | **Delete** |
| `src/index.ts` | Plugin entry | `definePluginEntry()`, `registrationMode` guard |
| `src/logger.ts` | Logger wrapper | Type with `PluginLogger`, remove `any` |
| `src/notifier.ts` | Notification delivery | Type runtime API, use SDK types |
| `src/session-route-memory.ts` | Route persistence | Rewrite to use `runtime-store` |
| `src/reply-target.ts` | Route normalization | Delegate generic normalization to `channel-route` |
| `src/config.ts` | Config resolution | Remove `PLUGIN_CONFIG_SCHEMA`, bump version |
| `tsup.config.ts` | Build config | Verify external patterns |
| `src/index.test.ts` | Plugin tests | Update for `definePluginEntry` shape |
| `src/notifier.test.ts` | Notifier tests | Update mock API type |
| `src/notification-route-resolver.test.ts` | Route resolver tests | Update for `runtime-store` |

---

### Task 1: Install SDK and Update Package Metadata

**Files:**
- Modify: `package.json`
- Modify: `openclaw.plugin.json`
- Modify: `tsup.config.ts`

- [ ] **Step 1: Install openclaw as devDependency**

Run: `pnpm add -D openclaw@latest`

Expected: `openclaw` appears in `devDependencies` with a 2026.5.x version.

- [ ] **Step 2: Update package.json openclaw metadata**

In `package.json`, update the `openclaw` section:

```json
{
  "openclaw": {
    "extensions": ["./index.ts"],
    "runtimeExtensions": ["./dist/index.js"],
    "compat": {
      "pluginApi": ">=2026.5.2",
      "minGatewayVersion": "2026.5.2"
    },
    "build": {
      "openclawVersion": "2026.5.2",
      "pluginSdkVersion": "2026.5.2"
    }
  }
}
```

- [ ] **Step 3: Update openclaw.plugin.json manifest**

Replace the contents of `openclaw.plugin.json` with:

```json
{
  "id": "openclaw-eigenflux",
  "name": "EigenFlux",
  "version": "0.0.9",
  "description": "CLI-based EigenFlux delivery for OpenClaw with server discovery, feed polling, and PM streaming",
  "activation": {
    "onStartup": true
  },
  "contracts": {},
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "eigenfluxBin": {
        "type": "string",
        "description": "Path to the eigenflux CLI binary",
        "default": "eigenflux"
      },
      "openclawCliBin": {
        "type": "string",
        "description": "OpenClaw CLI binary used by runtime command fallbacks",
        "default": "openclaw"
      }
    }
  }
}
```

- [ ] **Step 4: Verify tsup external patterns cover SDK subpaths**

In `tsup.config.ts`, the current `external` already has `['openclaw', /^openclaw\//]`. This covers all `openclaw/plugin-sdk/*` subpath imports. No change needed — just verify.

- [ ] **Step 5: Bump version via script**

Run: `pnpm bump-version 0.0.9`

Expected: `package.json`, `openclaw.plugin.json`, and `src/config.ts` all show version `0.0.9`.

- [ ] **Step 6: Verify build**

Run: `pnpm build`

Expected: Build succeeds (skills copy + tsup compile). No errors.

- [ ] **Step 7: Commit**

```bash
git add package.json openclaw.plugin.json pnpm-lock.yaml tsup.config.ts src/config.ts
git commit -m "chore: install openclaw SDK, update manifest and compat versions to 2026.5.x"
```

---

### Task 2: Delete Type Stubs and Adopt SDK Types

**Files:**
- Delete: `src/openclaw-plugin-sdk.d.ts`
- Modify: `src/index.ts` (import path)
- Modify: `src/notifier.ts` (import path)
- Modify: `src/notifier.test.ts` (import path)

- [ ] **Step 1: Delete the hand-rolled type stubs**

Delete the file `src/openclaw-plugin-sdk.d.ts`.

- [ ] **Step 2: Verify imports resolve to official SDK**

The three files that import from `'openclaw/plugin-sdk'` are:
- `src/index.ts:1` — `import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';`
- `src/notifier.ts:2` — `import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';`
- `src/notifier.test.ts:4` — `import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';`

These imports should now resolve to the official SDK types from the installed `openclaw` package. No import path changes needed yet — the main `openclaw/plugin-sdk` subpath exports the core types.

- [ ] **Step 3: Verify build still compiles**

Run: `pnpm build`

Expected: Build succeeds. If there are type errors, they indicate where the hand-rolled types diverged from the official SDK — fix any type mismatches.

- [ ] **Step 4: Run tests**

Run: `pnpm test`

Expected: All tests pass. The type stubs were only used at compile time, so runtime behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add -u src/openclaw-plugin-sdk.d.ts
git commit -m "chore: remove hand-rolled plugin SDK type stubs, use official openclaw types"
```

---

### Task 3: Adopt `definePluginEntry()` and `registrationMode` Guard

**Files:**
- Modify: `src/index.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Update src/config.ts — remove PLUGIN_CONFIG_SCHEMA export**

The `configSchema` now lives only in the manifest (`openclaw.plugin.json`). In `src/config.ts`, remove the `PLUGIN_CONFIG_SCHEMA` export. Find and delete lines 286-301:

```typescript
// DELETE this entire block from src/config.ts:
export const PLUGIN_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    eigenfluxBin: {
      type: 'string',
      description: 'Path to the eigenflux CLI binary',
      default: DEFAULT_EIGENFLUX_BIN,
    },
    openclawCliBin: {
      type: 'string',
      description: 'OpenClaw CLI binary used by runtime command fallbacks',
      default: DEFAULT_OPENCLAW_CLI_BIN,
    },
  },
} as const;
```

- [ ] **Step 2: Update src/index.ts — adopt definePluginEntry**

Replace the import and plugin definition at the top and bottom of `src/index.ts`:

**Replace the import (line 1):**
```typescript
// Before:
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

// After:
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
```

**Replace the plugin export (lines 188-196):**
```typescript
// Before:
const plugin = {
  id: 'openclaw-eigenflux',
  name: 'EigenFlux',
  description: 'OpenClaw extension for EigenFlux with CLI-based feed polling and PM streaming',
  configSchema: PLUGIN_CONFIG_SCHEMA,
  register,
};

export default plugin;

// After:
export default definePluginEntry({
  id: 'openclaw-eigenflux',
  name: 'EigenFlux',
  description: 'OpenClaw extension for EigenFlux with CLI-based feed polling and PM streaming',
  register(api) {
    if (api.registrationMode !== 'full') return;
    registerPlugin(api);
  },
});
```

**Rename the existing `register` function to `registerPlugin`** (line 97):
```typescript
// Before:
function register(api: OpenClawPluginApi): void {

// After:
function registerPlugin(api: OpenClawPluginApi): void {
```

**Remove the `PLUGIN_CONFIG_SCHEMA` import** from `src/index.ts` (it was imported from `./config`). Update the import on line 15:
```typescript
// Before:
import {
  PLUGIN_CONFIG,
  PLUGIN_CONFIG_SCHEMA,
  resolvePluginConfig,
  ...
} from './config';

// After:
import {
  PLUGIN_CONFIG,
  resolvePluginConfig,
  ...
} from './config';
```

- [ ] **Step 3: Verify build**

Run: `pnpm build`

Expected: Build succeeds. `definePluginEntry` wraps the plugin object and the `registrationMode` guard is in place.

- [ ] **Step 4: Update tests for new plugin shape**

In `src/index.test.ts`, the tests call `plugin.register(...)` directly. With `definePluginEntry`, the returned object still has a `register` method, but we need to ensure the mock API includes `registrationMode: 'full'` so the guard passes.

In `src/index.test.ts`, find every call to `plugin.register({...} as any)` (there are ~12 occurrences) and add `registrationMode: 'full'` to the mock API object. For example:

```typescript
// Before:
plugin.register({
  config: {},
  pluginConfig: {},
  runtime: { subagent: { run: subagentRun } },
  logger: createLogger(),
  registerService: (service: any) => services.push(service),
  registerCommand: jest.fn(),
  registerHook: jest.fn(),
  on: jest.fn(),
} as any);

// After:
plugin.register({
  registrationMode: 'full',
  config: {},
  pluginConfig: {},
  runtime: { subagent: { run: subagentRun } },
  logger: createLogger(),
  registerService: (service: any) => services.push(service),
  registerCommand: jest.fn(),
  registerHook: jest.fn(),
  on: jest.fn(),
} as any);
```

Apply this to every `plugin.register({` call in the test file.

- [ ] **Step 5: Add a test for registrationMode guard**

Add a new test at the end of the `describe('register unit')` block in `src/index.test.ts`:

```typescript
test('skips registration when registrationMode is not full', async () => {
  const { default: plugin } = await import('./index');
  const services: any[] = [];
  const commands: any[] = [];

  plugin.register({
    registrationMode: 'discovery',
    config: {},
    pluginConfig: {},
    runtime: {},
    logger: createLogger(),
    registerService: (service: any) => services.push(service),
    registerCommand: (command: any) => commands.push(command),
    registerHook: jest.fn(),
    on: jest.fn(),
  } as any);

  expect(services).toHaveLength(0);
  expect(commands).toHaveLength(0);
});
```

- [ ] **Step 6: Run tests**

Run: `pnpm test`

Expected: All tests pass, including the new `registrationMode` guard test.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/config.ts src/index.test.ts
git commit -m "feat: adopt definePluginEntry and registrationMode guard"
```

---

### Task 4: Clean Up Logger Types

**Files:**
- Modify: `src/logger.ts`

- [ ] **Step 1: Type the Logger class with SDK's PluginLogger**

Replace the entire contents of `src/logger.ts`:

```typescript
import type { PluginLogger } from 'openclaw/plugin-sdk';

/**
 * Logger wrapper that prefixes all messages with [EigenFlux].
 */
export class Logger {
  private baseLogger: PluginLogger;

  constructor(baseLogger: PluginLogger) {
    this.baseLogger = baseLogger;
  }

  info(message: string, ...args: unknown[]): void {
    this.baseLogger.info(`[EigenFlux] ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.baseLogger.warn(`[EigenFlux] ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.baseLogger.error(`[EigenFlux] ${message}`, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    (this.baseLogger as any).debug?.(`[EigenFlux] ${message}`, ...args);
  }
}
```

Note: `debug` may not be present on all `PluginLogger` implementations (it's optional in the SDK interface), so we keep the optional chaining with a cast for that one method.

- [ ] **Step 2: Verify build**

Run: `pnpm build`

Expected: Build succeeds. If `PluginLogger` doesn't export from `openclaw/plugin-sdk`, check the actual SDK exports and adjust the import path. The type may be at `openclaw/plugin-sdk` or a more specific subpath.

- [ ] **Step 3: Run tests**

Run: `pnpm test`

Expected: All tests pass. Logger behavior is identical.

- [ ] **Step 4: Commit**

```bash
git add src/logger.ts
git commit -m "refactor: type Logger with SDK PluginLogger, remove any casts"
```

---

### Task 5: Type the Runtime API in Notifier

**Files:**
- Modify: `src/notifier.ts`

- [ ] **Step 1: Extract runtime type interface**

The notifier currently casts `api.runtime` to ad-hoc inline types 4 times. Consolidate these into a single interface at the top of `src/notifier.ts`.

After the existing imports (line 13), add:

```typescript
/**
 * Typed subset of the OpenClaw runtime API used by the notifier.
 * Avoids ad-hoc inline casts throughout the delivery methods.
 */
type EigenFluxRuntimeApi = {
  subagent?: {
    run?: (params: {
      sessionKey: string;
      message: string;
      deliver?: boolean;
      idempotencyKey?: string;
    }) => Promise<{ runId: string }>;
    waitForRun?: (params: {
      runId: string;
      timeoutMs?: number;
    }) => Promise<{ status: 'ok' | 'error' | 'timeout'; error?: string }>;
  };
  system?: {
    enqueueSystemEvent?: (
      text: string,
      options: {
        sessionKey: string;
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
        };
      }
    ) => boolean;
    requestHeartbeatNow?: (options: {
      reason?: string;
      coalesceMs?: number;
      agentId?: string;
      sessionKey?: string;
    }) => void;
    runCommandWithTimeout?: CommandRunner;
  };
};
```

- [ ] **Step 2: Add a runtime accessor method to the class**

Add a private method to `EigenFluxNotifier` that casts `api.runtime` once:

```typescript
private get runtime(): EigenFluxRuntimeApi {
  return (this.api.runtime ?? {}) as EigenFluxRuntimeApi;
}
```

- [ ] **Step 3: Replace inline casts in delivery methods**

In `tryNotifyViaRuntimeSubagent` (around line 155), replace:
```typescript
// Before:
const runtimeSubagent = (this.api.runtime as
  | {
      subagent?: {
        run?: (...) => ...;
        waitForRun?: (...) => ...;
      };
    }
  | undefined)?.subagent;

// After:
const runtimeSubagent = this.runtime.subagent;
```

In `tryNotifyViaRuntimeHeartbeat` (around line 240), replace:
```typescript
// Before:
const runtimeSystem = (this.api.runtime as
  | {
      system?: {
        enqueueSystemEvent?: (...) => ...;
        requestHeartbeatNow?: (...) => ...;
      };
    }
  | undefined)?.system;

// After:
const runtimeSystem = this.runtime.system;
```

In `runRuntimeCommand` (around line 321), replace:
```typescript
// Before:
const runtimeCommand = (this.api.runtime as
  | {
      system?: {
        runCommandWithTimeout?: CommandRunner;
      };
    }
  | undefined)?.system?.runCommandWithTimeout;

// After:
const runtimeCommand = this.runtime.system?.runCommandWithTimeout;
```

- [ ] **Step 4: Verify build**

Run: `pnpm build`

Expected: Build succeeds. All runtime access is now through the typed `runtime` accessor.

- [ ] **Step 5: Run tests**

Run: `pnpm test`

Expected: All tests pass. Runtime behavior is identical — this is a type-only refactor.

- [ ] **Step 6: Commit**

```bash
git add src/notifier.ts
git commit -m "refactor: consolidate runtime API casts into typed EigenFluxRuntimeApi interface"
```

---

### Task 6: Adopt `plugin-sdk/runtime-store` for Session Route Memory

**Files:**
- Modify: `src/session-route-memory.ts`
- Modify: `src/notifier.ts` (pass store instead of eigenfluxBin)
- Modify: `src/index.ts` (create store, pass to notifier)
- Modify: `src/notification-route-resolver.ts` (read from store)
- Modify: `src/index.test.ts` (update mocks)
- Modify: `src/notifier.test.ts` (update mocks)

- [ ] **Step 1: Write failing test for runtime-store-based session memory**

Create a new test to verify the runtime-store API. In `src/session-route-memory.ts`, the public API stays the same but the implementation changes. First, update the import expectations.

Add a mock for the runtime store at the top of `src/index.test.ts` (after the existing mocks):

```typescript
// Mock runtime-store from plugin SDK
const runtimeStoreMock = {
  get: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue(undefined),
};

jest.mock('openclaw/plugin-sdk/runtime-store', () => ({
  createPluginRuntimeStore: jest.fn().mockReturnValue(runtimeStoreMock),
}));
```

Update the `/eigenflux here` test (the one titled `'supports /eigenflux here and persists the current conversation route'`) to verify the store is called instead of `execEigenflux`:

```typescript
// Replace the assertion block that checks execEigenfluxMock for config set:
// Before:
// const configSetCall = execEigenfluxMock.mock.calls.find(...)
// expect(configSetCall).toBeDefined();
// ...

// After:
expect(runtimeStoreMock.set).toHaveBeenCalledWith(
  'deliver_session:eigenflux',
  expect.objectContaining({
    sessionKey: 'agent:mengtian:feishu:direct:ou_current',
    agentId: 'mengtian',
    replyChannel: 'feishu',
    replyTo: 'user:ou_current',
    replyAccountId: 'default',
  })
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --testPathPattern index.test`

Expected: FAIL — the current implementation still uses `execEigenflux` for config set, not the runtime store.

- [ ] **Step 3: Rewrite session-route-memory.ts to use runtime-store**

Replace the entire contents of `src/session-route-memory.ts`:

```typescript
import { Logger } from './logger';
import { normalizeReplyTarget } from './reply-target';

export const DELIVER_SESSION_KEY_PREFIX = 'deliver_session';

export type StoredNotificationRoute = {
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  updatedAt: number;
};

export type PluginRuntimeStore = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
};

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeChannel(value: unknown): string | undefined {
  return readNonEmptyString(value)?.toLowerCase();
}

function storeKey(serverName: string): string {
  return `${DELIVER_SESSION_KEY_PREFIX}:${serverName}`;
}

/**
 * Reads the remembered delivery route for a server from the plugin runtime store.
 */
export async function readStoredNotificationRoute(
  store: PluginRuntimeStore | undefined,
  serverName: string | undefined,
  logger: Logger
): Promise<StoredNotificationRoute | undefined> {
  const server = readNonEmptyString(serverName);
  if (!store || !server) {
    return undefined;
  }

  try {
    const parsed = await store.get(storeKey(server));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const sessionKey = readNonEmptyString(record.sessionKey);
    const agentId = readNonEmptyString(record.agentId);
    if (!sessionKey || !agentId) {
      logger.warn(
        `Remembered route entry for server=${server} is incomplete (sessionKey/agentId missing)`
      );
      return undefined;
    }

    const route: StoredNotificationRoute = {
      sessionKey,
      agentId,
      replyChannel: normalizeChannel(record.replyChannel),
      replyTo: normalizeReplyTarget(readNonEmptyString(record.replyTo), {
        channel: normalizeChannel(record.replyChannel),
        sessionKey,
      }),
      replyAccountId: readNonEmptyString(record.replyAccountId),
      updatedAt:
        typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
          ? record.updatedAt
          : 0,
    };
    logger.info(
      `Remembered route loaded: server=${server}, session_key=${route.sessionKey}, agent_id=${route.agentId}, channel=${route.replyChannel ?? 'n/a'}, to=${route.replyTo ?? 'n/a'}, account=${route.replyAccountId ?? 'n/a'}`
    );
    return route;
  } catch (error) {
    logger.debug(
      `readStoredNotificationRoute: store.get failed for server=${server}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

/**
 * Persists the remembered delivery route for a server via the plugin runtime store.
 */
export async function writeStoredNotificationRoute(
  store: PluginRuntimeStore | undefined,
  serverName: string | undefined,
  route: Omit<StoredNotificationRoute, 'updatedAt'>,
  logger: Logger
): Promise<boolean> {
  const server = readNonEmptyString(serverName);
  if (!store || !server) {
    return false;
  }

  const normalized = {
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    replyChannel: normalizeChannel(route.replyChannel),
    replyTo: normalizeReplyTarget(readNonEmptyString(route.replyTo), {
      channel: normalizeChannel(route.replyChannel),
      sessionKey: route.sessionKey,
    }),
    replyAccountId: readNonEmptyString(route.replyAccountId),
  };

  const existing = await readStoredNotificationRoute(store, server, logger);
  if (
    existing &&
    existing.sessionKey === normalized.sessionKey &&
    existing.agentId === normalized.agentId &&
    existing.replyChannel === normalized.replyChannel &&
    existing.replyTo === normalized.replyTo &&
    existing.replyAccountId === normalized.replyAccountId
  ) {
    logger.debug(
      `Remembered route unchanged for server=${server} (session_key=${normalized.sessionKey}); skipping write`
    );
    return true;
  }

  try {
    const payload: StoredNotificationRoute = {
      ...normalized,
      updatedAt: Date.now(),
    };
    await store.set(storeKey(server), payload);

    logger.info(
      `Remembered route saved: server=${server}, session_key=${payload.sessionKey}, agent_id=${payload.agentId}, channel=${payload.replyChannel ?? 'n/a'}, to=${payload.replyTo ?? 'n/a'}, account=${payload.replyAccountId ?? 'n/a'}`
    );
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Failed to persist remembered session route via runtime store (server=${server}): ${detail}`
    );
    return false;
  }
}
```

- [ ] **Step 4: Update notifier to accept store instead of eigenfluxBin for route persistence**

In `src/notifier.ts`, update `EigenFluxNotifierConfig` to include the store:

```typescript
// Add import at top:
import { type PluginRuntimeStore } from './session-route-memory';

// Update EigenFluxNotifierConfig — add store field:
export type EigenFluxNotifierConfig = {
  eigenfluxBin?: string;
  serverName?: string;
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  openclawCliBin: string;
  sessionStorePath?: string;
  routeOverrides?: NotificationRouteOverrides;
  store?: PluginRuntimeStore;
};
```

In the `rememberRouteIfChanged` method, update the `writeStoredNotificationRoute` call:

```typescript
// Before:
await writeStoredNotificationRoute(
  this.config.eigenfluxBin,
  this.config.serverName,
  route,
  this.logger
);

// After:
await writeStoredNotificationRoute(
  this.config.store,
  this.config.serverName,
  route,
  this.logger
);
```

- [ ] **Step 5: Update notification-route-resolver to accept store**

In `src/notification-route-resolver.ts`, update the `resolveNotificationRoute` function to accept and use the store.

Update `NotificationRouteConfig`:
```typescript
// Add import:
import { readStoredNotificationRoute, type PluginRuntimeStore } from './session-route-memory';

// Add to NotificationRouteConfig:
export type NotificationRouteConfig = {
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  sessionStorePath?: string;
  eigenfluxBin?: string;
  serverName?: string;
  routeOverrides?: NotificationRouteOverrides;
  store?: PluginRuntimeStore;
};
```

Update the `readStoredNotificationRoute` call in `resolveNotificationRoute` (around line 748-752):

```typescript
// Before:
const remembered = await readStoredNotificationRoute(
  config.eigenfluxBin,
  config.serverName,
  logger
);

// After:
const remembered = await readStoredNotificationRoute(
  config.store,
  config.serverName,
  logger
);
```

- [ ] **Step 6: Update src/index.ts to create and pass the runtime store**

At the top of `src/index.ts`, add:

```typescript
import { createPluginRuntimeStore } from 'openclaw/plugin-sdk/runtime-store';
```

In the `registerPlugin` function (formerly `register`), create the store after getting the logger:

```typescript
function registerPlugin(api: OpenClawPluginApi): void {
  const logger = new Logger(resolvePluginLogger(api));
  const pluginConfig = resolvePluginConfig(api.pluginConfig, logger);
  const eigenfluxHome = resolveEigenfluxHome();
  const store = createPluginRuntimeStore(api);
  // ... rest of function
```

Pass the store to `EigenFluxNotifier` in `createServerRuntime`. Update the notifier constructor call (around line 235):

```typescript
const notifier = new EigenFluxNotifier(api, logger, {
  eigenfluxBin: pluginConfig.eigenfluxBin,
  serverName: server.name,
  sessionKey: routing.sessionKey,
  agentId: routing.agentId,
  replyChannel: routing.replyChannel,
  replyTo: routing.replyTo,
  replyAccountId: routing.replyAccountId,
  openclawCliBin: pluginConfig.openclawCliBin,
  routeOverrides: routing.routeOverrides,
  store,
});
```

Also pass the store in `deliverNotInstalledPrompt` (around line 209):

```typescript
// Add store parameter to deliverNotInstalledPrompt signature:
async function deliverNotInstalledPrompt(
  api: OpenClawPluginApi,
  logger: Logger,
  pluginConfig: ResolvedEigenFluxPluginConfig,
  _eigenfluxHome: string,
  bin: string,
  store: PluginRuntimeStore
): Promise<void> {
  const notifier = new EigenFluxNotifier(api, logger, {
    sessionKey: DEFAULT_ROUTING.sessionKey,
    agentId: DEFAULT_ROUTING.agentId,
    replyChannel: DEFAULT_ROUTING.replyChannel,
    replyTo: DEFAULT_ROUTING.replyTo,
    replyAccountId: DEFAULT_ROUTING.replyAccountId,
    openclawCliBin: pluginConfig.openclawCliBin,
    routeOverrides: DEFAULT_ROUTING.routeOverrides,
    store,
  });
  // ...
```

Update the call site in the discovery service start handler.

Also update `writeStoredNotificationRoute` calls in `src/index.ts` (the `rememberCurrentCommandRouteIfPossible` and `buildHereText` functions) to pass `store` instead of `eigenfluxBin`. These functions need the store added to their parameters.

- [ ] **Step 7: Update all tests**

In `src/index.test.ts`:
- Add the `runtimeStoreMock` as shown in Step 1
- Update the `/eigenflux here` test assertions to check `runtimeStoreMock.set` instead of `execEigenfluxMock`
- Reset `runtimeStoreMock` in `beforeEach`

In `src/notifier.test.ts`:
- Add `store: runtimeStoreMock` to the notifier config mock
- Mock `readStoredNotificationRoute` and `writeStoredNotificationRoute` using the store interface

In `src/notification-route-resolver.test.ts`:
- Add `store: runtimeStoreMock` to config objects passed to `resolveNotificationRoute`

- [ ] **Step 8: Run tests**

Run: `pnpm test`

Expected: All tests pass with the new runtime-store-based implementation.

- [ ] **Step 9: Verify build**

Run: `pnpm build`

Expected: Build succeeds.

- [ ] **Step 10: Commit**

```bash
git add src/session-route-memory.ts src/notifier.ts src/notification-route-resolver.ts src/index.ts src/index.test.ts src/notifier.test.ts src/notification-route-resolver.test.ts
git commit -m "feat: replace CLI-based route persistence with plugin-sdk/runtime-store"
```

---

### Task 7: Adopt `plugin-sdk/channel-route` for Route Normalization

**Files:**
- Modify: `src/reply-target.ts`
- Modify: `src/reply-target.test.ts`

- [ ] **Step 1: Investigate SDK channel-route exports**

Before modifying code, check what `openclaw/plugin-sdk/channel-route` actually exports:

Run: `node -e "console.log(Object.keys(require('openclaw/plugin-sdk/channel-route')))"`

Expected: A list of exported functions. Look for `normalizeChannelRoute`, `parseChannelTarget`, `compactRouteKey`, or similar. If the exports don't match what the design doc assumed, adjust the migration accordingly.

- [ ] **Step 2: Update reply-target.ts to use SDK channel-route**

Based on what Step 1 reveals, delegate the generic `isNormalizedConversationTarget` check and channel-prefix stripping to SDK helpers. Keep the EigenFlux-specific logic:
- Feishu `ou_`/`oc_` prefix detection (`deriveReplyTargetKindFromValue`)
- Discord/Feishu peer shape mapping (`deriveReplyTargetKindFromSessionKey`)
- `supportsKindPrefixedTargets` channel check

The exact code depends on what the SDK exports. If the SDK's `parseChannelTarget` handles the `kind:id` format detection, replace `isNormalizedConversationTarget`. If it provides route comparison helpers, those can be used in `session-route-memory.ts` for the equality check.

If the SDK's channel-route doesn't provide helpers that directly replace the existing logic (which is highly domain-specific), keep the current implementation and document why. The SDK adoption for this module is best-effort.

- [ ] **Step 3: Run tests**

Run: `pnpm test -- --testPathPattern reply-target`

Expected: All existing reply-target tests pass. The normalization behavior must be identical.

- [ ] **Step 4: Verify build**

Run: `pnpm build`

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/reply-target.ts src/reply-target.test.ts
git commit -m "refactor: delegate generic route normalization to plugin-sdk/channel-route"
```

---

### Task 8: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Full test suite**

Run: `pnpm test`

Expected: All tests pass.

- [ ] **Step 2: Full build**

Run: `pnpm build`

Expected: Build succeeds with no warnings.

- [ ] **Step 3: Verify the built output exports correctly**

Run: `node -e "const p = require('./dist/index.js'); console.log(p.default?.id, typeof p.default?.register)"`

Expected: `openclaw-eigenflux function`

- [ ] **Step 4: Verify no leftover references to old patterns**

Run: `grep -r "openclaw-plugin-sdk.d.ts" src/` — should return nothing.
Run: `grep -r "PLUGIN_CONFIG_SCHEMA" src/` — should return nothing.
Run: `grep -r "configSchema" src/index.ts` — should return nothing (configSchema is now manifest-only).

- [ ] **Step 5: Commit any remaining fixes**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "chore: final SDK migration cleanup"
```
