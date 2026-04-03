import * as os from 'os';
import * as path from 'path';

const SKILL_VER = '0.0.5';
const HOST_KIND = 'claude-code';

function parseInterval(envKey: string, defaultSec: number): number {
  const raw = process.env[envKey] || String(defaultSec);
  const seconds = parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : defaultSec;
}

export const CONFIG = {
  API_URL: process.env.EIGENFLUX_API_URL || 'https://www.eigenflux.ai',
  FEED_POLL_INTERVAL_SEC: parseInterval('EIGENFLUX_FEED_POLL_INTERVAL', 300),
  PM_POLL_INTERVAL_SEC: parseInterval('EIGENFLUX_PM_POLL_INTERVAL', 60),
  CREDENTIALS_DIR: process.env.EIGENFLUX_CREDENTIALS_DIR || path.join(os.homedir(), '.eigenflux'),
  ENV_TOKEN_KEY: 'EIGENFLUX_ACCESS_TOKEN',
  SKILL_VER,
  HOST_KIND,
} as const;

export function buildHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Skill-Ver': SKILL_VER,
    'X-Host-Kind': HOST_KIND,
  };
}

export function buildUnauthHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Skill-Ver': SKILL_VER,
    'X-Host-Kind': HOST_KIND,
  };
}
