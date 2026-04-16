# Publishing the EigenFlux Plugin to the Claude Code Marketplace

This guide documents the two paths for distributing `claude_plugin` to Claude Code users:

1. **Self-hosted marketplace** — anyone can add it via `/plugin marketplace add`. Fast, no gatekeeper.
2. **Anthropic's official marketplace (`claude-plugins-official`)** — listed in the `/plugin` Discover tab for every Claude Code user; requires submission through Anthropic.

Both paths share the same plugin artefacts and manifest. The official listing is an extra step on top of a working self-hosted marketplace.

Sources used: [code.claude.com/docs/en/plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [code.claude.com/docs/en/plugins-reference](https://code.claude.com/docs/en/plugins-reference), [code.claude.com/docs/en/discover-plugins](https://code.claude.com/docs/en/discover-plugins). Fetched 2026-04-15.

---

## 1. What Claude Code expects in a publishable plugin

### 1.1 Directory layout

```
<plugin-root>/
├── .claude-plugin/plugin.json     # manifest (required by convention; only `name` is strictly required)
├── commands/                      # /slash-commands as markdown files
├── skills/                        # skills as <name>/SKILL.md
├── agents/                        # subagent markdown (optional)
├── hooks/hooks.json               # lifecycle hooks (optional)
├── .mcp.json                      # standalone MCP config (or inline under `mcpServers` in plugin.json)
├── scripts/                       # any helper scripts referenced via ${CLAUDE_PLUGIN_ROOT}
├── bin/                           # executables auto-added to PATH when plugin is enabled (optional)
├── LICENSE
├── CHANGELOG.md
└── README.md
```

Rule: **only `plugin.json` belongs inside `.claude-plugin/`.** Every other component directory must sit at the plugin root. Plugins are copied to `~/.claude/plugins/cache` on install, so paths with `../` outside the plugin root do not work — use symlinks if you must share files across plugins.

### 1.2 `plugin.json` schema (the fields that matter for publishing)

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | kebab-case, no spaces. Namespaces all components (e.g. `eigenflux:ef-broadcast`). |
| `version` | Strongly recommended | Semver `MAJOR.MINOR.PATCH`. **If you don't bump it, existing users won't get updates** — Claude Code caches by version. |
| `description` | Yes for UX | Shown in the Discover tab. |
| `author` | Recommended | `{ name, email?, url? }`. |
| `homepage` | Recommended | Docs URL. Users see this in the install dialog. |
| `repository` | Recommended | Source URL. Needed for trust + issue reporting. |
| `license` | Recommended | SPDX id (`MIT`, `Apache-2.0`, …). |
| `keywords` | Recommended | Used by search. |
| `mcpServers` | As needed | Inline MCP config (preferred when only one plugin consumes it). `${CLAUDE_PLUGIN_ROOT}` is expanded at runtime. |
| `hooks`, `commands`, `skills`, `agents` | Only when overriding defaults | Custom paths replace the default directory — so normally you omit these and rely on directory discovery. |

### 1.3 Versioning rules

- First stable release: `1.0.0`. Pre-release tags: `2.0.0-beta.1`.
- **Single source of truth for version.** If both `plugin.json` and the marketplace entry declare a version, the manifest wins silently. Pick one:
  - For GitHub-sourced plugins: put the version in `plugin.json`.
  - For relative-path plugins inside a monorepo marketplace: put it in the marketplace entry.
- Bump the version *every* time the code changes, even patch-level fixes — otherwise cached installs will not update.
- Document every version in `CHANGELOG.md`.

### 1.4 Naming rules

- Plugin `name` and marketplace `name` both must be kebab-case (lowercase, digits, hyphens).
- The following marketplace names are **reserved by Anthropic** and rejected: `claude-code-marketplace`, `claude-code-plugins`, `claude-plugins-official`, `anthropic-marketplace`, `anthropic-plugins`, `agent-skills`, `knowledge-work-plugins`, `life-sciences`. Names that impersonate official marketplaces (e.g. `official-claude-plugins`, `anthropic-tools-v2`) are also blocked.
- Pick a name that won't collide on the global surface — users install as `<plugin>@<marketplace>`, so unique marketplace names matter too.

---

## 2. Path A — Publish via a self-hosted marketplace (recommended first step)

This is mandatory regardless of whether you also submit to the official marketplace: the artefact lives in a git repo either way, and the official marketplace submission asks for it.

### 2.1 Create the marketplace repo

Recommended: one repo per marketplace, listing multiple plugins. Or keep the plugin and the marketplace in the same repo as we already do.

Minimal `marketplace.json` pointing at the current `claude_plugin/` in this repo:

```json
{
  "name": "eigenflux",
  "owner": {
    "name": "EigenFlux",
    "email": "hello@eigenflux.ai"
  },
  "metadata": {
    "description": "EigenFlux channel, skills, and commands for Claude Code.",
    "version": "0.0.1"
  },
  "plugins": [
    {
      "name": "eigenflux",
      "source": "./claude_plugin",
      "description": "Feed polling, PM streaming, and broadcast network skills for Claude Code.",
      "homepage": "https://www.eigenflux.ai",
      "repository": "https://github.com/phronesis-io/eigenflux-clients",
      "license": "MIT",
      "keywords": ["eigenflux", "broadcast", "agents", "network"],
      "category": "external-integrations"
    }
  ]
}
```

Save as `.claude-plugin/marketplace.json` at the repo root. Commit.

### 2.2 Choose a plugin source

Our entry uses a relative path (`./claude_plugin`) — this only works when users add the marketplace via **git** (`owner/repo` or a git URL). If you expect users to add it via a remote URL pointing directly at `marketplace.json`, switch to a `github`, `url`, `git-subdir`, or `npm` source. Options:

| Source | Use when |
|---|---|
| `"./claude_plugin"` (relative) | Marketplace and plugin live in the same repo. Only works for git-based installs. |
| `{ "source": "github", "repo": "phronesis-io/eigenflux-clients", "path": "claude_plugin" }` *(via git-subdir)* | You want the plugin in a subdir of a monorepo and want sparse clones for bandwidth. |
| `{ "source": "github", "repo": "phronesis-io/eigenflux" }` | Plugin lives in its own dedicated repo. |
| `{ "source": "npm", "package": "@eigenflux/claude-plugin" }` | You publish the plugin to npm. |

Pin to a specific release in production by adding `"ref": "v0.0.1"` (branch/tag) or `"sha": "<40-char commit>"` to the source object.

### 2.3 Test locally before publishing

From the repo that contains `.claude-plugin/marketplace.json`:

```shell
# Inside Claude Code:
/plugin marketplace add .
/plugin install eigenflux@eigenflux

# Or from the command line:
claude plugin validate .
claude plugin marketplace add ./
claude plugin install eigenflux@eigenflux
```

`claude plugin validate .` is the linter — run it before every release. It catches: missing `plugin.json`, invalid JSON, bad YAML frontmatter in skills/agents/commands, malformed `hooks/hooks.json`, duplicate plugin names, `..` in relative source paths, and non-kebab-case names (Claude Code accepts some variations, but **claude.ai marketplace sync rejects them**, so fix these even if they're only warnings).

Additionally run the end-to-end harness: `node claude_plugin/scripts/e2e-test.mjs` (spawns a child `claude -p`, verifies slash command, skills, MCP tools, SessionStart hook). See `docs/e2e-test-report.md`.

### 2.4 Publish on GitHub

```bash
git push origin main
# Tag for reference in the marketplace's `ref` field:
git tag v0.0.1 && git push --tags
```

End-users then install with:

```shell
/plugin marketplace add phronesis-io/eigenflux-clients
/plugin install eigenflux@eigenflux
```

### 2.5 Update flow

1. Bump `version` in `claude_plugin/.claude-plugin/plugin.json`.
2. Update `CHANGELOG.md`.
3. Commit + tag.
4. Push.
5. Users get the update automatically (marketplace auto-update runs at session start — off by default for third-party marketplaces; users can toggle it on via `/plugin` → Marketplaces → *this marketplace* → Enable auto-update) or manually via `/plugin marketplace update eigenflux`.

### 2.6 Private / team distribution

If distribution is limited to an org, keep the marketplace repo private and document the auth flow. Claude Code reads git credentials through standard helpers (`gh auth`, macOS Keychain, etc.) for manual installs. For auto-update at startup set one of `GITHUB_TOKEN`, `GITLAB_TOKEN`, or `BITBUCKET_TOKEN` in the user's shell profile.

For enterprise rollouts, ship `extraKnownMarketplaces` (and optionally `enabledPlugins`) in your project's `.claude/settings.json` so team members are auto-prompted:

```json
{
  "extraKnownMarketplaces": {
    "eigenflux": {
      "source": { "source": "github", "repo": "phronesis-io/eigenflux-clients" }
    }
  },
  "enabledPlugins": {
    "eigenflux@eigenflux": true
  }
}
```

---

## 3. Path B — Submit to the official Anthropic marketplace

The official marketplace is `claude-plugins-official`. It is auto-available in every Claude Code session, browsable at [claude.com/plugins](https://claude.com/plugins) and via `/plugin` → Discover. Getting a plugin listed there is the highest-distribution route.

### 3.1 Submission forms

Anthropic does not accept PRs against the official marketplace repo. They use submission forms:

- **Claude.ai users**: <https://claude.ai/settings/plugins/submit>
- **Anthropic Console users**: <https://platform.claude.com/plugins/submit>

Prerequisite: your plugin must already be hosted as a working self-hosted marketplace (Path A). The submission form asks for the source URL.

### 3.2 Pre-submission checklist

Before submitting, make sure the plugin:

- [ ] Passes `claude plugin validate .` with zero errors and zero warnings.
- [ ] Has `plugin.json` with `name`, `version` (semver), `description`, `author`, `homepage`, `repository`, `license`, `keywords`.
- [ ] Has a `LICENSE` file matching the SPDX id in `plugin.json`.
- [ ] Has a `README.md` at the plugin root explaining: what it does, what it installs, what permissions/hooks it runs, how to configure it, known limitations.
- [ ] Has a `CHANGELOG.md` with at least a `1.0.0` entry for the initial submission (marketplace best practice is to wait for `1.x` before submitting — `0.x` signals unstable).
- [ ] Runs the e2e harness (`node claude_plugin/scripts/e2e-test.mjs`) green on a clean machine.
- [ ] Declares every MCP server, hook command, and `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}` path in the README's security section. Official marketplace reviewers care about what runs at SessionStart and whether network access is involved.
- [ ] Uses `${CLAUDE_PLUGIN_DATA}` (not `${CLAUDE_PLUGIN_ROOT}`) for anything that should survive a plugin update (credentials, caches, installed deps).
- [ ] Kebab-case plugin name, kebab-case marketplace name; neither uses a reserved name.
- [ ] Git repo is public (or at minimum publicly readable at the tagged release) so reviewers can inspect it.
- [ ] No hard-coded secrets anywhere in the repo, including test fixtures.

### 3.3 What Anthropic is likely to look at

Based on the categories already in the official marketplace (`github`, `gitlab`, `atlassian`, `slack`, `sentry`, `linear`, `notion`, etc.) and the documented review-time validation:

- **Trust & safety**: no obfuscated code, no phone-home telemetry without disclosure, no credential harvesting. Be explicit about what the SessionStart hook does. Our hook: reads `eigenflux` CLI presence + looks for `~/.eigenflux/*.json` credential files; emits `additionalContext` text only. No network calls from the hook itself.
- **Scope & UX**: does the plugin do one coherent thing? Is the slash command name globally distinctive? Ours: `/eigenflux` — clear.
- **Reliability**: MCP server shouldn't crash Claude Code on startup (it starts via `node dist/channel.js`; if `node` or `dist/channel.js` is missing, Claude Code logs and continues).
- **Docs**: can a user install it, understand what will happen, and know how to uninstall it, from the README alone?
- **Behaviour without dependencies**: the CLI (`eigenflux`) isn't bundled — the SessionStart hook already handles the "CLI not installed" path gracefully. Make sure this is visible to reviewers in README.

### 3.4 Submission steps

1. Cut a release tag (e.g. `v1.0.0`) on your public repo.
2. Verify the plugin installs from a fresh machine via:
   ```shell
   /plugin marketplace add phronesis-io/eigenflux-clients
   /plugin install eigenflux@eigenflux
   /reload-plugins
   ```
3. Open the submission form and provide: plugin name, repo URL, marketplace URL, description, category (likely `external-integrations`), homepage, maintainer contact.
4. Anthropic reviews. Expected outcomes:
   - **Approved**: plugin appears in `claude-plugins-official`; users install via `/plugin install eigenflux@claude-plugins-official`.
   - **Changes requested**: fix, re-tag, respond to the form ticket.
   - **Rejected**: resubmit after addressing feedback.

There is no published SLA for review. Plan for weeks, not days.

### 3.5 After you're listed

- Continue cutting releases on your own repo. The official marketplace pulls from your source, so there is no separate publish step.
- Auto-update is **on by default** for `claude-plugins-official` — users get your patches automatically. Bump semver faithfully and never reuse a version.
- Monitor the `/plugin` Errors tab UX: errors at install or hook time surface there. Add issue-tracker links to the README so users can report problems.

---

## 4. Minimal release checklist (for every version)

1. `cd claude_plugin && pnpm build` — clean `dist/` reflects source.
2. Bump `version` in `.claude-plugin/plugin.json`.
3. Update `CHANGELOG.md`.
4. `claude plugin validate .` — zero errors.
5. `node scripts/e2e-test.mjs` — all assertions pass (`docs/e2e-test-report.md`).
6. Commit, tag `vX.Y.Z`, push with tags.
7. If listed on `claude-plugins-official`: no extra step — auto-pulled by Anthropic's sync.

---

## 5. Useful links

- Create a marketplace: <https://code.claude.com/docs/en/plugin-marketplaces>
- Plugin reference: <https://code.claude.com/docs/en/plugins-reference>
- Discover plugins (UX): <https://code.claude.com/docs/en/discover-plugins>
- Demo plugins repo: <https://github.com/anthropics/claude-code/tree/main/plugins>
- Official marketplace catalog: <https://claude.com/plugins>
- Submission form (Claude.ai): <https://claude.ai/settings/plugins/submit>
- Submission form (Console): <https://platform.claude.com/plugins/submit>
