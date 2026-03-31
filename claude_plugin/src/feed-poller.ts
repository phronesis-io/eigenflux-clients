/**
 * Feed poller for EigenFlux broadcast items.
 * Periodically calls GET /api/v1/items/feed?action=refresh&limit=20
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import type { FeedResponse } from './types.js';

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
  private running = false;
  private authPrompted = false;

  constructor(config: FeedPollerConfig) {
    this.config = config;
  }

  start(): void {
    if (this.running) {
      console.error('[eigenflux:feed] Poller already running');
      return;
    }

    this.running = true;
    console.error(`[eigenflux:feed] Starting poller (interval: ${this.config.pollIntervalSec}s)`);

    // Immediate poll, then schedule
    this.pollOnce().catch((err) => {
      console.error('[eigenflux:feed] Initial poll error:', err);
    });

    this.intervalId = setInterval(() => {
      this.pollOnce().catch((err) => {
        console.error('[eigenflux:feed] Poll error:', err);
      });
    }, this.config.pollIntervalSec * 1000);
  }

  stop(): void {
    if (!this.running) return;

    console.error('[eigenflux:feed] Stopping poller');
    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async pollOnce(): Promise<FeedResponse | null> {
    const token = this.config.getAccessToken();
    if (!token) {
      if (!this.authPrompted) {
        this.authPrompted = true;
        await this.config.onAuthRequired('missing_or_expired_token');
      }
      return null;
    }

    const url = `${this.config.apiUrl}/api/v1/items/feed?action=refresh&limit=20`;

    try {
      console.error(`[eigenflux:feed] Polling: ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 401) {
        console.error('[eigenflux:feed] 401 Unauthorized');
        if (!this.authPrompted) {
          this.authPrompted = true;
          await this.config.onAuthRequired('unauthorized');
        }
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as FeedResponse;

      if (data.code !== 0) {
        throw new Error(`API error (code=${data.code}): ${data.msg}`);
      }

      // Reset auth flag on success
      this.authPrompted = false;

      const items = data.data.items ?? [];
      const notifications = data.data.notifications ?? [];
      console.error(
        `[eigenflux:feed] Polled: ${items.length} items, ${notifications.length} notifications, has_more=${data.data.has_more}`
      );

      if (items.length > 0 || notifications.length > 0) {
        await this.config.onFeedUpdate(data);
      }

      return data;
    } catch (error) {
      console.error('[eigenflux:feed] Poll failed:', error instanceof Error ? error.message : error);
      return null;
    }
  }
}
