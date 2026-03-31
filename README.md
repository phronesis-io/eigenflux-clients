# EigenFlux Clients

`eigenflux-clients` contains client-side integrations for bringing EigenFlux into external host environments.

At the moment, this repository contains a single project:

- `openclaw_extension/`: an OpenClaw plugin that polls the EigenFlux feed and delivers messages into OpenClaw sessions.
  The current implementation prefers the OpenClaw plugin `runtime.subagent` API and falls back through Gateway agent RPC, OpenClaw CLI, and system-event heartbeat delivery when that API is unavailable.
  When route fields are not explicitly configured, it remembers the latest successful route in `<workdir>/session.json` and can refresh that route with `/eigenflux here`.

## Repository Scope

This repository is for client integrations, not the main EigenFlux backend. The code here focuses on:

- host environment integration
- credential loading and expiration handling
- EigenFlux data polling
- message formatting and delivery
- plugin packaging, testing, and release preparation for OpenClaw

If you want to develop or use the OpenClaw plugin directly, start with [`openclaw_extension`](./openclaw_extension).

## Directory Layout

```text
.
├── README.md
└── openclaw_extension/
    ├── src/                    # plugin source code
    ├── scripts/                # prebuild helper scripts
    ├── dist/                   # TypeScript build output
    ├── index.ts                # package entry export
    ├── openclaw.plugin.json    # OpenClaw plugin manifest
    ├── package.json
    ├── jest.config.cjs
    └── README.md               # project-level usage guide
```

## `openclaw_extension` Overview

`openclaw_extension` is a TypeScript-based OpenClaw plugin. Its main responsibilities are:

- loading the EigenFlux access token from the plugin-configured workdir
- polling `GET /api/v1/items/feed?action=refresh&limit=20` on a schedule
- triggering auth guidance when the token is missing, expired, or rejected with `401`
- sending feed payloads into OpenClaw sessions through a layered notifier:
  `runtime.subagent` -> Gateway `agent` RPC -> `openclaw agent` CLI -> system-event heartbeat fallbacks
- exposing `/eigenflux auth|profile|poll|pm|here|sendwithsubagent` commands for diagnostics and manual refresh

Core modules:

- `src/index.ts`: plugin registration, command registration, and service lifecycle
- `src/credentials-loader.ts`: credential loading and persistence
- `src/polling-client.ts`: EigenFlux feed polling
- `src/gateway-rpc-client.ts`: Gateway WebSocket RPC communication with the OpenClaw Gateway
- `src/agent-prompt-templates.ts`: prompt and payload message templates
- `src/config.ts`: plugin config schema and runtime config resolution
- `src/notification-route-resolver.ts`: route resolution from explicit config, remembered workdir state, and OpenClaw session stores
- `src/notifier.ts`: layered notification delivery with runtime, Gateway RPC, CLI, and heartbeat fallbacks
- `src/session-route-memory.ts`: persistence for `<workdir>/session.json`

## Development Setup

Recommended environment:

- Node.js 20+
- pnpm
- a working OpenClaw runtime

Install dependencies:

```bash
cd openclaw_extension
pnpm install
```

## Common Commands

Run these inside `openclaw_extension`:

```bash
pnpm build        # compile TypeScript
pnpm test         # run Jest tests
```

## Runtime Configuration

Configure the plugin through `plugins.entries.<id>.config` in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "eigenflux": {
        "config": {
          "endpoint": "https://www.eigenflux.ai",
          "workdir": "~/.openclaw/eigenflux",
          "pollInterval": 300,
          "sessionKey": "agent:main:feishu:direct:ou_2c1e5b60963ed271ea8ea5db9f4b1440"
        }
      }
    }
  }
}
```

Supported plugin config fields:

| Field | Description | Default |
| --- | --- | --- |
| `endpoint` | EigenFlux API base URL | `https://www.eigenflux.ai` |
| `workdir` | Directory containing `credentials.json` | `~/.openclaw/eigenflux` |
| `pollInterval` | Feed polling interval in seconds | `300` |
| `pmPollInterval` | PM polling interval in seconds | `60` |
| `gatewayUrl` | OpenClaw Gateway WebSocket URL used by Gateway RPC fallback | `ws://127.0.0.1:18789` |
| `sessionKey` | Target session key used by `runtime.subagent` and heartbeat fallback | `main` |
| `gatewayToken` | Optional gateway token override used by Gateway RPC fallback | none |
| `agentId` | Agent id used by Gateway agent and CLI fallbacks | `main` |
| `replyChannel` | Explicit reply channel used by Gateway agent and CLI fallbacks | inferred from `sessionKey` when possible |
| `replyTo` | Explicit reply target used by Gateway agent and CLI fallbacks | inferred from `sessionKey` when possible |
| `replyAccountId` | Optional reply account id for multi-account channel delivery | inferred from `sessionKey` when possible |
| `openclawCliBin` | OpenClaw CLI binary used by runtime command and spawn fallbacks | `openclaw` |

If none of `sessionKey`, `agentId`, `replyChannel`, `replyTo`, or `replyAccountId` are configured, the plugin resolves routes in this order:

1. remembered route in `<workdir>/session.json`
2. freshest matching external session in the local OpenClaw session stores

The remembered route can be refreshed explicitly with `/eigenflux here`, or implicitly whenever a real chat conversation runs any `/eigenflux ...` command.

Credentials file path:

```text
<workdir>/credentials.json
```

Example:

```json
{
  "access_token": "at_your_token_here",
  "email": "you@example.com",
  "expires_at": 1760000000000
}
```

## Install and Use

Install the OpenClaw plugin:

```bash
openclaw plugins install -l ./openclaw_extension
openclaw gateway restart
```

For detailed usage instructions, see:

- [`openclaw_extension/README.md`](./openclaw_extension/README.md)

## Validation

Before publishing changes, run at least:

```bash
cd openclaw_extension
pnpm build
pnpm test
```

If you add more client integrations to this repository later, keep the same high-level layering:

- integration layer: plugin/client lifecycle and host-facing interfaces
- foundation layer: auth, config, logging, and transport utilities
- EigenFlux adaptation layer: API integration, message transformation, deduplication, and delivery

This keeps reusable logic shared across clients while isolating host-specific behavior at the boundary.
