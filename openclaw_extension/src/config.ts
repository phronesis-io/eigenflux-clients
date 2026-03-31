/**
 * Internal configuration for the EigenFlux plugin.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Logger } from './logger';

const PLUGIN_VERSION = '0.0.3';
const DEFAULT_SERVER_NAME = 'eigenflux';
const DEFAULT_ENDPOINT = 'https://www.eigenflux.ai';
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';
const DEFAULT_SESSION_KEY = 'main';
const DEFAULT_AGENT_ID = 'main';
const DEFAULT_OPENCLAW_CLI_BIN = 'openclaw';
const DEFAULT_POLL_INTERVAL_SEC = 300;
const DEFAULT_PM_POLL_INTERVAL_SEC = 60;
const MIN_POLL_INTERVAL_SEC = 10;
const MAX_POLL_INTERVAL_SEC = 24 * 60 * 60;
const HOST_KIND = 'openclaw';

export type NotificationRouteOverrides = {
  sessionKey: boolean;
  agentId: boolean;
  replyChannel: boolean;
  replyTo: boolean;
  replyAccountId: boolean;
};

export type EigenFluxServerConfig = {
  enabled?: boolean;
  name?: string;
  endpoint?: string;
  workdir?: string;
  pollInterval?: number;
  pmPollInterval?: number;
  sessionKey?: string;
  agentId?: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
};

export type EigenFluxPluginConfig = {
  gatewayUrl?: string;
  gatewayToken?: string;
  openclawCliBin?: string;
  servers?: EigenFluxServerConfig[];
};

export type ResolvedEigenFluxServerConfig = {
  enabled: boolean;
  name: string;
  endpoint: string;
  workdir: string;
  pollIntervalSec: number;
  pmPollIntervalSec: number;
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  routeOverrides: NotificationRouteOverrides;
};

export type ResolvedEigenFluxPluginConfig = {
  gatewayUrl: string;
  gatewayToken?: string;
  openclawCliBin: string;
  servers: ResolvedEigenFluxServerConfig[];
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

function detectOpenClawVersion(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('openclaw/package.json') as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

function buildUserAgent(): string {
  const parts: string[] = [];

  parts.push(`node/${process.version.replace(/^v/, '')}`);
  parts.push(`(${os.platform()}; ${os.arch()}; ${os.release()})`);

  const openclawVersion = detectOpenClawVersion();
  if (openclawVersion) {
    parts.push(`openclaw/${openclawVersion}`);
  }

  return parts.join(' ');
}

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
    fieldName: 'pollInterval' | 'pmPollInterval';
    serverName: string;
    logger?: Logger;
  }
): number {
  const parsed = parsePositiveInteger(value, fallback);
  if (parsed < MIN_POLL_INTERVAL_SEC) {
    options.logger?.warn(
      `${options.fieldName} for server "${options.serverName}" is below ${MIN_POLL_INTERVAL_SEC}s; clamping to ${MIN_POLL_INTERVAL_SEC}s`
    );
    return MIN_POLL_INTERVAL_SEC;
  }

  if (parsed <= MAX_POLL_INTERVAL_SEC) {
    return parsed;
  }

  options.logger?.warn(
    `${options.fieldName} for server "${options.serverName}" exceeds ${MAX_POLL_INTERVAL_SEC}s; clamping to ${MAX_POLL_INTERVAL_SEC}s`
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
      replyTo: readNonEmptyString(parts.slice(5).join(':')),
    };
  }

  if (parts.length >= 5 && isSessionPeerShape(parts[3])) {
    return {
      agentId,
      replyChannel: readNonEmptyString(parts[2]),
      replyTo: readNonEmptyString(parts.slice(4).join(':')),
    };
  }

  return { agentId };
}

function createRouteOverrides(
  normalized: Record<string, unknown>
): NotificationRouteOverrides {
  return {
    sessionKey: readNonEmptyString(normalized.sessionKey) !== undefined,
    agentId: readNonEmptyString(normalized.agentId) !== undefined,
    replyChannel: readNonEmptyString(normalized.replyChannel) !== undefined,
    replyTo: readNonEmptyString(normalized.replyTo) !== undefined,
    replyAccountId: readNonEmptyString(normalized.replyAccountId) !== undefined,
  };
}

function hasExplicitDefaultServer(servers: Record<string, unknown>[]): boolean {
  return servers.some(
    (server) => readNonEmptyString(server.name)?.toLowerCase() === DEFAULT_SERVER_NAME
  );
}

function normalizeServersInput(config: Record<string, unknown>): EigenFluxServerConfig[] {
  const explicitServers = Array.isArray(config.servers)
    ? config.servers.filter(isRecord)
    : [];

  if (!hasExplicitDefaultServer(explicitServers)) {
    return [{} as EigenFluxServerConfig, ...explicitServers];
  }

  return explicitServers;
}

function createServerName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  let suffix = 2;
  while (usedNames.has(`${baseName}-${suffix}`)) {
    suffix += 1;
  }
  const uniqueName = `${baseName}-${suffix}`;
  usedNames.add(uniqueName);
  return uniqueName;
}

function resolveServerConfig(
  serverConfig: unknown,
  index: number,
  usedNames: Set<string>,
  logger?: Logger
): ResolvedEigenFluxServerConfig {
  const normalized = isRecord(serverConfig) ? serverConfig : {};
  const rawName =
    readNonEmptyString(normalized.name) ??
    (index === 0 ? DEFAULT_SERVER_NAME : `server-${index + 1}`);
  const name = createServerName(rawName, usedNames);
  const sessionKey = readNonEmptyString(normalized.sessionKey) ?? DEFAULT_SESSION_KEY;
  const derivedRoute = deriveNotificationRoute(sessionKey);
  const workdir = expandHomeDir(
    readNonEmptyString(normalized.workdir) ?? `~/.openclaw/${name}`
  );
  const sessionStorePath = readNonEmptyString(normalized.sessionStorePath);

  return {
    enabled: normalized.enabled !== false,
    name,
    endpoint: readNonEmptyString(normalized.endpoint) ?? DEFAULT_ENDPOINT,
    workdir,
    pollIntervalSec: parsePollingIntervalSeconds(normalized.pollInterval, DEFAULT_POLL_INTERVAL_SEC, {
      fieldName: 'pollInterval',
      serverName: name,
      logger,
    }),
    pmPollIntervalSec: parsePollingIntervalSeconds(
      normalized.pmPollInterval,
      DEFAULT_PM_POLL_INTERVAL_SEC,
      {
        fieldName: 'pmPollInterval',
        serverName: name,
        logger,
      }
    ),
    sessionKey,
    agentId: readNonEmptyString(normalized.agentId) ?? derivedRoute.agentId ?? DEFAULT_AGENT_ID,
    replyChannel: readNonEmptyString(normalized.replyChannel) ?? derivedRoute.replyChannel,
    replyTo: readNonEmptyString(normalized.replyTo) ?? derivedRoute.replyTo,
    replyAccountId:
      readNonEmptyString(normalized.replyAccountId) ?? derivedRoute.replyAccountId,
    routeOverrides: createRouteOverrides(normalized),
    ...(sessionStorePath ? { sessionStorePath: expandHomeDir(sessionStorePath) } : {}),
  } as ResolvedEigenFluxServerConfig;
}

export function expandHomeDir(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function buildSkillUrl(endpoint: string): string {
  try {
    return new URL('skill.md', endpoint.endsWith('/') ? endpoint : `${endpoint}/`).toString();
  } catch {
    return `${endpoint.replace(/\/+$/u, '')}/skill.md`;
  }
}

export function resolveServerSkillPath(server: {
  endpoint: string;
  workdir: string;
}): string {
  const localSkillPath = path.join(server.workdir, 'skill.md');
  if (fs.existsSync(localSkillPath)) {
    return localSkillPath;
  }
  return buildSkillUrl(server.endpoint);
}

export function resolvePluginConfig(
  pluginConfig: unknown,
  globalConfig?: GlobalGatewayConfig,
  logger?: Logger
): ResolvedEigenFluxPluginConfig {
  const normalized = isRecord(pluginConfig) ? pluginConfig : {};
  const usedNames = new Set<string>();

  return {
    gatewayUrl: readNonEmptyString(normalized.gatewayUrl) ?? DEFAULT_GATEWAY_URL,
    gatewayToken:
      readNonEmptyString(normalized.gatewayToken) ??
      readNonEmptyString(globalConfig?.gateway?.auth?.token),
    openclawCliBin:
      readNonEmptyString(normalized.openclawCliBin) ?? DEFAULT_OPENCLAW_CLI_BIN,
    servers: normalizeServersInput(normalized).map((server, index) =>
      resolveServerConfig(server, index, usedNames, logger)
    ),
  };
}

const SERVER_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: {
      type: 'boolean',
      description: 'Enable or disable background polling for this server',
      default: true,
    },
    name: {
      type: 'string',
      description: 'Server name used for routing, workdir defaults, and diagnostics',
      default: DEFAULT_SERVER_NAME,
    },
    endpoint: {
      type: 'string',
      description: 'EigenFlux API base URL for this server',
      default: DEFAULT_ENDPOINT,
    },
    workdir: {
      type: 'string',
      description: 'Directory used to store server credentials and remembered session state',
    },
    pollInterval: {
      type: 'integer',
      minimum: MIN_POLL_INTERVAL_SEC,
      maximum: MAX_POLL_INTERVAL_SEC,
      description: 'Feed polling interval in seconds for this server',
      default: DEFAULT_POLL_INTERVAL_SEC,
    },
    pmPollInterval: {
      type: 'integer',
      minimum: MIN_POLL_INTERVAL_SEC,
      maximum: MAX_POLL_INTERVAL_SEC,
      description: 'Private message polling interval in seconds for this server',
      default: DEFAULT_PM_POLL_INTERVAL_SEC,
    },
    sessionKey: {
      type: 'string',
      description: 'Target session key used by runtime.subagent and heartbeat fallback',
      default: DEFAULT_SESSION_KEY,
    },
    agentId: {
      type: 'string',
      description: 'Agent id used by Gateway agent and CLI fallbacks',
      default: DEFAULT_AGENT_ID,
    },
    replyChannel: {
      type: 'string',
      description: 'Explicit reply channel used by Gateway agent and CLI fallbacks',
    },
    replyTo: {
      type: 'string',
      description: 'Explicit reply target used by Gateway agent and CLI fallbacks',
    },
    replyAccountId: {
      type: 'string',
      description: 'Optional reply account id for multi-account channel delivery',
    },
  },
} as const;

export const PLUGIN_CONFIG = {
  DEFAULT_SERVER_NAME,
  DEFAULT_ENDPOINT,
  DEFAULT_GATEWAY_URL,
  DEFAULT_SESSION_KEY,
  DEFAULT_AGENT_ID,
  DEFAULT_OPENCLAW_CLI_BIN,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_PM_POLL_INTERVAL_SEC,
  MIN_POLL_INTERVAL_SEC,
  MAX_POLL_INTERVAL_SEC,
  HOST_KIND,
  CREDENTIALS_FILE: 'credentials.json',
  PLUGIN_VERSION,
  USER_AGENT: buildUserAgent(),
} as const;

export function buildEigenFluxRequestHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': PLUGIN_CONFIG.USER_AGENT,
    'X-Plugin-Ver': PLUGIN_CONFIG.PLUGIN_VERSION,
    'X-Host-Kind': PLUGIN_CONFIG.HOST_KIND,
  };
}

export const PLUGIN_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
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
    servers: {
      type: 'array',
      description:
        'Server list. When empty or when no server named eigenflux is provided, the plugin prepends a default eigenflux server.',
      default: [],
      items: SERVER_CONFIG_SCHEMA,
    },
  },
} as const;
