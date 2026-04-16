# EigenFlux Claude Code Plugin — Standardization & Marketplace Readiness

**Date:** 2026-04-15
**Scope:** Refactor `claude_plugin/` to the official Claude Code plugin layout, add hooks + slash commands at parity with `openclaw_extension`, run an end-to-end test via a child Claude process, and produce a marketplace publishing guide.

## 1. Problem

The current `claude_plugin/` is a stdio MCP server only — no `.claude-plugin/plugin.json`, no hooks, no slash commands. It cannot be discovered or loaded by Claude Code through the standard plugin mechanism, and has no install-time / auth-time guidance flow. The sibling `openclaw_extension/` already implements feed polling, PM streaming, and a `/eigenflux` command set; the Claude Code plugin should reach functional parity, using the mechanisms Claude Code provides (hooks, commands, MCP servers, skills).

## 2. Goals / Non-Goals

**Goals**
- Conform to Claude Code's plugin directory convention.
- Keep the existing `channel.ts` MCP server and its tools (no behavioural regression).
- Add SessionStart hook for install/auth guidance via injected prompts.
- Add `/eigenflux` slash command with subcommands `auth | profile | servers | feed | pm | here | version`.
- Verify end-to-end using a non-interactive child `claude -p` process.
- Produce a doc describing how to publish to the Claude marketplace.

**Non-goals**
- Rewriting the polling / streaming logic (`feed-poller.ts`, `pm-stream.ts`) — reused as-is.
- Agents (`agents/`) — not needed in this iteration.
- Changing any existing skill content under `skills/`.

## 3. Target Layout

```
claude_plugin/
├── .claude-plugin/plugin.json        # NEW manifest
├── .mcp.json                         # NEW — declares the stdio channel server
├── commands/eigenflux.md             # NEW — slash command frontmatter + delegation
├── hooks/hooks.json                  # NEW — SessionStart + SessionEnd
├── scripts/
│   ├── session-start.sh              # NEW — install/auth guidance
│   ├── session-end.sh                # NEW — cleanup
│   └── eigenflux-cmd.sh              # NEW — routes /eigenflux subcommands to CLI
├── skills/                           # unchanged (ef-broadcast, ef-communication, ef-profile)
├── src/                              # unchanged; channel.ts stays entry point
├── dist/                             # tsc output
├── test-api.mjs                      # KEPT (existing)
├── test-channel.mjs                  # KEPT (existing)
└── scripts/e2e-test.mjs              # NEW — spawns child `claude -p`, asserts
```

## 4. Component Details

### 4.1 `.claude-plugin/plugin.json`

```json
{
  "name": "eigenflux",
  "version": "0.0.1",
  "description": "EigenFlux broadcast network channel for Claude Code — feed polling, PM streaming, skills.",
  "author": { "name": "EigenFlux", "url": "https://www.eigenflux.ai" },
  "homepage": "https://www.eigenflux.ai",
  "license": "MIT",
  "keywords": ["eigenflux", "broadcast", "agents", "network", "channel"]
}
```

Components in `commands/`, `hooks/`, `skills/`, `.mcp.json` are auto-discovered by Claude Code.

### 4.2 `.mcp.json`

```json
{
  "mcpServers": {
    "eigenflux": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/channel.js"]
    }
  }
}
```

Claude Code starts the MCP server on session start; the server emits `claude/channel` notifications as today.

### 4.3 Hooks (`hooks/hooks.json`)

```json
{
  "description": "EigenFlux plugin hooks",
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh\"" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh\"" }] }
    ]
  }
}
```

`session-start.sh` responsibilities:
1. If `eigenflux` CLI is missing on PATH → print a JSON hook response injecting `additionalContext` telling the agent how to install.
2. If CLI present but credentials absent/expired → inject `additionalContext` telling the agent to run `/eigenflux auth` or `eigenflux auth login`.
3. Otherwise exit 0 silently.

Implementation uses the documented hook JSON output format:
```json
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "..." } }
```

`session-end.sh` is a stub for future cleanup (no-op initially; exists so we can add behaviour without bumping the hook schema).

### 4.4 Slash command (`commands/eigenflux.md`)

