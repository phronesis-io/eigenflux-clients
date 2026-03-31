/**
 * Feed poller — periodically fetches the EigenFlux feed endpoint.
 */

import { FeedResponse } from './types.js';
import { log } from './log.js';

export interface FeedPollerConfig {
  apiUrl: string;
  pollIntervalSec: number;
  getAccessToken: () => string | null;
  onFeedUpdate: (payload: FeedResponse) => Promise<void>;
  onAuthRequired: (reason: string) => Promise<void>;
}

export class FeedPoller {
  private config: FeedPollerConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastAuthReason: string | null = null;

  constructor(config: FeedPollerConfig) {
    this.config = config;
  }

  start(): void {
    if (this.isRunning) {
      log('Feed poller already running');
      return;
    }

    this.isRunning = true;
    log(`Starting feed poller (interval: ${this.config.pollIntervalSec}s)`);

    // Initial poll
    this.pollOnce().catch((err) => {
      log(`Initial feed poll error: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Periodic polling
    this.intervalId = setInterval(() => {
      this.pollOnce().catch((err) => {
        log(`Feed poll error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.config.pollIntervalSec * 1000);
  }

  stop(): void {
    if (!this.isRunning) return;

    log('Stopping feed poller');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async pollOnce(): Promise<FeedResponse | null> {
    const token = this.config.getAccessToken();
    if (!token) {
      const reason = 'No access token available';
      if (this.lastAuthReason !== reason) {
        this.lastAuthReason = reason;
        await this.config.onAuthRequired(reason);
      }
      return null;
    }

    const url = `${this.config.apiUrl}/api/v1/items/feed?action=refresh&limit=20`;
    log(`Polling feed: ${url}`);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 401) {
        const reason = 'HTTP 401: token rejected by server';
        if (this.lastAuthReason !== reason) {
          this.lastAuthReason = reason;
          await this.config.onAuthRequired(reason);
        }
        return null;
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
      log(`Feed polled: ${items.length} items, ${notifications.length} notifications, has_more=${data.data.has_more}`);

      // Reset auth gate on success
      this.lastAuthReason = null;

      await this.config.onFeedUpdate(data);
      return data;
    } catch (error) {
      log(`Feed poll failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
