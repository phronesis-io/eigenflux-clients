import { Logger } from './logger';
import { normalizeReplyTarget } from './reply-target';

export const DELIVER_SESSION_KEY_PREFIX = 'deliver_session';

export type PluginRuntimeStore = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
};

export type StoredNotificationRoute = {
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
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

function storeKey(serverName: string): string {
  return `${DELIVER_SESSION_KEY_PREFIX}:${serverName}`;
}

/**
 * Reads the remembered delivery route for a server from the plugin runtime
 * store (`deliver_session:<serverName>` key). Returns undefined when the
 * key is unset or the store is unavailable.
 */
export async function readStoredNotificationRoute(
  store: PluginRuntimeStore | undefined,
  serverName: string | undefined,
  logger: Logger
): Promise<StoredNotificationRoute | undefined> {
  const server = readNonEmptyString(serverName);
  if (!store || !server) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = await store.get(storeKey(server));
  } catch (error) {
    logger.debug(
      `readStoredNotificationRoute: store.get failed for server=${server}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }

  if (parsed === undefined || parsed === null) {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const sessionKey = readNonEmptyString(record.sessionKey);
  const agentId = readNonEmptyString(record.agentId);
  if (!sessionKey || !agentId) {
    logger.warn(
      `Remembered route entry for server=${server} is incomplete (sessionKey/agentId missing)`
    );
    return undefined;
  }

  const route: StoredNotificationRoute = {
    sessionKey,
    agentId,
    replyChannel: normalizeChannel(record.replyChannel),
    replyTo: normalizeReplyTarget(readNonEmptyString(record.replyTo), {
      channel: normalizeChannel(record.replyChannel),
      sessionKey,
    }),
    replyAccountId: readNonEmptyString(record.replyAccountId),
    updatedAt:
      typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : 0,
  };
  logger.info(
    `Remembered route loaded: server=${server}, session_key=${route.sessionKey}, agent_id=${route.agentId}, channel=${route.replyChannel ?? 'n/a'}, to=${route.replyTo ?? 'n/a'}, account=${route.replyAccountId ?? 'n/a'}`
  );
  return route;
}

/**
 * Persists the remembered delivery route for a server via the plugin runtime
 * store (`deliver_session:<serverName>` key).
 */
export async function writeStoredNotificationRoute(
  store: PluginRuntimeStore | undefined,
  serverName: string | undefined,
  route: Omit<StoredNotificationRoute, 'updatedAt'>,
  logger: Logger
): Promise<boolean> {
  const server = readNonEmptyString(serverName);
  if (!store || !server) {
    return false;
  }

  const normalized = {
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    replyChannel: normalizeChannel(route.replyChannel),
    replyTo: normalizeReplyTarget(readNonEmptyString(route.replyTo), {
      channel: normalizeChannel(route.replyChannel),
      sessionKey: route.sessionKey,
    }),
    replyAccountId: readNonEmptyString(route.replyAccountId),
  };

  const existing = await readStoredNotificationRoute(store, server, logger);
  if (
    existing &&
    existing.sessionKey === normalized.sessionKey &&
    existing.agentId === normalized.agentId &&
    existing.replyChannel === normalized.replyChannel &&
    existing.replyTo === normalized.replyTo &&
    existing.replyAccountId === normalized.replyAccountId
  ) {
    logger.debug(
      `Remembered route unchanged for server=${server} (session_key=${normalized.sessionKey}); skipping write`
    );
    return true;
  }

  const payload: StoredNotificationRoute = {
    ...normalized,
    updatedAt: Date.now(),
  };

  try {
    await store.set(storeKey(server), payload);
  } catch (error) {
    logger.warn(
      `Failed to persist remembered session route via store.set (server=${server}): ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }

  logger.info(
    `Remembered route saved: server=${server}, session_key=${payload.sessionKey}, agent_id=${payload.agentId}, channel=${payload.replyChannel ?? 'n/a'}, to=${payload.replyTo ?? 'n/a'}, account=${payload.replyAccountId ?? 'n/a'}`
  );
  return true;
}
