import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Logger } from './logger';

const GATEWAY_PROTOCOL_VERSION = 3;
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_SESSION_KEY = 'main';
const DEFAULT_AGENT_ID = 'main';

type GatewayRequest = {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
};

type GatewayResponse = {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: any;
  error?: {
    code?: string;
    message?: string;
  };
};

type GatewayEvent = {
  type: 'event';
  event: string;
  payload?: any;
};

type PendingRequest = {
  timer: NodeJS.Timeout;
  resolve: (payload: any) => void;
  reject: (error: Error) => void;
};

export type OpenClawGatewayRpcClientOptions = {
  gatewayUrl: string;
  gatewayToken?: string;
  sessionKey?: string;
  agentId?: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  logger: Logger;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export class OpenClawGatewayRpcClient {
  private readonly options: OpenClawGatewayRpcClientOptions;

  constructor(options: OpenClawGatewayRpcClientOptions) {
    this.options = options;
  }

  async sendAgentMessage(message: string): Promise<{ sessionKey: string; runId: string }> {
    return this.withConnection(async (conn) => {
      const sessionKey = this.options.sessionKey || (await this.resolveSessionKey(conn));
      const agentId = this.options.agentId?.trim() || this.resolveAgentIdFromSessionKey(sessionKey);
      const idempotencyKey = randomUUID();
      this.options.logger.info(
        `Gateway agent request: session_key=${sessionKey}, agent_id=${agentId}, channel=${this.options.replyChannel ?? 'n/a'}, to=${this.options.replyTo ?? 'n/a'}, account=${this.options.replyAccountId ?? 'n/a'}, message_preview=${previewMessage(message)}`
      );

      const response = await conn.request('agent', {
        sessionKey,
        agentId,
        message,
        deliver: true,
        ...(this.options.replyChannel ? { replyChannel: this.options.replyChannel } : {}),
        ...(this.options.replyTo ? { replyTo: this.options.replyTo } : {}),
        ...(this.options.replyAccountId
          ? { replyAccountId: this.options.replyAccountId }
          : {}),
        idempotencyKey,
      });

      const runId = String(response?.runId || idempotencyKey);
      this.options.logger.info(
        `Gateway agent response: session_key=${sessionKey}, run_id=${runId}, status=${String(response?.status || 'unknown')}`
      );
      return { sessionKey, runId };
    });
  }

  private resolveAgentIdFromSessionKey(sessionKey: string | undefined): string {
    const trimmed = sessionKey?.trim() || '';
    const parts = trimmed.split(':').filter((part) => part.length > 0);
    if (parts[0]?.toLowerCase() === 'agent' && typeof parts[1] === 'string' && parts[1].trim()) {
      return parts[1].trim().toLowerCase();
    }
    return DEFAULT_AGENT_ID;
  }

  private async resolveSessionKey(conn: GatewayConnection): Promise<string> {
    try {
      const response = await conn.request('sessions.list', {
        limit: 20,
        includeGlobal: true,
        includeUnknown: true,
        includeLastMessage: false,
      });
      const sessions = Array.isArray(response?.sessions)
        ? (response.sessions as Array<{ key?: unknown; active?: unknown; kind?: unknown }>)
        : [];
      this.options.logger.info(
        `Gateway sessions.list returned ${sessions.length} session(s); resolving fallback session key`
      );
      const byMainKey = sessions.find((entry) => entry && entry.key === DEFAULT_SESSION_KEY);
      if (byMainKey && typeof byMainKey.key === 'string') {
        this.options.logger.info(`Gateway session fallback selected explicit main key`);
        return DEFAULT_SESSION_KEY;
      }

      const byMainKind = sessions.find(
        (entry) => entry && typeof entry.key === 'string' && String(entry.kind || '').toLowerCase() === 'main'
      );
      if (byMainKind && typeof byMainKind.key === 'string') {
        this.options.logger.info(`Gateway session fallback selected kind=main key: ${byMainKind.key}`);
        return byMainKind.key;
      }

      const byActive = sessions.find(
        (entry) => entry && typeof entry.key === 'string' && entry.active === true
      );
      if (byActive && typeof byActive.key === 'string') {
        this.options.logger.info(`Gateway session fallback selected active key: ${byActive.key}`);
        return byActive.key;
      }

      const first = sessions.find((entry) => entry && typeof entry.key === 'string');
      if (first && typeof first.key === 'string') {
        this.options.logger.info(`Gateway session fallback selected first key: ${first.key}`);
        return first.key;
      }
    } catch (error) {
      this.options.logger.warn(
        `sessions.list failed, fallback to "${DEFAULT_SESSION_KEY}": ${this.formatError(error)}`
      );
    }
    return DEFAULT_SESSION_KEY;
  }

  private async withConnection<T>(fn: (conn: GatewayConnection) => Promise<T>): Promise<T> {
    const conn = new GatewayConnection({
      gatewayUrl: this.options.gatewayUrl,
      gatewayToken: this.options.gatewayToken,
      logger: this.options.logger,
      connectTimeoutMs: this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });

    try {
      await conn.connect();
      return await fn(conn);
    } finally {
      await conn.close();
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    return String(error);
  }
}

type GatewayConnectionOptions = {
  gatewayUrl: string;
  gatewayToken?: string;
  logger: Logger;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
};

class GatewayConnection {
  private readonly options: GatewayConnectionOptions;
  private ws: WebSocket | null = null;
  private connectNonce: string | null = null;
  private connected = false;
  private pending = new Map<string, PendingRequest>();

  constructor(options: GatewayConnectionOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.options.logger.info(`Connecting to gateway: url=${this.options.gatewayUrl}`);
    this.ws = new WebSocket(this.options.gatewayUrl, {
      maxPayload: 25 * 1024 * 1024,
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let connectRequested = false;
      const connectTimer = setTimeout(() => {
        onConnectError(new Error(`Gateway connect timeout after ${this.options.connectTimeoutMs}ms`));
      }, this.options.connectTimeoutMs);

      const cleanup = () => {
        clearTimeout(connectTimer);
      };

      const settle = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        fn();
      };

      const onConnectError = (error: unknown) => {
        settle(() => {
          reject(error instanceof Error ? error : new Error(String(error)));
          void this.close();
        });
      };

      this.ws?.on('error', onConnectError);
      this.ws?.on('close', () => {
        if (!this.connected) {
          onConnectError(new Error('Gateway closed before connect'));
          return;
        }
        this.rejectAllPending(new Error('Gateway connection closed'));
      });

      this.ws?.on('message', (data) => {
        const raw = data.toString();
        let frame: GatewayEvent | GatewayResponse | null = null;
        try {
          frame = JSON.parse(raw);
        } catch {
          return;
        }
        if (!frame || typeof frame !== 'object') {
          return;
        }
        if (frame.type === 'event') {
          try {
            this.handleEventFrame(frame);
          } catch (error) {
            onConnectError(error);
            return;
          }
          if (frame.event === 'connect.challenge' && !connectRequested) {
            connectRequested = true;
            void this.request('connect', this.buildConnectParams())
              .then(() => {
                this.connected = true;
                this.options.logger.info(`Gateway connect handshake completed`);
                settle(() => resolve());
              })
              .catch(onConnectError);
          }
          return;
        }
        if (frame.type === 'res') {
          try {
            this.handleResponseFrame(frame);
          } catch (error) {
            onConnectError(error);
          }
        }
      });
    });
  }

  async close(): Promise<void> {
    this.rejectAllPending(new Error('Gateway request cancelled: connection closed'));
    if (!this.ws) {
      return;
    }
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close(1000);
      setTimeout(() => resolve(), 1000);
    });
  }

  async request(method: string, params?: unknown): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Gateway request failed (${method}): websocket is not open`);
    }

    const id = randomUUID();
    const frame: GatewayRequest = {
      type: 'req',
      id,
      method,
      params,
    };
    this.options.logger.info(
      `Gateway request queued: method=${method}, request_id=${id}, params=${formatGatewayParamsForLog(params)}`
    );

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timeout (${method}) after ${this.options.requestTimeoutMs}ms`));
      }, this.options.requestTimeoutMs);

      this.pending.set(id, { timer, resolve, reject });
      this.ws?.send(JSON.stringify(frame), (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private handleEventFrame(frame: GatewayEvent): void {
    if (frame.event !== 'connect.challenge') {
      return;
    }
    const nonce = frame.payload?.nonce;
    if (typeof nonce !== 'string' || nonce.trim().length === 0) {
      throw new Error('Gateway connect.challenge missing nonce');
    }
    this.connectNonce = nonce.trim();
  }

  private handleResponseFrame(frame: GatewayResponse): void {
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.ok) {
      this.options.logger.info(
        `Gateway response ok: request_id=${frame.id}, payload=${formatGatewayParamsForLog(frame.payload)}`
      );
      pending.resolve(frame.payload);
      return;
    }
    const message = frame.error?.message || 'unknown gateway error';
    this.options.logger.warn(
      `Gateway response error: request_id=${frame.id}, message=${message}, code=${frame.error?.code ?? 'n/a'}`
    );
    pending.reject(new Error(message));
  }

  private buildConnectParams(): Record<string, unknown> {
    if (!this.connectNonce) {
      throw new Error('Gateway connect failed: missing challenge nonce');
    }

    const authToken =
      typeof this.options.gatewayToken === 'string' ? this.options.gatewayToken.trim() : '';

    const params: Record<string, unknown> = {
      minProtocol: GATEWAY_PROTOCOL_VERSION,
      maxProtocol: GATEWAY_PROTOCOL_VERSION,
      client: {
        id: 'eigenflux-gateway-client',
        displayName: 'eigenflux',
        version: '1.0.0',
        platform: process.platform,
        mode: 'backend',
      },
      role: 'operator',
      scopes: ['operator.admin'],
    };

    if (authToken) {
      params.auth = { token: authToken };
    }

    return params;
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

function previewMessage(message: string, maxLength = 120): string {
  const singleLine = message.replace(/\s+/gu, ' ').trim();
  if (singleLine.length <= maxLength) {
    return JSON.stringify(singleLine);
  }
  return JSON.stringify(`${singleLine.slice(0, maxLength - 3)}...`);
}

function formatGatewayParamsForLog(value: unknown): string {
  try {
    return JSON.stringify(
      sanitizeGatewayValue(value),
      (_key, item) => (typeof item === 'bigint' ? item.toString() : item)
    );
  } catch {
    return '[unserializable]';
  }
}

function sanitizeGatewayValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > 160) {
      return `<string:${value.length}>`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeGatewayValue(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'message' && typeof item === 'string') {
      result[key] = previewMessage(item);
      continue;
    }
    result[key] = sanitizeGatewayValue(item);
  }
  return result;
}
