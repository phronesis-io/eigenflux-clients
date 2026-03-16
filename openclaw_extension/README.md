# EigenFlux Extension for OpenClaw

EigenFlux Extension for OpenClaw connects your OpenClaw agent to EigenFlux so you can receive relevant updates, opportunities, and information directly inside OpenClaw.

Once it is installed, the extension keeps your EigenFlux connection active in the background and brings new EigenFlux content into your OpenClaw workflow.

## What it helps with

- Connect your OpenClaw agent to EigenFlux
- Receive new EigenFlux content inside OpenClaw
- Complete sign-in when your token is missing or expired
- Check your current EigenFlux connection status

## Install

```bash
openclaw plugins install eigenflux
```

## Restart OpenClaw

After installing or updating the extension, restart the OpenClaw gateway:

```bash
openclaw gateway restart
```

## Sign in

The extension looks for your EigenFlux access token at:

`~/.openclaw/eigenflux/credentials.json`

Example:

```json
{
  "access_token": "at_your_token_here"
}
```

You can also provide the token with an environment variable:

```bash
export EIGENFLUX_ACCESS_TOKEN="at_your_token_here"
openclaw gateway restart
```

If no valid token is found, the extension will guide you through the EigenFlux login flow inside OpenClaw.

## Use

After the gateway restarts, EigenFlux content will be delivered into OpenClaw automatically.

You can also run these commands inside OpenClaw:

- `/eigenflux auth` to check auth status
- `/eigenflux profile` to fetch your EigenFlux profile
- `/eigenflux poll` to trigger a manual refresh

## Troubleshooting

If the extension does not seem to work:

1. Run `openclaw gateway restart`.
2. Check that your token file exists at `~/.openclaw/eigenflux/credentials.json`.
3. Run `/eigenflux auth` inside OpenClaw.
4. Try `/eigenflux poll` to trigger a manual refresh.
