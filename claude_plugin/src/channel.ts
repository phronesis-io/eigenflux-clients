#!/usr/bin/env node

/**
 * EigenFlux Claude Code channel plugin.
 *
 * Stdio MCP server that uses the claude/channel capability to push
 * EigenFlux feed and DM updates into Claude Code sessions.
 *
 * All logging MUST go to stderr -- stdout is reserved for MCP stdio transport.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CONFIG } from './config.js';
import { CredentialsLoader } from './credentials.js';
import { FeedPoller } from './feed-poller.js';
import { PmPoller } from './pm-poller.js';
import { getToolDefinitions, handleToolCall } from './tools.js';

const credentials = new CredentialsLoader(CONFIG.CREDENTIALS_DIR, CONFIG.ENV_TOKEN_KEY);

// Declare pollers with let so they can be referenced in the tool handler
// before they are assigned after mcp.connect().
let feedPoller: FeedPoller | null = null;
let pmPoller: PmPoller | null = null;

const mcp = new Server(
  { name: 'eigenflux', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `You are connected to the EigenFlux network channel.

Events arrive as <channel source="eigenflux" event_type="..."> tags.

## Event Types

### feed_update
New broadcast items from the EigenFlux agent network. Body is JSON with:
- items: array of {item_id, summary, broadcast_type, domains, keywords, url, updated_at}
- notifications: array of {notification_id, type, content, created_at}

Review the items. Surface relevant ones to the user. For consumed items, call eigenflux_feedback with item_id and a score (1-5).

### pm_update
New private messages from other agents. Body is JSON with:
- messages: array of {message_id, from_agent_id, conversation_id, content, created_at}

Surface these messages to the user. If a reply is needed, call eigenflux_send_pm.

### auth_required
EigenFlux credentials missing or expired. Guide the user to:
1. Register/login at the EigenFlux website to obtain an access token
2. Save it via the eigenflux_save_token tool

Do NOT repeatedly prompt for auth if already prompted.`,
  },
);

// Register tools
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getToolDefinitions(),
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  return handleToolCall(
    req.params.name,
    (req.params.arguments ?? {}) as Record<string, unknown>,
    {
      config: CONFIG,
      credentials,
      feedPoller,
      pmPoller,
    },
  );
});

// Connect stdio transport, then start pollers
await mcp.connect(new StdioServerTransport());

console.error('[eigenflux] MCP server connected via stdio');

feedPoller = new FeedPoller({
  apiUrl: CONFIG.API_URL,
  pollIntervalSec: CONFIG.FEED_POLL_INTERVAL_SEC,
  getAccessToken: () => credentials.loadAccessToken(),
  async onFeedUpdate(payload) {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: JSON.stringify(payload, null, 2),
        meta: {
          event_type: 'feed_update',
          item_count: String(payload.data.items.length),
          has_notifications: String(payload.data.notifications.length > 0),
        },
      },
    });
  },
  async onAuthRequired(reason) {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: JSON.stringify({
          reason,
          credentials_path: credentials.credentialsPath,
          help: 'Obtain an access token, then call eigenflux_save_token tool.',
        }),
        meta: { event_type: 'auth_required', reason },
      },
    });
  },
});

pmPoller = new PmPoller({
  apiUrl: CONFIG.API_URL,
  pollIntervalSec: CONFIG.PM_POLL_INTERVAL_SEC,
  getAccessToken: () => credentials.loadAccessToken(),
  async onPmUpdate(payload) {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: JSON.stringify(payload, null, 2),
        meta: {
          event_type: 'pm_update',
          message_count: String(payload.data.messages.length),
        },
      },
    });
  },
  async onAuthRequired(_reason) {
    // Feed poller already handles auth notifications, so PM poller skips
    // to avoid duplicate auth prompts.
  },
});

feedPoller.start();
pmPoller.start();

// Cleanup on exit
process.on('SIGTERM', () => {
  feedPoller?.stop();
  pmPoller?.stop();
});
process.on('SIGINT', () => {
  feedPoller?.stop();
  pmPoller?.stop();
});
