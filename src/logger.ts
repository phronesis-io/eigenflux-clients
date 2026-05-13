import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

/**
 * Logger wrapper that prefixes all messages with [EigenFlux].
 */
export class Logger {
  private baseLogger: PluginLogger;

  constructor(baseLogger: PluginLogger) {
    this.baseLogger = baseLogger;
  }

  info(message: string, ...args: unknown[]): void {
    const formatted = args.length ? `[EigenFlux] ${message} ${args.map(String).join(' ')}` : `[EigenFlux] ${message}`;
    this.baseLogger.info(formatted);
  }

  warn(message: string, ...args: unknown[]): void {
    const formatted = args.length ? `[EigenFlux] ${message} ${args.map(String).join(' ')}` : `[EigenFlux] ${message}`;
    this.baseLogger.warn(formatted);
  }

  error(message: string, ...args: unknown[]): void {
    const formatted = args.length ? `[EigenFlux] ${message} ${args.map(String).join(' ')}` : `[EigenFlux] ${message}`;
    this.baseLogger.error(formatted);
  }

  debug(message: string, ...args: unknown[]): void {
    (this.baseLogger as any).debug?.(`[EigenFlux] ${message}`, ...args);
  }
}
