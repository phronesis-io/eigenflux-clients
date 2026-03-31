import { randomUUID } from 'node:crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { type NotificationRouteOverrides } from './config';
import { OpenClawGatewayRpcClient } from './gateway-rpc-client';
import { Logger } from './logger';
import {
  resolveNotificationRoute,
  type NotificationRouteConfig,
  type ResolvedNotificationRoute,
} from './notification-route-resolver';
import { writeStoredNotificationRoute } from './session-route-memory';

const COMMAND_TIMEOUT_MS = 15000;
const HEARTBEAT_REASON = 'plugin:eigenflux';

export type EigenFluxNotifierConfig = {
  gatewayUrl: string;
  gatewayToken?: string;
  workdir?: string;
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  openclawCliBin: string;
  sessionStorePath?: string;
  routeOverrides?: NotificationRouteOverrides;
};

type GatewayRpcClientLike = {
  sendAgentMessage(message: string): Promise<{ sessionKey: string; runId: string }>;
};

type CreateGatewayRpcClient = (
  config: EigenFluxNotifierConfig & ResolvedNotificationRoute,
  logger: Logger
) => GatewayRpcClientLike;

type CommandRunner = (
  argv: string[],
  options: { timeoutMs: number }
) => Promise<{ code: number | null; stdout?: string; stderr?: string }>;

type NotifyAttemptResult =
  | {
      ok: true;
      mode: string;
      sessionKey?: string;
      runId?: string;
      detail?: string;
    }
  | {
      ok: false;
      mode: string;
      error: string;
    };

export class EigenFluxNotifier {
  private readonly api: OpenClawPluginApi;
  private readonly logger: Logger;
  private readonly config: EigenFluxNotifierConfig;
  private readonly createGatewayRpcClient: CreateGatewayRpcClient;

  constructor(
    api: OpenClawPluginApi,
    logger: Logger,
    config: EigenFluxNotifierConfig,
    createGatewayRpcClient: CreateGatewayRpcClient = createDefaultGatewayRpcClient
  ) {
    this.api = api;
    this.logger = logger;
    this.config = config;
    this.createGatewayRpcClient = createGatewayRpcClient;
  }

  async deliver(message: string): Promise<boolean> {
    const route = this.resolveRoute();
    const attempts: Array<() => Promise<NotifyAttemptResult>> = [
      () => this.tryNotifyViaRuntimeSubagent(message, route),
      () => this.tryNotifyViaGatewayRpcAgent(message, route),
      () => this.tryNotifyViaRuntimeCommandAgent(message, route),
      () => this.tryNotifyViaRuntimeHeartbeat(message, route),
      () => this.tryNotifyViaRuntimeCommandHeartbeat(message),
    ];

    const errors: string[] = [];

    for (const attempt of attempts) {
      const result = await attempt();
      if (result.ok) {
        this.rememberRoute({
          sessionKey: result.sessionKey ?? route.sessionKey,
          agentId: route.agentId,
          replyChannel: route.replyChannel,
          replyTo: route.replyTo,
          replyAccountId: route.replyAccountId,
        });
        this.logDispatch(result);
        return true;
      }
      errors.push(`${result.mode}: ${result.error}`);
    }

    this.logger.error(`Failed to deliver notification: ${errors.join(' | ')}`);
    return false;
  }

  async deliverWithSubagent(message: string): Promise<boolean> {
    const route = this.resolveRoute();
    const result = await this.tryNotifyViaRuntimeSubagent(message, route);
    if (!result.ok) {
      this.logger.warn(`runtime.subagent test dispatch failed: ${result.error}`);
      return false;
    }
    this.rememberRoute(route);
    this.logDispatch(result);
    return true;
  }

