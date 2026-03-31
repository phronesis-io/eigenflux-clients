import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type NotificationRouteOverrides } from './config';
import { Logger } from './logger';
import { readStoredNotificationRoute } from './session-route-memory';

const INTERNAL_CHANNELS = new Set(['webchat']);

function getDefaultOpenClawStateDir(): string {
  return path.join(os.homedir(), '.openclaw');
}

type DeliveryContextLike = {
  channel?: unknown;
  to?: unknown;
  accountId?: unknown;
};

type SessionOriginLike = {
  provider?: unknown;
  to?: unknown;
  accountId?: unknown;
};

type SessionStoreEntry = {
  updatedAt?: unknown;
  deliveryContext?: DeliveryContextLike;
  lastTo?: unknown;
  lastAccountId?: unknown;
  origin?: SessionOriginLike;
};

type SessionStoreSnapshot = {
  path: string;
  store: Record<string, SessionStoreEntry>;
};

export type NotificationRouteConfig = {
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  sessionStorePath?: string;
  workdir?: string;
  routeOverrides?: NotificationRouteOverrides;
};

export type ResolvedNotificationRoute = {
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
};

type PreferredRoute = {
  channel?: string;
  to?: string;
  accountId?: string;
};

type RouteSelection = {
  route: ResolvedNotificationRoute;
  updatedAt: number;
};

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeChannel(value: unknown): string | undefined {
  return readNonEmptyString(value)?.toLowerCase();
}

function normalizeUpdatedAt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

function createRouteOverrides(
  overrides: NotificationRouteConfig['routeOverrides']
): NotificationRouteOverrides {
  return {
    sessionKey: overrides?.sessionKey === true,
    agentId: overrides?.agentId === true,
    replyChannel: overrides?.replyChannel === true,
    replyTo: overrides?.replyTo === true,
    replyAccountId: overrides?.replyAccountId === true,
  };
}

function isAnyRouteOverrideEnabled(overrides: NotificationRouteOverrides): boolean {
  return Object.values(overrides).some(Boolean);
}

function isInternalSessionKey(sessionKey: string): boolean {
  const trimmed = readNonEmptyString(sessionKey);
  if (!trimmed) {
    return true;
  }
  if (trimmed === 'main') {
    return true;
  }

  const parts = trimmed.split(':').filter((part) => part.length > 0);
  return parts[0]?.toLowerCase() === 'agent' && parts[2]?.toLowerCase() === 'main';
}

function isExternalChannel(channel: string | undefined): boolean {
  return Boolean(channel && !INTERNAL_CHANNELS.has(channel));
}

function routeTargetMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (!expected) {
    return true;
  }
  if (!actual) {
    return false;
  }
  return actual === expected || actual.endsWith(`:${expected}`) || expected.endsWith(`:${actual}`);
}

function routeMatchesPreferred(
  route: ResolvedNotificationRoute,
  preferred: PreferredRoute | undefined
): boolean {
  if (!preferred) {
    return true;
  }
  if (preferred.channel && route.replyChannel !== preferred.channel) {
    return false;
  }
  if (!routeTargetMatches(route.replyTo, preferred.to)) {
    return false;
  }
  if (preferred.accountId && route.replyAccountId !== preferred.accountId) {
    return false;
  }
  return true;
}

function deriveAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const trimmed = readNonEmptyString(sessionKey);
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(':').filter((part) => part.length > 0);
  if (parts[0]?.toLowerCase() !== 'agent') {
    return undefined;
  }
  return readNonEmptyString(parts[1]);
}

