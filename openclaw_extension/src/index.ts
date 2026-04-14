import * as path from 'path';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import {
  EigenFluxPollingClient,
  type AuthRequiredEvent,
  type FeedResponse,
} from './polling-client';
import { EigenFluxStreamClient, type PmStreamEvent } from './stream-client';
import { execEigenflux } from './cli-executor';
import { Logger } from './logger';
import { AuthState, CredentialsLoader } from './credentials-loader';
import {
  PLUGIN_CONFIG,
  PLUGIN_CONFIG_SCHEMA,
  resolvePluginConfig,
  resolveEigenfluxHome,
  discoverServers,
  type ResolvedEigenFluxPluginConfig,
  type RoutingConfig,
  type DiscoveredServer,
} from './config';
import { resolveNotificationRoute } from './notification-route-resolver';
import {
  buildAuthRequiredPromptTemplate,
  buildFeedPayloadPromptTemplate,
  buildPmStreamEventPromptTemplate,
  type EigenFluxPromptServerContext,
} from './agent-prompt-templates';
import { EigenFluxNotifier } from './notifier';
import { normalizeReplyTarget } from './reply-target';
import { writeStoredNotificationRoute } from './session-route-memory';

type JsonRecord = Record<string, unknown>;

type JsonApiSuccess<T extends JsonRecord> = {
  code: number;
  msg: string;
  data: T;
};

type ProfileResponseData = {
  agent: JsonRecord;
  profile: JsonRecord;
  influence: JsonRecord;
};

type CommandRouteContext = {
  channel?: string;
  to?: string;
  from?: string;
  accountId?: string;
  getCurrentConversationBinding?: () => Promise<{
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  } | null>;
};

type ServerRuntime = {
  server: DiscoveredServer;
  routing: RoutingConfig;
  credentialsLoader: CredentialsLoader;
  notifier: EigenFluxNotifier;
  feedPoller: EigenFluxPollingClient;
  streamClient: EigenFluxStreamClient;
  getPromptContext: () => EigenFluxPromptServerContext;
};

type ParsedCommandArgs = {
  command: string;
  serverName?: string;
};

type ServerRuntimeSelection = {
  runtime?: ServerRuntime;
  error?: string;
};

const COMMAND_NAMES = ['auth', 'profile', 'servers', 'feed', 'pm', 'here'] as const;
const COMMAND_NAME_SET = new Set<string>(COMMAND_NAMES);

const DEFAULT_ROUTING: RoutingConfig = {
  sessionKey: PLUGIN_CONFIG.DEFAULT_SESSION_KEY,
  agentId: PLUGIN_CONFIG.DEFAULT_AGENT_ID,
  routeOverrides: {
    sessionKey: false,
    agentId: false,
    replyChannel: false,
    replyTo: false,
    replyAccountId: false,
  },
};

function register(api: OpenClawPluginApi): void {
  const logger = new Logger(api.logger);
  logger.info('EigenFlux activating...');

  const pluginConfig = resolvePluginConfig(api.pluginConfig, api.config as any, logger);
  const eigenfluxHome = resolveEigenfluxHome();

  let runtimes: ServerRuntime[] = [];

  // Register a single meta-service that discovers servers on start
  api.registerService({
    id: 'eigenflux:discovery',
    start: async () => {
      logger.info('Starting EigenFlux discovery service...');

      const servers = await discoverServers(pluginConfig.eigenfluxBin, logger);
      if (servers.length === 0) {
        logger.warn('No EigenFlux servers discovered; services will not start');
        return;
      }

      logger.info(`Discovered ${servers.length} server(s): ${servers.map((s) => s.name).join(', ')}`);

      runtimes = servers.map((server) =>
        createServerRuntime(api, logger, pluginConfig, server, eigenfluxHome)
      );

      for (const runtime of runtimes) {
        logger.info(`Starting services for server=${runtime.server.name}`);
        await runtime.feedPoller.start();
        await runtime.streamClient.start();
      }
    },
    stop: async () => {
      logger.info('Stopping EigenFlux discovery service...');
      for (const runtime of runtimes) {
        logger.info(`Stopping services for server=${runtime.server.name}`);
        runtime.feedPoller.stop();
        await runtime.streamClient.stop();
      }
      runtimes = [];
    },
  });

  registerCommand(api, logger, pluginConfig, eigenfluxHome, () => runtimes);

  logger.info('EigenFlux activated (servers will be discovered on service start)');
}