  private async tryNotifyViaRuntimeSubagent(
    message: string,
    route: ResolvedNotificationRoute
  ): Promise<NotifyAttemptResult> {
    const runtimeSubagent = (this.api.runtime as
      | {
          subagent?: {
            run?: (params: {
              sessionKey: string;
              message: string;
              deliver?: boolean;
              idempotencyKey?: string;
            }) => Promise<{ runId: string }>;
          };
        }
      | undefined)?.subagent;

    if (!runtimeSubagent || typeof runtimeSubagent.run !== 'function') {
      return {
        ok: false,
        mode: 'runtime.subagent',
        error: 'runtime.subagent.run is unavailable',
      };
    }

    try {
      const result = await runtimeSubagent.run({
        sessionKey: route.sessionKey,
        message,
        deliver: true,
        idempotencyKey: randomUUID(),
      });
      return {
        ok: true,
        mode: 'runtime.subagent',
        sessionKey: route.sessionKey,
        runId: result.runId,
      };
    } catch (error) {
      return {
        ok: false,
        mode: 'runtime.subagent',
        error: formatError(error),
      };
    }
  }

  private async tryNotifyViaGatewayRpcAgent(
    message: string,
    route: ResolvedNotificationRoute
  ): Promise<NotifyAttemptResult> {
    try {
      const client = this.createGatewayRpcClient(
        {
          ...this.config,
          ...route,
        },
        this.logger
      );
      const result = await client.sendAgentMessage(message);
      return {
        ok: true,
        mode: 'gateway.rpc.agent',
        sessionKey: result.sessionKey,
        runId: result.runId,
      };
    } catch (error) {
      return {
        ok: false,
        mode: 'gateway.rpc.agent',
        error: formatError(error),
      };
    }
  }

  private async tryNotifyViaRuntimeCommandAgent(
    message: string,
    route: ResolvedNotificationRoute
  ): Promise<NotifyAttemptResult> {
    return this.runRuntimeCommand(
      'runtime.command.agent',
      this.buildAgentCliArgs(message, route),
      route
    );
  }

  private async tryNotifyViaRuntimeHeartbeat(
    message: string,
    route: ResolvedNotificationRoute
  ): Promise<NotifyAttemptResult> {
    const runtimeSystem = (this.api.runtime as
      | {
          system?: {
            enqueueSystemEvent?: (
              text: string,
              options: {
                sessionKey: string;
                deliveryContext?: {
                  channel?: string;
                  to?: string;
                  accountId?: string;
                };
              }
            ) => boolean;
            requestHeartbeatNow?: (options: {
              reason?: string;
              coalesceMs?: number;
              agentId?: string;
              sessionKey?: string;
            }) => void;
          };
        }
      | undefined)?.system;

    if (
      !runtimeSystem ||
      typeof runtimeSystem.enqueueSystemEvent !== 'function' ||
      typeof runtimeSystem.requestHeartbeatNow !== 'function'
    ) {
      return {
        ok: false,
        mode: 'runtime.system.heartbeat',
        error: 'runtime.system heartbeat APIs are unavailable',
      };
    }

    try {
      const enqueued = runtimeSystem.enqueueSystemEvent(message, {
        sessionKey: route.sessionKey,
        ...(this.resolveHeartbeatDeliveryContext(route)
          ? { deliveryContext: this.resolveHeartbeatDeliveryContext(route) }
          : {}),
      });
      runtimeSystem.requestHeartbeatNow({
        reason: HEARTBEAT_REASON,
        coalesceMs: 0,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
      });

      return {
        ok: true,
        mode: 'runtime.system.heartbeat',
        sessionKey: route.sessionKey,
        detail: enqueued ? 'enqueued' : 'duplicate-enqueued',
      };
    } catch (error) {
      return {
        ok: false,
        mode: 'runtime.system.heartbeat',
        error: formatError(error),
      };
    }
  }

  private async tryNotifyViaRuntimeCommandHeartbeat(message: string): Promise<NotifyAttemptResult> {
    return this.runRuntimeCommand(
      'runtime.command.heartbeat',
      this.buildHeartbeatCliArgs(message),
      this.resolveRoute()
    );
  }

