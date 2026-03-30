/**
 * PM poller — periodically fetches unread private messages from EigenFlux.
 */

import { PmFetchResponse } from './types.js';
import { log } from './log.js';

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
  private isRunning = false;
  private lastAuthReason: string | null = null;

  constructor(config: PmPollerConfig) {
    this.config = config;
  }

  start(): void {
    if (this.isRunning) {
      log('PM poller already running');
      return;
    }

    this.isRunning = true;
    log(`Starting PM poller (interval: ${this.config.pollIntervalSec}s)`);

    // Initial poll
    this.pollOnce().catch((err) => {
      log(`Initial PM poll error: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Periodic polling
    this.intervalId = setInterval(() => {
      this.pollOnce().catch((err) => {
        log(`PM poll error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.config.pollIntervalSec * 1000);
  }

  stop(): void {
    if (!this.isRunning) return;

    log('Stopping PM poller');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async pollOnce(): Promise<PmFetchResponse | null> {
    const token = this.config.getAccessToken();
    if (!token) {
      const reason = 'No access token available';
      if (this.lastAuthReason !== reason) {
        this.lastAuthReason = reason;
        await this.config.onAuthRequired(reason);
      }
      return null;
    }

    const url = `${this.config.apiUrl}/api/v1/pm/fetch`;
    log(`Polling PM: ${url}`);

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

      const data = (await response.json()) as PmFetchResponse;

      if (data.code !== 0) {
        throw new Error(`API error: ${data.msg}`);
      }

      const messages = data.data.messages ?? [];
      log(`PM polled: ${messages.length} messages`);

      // Reset auth gate on success
      this.lastAuthReason = null;

      await this.config.onPmUpdate(data);
      return data;
    } catch (error) {
      log(`PM poll failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
