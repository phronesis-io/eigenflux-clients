# EigenFlux CLI Not-Installed Install Prompt

## Goal

When the OpenClaw plugin's discovery service starts and the `eigenflux` CLI
binary is missing from the system, deliver a message to the user via the agent
instructing them to install it with:

```
curl -fsSL https://eigenflux.ai/install.sh | bash
```

## Problem

`EigenFluxPollingClient` / `EigenFluxStreamClient` depend on the `eigenflux`
CLI. Today, if the CLI is not installed, `discoverServers()` calls
`execEigenflux('server list --format json')`, `execFile` fails with `ENOENT`,
and the error is swallowed into a plain log warning (`No EigenFlux servers
discovered`). The user never hears about the missing dependency.

## Design

### 1. `cli-executor.ts`

Detect `ENOENT` from `execFile` and surface it as a distinct result kind:

```ts
export type CliResult<T> =
  | { kind: 'success'; data: T }
  | { kind: 'auth_required'; stderr: string }
  | { kind: 'not_installed'; bin: string }
  | { kind: 'error'; error: Error; exitCode: number | null; stderr: string };
```

`execFile` error objects carry `code === 'ENOENT'` (string) when the binary
cannot be spawned. Match exactly that condition, returning `not_installed`
before the generic `error` branch.

### 2. `config.ts`

Fix the discovery command to match the current CLI:
```ts
['server', 'list', '--format', 'json']
```
(replacing the now-defunct `config server list -f json`).

Change the `discoverServers()` return type so callers can distinguish
"no servers" from "CLI missing":

```ts
export type DiscoveryResult =
  | { kind: 'ok'; servers: DiscoveredServer[] }
  | { kind: 'not_installed'; bin: string };

export async function discoverServers(...): Promise<DiscoveryResult>
```

Pass through `not_installed` from the executor; otherwise return `{ kind: 'ok', servers }`.

### 3. `index.ts`

In the discovery service `start()`:

- If result is `not_installed`: build a one-off `EigenFluxNotifier` using
  `DEFAULT_ROUTING` and an ephemeral `workdir = <eigenfluxHome>/bootstrap`,
  then deliver an English prompt telling the agent to surface the install
  command to the user. Return without starting any runtimes.
- If result is `ok`: existing behavior.

Guard the prompt with a module-level `notInstalledPromptDelivered` flag (reset
on `stop()`) so repeated start/stops do not spam the agent.

The message to the agent (English):
> The EigenFlux CLI is not installed on this machine. Please tell the user to run the following command to install it:
> `curl -fsSL https://eigenflux.ai/install.sh | bash`

### 4. Tests

- `cli-executor.test.ts`: ENOENT from `execFile` → `not_installed`.
- `config.test.ts`: `discoverServers` surfaces `not_installed` when the
  executor returns it; uses the new `server list --format json` argv.
- `index.test.ts`: discovery `start()` with `not_installed` delivers the
  install message via notifier exactly once and does not create runtimes.

## Out of scope

- Re-checking installation between polls.
- Auto-running the install command.
- Any UX beyond the single agent-surfaced prompt.
