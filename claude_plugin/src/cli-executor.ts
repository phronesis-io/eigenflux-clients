/**
 * Generic helper to run `eigenflux` CLI commands as one-shot subprocesses.
 *
 * All logging goes to stderr (stdout reserved for MCP stdio transport).
 */

import { execFile } from 'child_process';
import { log } from './logger.js';

const EXIT_AUTH_REQUIRED = 4;
const DEFAULT_TIMEOUT_MS = 30_000;

export type CliResult<T> =
  | { kind: 'success'; data: T }
  | { kind: 'auth_required'; stderr: string }
  | { kind: 'error'; error: Error; exitCode: number | null; stderr: string };

export interface ExecOptions {
  timeout?: number;
  cwd?: string;
}

export function execEigenflux<T>(
  bin: string,
  args: string[],
  options?: ExecOptions
): Promise<CliResult<T>> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    log(`[eigenflux:cli] exec: ${bin} ${args.join(' ')}`);

    execFile(
      bin,
      args,
      {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
        ...(options?.cwd ? { cwd: options.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          const numericExit =
            typeof exitCode === 'number'
              ? exitCode
              : error.killed
                ? null
                : (error as any).status ?? null;

          if (numericExit === EXIT_AUTH_REQUIRED) {
            log(`[eigenflux:cli] auth required: ${stderr.trim()}`);
            resolve({ kind: 'auth_required', stderr: stderr.trim() });
            return;
          }

          log(`[eigenflux:cli] failed (exit=${numericExit}): ${stderr.trim() || error.message}`);
          resolve({
            kind: 'error',
            error: new Error(stderr.trim() || error.message),
            exitCode: numericExit,
            stderr: stderr.trim(),
          });
          return;
        }

        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve({
            kind: 'success',
            data: undefined as unknown as T,
          });
          return;
        }

        try {
          const data = JSON.parse(trimmed) as T;
          resolve({ kind: 'success', data });
        } catch (parseError) {
          log(`[eigenflux:cli] JSON parse error: ${(parseError as Error).message}`);
          resolve({
            kind: 'error',
            error: new Error(`Failed to parse CLI output: ${(parseError as Error).message}`),
            exitCode: 0,
            stderr: '',
          });
        }
      }
    );
  });
}
