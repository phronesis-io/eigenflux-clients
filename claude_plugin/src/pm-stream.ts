/**
 * Stream client for EigenFlux private message updates.
 * Manages a long-running `eigenflux stream` child process that outputs NDJSON.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface as ReadlineInterface } from 'readline';
import { log } from './logger.js';

const EXIT_AUTH_REQUIRED = 4;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;
const STOP_GRACE_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 20;

export interface PmStreamEvent {
  type: string;
  data: {
    messages?: Array<{
      msg_id: string;
      conv_id: string;
      sender_id?: string;
      sender_name?: string;
      content: string;
      created_at: number;
    }>;
    next_cursor?: string;
    [key: string]: unknown;
  };
}

export interface PmStreamClientConfig {
  serverName: string;
  eigenfluxBin: string;
  onPmEvent: (event: PmStreamEvent) => Promise<void>;
  onAuthRequired: () => Promise<void>;
}

export class PmStreamClient {
  private config: PmStreamClientConfig;
  private child: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private stopping = false;
  private running = false;
  private lastCursor: string | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private consecutiveFailures = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(config: PmStreamClientConfig) {
    this.config = config;
  }

  isRunning(): boolean {
    return this.running;
  }

  getLastCursor(): string | null {
    return this.lastCursor;
  }

  start(): void {
    if (this.running) {
      log('[eigenflux:stream] Stream client already running');
      return;
    }

    this.running = true;
    this.stopping = false;
    log(`[eigenflux:stream] Starting stream client for server=${this.config.serverName}`);
    this.spawnStreamProcess();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    log('[eigenflux:stream] Stopping stream client');
    this.stopping = true;
    this.running = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.child) {
      const child = this.child;
      this.child = null;

      child.kill('SIGTERM');

      await new Promise<void>((resolve) => {
        const forceKillTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process already exited
          }
          resolve();
        }, STOP_GRACE_MS);

        child.once('exit', () => {
          clearTimeout(forceKillTimer);
          resolve();
        });
      });
    }
  }

  private spawnStreamProcess(): void {
    if (this.stopping || !this.running) {
      return;
    }

    const args = ['stream', '-s', this.config.serverName, '-f', 'json'];
    if (this.lastCursor) {
      args.push('--cursor', this.lastCursor);
    }

    log(`[eigenflux:stream] Spawning: ${this.config.eigenfluxBin} ${args.join(' ')}`);

    const child = spawn(this.config.eigenfluxBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const rl = createInterface({ input: child.stdout! });
    this.readline = rl;

    rl.on('line', (line) => {
      this.handleLine(line);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        log(`[eigenflux:stream] stderr: ${text}`);
      }
    });

    child.on('error', (err) => {
      log(`[eigenflux:stream] Process error: ${err.message}`);
      this.scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      log(`[eigenflux:stream] Process exited (code=${code}, signal=${signal})`);

      if (this.stopping) {
        return;
      }

      if (code === EXIT_AUTH_REQUIRED) {
        log('[eigenflux:stream] Auth required');
        this.config.onAuthRequired().then(() => {
          this.scheduleRestart();
        }).catch((err) => {
          log(`[eigenflux:stream] Auth handler error: ${err instanceof Error ? err.message : String(err)}`);
          this.scheduleRestart();
        });
        return;
      }

      this.scheduleRestart();
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const event = JSON.parse(trimmed) as PmStreamEvent;

      // Update cursor for reconnect resume
      if (event.data?.next_cursor) {
        this.lastCursor = event.data.next_cursor;
      }

      // Reset backoff on successful message
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.consecutiveFailures = 0;

      this.config.onPmEvent(event).catch((err) => {
        log(`[eigenflux:stream] PM event handler error: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      log(`[eigenflux:stream] Failed to parse line: ${(err as Error).message}`);
    }
  }

  private scheduleRestart(): void {
    if (this.stopping || !this.running) {
      return;
    }

    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      log(`[eigenflux:stream] Giving up after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
      this.running = false;
      return;
    }

    log(`[eigenflux:stream] Reconnecting in ${this.backoffMs}ms (failure #${this.consecutiveFailures})`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnStreamProcess();
    }, this.backoffMs);

    this.backoffMs = Math.min(
      this.backoffMs * BACKOFF_MULTIPLIER,
      MAX_BACKOFF_MS
    );
  }
}