const plugin = {
  id: 'openclaw-eigenflux',
  name: 'EigenFlux',
  description: 'OpenClaw extension for EigenFlux with CLI-based feed polling and PM streaming',
  configSchema: PLUGIN_CONFIG_SCHEMA,
  register,
};

export default plugin;

function createServerRuntime(
  api: OpenClawPluginApi,
  logger: Logger,
  pluginConfig: ResolvedEigenFluxPluginConfig,
  server: DiscoveredServer,
  eigenfluxHome: string
): ServerRuntime {
  const routing = pluginConfig.serverRouting[server.name] ?? DEFAULT_ROUTING;
  const serverDataDir = path.join(eigenfluxHome, 'servers', server.name);

  const credentialsLoader = new CredentialsLoader(logger, eigenfluxHome, server.name);

  const notifier = new EigenFluxNotifier(api, logger, {
    gatewayUrl: pluginConfig.gatewayUrl,
    gatewayToken: pluginConfig.gatewayToken,
    workdir: serverDataDir,
    sessionKey: routing.sessionKey,
    agentId: routing.agentId,
    replyChannel: routing.replyChannel,
    replyTo: routing.replyTo,
    replyAccountId: routing.replyAccountId,
    openclawCliBin: pluginConfig.openclawCliBin,
    routeOverrides: routing.routeOverrides,
  });

  const getPromptContext = (): EigenFluxPromptServerContext => ({
    serverName: server.name,
    endpoint: server.endpoint,
    eigenfluxHome,
    skills: pluginConfig.skills,
  });

  let lastAuthPromptKey: string | null = null;

  const resetAuthPromptGate = (): void => {
    lastAuthPromptKey = null;
  };

  const notifyAuthRequired = async (authEvent: AuthRequiredEvent): Promise<void> => {
    const promptKey = `auth_required:${server.name}`;
    if (lastAuthPromptKey === promptKey) {
      logger.debug(`Skipping duplicate auth prompt for server=${server.name}`);
      return;
    }

    lastAuthPromptKey = promptKey;
    await notifier.deliver(
      buildAuthRequiredPromptTemplate({ context: getPromptContext() })
    );
  };

  const feedPoller = new EigenFluxPollingClient({
    serverName: server.name,
    eigenfluxBin: pluginConfig.eigenfluxBin,
    pollIntervalSec: pluginConfig.feedPollIntervalSec,
    logger,
    onFeedPolled: async (payload: FeedResponse) => {
      resetAuthPromptGate();
      await notifier.deliver(buildFeedPayloadPromptTemplate(payload, getPromptContext()));
    },
    onAuthRequired: notifyAuthRequired,
  });

  const streamClient = new EigenFluxStreamClient({
    serverName: server.name,
    eigenfluxBin: pluginConfig.eigenfluxBin,
    logger,
    onPmEvent: async (event: PmStreamEvent) => {
      resetAuthPromptGate();
      await notifier.deliver(buildPmStreamEventPromptTemplate(event, getPromptContext()));
    },
    onAuthRequired: async () => {
      await notifyAuthRequired({ reason: 'auth_required' });
    },
  });

  return {
    server,
    routing,
    credentialsLoader,
    notifier,
    feedPoller,
    streamClient,
    getPromptContext,
  };
}

// ─── Command Handler ────────────────────────────────────────────────────────

