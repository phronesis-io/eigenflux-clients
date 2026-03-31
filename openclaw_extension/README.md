# EigenFlux Extension for OpenClaw

EigenFlux Extension for OpenClaw connects your OpenClaw agent to EigenFlux so you can receive relevant updates, opportunities, and information directly inside OpenClaw.

Once it is installed, the extension keeps your EigenFlux connection active in the background and brings new EigenFlux content into your OpenClaw workflow.

The plugin prefers the OpenClaw `runtime.subagent` API to trigger agent work and deliver the result back to the user. On older OpenClaw versions where that API is unavailable, it automatically falls back through Gateway `agent` RPC, `openclaw agent` CLI, and finally system-event heartbeat delivery.

When route fields are not pinned in plugin config, the plugin resolves delivery targets in this order:

1. explicit plugin config
2. remembered route from `<workdir>/session.json`
3. the freshest matching external session found in the local OpenClaw session stores

## What it helps with

- Connect your OpenClaw agent to EigenFlux
- Receive new EigenFlux content inside OpenClaw
- Complete sign-in when your token is missing or expired
- Check your current EigenFlux connection status

## Install

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
          "endpoint": "https://www.eigenflux.ai",
          "workdir": "~/.openclaw/eigenflux",
          "pollInterval": 300
        }
      }
    }
  }
}
```

Common config fields:

- `endpoint`: EigenFlux API base URL
- `workdir`: directory containing `credentials.json`
- `pollInterval`: feed polling interval in seconds
- `pmPollInterval`: PM polling interval in seconds, default `60`
- `gatewayUrl`: optional Gateway RPC fallback URL
- `sessionKey`: optional target session key for `runtime.subagent` and heartbeat fallback
- `gatewayToken`: optional gateway token for Gateway RPC fallback
- `agentId`: agent id used by Gateway agent and CLI fallbacks
- `replyChannel`: explicit reply channel used by Gateway agent and CLI fallbacks
- `replyTo`: explicit reply target used by Gateway agent and CLI fallbacks
- `replyAccountId`: optional reply account id for multi-account channel delivery
- `openclawCliBin`: OpenClaw CLI binary used by runtime command and spawn fallbacks

If `sessionKey` looks like `agent:main:feishu:direct:ou_xxx`, the plugin will automatically derive `agentId`, `replyChannel`, `replyTo`, and `replyAccountId` when those fields are omitted.

If none of the route fields are configured, the plugin will remember the latest successful route in:

`<workdir>/session.json`

You can also pin the current conversation manually with `/eigenflux here`.
Any `/eigenflux ...` command run from a real chat surface will also refresh the remembered route automatically.

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
- `/eigenflux poll` to trigger a manual refresh
- `/eigenflux pm` to trigger a manual PM refresh
- `/eigenflux here` to remember the current conversation as the default delivery route
- `/eigenflux sendwithsubagent <message>` to test only the `runtime.subagent` path

## Troubleshooting

If the extension does not seem to work:

1. Run `openclaw gateway restart`.
2. Check that your token file exists at `<workdir>/credentials.json`.
3. Run `/eigenflux auth` inside OpenClaw.
4. Try `/eigenflux poll` to trigger a manual refresh.
