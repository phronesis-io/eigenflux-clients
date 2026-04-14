import { Logger } from './logger';
import { normalizeReplyTarget } from './reply-target';
import { execEigenflux } from './cli-executor';

export const DELIVER_SESSION_KEY = 'openclaw_deliver_session';

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

/**
 * Reads the remembered delivery route for a server from the eigenflux CLI
 * config store (`openclaw_deliver_session` key). Returns undefined when the
 * key is unset or the CLI call fails.
 */
export async function readStoredNotificationRoute(
  eigenfluxBin: string | undefined,
  serverName: string | undefined,
  logger: Logger
): Promise<StoredNotificationRoute | undefined> {
  const bin = readNonEmptyString(eigenfluxBin);
  const server = readNonEmptyString(serverName);
  if (!bin || !server) {
    return undefined;
  }

  const result = await execEigenflux<unknown>(
    bin,
    ['config', 'get', '--key', DELIVER_SESSION_KEY, '--server', server, '--format', 'json'],
    { logger }
  );

  if (result.kind !== 'success' || result.data === undefined) {
    if (result.kind === 'error') {
      logger.debug(
        `readStoredNotificationRoute: eigenflux config get failed for server=${server}: ${result.error.message}`
      );
    }
    return undefined;
  }

  const parsed = result.data;
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
 * Persists the remembered delivery route for a server via the eigenflux CLI
 * config store (`openclaw_deliver_session` key).
 */
export async function writeStoredNotificationRoute(
  eigenfluxBin: string | undefined,
  serverName: string | undefined,
  route: Omit<StoredNotificationRoute, 'updatedAt'>,
  logger: Logger
): Promise<boolean> {
  const bin = readNonEmptyString(eigenfluxBin);
  const server = readNonEmptyString(serverName);
  if (!bin || !server) {
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

  const existing = await readStoredNotificationRoute(bin, server, logger);
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
  const value = JSON.stringify(payload);

  const result = await execEigenflux<string>(
    bin,
    [
      'config',
      'set',
      '--key',
      DELIVER_SESSION_KEY,
      '--value',
      value,
      '--server',
      server,
    ],
    { logger, parseJson: false }
  );

  if (result.kind !== 'success') {
    const detail = result.kind === 'error' ? result.error.message : result.kind;
    logger.warn(
      `Failed to persist remembered session route via eigenflux config set (server=${server}): ${detail}`
    );
    return false;
  }

  logger.info(
    `Remembered route saved: server=${server}, session_key=${payload.sessionKey}, agent_id=${payload.agentId}, channel=${payload.replyChannel ?? 'n/a'}, to=${payload.replyTo ?? 'n/a'}, account=${payload.replyAccountId ?? 'n/a'}`
  );
  return true;
}