function registerCommand(
  api: OpenClawPluginApi,
  logger: Logger,
  pluginConfig: ResolvedEigenFluxPluginConfig,
  eigenfluxHome: string,
  getRuntimes: () => ServerRuntime[]
): void {
  if (!api.registerCommand) {
    logger.warn('registerCommand API unavailable; skipping /eigenflux command registration');
    return;
  }

  api.registerCommand({
    name: 'eigenflux',
    description: 'EigenFlux plugin commands: auth, profile, servers, feed, pm, here',
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseCommandArgs(ctx.args);
      const runtimes = getRuntimes();

      if (parsed.command === 'servers') {
        return {
          text: buildServersText(runtimes),
        };
      }

      const selection = selectServerRuntime(runtimes, parsed.serverName);
      if (!selection.runtime) {
        return {
          text: selection.error ?? buildHelpText(runtimes),
        };
      }
      const runtime = selection.runtime;
      const serverDataDir = path.join(eigenfluxHome, 'servers', runtime.server.name);

      await rememberCurrentCommandRouteIfPossible(ctx, runtime, serverDataDir, logger);

      switch (parsed.command) {
        case 'auth':
          return {
            text: buildAuthStatusText(runtime),
          };
        case 'profile':
          return {
            text: await buildProfileText(runtime, pluginConfig.eigenfluxBin),
          };
        case 'feed':
          return {
            text: await buildFeedText(runtime),
          };
        case 'pm':
          return {
            text: buildPmStatusText(runtime),
          };
        case 'here':
          return {
            text: await buildHereText(ctx, runtime, serverDataDir, logger),
          };
        default:
          return {
            text: buildHelpText(runtimes),
          };
      }
    },
  });
}

function parseCommandArgs(args: string | undefined): ParsedCommandArgs {
  const tokens = args?.trim().length ? args.trim().split(/\s+/u) : [];
  let serverName: string | undefined;
  const filtered: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if ((token === '--server' || token === '-s') && tokens[index + 1]) {
      serverName = tokens[index + 1];
      index += 1;
      continue;
    }
    filtered.push(token);
  }

  const command = filtered[0]?.toLowerCase() ?? '';
  return {
    command,
    serverName,
  };
}

function selectServerRuntime(
  runtimes: ServerRuntime[],
  requestedServerName: string | undefined
): ServerRuntimeSelection {
  if (runtimes.length === 0) {
    return {
      error: 'No EigenFlux servers discovered. Ensure eigenflux CLI is configured with at least one server.',
    };
  }

  if (!requestedServerName) {
    return {
      runtime: runtimes[0],
    };
  }

  const normalizedRequestedName = requestedServerName.trim().toLowerCase();
  const runtime = runtimes.find(
    (item) => item.server.name.trim().toLowerCase() === normalizedRequestedName
  );
  if (runtime) {
    return { runtime };
  }

  return {
    error: [
      `Unknown EigenFlux server: ${requestedServerName}`,
      `Available servers: ${runtimes.map((item) => item.server.name).join(', ')}`,
    ].join('\n'),
  };
}

function buildServersText(runtimes: ServerRuntime[]): string {
  if (runtimes.length === 0) {
    return 'No EigenFlux servers discovered.';
  }

  return [
    'EigenFlux servers (discovered via CLI):',
    ...runtimes.map((runtime) => {
      const flags = [
        runtime.server.current ? 'default' : null,
        runtime.streamClient.isRunning() ? 'streaming' : null,
      ]
        .filter(Boolean)
        .join(', ');
      const suffix = flags ? ` (${flags})` : '';
      return `- ${runtime.server.name}: endpoint=${runtime.server.endpoint}${suffix}`;
    }),
  ].join('\n');
}

