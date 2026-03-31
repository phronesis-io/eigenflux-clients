/**
 * Private message poller for EigenFlux.
 * Periodically calls GET /api/v1/pm/fetch
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import type { PmFetchResponse } from './types.js';

export interface PmPollerConfig {
  apiUrl: string;
  pollIntervalSec: number;
  getAccessToken: () => string | null;
  onPmUpdate: (payload: PmFetchResponse) => Promise<void>;
  onAuthRequired: (reason: string) => Promise<void>;
}

export class PmPoller {
  private config: PmPollerConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private running = false;
  private authPrompted = false;

  constructor(config: PmPollerConfig) {
    this.config = config;
  }

  start(): void {
    if (this.running) {
      console.error('[eigenflux:pm] Poller already running');
      return;
    }

    this.running = true;
    console.error(`[eigenflux:pm] Starting poller (interval: ${this.config.pollIntervalSec}s)`);

    // Immediate poll, then schedule
    this.pollOnce().catch((err) => {
      console.error('[eigenflux:pm] Initial poll error:', err);
    });

    this.intervalId = setInterval(() => {
      this.pollOnce().catch((err) => {
        console.error('[eigenflux:pm] Poll error:', err);
      });
    }, this.config.pollIntervalSec * 1000);
  }

  stop(): void {
    if (!this.running) return;

    console.error('[eigenflux:pm] Stopping poller');
    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async pollOnce(): Promise<PmFetchResponse | null> {
    const token = this.config.getAccessToken();
    if (!token) {
      if (!this.authPrompted) {
        this.authPrompted = true;
        await this.config.onAuthRequired('missing_or_expired_token');
      }
      return null;
    }

    const url = `${this.config.apiUrl}/api/v1/pm/fetch`;

    try {
      console.error(`[eigenflux:pm] Polling: ${url}`);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.status === 401) {
        console.error('[eigenflux:pm] 401 Unauthorized');
        if (!this.authPrompted) {
          this.authPrompted = true;
          await this.config.onAuthRequired('unauthorized');
        }
        return null;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as PmFetchResponse;

      if (data.code !== 0) {
        throw new Error(`API error (code=${data.code}): ${data.msg}`);
      }

      // Reset auth flag on success
      this.authPrompted = false;

      const messages = data.data.messages ?? [];
      console.error(`[eigenflux:pm] Polled: ${messages.length} messages`);

      if (messages.length > 0) {
        await this.config.onPmUpdate(data);
      }

      return data;
    } catch (error) {
      console.error('[eigenflux:pm] Poll failed:', error instanceof Error ? error.message : error);
      return null;
    }
  }
}
