/**
 * Configuration for the EigenFlux plugin.
 *
 * Server management is now handled by the eigenflux CLI.
 * The plugin config only holds plugin-level settings and
 * per-server notification routing overrides.
 */

import * as os from 'os';
import * as path from 'path';

import { Logger } from './logger';
import { normalizeReplyTarget } from './reply-target';
import { execEigenflux } from './cli-executor';

const PLUGIN_VERSION = '0.0.5';
const DEFAULT_EIGENFLUX_BIN = 'eigenflux';
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';
const DEFAULT_SESSION_KEY = 'main';
const DEFAULT_AGENT_ID = 'main';
const DEFAULT_OPENCLAW_CLI_BIN = 'openclaw';
const DEFAULT_FEED_POLL_INTERVAL_SEC = 300;
const MIN_POLL_INTERVAL_SEC = 10;
const MAX_POLL_INTERVAL_SEC = 24 * 60 * 60;
const HOST_KIND = 'openclaw';

// ─── Types ──────────────────────────────────────────────────────────────────

export type NotificationRouteOverrides = {
  sessionKey: boolean;
  agentId: boolean;
  replyChannel: boolean;
  replyTo: boolean;
  replyAccountId: boolean;
};

export type RoutingConfig = {
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  routeOverrides: NotificationRouteOverrides;
};

export type DiscoveredServer = {
  name: string;
  endpoint: string;
  stream_endpoint?: string;
  current: boolean;
};

export type EigenFluxPluginConfig = {
  eigenfluxBin?: string;
  feedPollInterval?: number;
  skills?: string[];
  gatewayUrl?: string;
  gatewayToken?: string;
  openclawCliBin?: string;
  serverRouting?: Record<string, {
    sessionKey?: string;
    agentId?: string;
    replyChannel?: string;
    replyTo?: string;
    replyAccountId?: string;
  }>;
};

export type ResolvedEigenFluxPluginConfig = {
  eigenfluxBin: string;
  feedPollIntervalSec: number;
  skills: string[];
  gatewayUrl: string;
  gatewayToken?: string;
  openclawCliBin: string;
  serverRouting: Record<string, RoutingConfig>;
};

type GlobalGatewayConfig = {
  gateway?: {
    auth?: {
      token?: string;
    };
  };
};

type DerivedNotificationRoute = {
  agentId?: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function parsePollingIntervalSeconds(
  value: unknown,
  fallback: number,
  options: {
    fieldName: string;
    logger?: Logger;
  }
): number {
  const parsed = parsePositiveInteger(value, fallback);
  if (parsed < MIN_POLL_INTERVAL_SEC) {
    options.logger?.warn(
      `${options.fieldName} is below ${MIN_POLL_INTERVAL_SEC}s; clamping to ${MIN_POLL_INTERVAL_SEC}s`
    );
    return MIN_POLL_INTERVAL_SEC;
  }

  if (parsed <= MAX_POLL_INTERVAL_SEC) {
    return parsed;
  }

  options.logger?.warn(
    `${options.fieldName} exceeds ${MAX_POLL_INTERVAL_SEC}s; clamping to ${MAX_POLL_INTERVAL_SEC}s`
  );
  return MAX_POLL_INTERVAL_SEC;
}

function isSessionPeerShape(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === 'direct' ||
    normalized === 'dm' ||
    normalized === 'group' ||
    normalized === 'channel'
  );
}

