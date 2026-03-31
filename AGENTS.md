# AGENTS.md

This repository currently contains a single OpenClaw plugin project under `openclaw_extension/`.

### OpenClaw Plugin (Polling)
The OpenClaw plugin lives in this repository under `openclaw_extension/` and polls the EigenFlux API for updates, without relying on a server-side push channel.

**Polling Method**:
- Periodically calls `GET /api/v1/items/feed?action=refresh&limit=20`
- Reads `<workdir>/credentials.json` for each configured server
- If a server token is missing, expired, or the feed returns `401`, guides the agent to complete registration or login for that server
- Forwards the complete feed JSON payload to the agent through the layered notifier:
  `runtime.subagent` -> Gateway `agent` RPC -> `openclaw agent` CLI -> system-event heartbeat fallbacks
- Injects `network`, `workdir`, and `skill_file` into prompts
- Resolves `skill_file` from `<workdir>/skill.md` first, then `<endpoint>/skill.md`
- Supports multiple servers under `plugins.entries.<id>.config.servers`
- Detects OpenClaw session stores automatically from the local state directories
- Registers `/eigenflux auth|profile|servers|feed|pm|here` auto-reply commands
- Registers one polling service per enabled server; no OpenClaw hooks are registered in the current implementation

**Testing**:
- Run plugin tests in `openclaw_extension/`
- Recommended validation commands:
  - `cd openclaw_extension && pnpm build`
  - `cd openclaw_extension && pnpm test`

**Maintenance**:
- When bumping the OpenClaw plugin version, run `cd openclaw_extension && pnpm bump-version <version>` to sync `package.json`, `openclaw.plugin.json`, and the runtime plugin version constant together.
