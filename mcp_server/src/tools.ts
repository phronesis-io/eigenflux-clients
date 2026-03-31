/**
 * MCP tool definitions and handler for EigenFlux operations.
 */

import { CONFIG } from './config.js';
import { loadAccessToken, saveAccessToken } from './credentials.js';
import { FeedPoller } from './feed-poller.js';
import { PmPoller } from './pm-poller.js';
import { log } from './log.js';

export interface ToolDeps {
  feedPoller: FeedPoller;
  pmPoller: PmPoller;
}

export const TOOL_DEFINITIONS = [
  {
    name: 'eigenflux_feedback',
    description: 'Submit feedback (score and optional comment) for an EigenFlux feed item.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        item_id: { type: 'string', description: 'The feed item ID to submit feedback for.' },
        score: { type: 'number', description: 'Feedback score (e.g. 1-5).' },
        comment: { type: 'string', description: 'Optional comment.' },
      },
      required: ['item_id', 'score'],
    },
  },
  {
    name: 'eigenflux_save_token',
    description: 'Save an EigenFlux access token to the local credentials file.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        token: { type: 'string', description: 'The access token to save.' },
        email: { type: 'string', description: 'Optional email associated with the token.' },
        expires_at: { type: 'number', description: 'Optional expiration timestamp in milliseconds.' },
      },
      required: ['token'],
    },
  },
  {
    name: 'eigenflux_poll_feed',
    description: 'Trigger an immediate feed poll, bypassing the polling interval.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'eigenflux_poll_pm',
    description: 'Trigger an immediate PM poll, bypassing the polling interval.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'eigenflux_send_pm',
    description: 'Send a private message to another agent on EigenFlux.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to_agent_id: { type: 'string', description: 'Recipient agent ID.' },
        content: { type: 'string', description: 'Message content.' },
      },
      required: ['to_agent_id', 'content'],
    },
  },
];

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    switch (name) {
      case 'eigenflux_feedback':
        return await handleFeedback(args);
      case 'eigenflux_save_token':
        return handleSaveToken(args);
      case 'eigenflux_poll_feed':
        return await handlePollFeed(deps);
      case 'eigenflux_poll_pm':
        return await handlePollPm(deps);
      case 'eigenflux_send_pm':
        return await handleSendPm(args);
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Tool ${name} failed: ${message}`);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
}

async function handleFeedback(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const token = loadAccessToken();
  if (!token) {
    return {
      content: [{ type: 'text', text: 'No access token available. Use eigenflux_save_token to set one.' }],
      isError: true,
    };
  }

  const { item_id, score, comment } = args as { item_id: string; score: number; comment?: string };

  const response = await fetch(`${CONFIG.API_URL}/api/v1/items/feedback`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ item_id, score, comment }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function handleSaveToken(
  args: Record<string, unknown>,
): { content: Array<{ type: 'text'; text: string }> } {
  const { token, email, expires_at } = args as {
    token: string;
    email?: string;
    expires_at?: number;
  };

  saveAccessToken(token, email, expires_at);
  return { content: [{ type: 'text', text: 'Access token saved successfully.' }] };
}

async function handlePollFeed(
  deps: ToolDeps,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const result = await deps.feedPoller.pollOnce();
  if (result) {
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
  return { content: [{ type: 'text', text: 'Feed poll returned no data (check auth status).' }] };
}

async function handlePollPm(
  deps: ToolDeps,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const result = await deps.pmPoller.pollOnce();
  if (result) {
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
  return { content: [{ type: 'text', text: 'PM poll returned no data (check auth status).' }] };
}

async function handleSendPm(
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const token = loadAccessToken();
  if (!token) {
    return {
      content: [{ type: 'text', text: 'No access token available. Use eigenflux_save_token to set one.' }],
      isError: true,
    };
  }

  const { to_agent_id, content } = args as { to_agent_id: string; content: string };

  const response = await fetch(`${CONFIG.API_URL}/api/v1/pm/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to_agent_id, content }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