function deriveNotificationRoute(sessionKey: string | undefined): DerivedNotificationRoute {
  const trimmed = readNonEmptyString(sessionKey);
  if (!trimmed) {
    return {};
  }

  const parts = trimmed.split(':').filter((part) => part.length > 0);
  if (parts.length < 3 || parts[0]?.toLowerCase() !== 'agent') {
    return {};
  }

  const agentId = readNonEmptyString(parts[1]);
  if (parts.length >= 6 && isSessionPeerShape(parts[4])) {
    return {
      agentId,
      replyChannel: readNonEmptyString(parts[2]),
      replyAccountId: readNonEmptyString(parts[3]),
      replyTo: normalizeReplyTarget(parts.slice(5).join(':'), {
        channel: readNonEmptyString(parts[2]),
        sessionKey: trimmed,
      }),
    };
  }

  if (parts.length >= 5 && isSessionPeerShape(parts[3])) {
    return {
      agentId,
      replyChannel: readNonEmptyString(parts[2]),
      replyTo: normalizeReplyTarget(parts.slice(4).join(':'), {
        channel: readNonEmptyString(parts[2]),
        sessionKey: trimmed,
      }),
    };
  }

  return { agentId };
}

function createRouteOverrides(
  normalized: Record<string, unknown>
): NotificationRouteOverrides {
  const sessionKey = readNonEmptyString(normalized.sessionKey);
  const agentId = readNonEmptyString(normalized.agentId);
  const replyChannel = readNonEmptyString(normalized.replyChannel);
  const replyTo = readNonEmptyString(normalized.replyTo);
  const replyAccountId = readNonEmptyString(normalized.replyAccountId);

  return {
    sessionKey: sessionKey !== undefined && sessionKey !== DEFAULT_SESSION_KEY,
    agentId:
      agentId !== undefined &&
      agentId !== DEFAULT_AGENT_ID &&
      !(sessionKey && deriveNotificationRoute(sessionKey).agentId === agentId),
    replyChannel: replyChannel !== undefined,
    replyTo: replyTo !== undefined,
    replyAccountId: replyAccountId !== undefined,
  };
}

// ─── Server Discovery ───────────────────────────────────────────────────────

export async function discoverServers(
  eigenfluxBin: string,
  logger?: Logger
): Promise<DiscoveredServer[]> {
  const result = await execEigenflux<DiscoveredServer[]>(
    eigenfluxBin,
    ['config', 'server', 'list', '-f', 'json'],
    { logger }
  );

  if (result.kind === 'success') {
    if (Array.isArray(result.data)) {
      return result.data;
    }
    logger?.warn('eigenflux config server list returned non-array data');
    return [];
  }

  if (result.kind === 'auth_required') {
    logger?.warn('eigenflux config server list: auth required (unexpected)');
    return [];
  }

  logger?.error(`eigenflux config server list failed: ${result.error.message}`);
  return [];
}

// ─── EigenFlux Home ─────────────────────────────────────────────────────────

export function resolveEigenfluxHome(): string {
  const envHome = process.env.EIGENFLUX_HOME;
  if (envHome) {
    const expanded = expandHomeDir(envHome);
    if (!expanded.endsWith('.eigenflux')) {
      return path.join(expanded, '.eigenflux');
    }
    return expanded;
  }
  return path.join(os.homedir(), '.eigenflux');
}

// ─── Config Resolution ──────────────────────────────────────────────────────

function resolveRoutingConfig(
  raw: Record<string, unknown> | undefined,
  logger?: Logger
): RoutingConfig {
  const normalized = isRecord(raw) ? raw : {};
  const sessionKey = readNonEmptyString(normalized.sessionKey) ?? DEFAULT_SESSION_KEY;
  const derivedRoute = deriveNotificationRoute(sessionKey);
  const replyChannel = readNonEmptyString(normalized.replyChannel) ?? derivedRoute.replyChannel;
  const replyTo =
    normalizeReplyTarget(readNonEmptyString(normalized.replyTo), {
      channel: replyChannel,
      sessionKey,
    }) ?? derivedRoute.replyTo;

  return {
    sessionKey,
    agentId: readNonEmptyString(normalized.agentId) ?? derivedRoute.agentId ?? DEFAULT_AGENT_ID,
    replyChannel,
    replyTo,
    replyAccountId:
      readNonEmptyString(normalized.replyAccountId) ?? derivedRoute.replyAccountId,
    routeOverrides: createRouteOverrides(normalized),
  };
}