  private async runRuntimeCommand(
    mode: string,
    argv: string[],
    route: ResolvedNotificationRoute
  ): Promise<NotifyAttemptResult> {
    const runtimeCommand = (this.api.runtime as
      | {
          system?: {
            runCommandWithTimeout?: CommandRunner;
          };
        }
      | undefined)?.system?.runCommandWithTimeout;

    if (typeof runtimeCommand !== 'function') {
      return {
        ok: false,
        mode,
        error: 'runtime.system.runCommandWithTimeout is unavailable',
      };
    }

    try {
      const result = await runtimeCommand(argv, { timeoutMs: COMMAND_TIMEOUT_MS });
      if (result.code === 0) {
        return {
          ok: true,
          mode,
          sessionKey: route.sessionKey,
        };
      }

      return {
        ok: false,
        mode,
        error: formatCommandFailure(result),
      };
    } catch (error) {
      return {
        ok: false,
        mode,
        error: formatError(error),
      };
    }
  }

  private buildAgentCliArgs(message: string, route: ResolvedNotificationRoute): string[] {
    const args = [
      this.config.openclawCliBin,
      'agent',
      '--message',
      message,
      '--agent',
      route.agentId,
      '--deliver',
    ];

    if (route.replyChannel) {
      args.push('--reply-channel', route.replyChannel);
    }
    if (route.replyTo) {
      args.push('--reply-to', route.replyTo);
    }
    if (route.replyAccountId) {
      args.push('--reply-account', route.replyAccountId);
    }

    return args;
  }

  private buildHeartbeatCliArgs(message: string): string[] {
    return [
      this.config.openclawCliBin,
      'system',
      'event',
      '--text',
      message,
      '--mode',
      'now',
    ];
  }

  private resolveHeartbeatDeliveryContext(
    route: ResolvedNotificationRoute
  ):
    | {
        channel?: string;
        to?: string;
        accountId?: string;
      }
    | undefined {
    if (!route.replyChannel && !route.replyTo && !route.replyAccountId) {
      return undefined;
    }

    return {
      ...(route.replyChannel ? { channel: route.replyChannel } : {}),
      ...(route.replyTo ? { to: route.replyTo } : {}),
      ...(route.replyAccountId ? { accountId: route.replyAccountId } : {}),
    };
  }

  private resolveRoute(): ResolvedNotificationRoute {
    return resolveNotificationRoute(this.config as NotificationRouteConfig, this.logger);
  }

  private rememberRoute(route: ResolvedNotificationRoute): void {
    if (!route.sessionKey || !route.agentId) {
      return;
    }
    writeStoredNotificationRoute(this.config.workdir, route, this.logger);
  }

  private logDispatch(result: Extract<NotifyAttemptResult, { ok: true }>): void {
    const details = [
      `mode=${result.mode}`,
      result.sessionKey ? `session_key=${result.sessionKey}` : null,
      result.runId ? `run_id=${result.runId}` : null,
      result.detail ? `detail=${result.detail}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    this.logger.info(`Notification dispatched: ${details}`);
  }
}

function createDefaultGatewayRpcClient(
  config: EigenFluxNotifierConfig & ResolvedNotificationRoute,
  logger: Logger
): OpenClawGatewayRpcClient {
  return new OpenClawGatewayRpcClient({
    gatewayUrl: config.gatewayUrl,
    gatewayToken: config.gatewayToken,
    sessionKey: config.sessionKey,
    agentId: config.agentId,
    replyChannel: config.replyChannel,
    replyTo: config.replyTo,
    replyAccountId: config.replyAccountId,
    logger,
  });
}

function formatCommandFailure(result: {
  code: number | null;
  stdout?: string;
  stderr?: string;
}): string {
  return (
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    `command exited with ${result.code ?? 'unknown'}`
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