function buildHelpText(runtimes: ServerRuntime[]): string {
  const defaultRuntime = runtimes[0];
  const availableCommands = Array.from(COMMAND_NAME_SET).join('|');

  return [
    `Usage: /eigenflux [--server <name>] <${availableCommands}>`,
    defaultRuntime ? `Default server: ${defaultRuntime.server.name}` : undefined,
    runtimes.length > 0
      ? `Available servers: ${runtimes.map((runtime) => runtime.server.name).join(', ')}`
      : undefined,
    '',
    '/eigenflux auth — Show credential status',
    '/eigenflux profile — Fetch agent profile',
    '/eigenflux servers — List discovered servers',
    '/eigenflux feed — Run one feed refresh',
    '/eigenflux pm — Show PM stream status',
    '/eigenflux here — Remember current conversation as delivery route',
  ]
    .filter(Boolean)
    .join('\n');
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeChannel(value: unknown): string | undefined {
  return readNonEmptyString(value)?.toLowerCase();
}

function isInternalAgentSessionKey(value: string | undefined): boolean {
  const trimmed = readNonEmptyString(value);
  if (!trimmed || trimmed === 'main') {
    return true;
  }

  const parts = trimmed.split(':').filter((part) => part.length > 0);
  return parts[0]?.toLowerCase() === 'agent' && parts[2]?.toLowerCase() === 'main';
}

async function resolveCurrentCommandRoute(
  ctx: CommandRouteContext,
  runtime: ServerRuntime,
  serverDataDir: string,
  logger: Logger
) {
  const channel = normalizeChannel(ctx.channel);
  const accountId = readNonEmptyString(ctx.accountId);

  let replyChannel = channel;
  let replyTo =
    normalizeReplyTarget(ctx.to, { channel }) ??
    normalizeReplyTarget(ctx.from, { channel, fallbackKind: 'user' });
  let replyAccountId = accountId;

  if (typeof ctx.getCurrentConversationBinding === 'function') {
    try {
      const binding = await ctx.getCurrentConversationBinding();
      if (binding) {
        replyChannel = normalizeChannel(binding.channel) ?? replyChannel;
        replyTo =
          normalizeReplyTarget(binding.conversationId, { channel: replyChannel }) ??
          normalizeReplyTarget(binding.parentConversationId, { channel: replyChannel }) ??
          replyTo;
        replyAccountId = readNonEmptyString(binding.accountId) ?? replyAccountId;
      }
    } catch (error) {
      logger.debug(
        `Failed to read current conversation binding: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!replyChannel || !replyTo) {
    return undefined;
  }

  const route = resolveNotificationRoute(
    {
      sessionKey: 'main',
      agentId: runtime.routing.agentId,
      replyChannel,
      replyTo,
      replyAccountId,
      workdir: serverDataDir,
      routeOverrides: {
        sessionKey: false,
        agentId: false,
        replyChannel: true,
        replyTo: true,
        replyAccountId: replyAccountId !== undefined,
      },
    },
    logger
  );

  if (!route.replyChannel || !route.replyTo) {
    return undefined;
  }

  if (isInternalAgentSessionKey(route.sessionKey)) {
    const configuredSessionKey = readNonEmptyString(runtime.routing.sessionKey);
    if (configuredSessionKey && !isInternalAgentSessionKey(configuredSessionKey)) {
      return {
        sessionKey: configuredSessionKey,
        agentId: readNonEmptyString(runtime.routing.agentId) ?? route.agentId,
        replyChannel: route.replyChannel,
        replyTo: route.replyTo,
        replyAccountId: route.replyAccountId,
      };
    }
  }

  return route;
}

async function buildHereText(
  ctx: CommandRouteContext,
  runtime: ServerRuntime,
  serverDataDir: string,
  logger: Logger
): Promise<string> {
  const route = await resolveCurrentCommandRoute(ctx, runtime, serverDataDir, logger);
  if (!route || route.sessionKey === 'main' || route.sessionKey.endsWith(':main')) {
    return [
      `Unable to resolve the current external session for server=${runtime.server.name}.`,
      'Run `/eigenflux here` inside the target conversation after OpenClaw has already created a session for it.',
    ].join('\n');
  }

  const saved = writeStoredNotificationRoute(serverDataDir, route, logger);
  if (!saved) {
    return `Failed to persist the current EigenFlux route for server=${runtime.server.name}; check plugin logs for details.`;
  }

  return [
    `EigenFlux server ${runtime.server.name} will deliver to this conversation by default:`,
    `sessionKey: ${route.sessionKey}`,
    `agentId: ${route.agentId}`,
    `channel: ${route.replyChannel ?? 'unknown'}`,
    `target: ${route.replyTo ?? 'unknown'}`,
    route.replyAccountId ? `account: ${route.replyAccountId}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

async function rememberCurrentCommandRouteIfPossible(
  ctx: CommandRouteContext,
  runtime: ServerRuntime,
  serverDataDir: string,
  logger: Logger
): Promise<void> {
  const route = await resolveCurrentCommandRoute(ctx, runtime, serverDataDir, logger);
  if (!route || route.sessionKey === 'main' || route.sessionKey.endsWith(':main')) {
    return;
  }

  if (writeStoredNotificationRoute(serverDataDir, route, logger)) {
    logger.debug(
      `Remembered current command route for server=${runtime.server.name}: session_key=${route.sessionKey}, channel=${route.replyChannel ?? 'unknown'}, to=${route.replyTo ?? 'unknown'}`
    );
  }
}

// ─── Command Handlers ───────────────────────────────────────────────────────

function buildAuthStatusText(runtime: ServerRuntime): string {
  const authState = runtime.credentialsLoader.loadAuthState();
  const lines = [`EigenFlux auth status (server=${runtime.server.name}):`];
  lines.push(`- credentials_path: ${authState.credentialsPath}`);
  lines.push(`- status: ${authState.status}`);
  if (authState.expiresAt) {
    lines.push(`- expires_at: ${authState.expiresAt}`);
  }
  if (authState.status === 'available') {
    lines.push(`- token: ${maskToken(authState.accessToken)}`);
  } else {
    lines.push('- token: unavailable');
  }
  return lines.join('\n');
}

async function buildProfileText(
  runtime: ServerRuntime,
  eigenfluxBin: string
): Promise<string> {
  const result = await execEigenflux<JsonApiSuccess<ProfileResponseData>>(
    eigenfluxBin,
    ['profile', 'show', '-s', runtime.server.name, '-f', 'json']
  );

  if (result.kind === 'auth_required') {
    return buildAuthRequiredPromptTemplate({ context: runtime.getPromptContext() });
  }
  if (result.kind === 'error') {
    return `Failed to fetch profile for server ${runtime.server.name}: ${result.error.message}`;
  }

  return [
    `EigenFlux profile (server=${runtime.server.name}):`,
    '```json',
    safeJsonStringify(result.data),
    '```',
  ].join('\n');
}

async function buildFeedText(runtime: ServerRuntime): Promise<string> {
  const result = await runtime.feedPoller.pollOnce({
    notifyFeed: false,
    notifyAuthRequired: false,
  });
  switch (result.kind) {
    case 'success':
      return [
        `EigenFlux feed result (server=${runtime.server.name}):`,
        '```json',
        safeJsonStringify(result.payload),
        '```',
      ].join('\n');
    case 'auth_required':
      return buildAuthRequiredPromptTemplate({ context: runtime.getPromptContext() });
    case 'error':
      return `EigenFlux feed failed for server ${runtime.server.name}: ${result.error.message}`;
    default:
      return `EigenFlux feed finished with an unknown result for server ${runtime.server.name}.`;
  }
}

function buildPmStatusText(runtime: ServerRuntime): string {
  const running = runtime.streamClient.isRunning();
  const cursor = runtime.streamClient.getLastCursor();

  const lines = [`EigenFlux PM stream status (server=${runtime.server.name}):`];
  lines.push(`- streaming: ${running ? 'active' : 'inactive'}`);
  if (cursor) {
    lines.push(`- last_cursor: ${cursor}`);
  }

  if (!running) {
    lines.push('PM stream is not running. Check auth status or restart the service.');
  }

  return lines.join('\n');
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function maskToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 2)}***`;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
