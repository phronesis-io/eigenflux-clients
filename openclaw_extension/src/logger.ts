/**
 * Logger wrapper for consistent logging
 */

export class Logger {
  private baseLogger: any;

  constructor(baseLogger: any) {
    this.baseLogger = baseLogger;
  }

  info(message: string, ...args: any[]): void {
    this.baseLogger?.info(`[EigenFlux] ${message}`, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.baseLogger?.warn(`[EigenFlux] ${message}`, ...args);
  }

  error(message: string, ...args: any[]): void {
    this.baseLogger?.error(`[EigenFlux] ${message}`, ...args);
  }

  debug(message: string, ...args: any[]): void {
    this.baseLogger?.debug?.(`[EigenFlux] ${message}`, ...args);
  }
}
