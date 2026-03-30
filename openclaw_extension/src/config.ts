/**
 * Internal configuration for EigenFlux plugin
 */

import * as os from 'os';

const PLUGIN_VERSION = '0.0.1-alpha.0';

function detectOpenClawVersion(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('openclaw/package.json') as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

function buildUserAgent(): string {
  const parts: string[] = [];

  // Runtime: node/22.0.0
  parts.push(`node/${process.version.replace(/^v/, '')}`);

  // OS: (darwin; arm64; 25.3.0)
  parts.push(`(${os.platform()}; ${os.arch()}; ${os.release()})`);

  // OpenClaw host version (if detectable)
  const openclawVersion = detectOpenClawVersion();
  if (openclawVersion) {
    parts.push(`openclaw/${openclawVersion}`);
  }

  // Plugin identifier
  parts.push(`eigenflux-plugin/${PLUGIN_VERSION}`);

  return parts.join(' ');
}

function parsePollIntervalSec(): number {
  const raw = process.env.EIGENFLUX_POLL_INTERVAL || '300';
  const seconds = parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 300;
  }
  return seconds;
}

function parsePmPollIntervalSec(): number {
  const raw = process.env.EIGENFLUX_PM_POLL_INTERVAL || '60';
  const seconds = parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 60;
  }
  return seconds;
}

export const PLUGIN_CONFIG = {
  // EigenFlux API base URL (internal, not exposed to OpenClaw config)
  API_URL: process.env.EIGENFLUX_API_URL || 'https://www.eigenflux.ai',

  // OpenClaw Gateway ACP URL (internal)
  OPENCLAW_GATEWAY_URL: process.env.EIGENFLUX_OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789',

  // Optional fixed session key for ACP chat.send target (fallback resolves from sessions.list)
  OPENCLAW_SESSION_KEY: process.env.EIGENFLUX_OPENCLAW_SESSION_KEY,

  // Polling interval in seconds (default: 300s = 5 minutes)
  POLL_INTERVAL_SEC: parsePollIntervalSec(),

  // PM polling interval in seconds (default: 60s = 1 minute)
  PM_POLL_INTERVAL_SEC: parsePmPollIntervalSec(),

  // Credentials file path (relative to OpenClaw home, e.g. ~/.openclaw)
  CREDENTIALS_FILE: 'eigenflux/credentials.json',

  // Environment variable name for auth token
  ENV_TOKEN_KEY: 'EIGENFLUX_ACCESS_TOKEN',

  // Environment variable fallback keys for OpenClaw gateway token
  GATEWAY_TOKEN_ENV_KEYS: ['EIGENFLUX_OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_GATEWAY_TOKEN'],

  // Plugin version
  PLUGIN_VERSION,

  // User-Agent header value
  // e.g. "node/22.0.0 (darwin; arm64; 25.3.0) openclaw/2026.3.2 eigenflux-plugin/0.0.1-alpha.0"
  USER_AGENT: buildUserAgent(),
} as const;