Frontmatter:
```
---
description: "EigenFlux plugin commands: auth, profile, servers, feed, pm, here, version"
argument-hint: "[--server <name>] <auth|profile|servers|feed|pm|here|version>"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/eigenflux-cmd.sh:*)"]
---
```
Body delegates to `scripts/eigenflux-cmd.sh $ARGUMENTS`, which shells to the `eigenflux` CLI and formats output. Subcommand behaviours mirror `openclaw_extension/src/index.ts:395-422`:
- `auth` — credential status (path, token mask, expiry)
- `profile` — `eigenflux profile show -s <server> -f json`
- `servers` — list discovered servers
- `feed` — run one `eigenflux feed poll` and format the payload
- `pm` — `eigenflux pm status` (stream status)
- `here` — bind current Claude Code session route (best-effort; stub may just emit explanatory text in v1 because Claude Code doesn't expose the same conversation binding API as OpenClaw)
- `version` — CLI version info

`here` — v1 implementation note: OpenClaw's `here` uses an OpenClaw-only `getCurrentConversationBinding()` API. Claude Code has no direct equivalent, so v1 outputs a clear message explaining the limitation and pointing to the MCP channel as the delivery mechanism. Future work can persist a session route keyed on `CLAUDE_SESSION_ID` if Anthropic exposes it.

### 4.5 E2E test (`scripts/e2e-test.mjs`)

Pure Node; no test framework. Flow:
1. `pnpm build` (tsc + copy-skills).
2. Create temp HOME at `<repo>/.e2e-tmp/HOME` with `~/.claude/settings.json`:
   ```json
   {
     "enabledPlugins": { "eigenflux@local": true },
     "extraKnownMarketplaces": {
       "local": { "source": { "source": "local", "path": "<absolute path to claude_plugin>" } }
     }
   }
   ```
   (If the `local` marketplace source form isn't supported in this CLI version, fall back to symlinking `claude_plugin` into `$HOME/.claude/plugins/eigenflux`.)
3. Spawn `claude -p "/eigenflux version" --permission-mode bypassPermissions --output-format stream-json`.
4. Parse streamed JSON messages. Assert:
   - Message stream contains a tool call or text result referencing `EigenFlux CLI version` or `not installed` — both indicate the command ran through the plugin.
   - MCP `eigenflux` server connects (look for `startup_test` notification or equivalent channel event in the stream).
   - Skills are discoverable (optional — parse `skills` field if present).
5. Kill subprocess, write human-readable report to `docs/e2e-test-report.md`.
6. Exit non-zero on any assertion failure.

Running locally: `node scripts/e2e-test.mjs`.

### 4.6 Marketplace publishing doc (`docs/publishing-to-claude-marketplace.md`)

Separate deliverable, sourced from current Anthropic docs via WebFetch. Outline:
1. Two publishing paths — Anthropic's official marketplace vs. self-hosted marketplace git repo
2. `.claude-plugin/plugin.json` required fields & semver
3. `.claude-plugin/marketplace.json` schema (if self-hosting a marketplace)
4. Git hosting recommendations & tags
5. Security considerations — hooks run shell commands; MCP servers have stdio access
6. User install flow (`/plugin marketplace add …` → `/plugin install …`)
7. Update / versioning workflow
8. Submission to Anthropic's official marketplace — process, review criteria, contact channels

## 5. Testing / Verification

- `cd claude_plugin && pnpm build` must succeed.
- `node scripts/e2e-test.mjs` exits 0 and produces `docs/e2e-test-report.md`.
- Kept files (`test-api.mjs`, `test-channel.mjs`) still runnable.
- Manual smoke: `claude --debug` in a test dir and run `/eigenflux version`.

## 6. Risks

- **Plugin loading from a local path** — the exact `settings.json` shape for an unpublished local plugin may differ by CLI version. E2E test must tolerate fallback to a symlink.
- **Hook-injected install prompts** — must not spam on every session. v1 prints once per session (stateless acceptable since hook runs per session).
- **`/eigenflux here`** — no parity today; documented as limited in v1.
- **CI absence** — e2e test is run by the developer, not CI. Documented in commit notes.

## 7. Rollout

Single PR. `openclaw_extension` is untouched. Existing `claude_plugin` stays importable as an MCP server for users who haven't adopted the new plugin flow (manifest is additive).
