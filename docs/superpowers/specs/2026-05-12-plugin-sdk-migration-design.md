# OpenClaw Plugin SDK Migration Design

**Date:** 2026-05-12
**Scope:** Migrate openclaw-eigenflux from legacy manual plugin export to the official OpenClaw Plugin SDK (`definePluginEntry`) and adopt SDK utilities where they replace hand-rolled code.

## Background

The plugin currently:
- Exports a plain `{ id, name, description, configSchema, register }` object
- Maintains hand-rolled type stubs in `src/openclaw-plugin-sdk.d.ts`
- Casts `api.runtime` to ad-hoc inline types wherever it accesses runtime APIs
- Stores remembered delivery routes by shelling out to `eigenflux config get/set`
- Builds its own `Logger` wrapper around the raw plugin logger

The latest OpenClaw Plugin SDK (2026.5.x) provides `definePluginEntry()`, official types, `registrationMode` guards, `runtime-store` for plugin-scoped persistence, and `channel-route` utilities.

## Migration Steps

### Step 1: Install SDK and Remove Type Stubs

- Add `openclaw` as a `devDependency` in `package.json` (latest 2026.5.x)
- Keep `openclaw` in `peerDependencies` for runtime
- Delete `src/openclaw-plugin-sdk.d.ts`
- Update all imports from `'openclaw/plugin-sdk'` to focused subpath imports:
  - `openclaw/plugin-sdk/plugin-entry` for `definePluginEntry`
  - `openclaw/plugin-sdk` for core types (`OpenClawPluginApi`, `PluginLogger`, etc.)
- Update `tsup.config.ts` external patterns if needed to cover new subpaths

### Step 2: Adopt `definePluginEntry()`

Replace the manual plugin object in `src/index.ts`:

```typescript
// Before
const plugin = {
  id: 'openclaw-eigenflux',
  name: 'EigenFlux',
  description: '...',
  configSchema: PLUGIN_CONFIG_SCHEMA,
  register,
};
export default plugin;

// After
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

export default definePluginEntry({
  id: 'openclaw-eigenflux',
  name: 'EigenFlux',
  description: 'OpenClaw extension for EigenFlux with CLI-based feed polling and PM streaming',
  register(api) {
    if (api.registrationMode !== 'full') return;
    // existing register() body
  },
});
```

The `registrationMode` guard ensures side effects (polling, streaming, CLI subprocess spawns) only run during full runtime activation, not during discovery, CLI metadata collection, or setup-only loading.

The `configSchema` moves out of the runtime entry and lives only in `openclaw.plugin.json` (manifest-first design).

### Step 3: Adopt `plugin-sdk/runtime-store` for Session Route Memory

Replace the CLI-based `session-route-memory.ts` (which shells out to `eigenflux config get/set`) with the SDK's `createPluginRuntimeStore()`:

```typescript
import { createPluginRuntimeStore } from 'openclaw/plugin-sdk/runtime-store';

const store = createPluginRuntimeStore(api);
// Read
const route = await store.get('deliver_session');
// Write
await store.set('deliver_session', payload);
```

**Trade-off:** The current implementation stores the route in eigenflux's config (per-server). Moving to `runtime-store` stores it in OpenClaw's plugin-scoped store. This is a better separation of concerns: OpenClaw delivery state belongs in OpenClaw, not eigenflux config.

The store key changes from `openclaw_deliver_session` (a single global key with the server name encoded in the CLI args) to `deliver_session:<serverName>` (one key per server in the plugin store).

The `session-route-memory.ts` module is rewritten but its public API (`readStoredNotificationRoute`, `writeStoredNotificationRoute`) stays the same. Callers (`notifier.ts`, `src/index.ts`) are unaffected.

### Step 4: Adopt `plugin-sdk/channel-route` for Route Utilities

The SDK's `channel-route` subpath exposes route normalization, target resolution, and route comparison helpers. Replace applicable parts of `reply-target.ts`:

- Use SDK's `normalizeChannelRoute()` and `parseChannelTarget()` for generic route normalization
- Keep EigenFlux-specific derivation logic (Feishu `ou_`/`oc_` prefix detection, Discord channel-type mapping) since these are domain-specific patterns the SDK does not cover
- Use SDK's route comparison helpers in `notifier.ts` when checking if a route has changed (replacing the manual field-by-field equality check in `writeStoredNotificationRoute`)

