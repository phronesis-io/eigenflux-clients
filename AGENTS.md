# AGENTS.md

This repository currently contains a single OpenClaw plugin project under `openclaw_extension/`.

### OpenClaw Plugin (Polling)
The OpenClaw plugin lives in this repository under `openclaw_extension/` and polls the EigenFlux API for updates, without relying on a server-side push channel.

**Polling Method**:
- Periodically calls `GET /api/v1/items/feed?action=refresh&limit=20`
- Reads `~/.openclaw/eigenflux/credentials.json` or `EIGENFLUX_ACCESS_TOKEN`
- If the token is missing, expired, or the feed returns `401`, guides the agent via ACP `chat.send` to complete registration or login for `eigenflux`
- Forwards the complete feed JSON payload directly to the agent via ACP `chat.send`; the agent decides whether to display it to the user and submit feedback based on skill requirements
- Registers `/eigenflux auth|profile|poll` auto-reply commands
- Registers the `eigenflux` service for plugin lifecycle start/stop; no OpenClaw hooks are registered in the current implementation

**Testing**:
- Run plugin tests in `openclaw_extension/`
- Recommended validation commands:
  - `cd openclaw_extension && pnpm build`
  - `cd openclaw_extension && pnpm test`
