import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { normalizeReplyTarget } from './reply-target';

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

export function resolveSessionRouteMemoryPath(workdir: string): string {
  return path.join(workdir, 'session.json');
}

export function readStoredNotificationRoute(
  workdir: string | undefined,
  logger: Logger
): StoredNotificationRoute | undefined {
  const trimmedWorkdir = readNonEmptyString(workdir);
  if (!trimmedWorkdir) {
    return undefined;
  }

  const filePath = resolveSessionRouteMemoryPath(trimmedWorkdir);
  try {
    if (!fs.existsSync(filePath)) {
      logger.info(`Remembered route file missing: path=${filePath}`);
      return undefined;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    const sessionKey = readNonEmptyString(record.sessionKey);
    const agentId = readNonEmptyString(record.agentId);
    if (!sessionKey || !agentId) {
      logger.warn(`Remembered route file is incomplete: path=${filePath}`);
      return undefined;
    }

    const route = {
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
      `Remembered route loaded: path=${filePath}, session_key=${route.sessionKey}, agent_id=${route.agentId}, channel=${route.replyChannel ?? 'n/a'}, to=${route.replyTo ?? 'n/a'}, account=${route.replyAccountId ?? 'n/a'}`
    );
    return route;
  } catch (error) {
    logger.debug(
      `Failed to read remembered session route ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

export function writeStoredNotificationRoute(
  workdir: string | undefined,
  route: Omit<StoredNotificationRoute, 'updatedAt'>,
  logger: Logger
): boolean {
  const trimmedWorkdir = readNonEmptyString(workdir);
  if (!trimmedWorkdir) {
    return false;
  }

  const filePath = resolveSessionRouteMemoryPath(trimmedWorkdir);
  const payload: StoredNotificationRoute = {
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    replyChannel: normalizeChannel(route.replyChannel),
    replyTo: normalizeReplyTarget(readNonEmptyString(route.replyTo), {
      channel: normalizeChannel(route.replyChannel),
      sessionKey: route.sessionKey,
    }),
    replyAccountId: readNonEmptyString(route.replyAccountId),
    updatedAt: Date.now(),
  };

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    logger.info(
      `Remembered route saved: path=${filePath}, session_key=${payload.sessionKey}, agent_id=${payload.agentId}, channel=${payload.replyChannel ?? 'n/a'}, to=${payload.replyTo ?? 'n/a'}, account=${payload.replyAccountId ?? 'n/a'}`
    );
    return true;
  } catch (error) {
    logger.warn(
      `Failed to write remembered session route ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