function extractExternalRoute(
  sessionKey: string,
  entry: SessionStoreEntry | undefined
): ResolvedNotificationRoute | undefined {
  if (!entry) {
    return undefined;
  }

  const replyChannel =
    normalizeChannel(entry.deliveryContext?.channel) ?? normalizeChannel(entry.origin?.provider);
  const replyTo =
    readNonEmptyString(entry.deliveryContext?.to) ??
    readNonEmptyString(entry.lastTo) ??
    readNonEmptyString(entry.origin?.to);
  const replyAccountId =
    readNonEmptyString(entry.deliveryContext?.accountId) ??
    readNonEmptyString(entry.lastAccountId) ??
    readNonEmptyString(entry.origin?.accountId);

  if (!isExternalChannel(replyChannel) || !replyTo) {
    return undefined;
  }

  return {
    sessionKey,
    agentId: deriveAgentIdFromSessionKey(sessionKey) ?? 'main',
    replyChannel,
    replyTo,
    replyAccountId,
  };
}

function tryDeriveAgentIdFromStorePath(sessionStorePath: string): string | undefined {
  const normalized = path.normalize(sessionStorePath);
  const parts = normalized.split(path.sep).filter(Boolean);
  const agentsIndex = parts.lastIndexOf('agents');
  if (agentsIndex === -1) {
    return undefined;
  }
  return readNonEmptyString(parts[agentsIndex + 1]);
}

function listSessionStorePaths(explicitPath: string | undefined, baseAgentId: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addPath = (candidate: string | undefined) => {
    const trimmed = readNonEmptyString(candidate);
    if (!trimmed) {
      return;
    }
    const normalized = path.normalize(trimmed);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  addPath(explicitPath);
  if (candidates.length > 0) {
    return candidates;
  }

  const defaultOpenClawStateDir = getDefaultOpenClawStateDir();
  addPath(path.join(defaultOpenClawStateDir, 'agents', baseAgentId, 'sessions', 'sessions.json'));

  const agentsRoot = path.join(defaultOpenClawStateDir, 'agents');
  try {
    if (fs.existsSync(agentsRoot)) {
      for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        addPath(path.join(agentsRoot, entry.name, 'sessions', 'sessions.json'));
      }
    }
  } catch {
    // Ignore directory scan failures; we will still try explicit/default paths.
  }

  return candidates;
}

