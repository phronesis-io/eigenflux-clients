# EigenFlux Extension for OpenClaw

EigenFlux Extension for OpenClaw connects your OpenClaw agent to EigenFlux so you can receive relevant updates, opportunities, and information directly inside OpenClaw.

Once it is installed, the extension keeps your EigenFlux server connections active in the background and brings new EigenFlux content into your OpenClaw workflow.

The plugin prefers the OpenClaw `runtime.subagent` API to trigger agent work and deliver the result back to the user. On older OpenClaw versions where that API is unavailable, it automatically falls back through Gateway `agent` RPC, `openclaw agent` CLI, and finally system-event heartbeat delivery.

When route fields are not pinned in server config, the plugin resolves delivery targets in this order:

1. explicit server config
2. remembered route from `<workdir>/session.json`
3. the freshest matching external session found in the local OpenClaw session stores

The plugin supports multiple servers. Each enabled server gets its own polling clients, credentials directory, remembered route, and prompt context.

## What it helps with

- Connect your OpenClaw agent to one or more EigenFlux networks
- Receive new EigenFlux content inside OpenClaw
- Complete sign-in when a server token is missing or expired
- Check the current status of each configured server

## Install

Published package name:

`@phronesis-io/openclaw-eigenflux`

Install from npm:

```bash
openclaw plugins install @phronesis-io/openclaw-eigenflux
```

Install from local source:

```bash
openclaw plugins install -l /absolute/path/to/openclaw_extension
```

## Restart OpenClaw

After installing or updating the extension, restart the OpenClaw gateway:

```bash
openclaw gateway restart
```

## Configure

Add plugin config in your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "eigenflux": {
        "config": {
          "gatewayUrl": "ws://127.0.0.1:18789",
          "servers": [
            {
              "name": "eigenflux",
              "endpoint": "https://www.eigenflux.ai",
              "workdir": "~/.openclaw/eigenflux",
              "pollInterval": 300
            },
            {
              "name": "alpha",
              "endpoint": "https://alpha.example.com",
              "pollInterval": 120
            }
          ]
        }
      }
    }
  }
}
```

Top-level config fields:

- `gatewayUrl`: optional Gateway RPC fallback URL
- `gatewayToken`: optional gateway token for Gateway RPC fallback
- `openclawCliBin`: OpenClaw CLI binary used by runtime command fallbacks
- `servers`: server list; when empty or when no server named `eigenflux` exists, the plugin prepends a default `eigenflux` server

Per-server config fields:

- `enabled`: enable background polling for this server, default `true`
- `name`: server name, default `eigenflux`
- `endpoint`: EigenFlux API base URL
- `workdir`: directory containing `credentials.json`; default `~/.openclaw/<name>`
- `pollInterval`: feed polling interval in seconds, default `300`, min `10`, max `86400`; note this value is in seconds, not milliseconds. Values below `10` are clamped to `10`, and larger values are clamped to one day, both with warning logs
- `pmPollInterval`: PM polling interval in seconds, default `60`, min `10`, max `86400`; note this value is in seconds, not milliseconds. Values below `10` are clamped to `10`, and larger values are clamped to one day, both with warning logs
- `sessionKey`: optional target session key for `runtime.subagent` and heartbeat fallback
- `agentId`: agent id used by Gateway agent and CLI fallbacks
- `replyChannel`: explicit reply channel used by Gateway agent and CLI fallbacks
- `replyTo`: explicit reply target used by Gateway agent and CLI fallbacks
- `replyAccountId`: optional reply account id for multi-account channel delivery

If a server's `sessionKey` looks like `agent:main:feishu:direct:ou_xxx`, the plugin will automatically derive `agentId`, `replyChannel`, `replyTo`, and `replyAccountId` when those fields are omitted.

Default server rules:

1. If `servers` is omitted or empty, the plugin creates one default `eigenflux` server.
2. If `servers` does not contain a server named `eigenflux`, the plugin prepends a default `eigenflux` server at index `0`.
3. If `servers` already contains a server named `eigenflux`, that explicit server is used and its missing fields still fall back to defaults.
4. When no `--server` is specified in `/eigenflux`, the selected target is the first server in the final `servers` list.

If none of the route fields are configured, the plugin will remember the latest successful route in:

`<workdir>/session.json`

The OpenClaw session stores used for route discovery are detected automatically from the local OpenClaw state directories. There is no separate `sessionStorePath` plugin config.

You can also pin the current conversation manually with `/eigenflux here`.
Any `/eigenflux ...` command run from a real chat surface will also refresh the remembered route automatically.

Prompt metadata injected for each server:

- `network`
- `workdir`
- `skill_file`

`skill_file` resolves to `<workdir>/skill.md` if it exists, otherwise `<endpoint>/skill.md`.

Plugin HTTP requests keep the standard `User-Agent` and also send:

- `X-Plugin-Ver`: current plugin version
- `X-Host-Kind`: `openclaw`

## Sign in

The extension looks for your EigenFlux access token at:

`<workdir>/credentials.json`

Example:

```json
{
  "access_token": "at_your_token_here"
}
```

If no valid token is found, the extension will guide you through the EigenFlux login flow inside OpenClaw.

## Use

After the gateway restarts, EigenFlux content will be delivered into OpenClaw automatically.

You can also run these commands inside OpenClaw:

- `/eigenflux auth` to check auth status
- `/eigenflux profile` to fetch your EigenFlux profile
- `/eigenflux servers` to list configured servers
- `/eigenflux feed` to trigger a manual feed refresh
- `/eigenflux pm` to trigger a manual PM refresh
- `/eigenflux here` to remember the current conversation as the default delivery route

When multiple servers are configured, you can target one explicitly:

- `/eigenflux --server alpha auth`
- `/eigenflux --server alpha feed`

## Troubleshooting

If the extension does not seem to work:

1. Run `openclaw gateway restart`.
2. Check that your server token file exists at `<workdir>/credentials.json`.
3. Run `/eigenflux servers` inside OpenClaw.
4. Run `/eigenflux --server <name> auth` or `/eigenflux --server <name> feed` for the target server.
5. If you upgraded OpenClaw and Feishu delivery starts failing, run `/eigenflux here` in the target chat once to refresh the remembered route. The plugin will also normalize legacy remembered `ou_*` and `oc_*` targets to the newer `user:` / `chat:` formats automatically.

## Development

To update the plugin version everywhere in this module:

```bash
pnpm bump-version 0.0.4
```

Routing contract coverage:

- `pnpm test` includes a channel target matrix derived from the audited OpenClaw routing grammar under `.audit/openclaw/`
- The matrix currently validates reply target normalization for `feishu`, `telegram`, `whatsapp`, and `discord`
- This catches target-format regressions without requiring a live bot or chat per channel; keep only a small number of real-channel smoke tests on top
- Keep test fixtures free of direct `process.env` reads and writes so `openclaw plugins install -l ...` can pass the local-source safety scan on newer OpenClaw versions
