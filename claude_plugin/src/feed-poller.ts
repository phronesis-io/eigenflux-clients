/**
 * Feed poller for EigenFlux broadcast items.
 * Uses the eigenflux CLI (`eigenflux feed poll`) instead of direct HTTP calls.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import type { FeedResponse } from './types.js';
import { execEigenflux } from './cli-executor.js';
import { log } from './logger.js';

export interface FeedPollerConfig {
  serverName: string;
  eigenfluxBin: string;
  pollIntervalSec: number;
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
      log('[eigenflux:feed] Poller already running');
      return;
    }

    this.running = true;
    log(`[eigenflux:feed] Starting poller for server=${this.config.serverName} (interval: ${this.config.pollIntervalSec}s)`);

    // Immediate poll, then schedule
    this.pollOnce().catch((err) => {
      log('[eigenflux:feed] Initial poll error:', err);
    });

    this.intervalId = setInterval(() => {
      this.pollOnce().catch((err) => {
        log('[eigenflux:feed] Poll error:', err);
      });
    }, this.config.pollIntervalSec * 1000);
  }

  stop(): void {
    if (!this.running) return;

    log('[eigenflux:feed] Stopping poller');
    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async pollOnce(): Promise<FeedResponse | null> {
    try {
      log(`[eigenflux:feed] Polling via CLI for server=${this.config.serverName}`);

      const result = await execEigenflux<FeedResponse['data']>(
        this.config.eigenfluxBin,
        ['feed', 'poll', '--limit', '20', '--action', 'refresh', '-s', this.config.serverName, '-f', 'json']
      );

      if (result.kind === 'auth_required') {
        log('[eigenflux:feed] Auth required');
        if (!this.authPrompted) {
          this.authPrompted = true;
          await this.config.onAuthRequired('auth_required');
        }
        return null;
      }

      if (result.kind === 'error') {
        log(`[eigenflux:feed] CLI error: ${result.error.message}`);
        return null;
      }

      // Reconstruct full FeedResponse envelope from CLI data output
      const data: FeedResponse = {
        code: 0,
        msg: 'success',
        data: result.data,
      };

      // Reset auth flag on success
      this.authPrompted = false;

      const items = data.data.items ?? [];
      const notifications = data.data.notifications ?? [];
      log(
        `[eigenflux:feed] Polled: ${items.length} items, ${notifications.length} notifications, has_more=${data.data.has_more}`
      );

      if (items.length > 0 || notifications.length > 0) {
        await this.config.onFeedUpdate(data);
      }

      return data;
    } catch (error) {
      log('[eigenflux:feed] Poll failed:', error instanceof Error ? error.message : error);
      return null;
    }
  }
}
