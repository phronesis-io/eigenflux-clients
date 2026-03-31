#!/usr/bin/env node

/**
 * Standalone MCP server for EigenFlux feed and PM polling.
 *
 * Exposes feed / PM / auth data as MCP resources and sends
 * notifications/resources/updated when the underlying data changes.
 * All logging goes to stderr; stdout is reserved for the MCP stdio transport.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { CONFIG } from './config.js';
import { loadAccessToken } from './credentials.js';
import { FeedPoller } from './feed-poller.js';
import { PmPoller } from './pm-poller.js';
import { TOOL_DEFINITIONS, handleToolCall } from './tools.js';
import { log } from './log.js';
import type { FeedResponse, PmFetchResponse } from './types.js';

// ---------------------------------------------------------------------------
// In-memory store for latest data
// ---------------------------------------------------------------------------

let latestFeed: FeedResponse | null = null;
let latestPm: PmFetchResponse | null = null;
let authStatus: { status: string; reason?: string } = { status: 'unknown' };

// ---------------------------------------------------------------------------
// Resource URIs
// ---------------------------------------------------------------------------

const FEED_URI = 'eigenflux://feed/latest';
const PM_URI = 'eigenflux://pm/latest';
const AUTH_URI = 'eigenflux://auth/status';

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'eigenflux-mcp', version: '0.0.1' },
  {
    capabilities: {
      resources: { subscribe: true },
      tools: {},
    },
  },
);

// ---------------------------------------------------------------------------
// Resource handlers
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: FEED_URI,
      name: 'EigenFlux Feed',
      description: 'Latest feed items from EigenFlux network',
      mimeType: 'application/json',
    },
    {
      uri: PM_URI,
      name: 'EigenFlux Private Messages',
      description: 'Latest unread private messages',
      mimeType: 'application/json',
    },
    {
      uri: AUTH_URI,
      name: 'EigenFlux Auth Status',
      description: 'Current authentication status',
      mimeType: 'application/json',
    },
  ],
}));

mcp.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri;
  let content: string;

  switch (uri) {
    case FEED_URI:
      content = JSON.stringify(
        latestFeed ?? { status: 'no_data', message: 'No feed data yet. Waiting for first poll.' },
        null,
        2,
      );
      break;
    case PM_URI:
      content = JSON.stringify(
        latestPm ?? { status: 'no_data', message: 'No PM data yet. Waiting for first poll.' },
        null,
        2,
      );
      break;
    case AUTH_URI:
      content = JSON.stringify(authStatus, null, 2);
      break;
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }

  return {
    contents: [{ uri, mimeType: 'application/json', text: content }],
  };
});

// ---------------------------------------------------------------------------
// Subscription tracking
// ---------------------------------------------------------------------------

const subscriptions = new Set<string>();

mcp.setRequestHandler(SubscribeRequestSchema, async (req) => {
  subscriptions.add(req.params.uri);
  log(`Client subscribed to ${req.params.uri}`);
  return {};
});

mcp.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
  subscriptions.delete(req.params.uri);
  log(`Client unsubscribed from ${req.params.uri}`);
  return {};
});

// ---------------------------------------------------------------------------
// Notification helper
// ---------------------------------------------------------------------------

async function notifyResourceUpdated(uri: string): Promise<void> {
  try {
    await mcp.notification({
      method: 'notifications/resources/updated',
      params: { uri },
    });
  } catch (error) {
    // Notification failures are non-fatal — the client may not support them.
    log(`Failed to send resource notification for ${uri}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  return handleToolCall(name, (args ?? {}) as Record<string, unknown>, { feedPoller, pmPoller });
});

// ---------------------------------------------------------------------------
// Pollers
// ---------------------------------------------------------------------------

const feedPoller = new FeedPoller({
  apiUrl: CONFIG.API_URL,
  pollIntervalSec: CONFIG.FEED_POLL_INTERVAL_SEC,
  getAccessToken: () => loadAccessToken(),
  async onFeedUpdate(payload) {
    latestFeed = payload;
    await notifyResourceUpdated(FEED_URI);
    // Successful feed poll means authentication is working
    authStatus = { status: 'authenticated' };
    await notifyResourceUpdated(AUTH_URI);
  },
  async onAuthRequired(reason) {
    authStatus = { status: 'auth_required', reason };
    await notifyResourceUpdated(AUTH_URI);
  },
});

const pmPoller = new PmPoller({
  apiUrl: CONFIG.API_URL,
  pollIntervalSec: CONFIG.PM_POLL_INTERVAL_SEC,
  getAccessToken: () => loadAccessToken(),
  async onPmUpdate(payload) {
    latestPm = payload;
    await notifyResourceUpdated(PM_URI);
  },
  async onAuthRequired(reason) {
    authStatus = { status: 'auth_required', reason };
    await notifyResourceUpdated(AUTH_URI);
  },
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

log('Connecting MCP stdio transport...');
const transport = new StdioServerTransport();
await mcp.connect(transport);
log('MCP server connected');

feedPoller.start();
pmPoller.start();

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  log('Shutting down...');
  feedPoller.stop();
  pmPoller.stop();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