`reply-target.ts` becomes thinner: generic normalization delegates to the SDK, EigenFlux-specific logic stays.

### Step 5: Clean Up Logger

The current `Logger` class is a thin wrapper that prepends `[EigenFlux]` to all messages. With the official SDK, `api.logger` is already scoped to the plugin. The child logger pattern is also built-in:

```typescript
const logger = api.runtime.logging.getChildLogger({ plugin: 'eigenflux' });
```

The existing `resolvePluginLogger()` function already tries this pattern with a fallback. Simplify `logger.ts` to use the SDK's `PluginLogger` type directly and remove the `any` casts.

### Step 6: Type the Runtime API

The `notifier.ts` module casts `api.runtime` to ad-hoc inline types 4 times (for `subagent`, `system.enqueueSystemEvent`, `system.requestHeartbeatNow`, `system.runCommandWithTimeout`). With the official SDK types installed, these casts should be replaced with proper type imports from the SDK if available, or consolidated into a single typed runtime interface at the top of the file.

### Step 7: Update Manifest (`openclaw.plugin.json`)

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

- `activation.onStartup: true` ensures the discovery service starts immediately
- `contracts: {}` is the manifest ownership contract (no tools registered yet; empty is valid)

### Step 8: Update `package.json`

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

- Add `runtimeExtensions` for packaged installs
- Bump compat to 2026.5.2
- Add `openclaw` to `devDependencies`
- Bump version to `0.0.9` via `pnpm bump-version 0.0.9`

### Step 9: Update Tests

- Update `src/index.test.ts`: the default export is now a `definePluginEntry` result, not a plain object. Tests that call `.register(mockApi)` still work since the entry object still exposes `register`.
- Update `src/session-route-memory.test.ts`: mock `createPluginRuntimeStore` instead of `execEigenflux`.
- Update `src/reply-target.test.ts`: if using SDK's channel-route, update mocks accordingly. Domain-specific tests remain.
- All other test files (`polling-client`, `stream-client`, `notifier`, `cli-executor`, etc.) should be unaffected since business logic is unchanged.

### Step 10: Update Root Entry (`index.ts`)

No change needed. `export { default } from './dist/index.js'` continues to work since `definePluginEntry` returns an object with the same shape.

## Files Changed

| File | Change |
|------|--------|
| `src/index.ts` | `definePluginEntry`, `registrationMode` guard, remove `configSchema` from export |
| `src/openclaw-plugin-sdk.d.ts` | **Deleted** |
| `src/session-route-memory.ts` | Rewrite to use `plugin-sdk/runtime-store` |
| `src/reply-target.ts` | Delegate generic normalization to `plugin-sdk/channel-route` |
| `src/logger.ts` | Simplify, use SDK `PluginLogger` type |
| `src/notifier.ts` | Replace ad-hoc runtime casts with SDK types |
| `src/config.ts` | Remove `PLUGIN_CONFIG_SCHEMA` export (now manifest-only), bump `PLUGIN_VERSION` |
| `openclaw.plugin.json` | Add `activation`, `contracts` |
| `package.json` | Add `runtimeExtensions`, `devDependencies.openclaw`, bump compat |
| `tsup.config.ts` | Verify external patterns cover SDK subpaths |
| Test files | Update mocks for changed modules |

## What Does NOT Change

- `polling-client.ts` — Business logic unchanged
- `stream-client.ts` — Business logic unchanged
- `cli-executor.ts` — Business logic unchanged
- `notification-route-resolver.ts` — Route resolution logic unchanged
- `credentials-loader.ts` — Auth credentials logic unchanged
- `agent-prompt-templates.ts` — Prompt templates unchanged
- `skills/` — Skill definitions unchanged

## Risk Assessment

- **Low risk:** Steps 1, 2, 6, 7, 8, 10 are mechanical transformations
- **Medium risk:** Steps 3, 4 change where data is stored / how normalization works. Mitigated by keeping public APIs identical and running full test suite after each step.
- **Rollback:** Each step is independently committable. If `runtime-store` or `channel-route` don't work as expected at runtime, we can revert those steps while keeping the rest of the migration.
