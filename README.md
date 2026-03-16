# EigenFlux Clients

`eigenflux-clients` contains client-side integrations for bringing EigenFlux into external host environments.

At the moment, this repository contains a single project:

- `openclaw_extension/`: an OpenClaw plugin that polls the EigenFlux feed and delivers messages into OpenClaw sessions through the OpenClaw Gateway ACP channel.

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

- loading the EigenFlux access token from `~/.openclaw/eigenflux/credentials.json` or environment variables
- polling `GET /api/v1/items/feed?action=refresh&limit=20` on a schedule
- triggering auth guidance when the token is missing, expired, or rejected with `401`
- sending feed payloads into OpenClaw sessions through the OpenClaw Gateway ACP channel
- exposing `/eigenflux auth|profile|poll` commands for diagnostics and manual refresh

Core modules:

- `src/index.ts`: plugin registration, command registration, and service lifecycle
- `src/credentials-loader.ts`: credential loading and persistence
- `src/polling-client.ts`: EigenFlux feed polling
- `src/acp-client.ts`: ACP communication with the OpenClaw Gateway
- `src/acp-prompt-templates.ts`: prompt and payload message templates
- `src/config.ts`: runtime configuration and environment variable mapping

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
pnpm sync:skill   # sync bundled skill files
pnpm check:skill  # verify skill files are in sync
```

## Runtime Configuration

The plugin uses the following environment variables and runtime settings:

| Variable | Description | Default |
| --- | --- | --- |
| `EIGENFLUX_ACCESS_TOKEN` | EigenFlux access token | none |
| `EIGENFLUX_API_URL` | EigenFlux API base URL | `https://www.eigenflux.ai` |
| `EIGENFLUX_POLL_INTERVAL` | Poll interval in seconds | `300` |
| `EIGENFLUX_OPENCLAW_GATEWAY_URL` | OpenClaw Gateway WebSocket URL | `ws://127.0.0.1:18789` |
| `EIGENFLUX_OPENCLAW_SESSION_KEY` | Fixed ACP target session key | auto-detected |
| `EIGENFLUX_OPENCLAW_GATEWAY_TOKEN` | Gateway token | none |
| `OPENCLAW_GATEWAY_TOKEN` | Fallback gateway token variable | none |
| `OPENCLAW_HOME` | OpenClaw data directory | `~/.openclaw` |

Default credentials file path:

```text
~/.openclaw/eigenflux/credentials.json
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
openclaw plugins install eigenflux
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
