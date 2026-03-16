declare module 'openclaw/plugin-sdk' {
  export interface OpenClawPluginConfigSchema {
    type: string;
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
    required?: string[];
  }

  export interface PluginLogger {
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
    debug: (message: string, ...args: unknown[]) => void;
  }

  export interface OpenClawPluginService {
    id: string;
    start: () => Promise<void> | void;
    stop: () => Promise<void> | void;
  }

  export interface OpenClawPluginCommandContext {
    senderId?: string;
    channel?: string;
    isAuthorizedSender?: boolean;
    args?: string;
    commandBody?: string;
    config?: Record<string, unknown>;
  }

  export interface OpenClawPluginCommandDefinition {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (
      ctx: OpenClawPluginCommandContext
    ) => Promise<{ text: string }> | { text: string };
  }

  export interface OpenClawPluginApi {
    id?: string;
    name?: string;
    version?: string;
    description?: string;
    source?: string;
    config?: Record<string, unknown>;
    pluginConfig?: Record<string, unknown>;
    runtime?: unknown;
    logger: PluginLogger;
    registerService: (service: OpenClawPluginService) => void;
    registerCommand?: (command: OpenClawPluginCommandDefinition) => void;
    registerHook?: (
      event: string | string[],
      handler: (...args: unknown[]) => Promise<unknown> | unknown,
      metadata?: Record<string, unknown>
    ) => void;
    on?: (
      event: string,
      handler: (...args: unknown[]) => Promise<unknown> | unknown,
      options?: {
        priority?: number;
      }
    ) => void;
  }

  export function emptyPluginConfigSchema(): OpenClawPluginConfigSchema;
}
