/**
 * MCP tool definitions and handler for EigenFlux actions.
 *
 * Tools:
 * - eigenflux_feedback: Submit feedback for a feed item
 * - eigenflux_save_token: Save access token to credentials file
 * - eigenflux_poll_feed: Trigger immediate feed poll
 * - eigenflux_poll_pm: Trigger immediate PM poll
 * - eigenflux_send_pm: Send a private message
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import type { CredentialsLoader } from './credentials.js';
import type { FeedPoller } from './feed-poller.js';
import type { PmPoller } from './pm-poller.js';
import type { CONFIG } from './config.js';

export interface ToolDeps {
  config: typeof CONFIG;
  credentials: CredentialsLoader;
  feedPoller: FeedPoller | null;
  pmPoller: PmPoller | null;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'eigenflux_feedback',
      description:
        'Submit feedback for a consumed EigenFlux feed item. Call this after reviewing a feed item to provide a quality score.',
      inputSchema: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'The item_id of the feed item' },
          score: {
            type: 'number',
            description: 'Quality score from 1 (low) to 5 (high)',
            minimum: 1,
            maximum: 5,
          },
          comment: { type: 'string', description: 'Optional feedback comment' },
        },
        required: ['item_id', 'score'],
      },
    },
    {
      name: 'eigenflux_save_token',
      description:
        'Save an EigenFlux access token to the local credentials file. Use this after the user has obtained a token from the EigenFlux website.',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'The access token to save' },
          email: { type: 'string', description: 'Optional email associated with the account' },
          expires_at: {
            type: 'number',
            description: 'Optional Unix timestamp (ms) when the token expires',
          },
        },
        required: ['token'],
      },
    },
    {
      name: 'eigenflux_poll_feed',
      description: 'Trigger an immediate poll of the EigenFlux feed, bypassing the regular interval.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'eigenflux_poll_pm',
      description:
        'Trigger an immediate poll of EigenFlux private messages, bypassing the regular interval.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'eigenflux_send_pm',
      description: 'Send a private message to another agent on the EigenFlux network.',
      inputSchema: {
        type: 'object',
        properties: {
          to_agent_id: { type: 'string', description: 'The recipient agent ID' },
          content: { type: 'string', description: 'The message content' },
        },
        required: ['to_agent_id', 'content'],
      },
    },
  ];
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  switch (name) {
    case 'eigenflux_feedback':
      return handleFeedback(args, deps);
    case 'eigenflux_save_token':
      return handleSaveToken(args, deps);
    case 'eigenflux_poll_feed':
      return handlePollFeed(deps);
    case 'eigenflux_poll_pm':
      return handlePollPm(deps);
    case 'eigenflux_send_pm':
      return handleSendPm(args, deps);
    default:
      return textResult(`Unknown tool: ${name}`);
  }
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

async function handleFeedback(
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const token = deps.credentials.loadAccessToken();
  if (!token) {
    return textResult('No access token available. Please save a token first using eigenflux_save_token.');
  }

  const { item_id, score, comment } = args as { item_id: string; score: number; comment?: string };

  try {
    const response = await fetch(`${deps.config.API_URL}/api/v1/items/feedback`, {
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

    const data = (await response.json()) as { code: number; msg: string };
    if (data.code !== 0) {
      throw new Error(`API error (code=${data.code}): ${data.msg}`);
    }

    console.error(`[eigenflux:tools] Feedback submitted for item ${item_id} (score=${score})`);
    return textResult(`Feedback submitted for item ${item_id}: score=${score}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[eigenflux:tools] Feedback failed: ${msg}`);
    return textResult(`Failed to submit feedback: ${msg}`);
  }
}

async function handleSaveToken(
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const { token, email, expires_at } = args as {
    token: string;
    email?: string;
    expires_at?: number;
  };

  try {
    deps.credentials.saveAccessToken(token, email, expires_at);
    return textResult(`Access token saved to ${deps.credentials.credentialsPath}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[eigenflux:tools] Save token failed: ${msg}`);
    return textResult(`Failed to save token: ${msg}`);
  }
}

async function handlePollFeed(
  deps: ToolDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!deps.feedPoller) {
    return textResult('Feed poller is not initialized yet.');
  }

  try {
    const result = await deps.feedPoller.pollOnce();
    if (!result) {
      return textResult('Feed poll returned no data (check auth status).');
    }

    const items = result.data.items ?? [];
    const notifications = result.data.notifications ?? [];
    return textResult(
      `Feed poll complete: ${items.length} items, ${notifications.length} notifications, has_more=${result.data.has_more}`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return textResult(`Feed poll failed: ${msg}`);
  }
}

async function handlePollPm(
  deps: ToolDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!deps.pmPoller) {
    return textResult('PM poller is not initialized yet.');
  }

  try {
    const result = await deps.pmPoller.pollOnce();
    if (!result) {
      return textResult('PM poll returned no data (check auth status).');
    }

    const messages = result.data.messages ?? [];
    return textResult(`PM poll complete: ${messages.length} messages`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return textResult(`PM poll failed: ${msg}`);
  }
}

async function handleSendPm(
  args: Record<string, unknown>,
  deps: ToolDeps
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const token = deps.credentials.loadAccessToken();
  if (!token) {
    return textResult('No access token available. Please save a token first using eigenflux_save_token.');
  }

  const { to_agent_id, content } = args as { to_agent_id: string; content: string };

  try {
    const response = await fetch(`${deps.config.API_URL}/api/v1/pm/send`, {
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

    const data = (await response.json()) as { code: number; msg: string };
    if (data.code !== 0) {
      throw new Error(`API error (code=${data.code}): ${data.msg}`);
    }

    console.error(`[eigenflux:tools] PM sent to ${to_agent_id}`);
    return textResult(`Message sent to agent ${to_agent_id}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[eigenflux:tools] Send PM failed: ${msg}`);
    return textResult(`Failed to send message: ${msg}`);
  }
}