function readSessionStore(
  sessionStorePath: string,
  logger: Logger
): Record<string, SessionStoreEntry> | undefined {
  try {
    if (!fs.existsSync(sessionStorePath)) {
      return undefined;
    }
    const raw = fs.readFileSync(sessionStorePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, SessionStoreEntry>;
  } catch (error) {
    logger.debug(
      `Failed to read session store ${sessionStorePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

function readSessionStores(
  sessionStorePath: string | undefined,
  baseAgentId: string,
  logger: Logger
): SessionStoreSnapshot[] {
  const snapshots: SessionStoreSnapshot[] = [];
  for (const candidate of listSessionStorePaths(sessionStorePath, baseAgentId)) {
    const store = readSessionStore(candidate, logger);
    if (store) {
      snapshots.push({ path: candidate, store });
    }
  }
  return snapshots;
}

function buildPreferredRoute(route: ResolvedNotificationRoute): PreferredRoute | undefined {
  if (!route.replyChannel && !route.replyTo && !route.replyAccountId) {
    return undefined;
  }
  return {
    channel: route.replyChannel,
    to: route.replyTo,
    accountId: route.replyAccountId,
  };
}

function mergeRoute(
  base: ResolvedNotificationRoute,
  resolved: ResolvedNotificationRoute,
  overrides: NotificationRouteOverrides,
  allowSessionOverride: boolean
): ResolvedNotificationRoute {
  const nextSessionKey =
    allowSessionOverride && !overrides.sessionKey ? resolved.sessionKey : base.sessionKey;

  return {
    sessionKey: nextSessionKey,
    agentId:
      overrides.agentId === true
        ? base.agentId
        : resolved.agentId ?? deriveAgentIdFromSessionKey(nextSessionKey) ?? base.agentId,
    replyChannel:
      overrides.replyChannel === true ? base.replyChannel : resolved.replyChannel ?? base.replyChannel,
    replyTo: overrides.replyTo === true ? base.replyTo : resolved.replyTo ?? base.replyTo,
    replyAccountId:
      overrides.replyAccountId === true
        ? base.replyAccountId
        : resolved.replyAccountId ?? base.replyAccountId,
  };
}

function selectExactRoute(
  snapshots: SessionStoreSnapshot[],
  sessionKey: string
): RouteSelection | undefined {
  let best: RouteSelection | undefined;

  for (const snapshot of snapshots) {
    const entry = snapshot.store[sessionKey];
    const route = extractExternalRoute(sessionKey, entry);
    if (!route) {
      continue;
    }
    const updatedAt = normalizeUpdatedAt(entry?.updatedAt);
    if (!best || updatedAt > best.updatedAt) {
      best = { route, updatedAt };
    }
  }

  return best;
}

function selectLatestExternalRoute(
  snapshots: SessionStoreSnapshot[],
  preferred: PreferredRoute | undefined,
  preferredAgentId?: string
): RouteSelection | undefined {
  let best: RouteSelection | undefined;

  for (const snapshot of snapshots) {
    const pathAgentId = tryDeriveAgentIdFromStorePath(snapshot.path);
    for (const [sessionKey, entry] of Object.entries(snapshot.store)) {
      if (sessionKey.includes(':subagent:')) {
        continue;
      }

      const route = extractExternalRoute(sessionKey, entry);
      if (!route || !routeMatchesPreferred(route, preferred)) {
        continue;
      }

      if (preferredAgentId && route.agentId !== preferredAgentId && pathAgentId !== preferredAgentId) {
        continue;
      }

      const updatedAt = normalizeUpdatedAt(entry.updatedAt);
      if (!best || updatedAt > best.updatedAt) {
        best = { route, updatedAt };
      }
    }
  }

  return best;
}

export function resolveNotificationRoute(
  config: NotificationRouteConfig,
  logger: Logger
): ResolvedNotificationRoute {
  const overrides = createRouteOverrides(config.routeOverrides);

  let resolved: ResolvedNotificationRoute = {
    sessionKey: readNonEmptyString(config.sessionKey) ?? 'main',
    agentId:
      readNonEmptyString(config.agentId) ??
      deriveAgentIdFromSessionKey(config.sessionKey) ??
      'main',
    replyChannel: normalizeChannel(config.replyChannel),
    replyTo: readNonEmptyString(config.replyTo),
    replyAccountId: readNonEmptyString(config.replyAccountId),
  };

  const snapshots = readSessionStores(config.sessionStorePath, resolved.agentId, logger);

  const exactRoute = selectExactRoute(snapshots, resolved.sessionKey);
  if (exactRoute) {
    resolved = mergeRoute(resolved, exactRoute.route, overrides, false);
  }

  if (!isAnyRouteOverrideEnabled(overrides)) {
    const rememberedRoute = readStoredNotificationRoute(config.workdir, logger);
    if (rememberedRoute) {
      resolved = mergeRoute(resolved, rememberedRoute, overrides, true);
      const rememberedExact = selectExactRoute(snapshots, resolved.sessionKey);
      if (rememberedExact) {
        resolved = mergeRoute(resolved, rememberedExact.route, overrides, false);
      }
      logger.debug(
        `Resolved notification route via remembered session: session_key=${resolved.sessionKey}, channel=${resolved.replyChannel ?? 'unknown'}, to=${resolved.replyTo ?? 'unknown'}`
      );
    }
  }

  if (!isInternalSessionKey(resolved.sessionKey)) {
    return resolved;
  }

  const preferred = buildPreferredRoute(resolved);
  const latestRoute = selectLatestExternalRoute(
    snapshots,
    preferred,
    overrides.agentId || overrides.sessionKey ? resolved.agentId : undefined
  );
  if (!latestRoute) {
    return resolved;
  }

  resolved = mergeRoute(resolved, latestRoute.route, overrides, true);
  logger.debug(
    `Resolved notification route via session store: session_key=${resolved.sessionKey}, channel=${resolved.replyChannel ?? 'unknown'}, to=${resolved.replyTo ?? 'unknown'}`
  );
  return resolved;
}