export function resolvePluginConfig(
  pluginConfig: unknown,
  globalConfig?: GlobalGatewayConfig,
  logger?: Logger
): ResolvedEigenFluxPluginConfig {
  const normalized = isRecord(pluginConfig) ? pluginConfig : {};

  const rawRouting = isRecord(normalized.serverRouting) ? normalized.serverRouting : {};
  const serverRouting: Record<string, RoutingConfig> = {};
  for (const [serverName, rawConfig] of Object.entries(rawRouting)) {
    serverRouting[serverName] = resolveRoutingConfig(
      isRecord(rawConfig) ? rawConfig : undefined,
      logger
    );
  }

  const rawSkills = Array.isArray(normalized.skills)
    ? normalized.skills.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : ['ef-broadcast', 'ef-communication'];

  return {
    eigenfluxBin: readNonEmptyString(normalized.eigenfluxBin) ?? DEFAULT_EIGENFLUX_BIN,
    feedPollIntervalSec: parsePollingIntervalSeconds(
      normalized.feedPollInterval,
      DEFAULT_FEED_POLL_INTERVAL_SEC,
      { fieldName: 'feedPollInterval', logger }
    ),
    skills: rawSkills,
    gatewayUrl: readNonEmptyString(normalized.gatewayUrl) ?? DEFAULT_GATEWAY_URL,
    gatewayToken:
      readNonEmptyString(normalized.gatewayToken) ??
      readNonEmptyString(globalConfig?.gateway?.auth?.token),
    openclawCliBin:
      readNonEmptyString(normalized.openclawCliBin) ?? DEFAULT_OPENCLAW_CLI_BIN,
    serverRouting,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

export function expandHomeDir(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export const PLUGIN_CONFIG = {
  DEFAULT_EIGENFLUX_BIN,
  DEFAULT_GATEWAY_URL,
  DEFAULT_SESSION_KEY,
  DEFAULT_AGENT_ID,
  DEFAULT_OPENCLAW_CLI_BIN,
  DEFAULT_FEED_POLL_INTERVAL_SEC,
  MIN_POLL_INTERVAL_SEC,
  MAX_POLL_INTERVAL_SEC,
  HOST_KIND,
  PLUGIN_VERSION,
} as const;

export const PLUGIN_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    eigenfluxBin: {
      type: 'string',
      description: 'Path to the eigenflux CLI binary',
      default: DEFAULT_EIGENFLUX_BIN,
    },
    feedPollInterval: {
      type: 'integer',
      minimum: MIN_POLL_INTERVAL_SEC,
      maximum: MAX_POLL_INTERVAL_SEC,
      description: 'Feed polling interval in seconds',
      default: DEFAULT_FEED_POLL_INTERVAL_SEC,
    },
    skills: {
      type: 'array',
      items: { type: 'string' },
      description: 'EigenFlux skill names bundled with the plugin',
      default: ['ef-broadcast', 'ef-communication'],
    },
    gatewayUrl: {
      type: 'string',
      description: 'OpenClaw Gateway WebSocket URL used for Gateway RPC fallback',
      default: DEFAULT_GATEWAY_URL,
    },
    gatewayToken: {
      type: 'string',
      description: 'Optional gateway token override used for Gateway RPC fallback',
    },
    openclawCliBin: {
      type: 'string',
      description: 'OpenClaw CLI binary used by runtime command fallbacks',
      default: DEFAULT_OPENCLAW_CLI_BIN,
    },
    serverRouting: {
      type: 'object',
      description: 'Per-server notification routing overrides keyed by server name',
      additionalProperties: {
        type: 'object',
        properties: {
          sessionKey: { type: 'string' },
          agentId: { type: 'string' },
          replyChannel: { type: 'string' },
          replyTo: { type: 'string' },
          replyAccountId: { type: 'string' },
        },
      },
    },
  },
} as const;
