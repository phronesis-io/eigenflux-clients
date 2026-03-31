/**
 * Internal configuration for the EigenFlux plugin.
 */

import * as os from 'os';
import * as path from 'path';

const PLUGIN_VERSION = '0.0.1-alpha.0';
const DEFAULT_ENDPOINT = 'https://www.eigenflux.ai';
const DEFAULT_WORKDIR = '~/.openclaw/eigenflux';
const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:18789';
const DEFAULT_SESSION_KEY = 'main';
const DEFAULT_AGENT_ID = 'main';
const DEFAULT_OPENCLAW_CLI_BIN = 'openclaw';
const DEFAULT_POLL_INTERVAL_SEC = 300;
const DEFAULT_PM_POLL_INTERVAL_SEC = 60;

export type EigenFluxPluginConfig = {
  enabled?: boolean;
  endpoint?: string;
  workdir?: string;
  pollInterval?: number;
  pmPollInterval?: number;
  gatewayUrl?: string;
  sessionKey?: string;
  gatewayToken?: string;
  agentId?: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  openclawCliBin?: string;
  sessionStorePath?: string;
};

export type NotificationRouteOverrides = {
  sessionKey: boolean;
  agentId: boolean;
  replyChannel: boolean;
  replyTo: boolean;
  replyAccountId: boolean;
};

export type ResolvedEigenFluxPluginConfig = {
  enabled: boolean;
  endpoint: string;
  workdir: string;
  pollIntervalSec: number;
  pmPollIntervalSec: number;
  gatewayUrl: string;
  sessionKey: string;
  gatewayToken?: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  openclawCliBin: string;
  sessionStorePath?: string;
  routeOverrides: NotificationRouteOverrides;
};

type GlobalGatewayConfig = {
  gateway?: {
    auth?: {
      token?: string;
    };
  };
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

  parts.push(`eigenflux-plugin/${PLUGIN_VERSION}`);

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

type DerivedNotificationRoute = {
  agentId?: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
};

function isSessionPeerShape(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'direct' || normalized === 'dm' || normalized === 'group' || normalized === 'channel';
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

export function expandHomeDir(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function resolvePluginConfig(
  pluginConfig: unknown,
  globalConfig?: GlobalGatewayConfig
): ResolvedEigenFluxPluginConfig {
  const normalized = isRecord(pluginConfig) ? pluginConfig : {};
  const sessionKey = readNonEmptyString(normalized.sessionKey) ?? DEFAULT_SESSION_KEY;
  const derivedRoute = deriveNotificationRoute(sessionKey);

  const workdir = expandHomeDir(
    readNonEmptyString(normalized.workdir) ?? DEFAULT_WORKDIR
  );

  return {
    enabled: normalized.enabled !== false,
    endpoint: readNonEmptyString(normalized.endpoint) ?? DEFAULT_ENDPOINT,
    workdir,
    pollIntervalSec: parsePositiveInteger(
      normalized.pollInterval,
      DEFAULT_POLL_INTERVAL_SEC
    ),
    pmPollIntervalSec: parsePositiveInteger(
      normalized.pmPollInterval,
      DEFAULT_PM_POLL_INTERVAL_SEC
    ),
    gatewayUrl: readNonEmptyString(normalized.gatewayUrl) ?? DEFAULT_GATEWAY_URL,
    sessionKey,
    gatewayToken:
      readNonEmptyString(normalized.gatewayToken) ??
      readNonEmptyString(globalConfig?.gateway?.auth?.token),
    agentId: readNonEmptyString(normalized.agentId) ?? derivedRoute.agentId ?? DEFAULT_AGENT_ID,
    replyChannel:
      readNonEmptyString(normalized.replyChannel) ?? derivedRoute.replyChannel,
    replyTo: readNonEmptyString(normalized.replyTo) ?? derivedRoute.replyTo,
    replyAccountId:
      readNonEmptyString(normalized.replyAccountId) ?? derivedRoute.replyAccountId,
    openclawCliBin:
      readNonEmptyString(normalized.openclawCliBin) ?? DEFAULT_OPENCLAW_CLI_BIN,
    sessionStorePath: readNonEmptyString(normalized.sessionStorePath),
    routeOverrides: {
      sessionKey: readNonEmptyString(normalized.sessionKey) !== undefined,
      agentId: readNonEmptyString(normalized.agentId) !== undefined,
      replyChannel: readNonEmptyString(normalized.replyChannel) !== undefined,
      replyTo: readNonEmptyString(normalized.replyTo) !== undefined,
      replyAccountId: readNonEmptyString(normalized.replyAccountId) !== undefined,
    },
  };
}

export const PLUGIN_CONFIG = {
  DEFAULT_ENDPOINT,
  DEFAULT_WORKDIR,
  DEFAULT_GATEWAY_URL,
  DEFAULT_SESSION_KEY,
  DEFAULT_AGENT_ID,
  DEFAULT_OPENCLAW_CLI_BIN,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_PM_POLL_INTERVAL_SEC,
  CREDENTIALS_FILE: 'credentials.json',
  PLUGIN_VERSION,
  USER_AGENT: buildUserAgent(),
} as const;

export const PLUGIN_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: {
      type: 'boolean',
      description: 'Enable or disable the plugin',
      default: true,
    },
    endpoint: {
      type: 'string',
      description: 'EigenFlux API base URL',
      default: DEFAULT_ENDPOINT,
    },
    workdir: {
      type: 'string',
      description: 'Directory used to store EigenFlux credentials',
      default: DEFAULT_WORKDIR,
    },
    pollInterval: {
      type: 'integer',
      minimum: 1,
      description: 'Feed polling interval in seconds',
      default: DEFAULT_POLL_INTERVAL_SEC,
    },
    pmPollInterval: {
      type: 'integer',
      minimum: 1,
      description: 'Private message polling interval in seconds',
      default: DEFAULT_PM_POLL_INTERVAL_SEC,
    },
    gatewayUrl: {
      type: 'string',
      description: 'OpenClaw Gateway WebSocket URL used for Gateway RPC fallback',
      default: DEFAULT_GATEWAY_URL,
    },
    sessionKey: {
      type: 'string',
      description: 'Target session key used by runtime.subagent and heartbeat fallback',
      default: DEFAULT_SESSION_KEY,
    },
    gatewayToken: {
      type: 'string',
      description: 'Optional gateway token override used for Gateway RPC fallback',
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
    openclawCliBin: {
      type: 'string',
      description: 'OpenClaw CLI binary used by runtime command and spawn fallbacks',
      default: DEFAULT_OPENCLAW_CLI_BIN,
    },
  },
} as const;
