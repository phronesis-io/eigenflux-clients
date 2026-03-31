/**
 * Polling client for EigenFlux private message updates
 */

import { AuthState } from './credentials-loader';
import { buildEigenFluxRequestHeaders } from './config';
import { Logger } from './logger';
import { AuthRequiredEvent, PollOnceOptions } from './polling-client';

export interface PmMessage {
  message_id: string;
  from_agent_id: string;
  conversation_id: string;
  content: string;
  created_at: number;
}

export interface PmFetchResponse {
  code: number;
  msg: string;
  data: {
    messages: PmMessage[];
  };
}

export interface PmPollingClientConfig {
  apiUrl: string;
  getAuthState: () => AuthState;
  pollIntervalSec: number;
  logger: Logger;
  onPmFetched: (payload: PmFetchResponse) => Promise<void>;
  onAuthRequired: (event: AuthRequiredEvent) => Promise<void>;
}

export type PmPollResult =
  | {
      kind: 'success';
      payload: PmFetchResponse;
    }
  | {
      kind: 'auth_required';
      authEvent: AuthRequiredEvent;
    }
  | {
      kind: 'error';
      error: Error;
    };

export class EigenFluxPmPollingClient {
  private config: PmPollingClientConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private activePoll: Promise<PmPollResult> | null = null;

  constructor(config: PmPollingClientConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.config.logger.warn('PM polling client already running');
      return;
    }

    this.isRunning = true;
    this.config.logger.info(
      `Starting PM polling client (interval: ${this.config.pollIntervalSec}s)`
    );

    // Initial fetch
    await this.pollOnce();

    // Schedule periodic polling
    this.intervalId = setInterval(() => {
      this.pollOnce().catch((err) => {
        this.config.logger.error(`PM polling error: ${this.formatError(err)}`);
      });
    }, this.config.pollIntervalSec * 1000);
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.config.logger.info('Stopping PM polling client');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async pollOnce(options: PollOnceOptions = {}): Promise<PmPollResult> {
    if (this.activePoll) {
      this.config.logger.warn('Skipping PM poll because a previous poll is still in progress');
      return this.activePoll;
    }

    const run = async (): Promise<PmPollResult> => {
      const notifyFeed = options.notifyFeed ?? true;
      const notifyAuthRequired = options.notifyAuthRequired ?? true;
      const authState = this.config.getAuthState();
      if (authState.status !== 'available') {
        this.config.logger.warn(
          `No usable access token available (status=${authState.status}), skipping PM poll`
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

      const url = `${this.config.apiUrl}/api/v1/pm/fetch`;

      try {
        this.config.logger.info(`Polling PM request: ${url}`);
        this.config.logger.debug(`Polling: ${url}`);

        const response = await fetch(url, {
          method: 'GET',
          headers: buildEigenFluxRequestHeaders(authState.accessToken),
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

        const data = (await response.json()) as PmFetchResponse;

        if (data.code !== 0) {
          throw new Error(`API error: ${data.msg}`);
        }

        const messages = data.data.messages ?? [];
        this.config.logger.info(`Polled PM: ${messages.length} messages`);

        if (notifyFeed && messages.length > 0) {
          await this.config.onPmFetched(data);
        }
        return {
          kind: 'success',
          payload: data,
        };
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.config.logger.error(
          `Failed to poll PM (url=${url}): ${this.formatError(normalized)}`
        );
        return {
          kind: 'error',
          error: normalized,
        };
      }
    };

    this.activePoll = run().finally(() => {
      this.activePoll = null;
    });
    return this.activePoll;
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
