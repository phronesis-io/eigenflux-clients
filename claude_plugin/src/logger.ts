/**
 * File logger for EigenFlux MCP server.
 * Writes to ~/.eigenflux/mcp-server.log (appends, rotates at 5 MB).
 * Also mirrors to stderr so Claude Code CLI still shows logs in terminal.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOG_DIR = path.join(os.homedir(), '.eigenflux');
const LOG_FILE = path.join(LOG_DIR, 'mcp-server.log');
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function rotatIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch {
    // file doesn't exist yet, fine
  }
}

let initialized = false;

function init(): void {
  if (initialized) return;
  initialized = true;
  ensureLogDir();
  rotatIfNeeded();
  // Write session separator
  const sep = `\n${'='.repeat(60)}\n[eigenflux] MCP server started at ${new Date().toISOString()}\n${'='.repeat(60)}\n`;
  fs.appendFileSync(LOG_FILE, sep);
}

export function log(...args: unknown[]): void {
  init();
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // ignore write errors
  }
  process.stderr.write(line);
}

export const LOG_PATH = LOG_FILE;
