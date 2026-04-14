/**
 * Polling client for EigenFlux feed updates.
 * Uses the eigenflux CLI (`eigenflux feed poll`) instead of direct HTTP calls.
 */

import { execEigenflux } from './cli-executor';
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

export interface FeedResponseData {
  items: FeedItem[];
  has_more: boolean;
  notifications: FeedNotification[];
}

export interface FeedResponse {
  code: number;
  msg: string;
  data: FeedResponseData;
}

export interface PollingClientConfig {
  serverName: string;
  eigenfluxBin: string;
  pollIntervalSec: number;
  logger: Logger;
  onFeedPolled: (payload: FeedResponse) => Promise<void>;
  onAuthRequired: (event: AuthRequiredEvent) => Promise<void>;
}

export interface AuthRequiredEvent {
  reason: 'auth_required';
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
  private activePoll: Promise<PollResult> | null = null;

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
      `Starting polling client for server=${this.config.serverName} (interval: ${this.config.pollIntervalSec}s)`
    );

    // Initial fetch
    await this.pollOnce();

    // Schedule periodic polling
    this.intervalId = setInterval(() => {
      this.pollOnce().catch((err) => {
        this.config.logger.error(`Polling error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.config.pollIntervalSec * 1000);
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.config.logger.info(`Stopping polling client for server=${this.config.serverName}`);
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async pollOnce(options: PollOnceOptions = {}): Promise<PollResult> {
    if (this.activePoll) {
      this.config.logger.warn('Skipping feed poll because a previous poll is still in progress');
      return this.activePoll;
    }

    const run = async (): Promise<PollResult> => {
      const notifyFeed = options.notifyFeed ?? true;
      const notifyAuthRequired = options.notifyAuthRequired ?? true;

      try {
        this.config.logger.info(`Polling feed via CLI for server=${this.config.serverName}`);

        const result = await execEigenflux<FeedResponseData>(
          this.config.eigenfluxBin,
          ['feed', 'poll', '--limit', '20', '--action', 'refresh', '-s', this.config.serverName, '-f', 'json'],
          { logger: this.config.logger }
        );

        if (result.kind === 'auth_required') {
          const authEvent: AuthRequiredEvent = { reason: 'auth_required' };
          if (notifyAuthRequired) {
            await this.config.onAuthRequired(authEvent);
          }
          return { kind: 'auth_required', authEvent };
        }

        if (result.kind === 'error') {
          return { kind: 'error', error: result.error };
        }

        // Reconstruct full FeedResponse envelope from CLI data output
        const feedResponse: FeedResponse = {
          code: 0,
          msg: 'success',
          data: result.data,
        };

        const items = feedResponse.data.items ?? [];
        const notifications = feedResponse.data.notifications ?? [];
        this.config.logger.info(
          `Polled feed: ${items.length} items, notifications=${notifications.length}, has_more=${feedResponse.data.has_more}`
        );

        if (notifyFeed && (items.length > 0 || notifications.length > 0)) {
          await this.config.onFeedPolled(feedResponse);
        }

        return { kind: 'success', payload: feedResponse };
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.config.logger.error(
          `Failed to poll feed for server=${this.config.serverName}: ${normalized.message}`
        );
        return { kind: 'error', error: normalized };
      }
    };

    this.activePoll = run().finally(() => {
      this.activePoll = null;
    });
    return this.activePoll;
  }
}
