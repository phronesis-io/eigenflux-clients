/**
 * Polling client for EigenFlux feed updates
 */

import { AuthState } from './credentials-loader';
import { PLUGIN_CONFIG } from './config';
import { Logger } from './logger';

export interface FeedItem {
  item_id: string;
  summary?: string;
  broadcast_type: string;
  domains?: string[];
  keywords?: string[];
  group_id?: string;
  source_type?: string;
  url?: string;
  updated_at: number;
}

export interface FeedNotification {
  notification_id: string;
  type: string;
  content: string;
  created_at: number;
}

export interface FeedResponse {
  code: number;
  msg: string;
  data: {
    items: FeedItem[];
    has_more: boolean;
    notifications: FeedNotification[];
  };
}

export interface PollingClientConfig {
  apiUrl: string;
  getAuthState: () => AuthState;
  pollIntervalSec: number;
  logger: Logger;
  onFeedPolled: (payload: FeedResponse) => Promise<void>;
  onAuthRequired: (event: AuthRequiredEvent) => Promise<void>;
}

export interface AuthRequiredEvent {
  reason: 'missing_token' | 'expired_token' | 'unauthorized';
  credentialsPath: string;
  source?: 'file';
  expiresAt?: number;
  statusCode?: number;
}

export type PollResult =
  | {
      kind: 'success';
      payload: FeedResponse;
    }
  | {
      kind: 'auth_required';
      authEvent: AuthRequiredEvent;
    }
  | {
      kind: 'error';
      error: Error;
    };

export interface PollOnceOptions {
  notifyFeed?: boolean;
  notifyAuthRequired?: boolean;
}

export class EigenFluxPollingClient {
  private config: PollingClientConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(config: PollingClientConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.config.logger.warn('Polling client already running');
      return;
    }

    this.isRunning = true;
    this.config.logger.info(
      `Starting polling client (interval: ${this.config.pollIntervalSec}s)`
    );

    // Initial fetch
    await this.pollOnce();

    // Schedule periodic polling
    this.intervalId = setInterval(() => {
      this.pollOnce().catch((err) => {
        this.config.logger.error(`Polling error: ${this.formatError(err)}`);
      });
    }, this.config.pollIntervalSec * 1000);
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.config.logger.info('Stopping polling client');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async pollOnce(options: PollOnceOptions = {}): Promise<PollResult> {
    const notifyFeed = options.notifyFeed ?? true;
    const notifyAuthRequired = options.notifyAuthRequired ?? true;
    const authState = this.config.getAuthState();
    if (authState.status !== 'available') {
      this.config.logger.warn(
        `No usable access token available (status=${authState.status}), skipping poll`
      );
      const authEvent: AuthRequiredEvent = {
        reason: authState.status === 'expired' ? 'expired_token' : 'missing_token',
        credentialsPath: authState.credentialsPath,
        source: authState.source,
        expiresAt: authState.expiresAt,
      };
      if (notifyAuthRequired) {
        await this.config.onAuthRequired(authEvent);
      }
      return {
        kind: 'auth_required',
        authEvent,
      };
    }

    const url = `${this.config.apiUrl}/api/v1/items/feed?action=refresh&limit=20`;

    try {
      this.config.logger.info(`Polling feed request: ${url}`);
      this.config.logger.debug(`Polling: ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${authState.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': PLUGIN_CONFIG.USER_AGENT,
        },
      });

      if (response.status === 401) {
        const authEvent: AuthRequiredEvent = {
          reason: 'unauthorized',
          credentialsPath: authState.credentialsPath,
          source: authState.source,
          expiresAt: authState.expiresAt,
          statusCode: 401,
        };
        if (notifyAuthRequired) {
          await this.config.onAuthRequired(authEvent);
        }
        return {
          kind: 'auth_required',
          authEvent,
        };
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as FeedResponse;

      if (data.code !== 0) {
        throw new Error(`API error: ${data.msg}`);
      }

      const items = data.data.items ?? [];
      const notifications = data.data.notifications ?? [];
      this.config.logger.info(
        `Polled feed: ${items.length} items, notifications=${notifications.length}, has_more=${data.data.has_more}`
      );

      if (notifyFeed && (items.length > 0 || notifications.length > 0)) {
        await this.config.onFeedPolled(data);
      }
      return {
        kind: 'success',
        payload: data,
      };
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.config.logger.error(
        `Failed to poll feed (url=${url}): ${this.formatError(normalized)}`
      );
      return {
        kind: 'error',
        error: normalized,
      };
    }
  }

  private formatError(error: unknown): string {
    const segments: string[] = [];
    this.appendErrorSegment(segments, error, false);
    return segments.join(' | ');
  }

  private appendErrorSegment(segments: string[], error: unknown, isCause: boolean): void {
    const prefix = isCause ? 'cause=' : '';

    if (error instanceof Error) {
      const details: string[] = [`${error.name}: ${error.message}`];
      const metadata = this.errorMetadata(error);
      if (metadata.length > 0) {
        details.push(...metadata);
      }
      segments.push(prefix + details.join(' | '));

      const cause = (error as Error & { cause?: unknown }).cause;
      if (cause !== undefined) {
        this.appendErrorSegment(segments, cause, true);
      }
      return;
    }

    if (error && typeof error === 'object') {
      const metadata = this.errorMetadata(error);
      if (metadata.length > 0) {
        segments.push(prefix + metadata.join(' | '));
        return;
      }
    }

    segments.push(prefix + String(error));
  }

  private errorMetadata(value: unknown): string[] {
    if (!value || typeof value !== 'object') {
      return [];
    }

    const record = value as {
      code?: unknown;
      errno?: unknown;
      syscall?: unknown;
      address?: unknown;
      port?: unknown;
      status?: unknown;
      statusText?: unknown;
    };

    const metadata: string[] = [];
    if (record.code !== undefined) {
      metadata.push(`code=${String(record.code)}`);
    }
    if (record.errno !== undefined) {
      metadata.push(`errno=${String(record.errno)}`);
    }
    if (record.syscall !== undefined) {
      metadata.push(`syscall=${String(record.syscall)}`);
    }
    if (record.address !== undefined) {
      metadata.push(`address=${String(record.address)}`);
    }
    if (record.port !== undefined) {
      metadata.push(`port=${String(record.port)}`);
    }
    if (record.status !== undefined) {
      metadata.push(`status=${String(record.status)}`);
    }
    if (record.statusText !== undefined) {
      metadata.push(`status_text=${String(record.statusText)}`);
    }
    return metadata;
  }
}
