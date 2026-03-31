import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import {
  EigenFluxPollingClient,
  AuthRequiredEvent,
  FeedResponse,
} from './polling-client';
import { EigenFluxPmPollingClient, PmFetchResponse } from './pm-polling-client';
import { Logger } from './logger';
import { AuthState, CredentialsLoader } from './credentials-loader';
import {
  buildEigenFluxRequestHeaders,
  PLUGIN_CONFIG,
  PLUGIN_CONFIG_SCHEMA,
  resolvePluginConfig,
  resolveServerSkillPath,
  type ResolvedEigenFluxPluginConfig,
  type ResolvedEigenFluxServerConfig,
} from './config';
import { resolveNotificationRoute } from './notification-route-resolver';
import {
  buildAuthRequiredPromptTemplate,
  buildFeedPayloadPromptTemplate,
  buildPmPayloadPromptTemplate,
  type EigenFluxPromptServerContext,
} from './agent-prompt-templates';
import { EigenFluxNotifier } from './notifier';
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

type AuthPromptContext = {
  authEvent: AuthRequiredEvent;
  authState?: AuthState;
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
  server: ResolvedEigenFluxServerConfig;
  credentialsLoader: CredentialsLoader;
  notifier: EigenFluxNotifier;
  pollingClient: EigenFluxPollingClient;
  pmPollingClient: EigenFluxPmPollingClient;
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

function readServerSessionStorePath(
  server: ResolvedEigenFluxServerConfig
): string | undefined {
  return (server as ResolvedEigenFluxServerConfig & { sessionStorePath?: string })
    .sessionStorePath;
}

function register(api: OpenClawPluginApi): void {
  const logger = new Logger(api.logger);
  logger.info('EigenFlux activating...');

  const pluginConfig = resolvePluginConfig(api.pluginConfig, api.config as any, logger);
  const runtimes = pluginConfig.servers.map((server) =>
    createServerRuntime(api, logger, pluginConfig, server)
  );
  const enabledRuntimes = runtimes.filter((runtime) => runtime.server.enabled);

  if (!pluginConfig.gatewayToken) {
    logger.warn(
      'OpenClaw gateway token not found in config.gateway.auth.token or plugin config; Gateway RPC fallback may fail when gateway auth mode is token'
    );
  }

  if (enabledRuntimes.length === 0) {
    logger.warn('No enabled EigenFlux servers configured; background polling services will not start');
  }

  registerServices(api, logger, enabledRuntimes);
  registerCommand(api, logger, runtimes);

  logger.info(
    `EigenFlux activated with ${enabledRuntimes.length}/${runtimes.length} enabled server(s)`
  );
}

const plugin = {
  id: 'openclaw-eigenflux',
  name: 'EigenFlux',
  description: 'OpenClaw extension for EigenFlux periodic polling with multi-server delivery',
  configSchema: PLUGIN_CONFIG_SCHEMA,
  register,
};

export default plugin;

function createServerRuntime(
  api: OpenClawPluginApi,
  logger: Logger,
  pluginConfig: ResolvedEigenFluxPluginConfig,
  server: ResolvedEigenFluxServerConfig
): ServerRuntime {
  const credentialsLoader = new CredentialsLoader(logger, server.workdir);
  const notifier = new EigenFluxNotifier(api, logger, {
    gatewayUrl: pluginConfig.gatewayUrl,
    gatewayToken: pluginConfig.gatewayToken,
    workdir: server.workdir,
    sessionKey: server.sessionKey,
    agentId: server.agentId,
    replyChannel: server.replyChannel,
    replyTo: server.replyTo,
    replyAccountId: server.replyAccountId,
    openclawCliBin: pluginConfig.openclawCliBin,
    sessionStorePath: readServerSessionStorePath(server),
    routeOverrides: server.routeOverrides,
  });

  const getPromptContext = (): EigenFluxPromptServerContext => ({
    serverName: server.name,
    workdir: server.workdir,
    skillPath: resolveServerSkillPath(server),
  });

  let lastAuthPromptKey: string | null = null;

  const resetAuthPromptGate = (): void => {
    lastAuthPromptKey = null;
  };

  const notifyAuthRequired = async (authEvent: AuthRequiredEvent): Promise<void> => {
    const promptKey = `${authEvent.reason}:${authEvent.credentialsPath}:${authEvent.source || 'unknown'}`;
    if (lastAuthPromptKey === promptKey) {
      logger.debug(`Skipping duplicate auth prompt for server=${server.name}, key=${promptKey}`);
      return;
    }

    lastAuthPromptKey = promptKey;
    const authState = credentialsLoader.loadAuthState();
    await notifier.deliver(
      buildAuthRequiredMessage(getPromptContext(), {
        authEvent,
        authState,
      })
    );
  };

  const pollingClient = new EigenFluxPollingClient({
    apiUrl: server.endpoint,
    getAuthState: () => credentialsLoader.loadAuthState(),
    pollIntervalSec: server.pollIntervalSec,
    logger,
    onFeedPolled: async (payload: FeedResponse) => {
      resetAuthPromptGate();
      await notifier.deliver(buildFeedPayloadMessage(getPromptContext(), payload));
    },
    onAuthRequired: notifyAuthRequired,
  });

  const pmPollingClient = new EigenFluxPmPollingClient({
    apiUrl: server.endpoint,
    getAuthState: () => credentialsLoader.loadAuthState(),
    pollIntervalSec: server.pmPollIntervalSec,
    logger,
    onPmFetched: async (payload: PmFetchResponse) => {
      resetAuthPromptGate();
      await notifier.deliver(buildPmPayloadMessage(getPromptContext(), payload));
    },
    onAuthRequired: notifyAuthRequired,
  });

  return {
    server,
    credentialsLoader,
    notifier,
    pollingClient,
    pmPollingClient,
    getPromptContext,
  };
}

function registerServices(
  api: OpenClawPluginApi,
  logger: Logger,
  runtimes: ServerRuntime[]
): void {
  for (const runtime of runtimes) {
    api.registerService({
      id: `eigenflux:${toServiceIdSegment(runtime.server.name)}`,
      start: async () => {
        logger.info(`Starting EigenFlux polling services for server=${runtime.server.name}`);
        await runtime.pollingClient.start();
        await runtime.pmPollingClient.start();
      },
      stop: async () => {
        logger.info(`Stopping EigenFlux polling services for server=${runtime.server.name}`);
        runtime.pollingClient.stop();
        runtime.pmPollingClient.stop();
      },
    });
  }
}

function registerCommand(
  api: OpenClawPluginApi,
  logger: Logger,
  runtimes: ServerRuntime[]
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

      await rememberCurrentCommandRouteIfPossible(ctx, runtime.server, logger);

      switch (parsed.command) {
        case 'auth':
          return {
            text: buildAuthStatusText(runtime.server, runtime.credentialsLoader.loadAuthState()),
          };
        case 'profile':
          return {
            text: await buildProfileText(runtime, runtime.credentialsLoader.loadAuthState()),
          };
        case 'feed':
          return {
            text: await buildFeedText(runtime, runtime.credentialsLoader.loadAuthState()),
          };
        case 'pm':
          return {
            text: await buildPmPollText(runtime, runtime.credentialsLoader.loadAuthState()),
          };
        case 'here':
          return {
            text: await buildHereText(ctx, runtime.server, logger),
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
      error: 'No EigenFlux servers are configured.',
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
    return 'No EigenFlux servers are configured.';
  }

  const defaultRuntime = runtimes[0];

  return [
    'EigenFlux servers:',
    ...runtimes.map((runtime) => {
      const flags = [
        runtime.server.enabled ? 'enabled' : 'disabled',
        defaultRuntime?.server.name === runtime.server.name ? 'default' : null,
      ]
        .filter(Boolean)
        .join(', ');
      return `- ${runtime.server.name}: ${flags}; endpoint=${runtime.server.endpoint}; workdir=${runtime.server.workdir}`;
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
    '/eigenflux auth',
    'Show current EigenFlux credential status.',
    '',
    '/eigenflux profile',
    'Fetch /api/v1/agents/me with the current access token.',
    '',
    '/eigenflux servers',
    'List configured EigenFlux servers.',
    '',
    '/eigenflux feed',
    'Run one feed refresh and return the raw feed payload.',
    '',
    '/eigenflux pm',
    'Run one PM fetch and return the raw PM payload.',
    '',
    '/eigenflux here',
    'Remember the current conversation as the default delivery route for the selected server.',
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

function isNormalizedConversationTarget(value: string): boolean {
  return /^(user|chat|channel|room):/u.test(value);
}

function normalizeReplyTarget(
  value: unknown,
  channel: string | undefined,
  fallbackKind?: 'user' | 'chat' | 'channel' | 'room'
): string | undefined {
  const trimmed = readNonEmptyString(value);
  if (!trimmed) {
    return undefined;
  }
  if (isNormalizedConversationTarget(trimmed)) {
    return trimmed;
  }
  if (channel && trimmed.startsWith(`${channel}:`)) {
    const inner = trimmed.slice(channel.length + 1).trim();
    if (isNormalizedConversationTarget(inner)) {
      return inner;
    }
    return fallbackKind ? `${fallbackKind}:${inner}` : inner;
  }
  return fallbackKind ? `${fallbackKind}:${trimmed}` : trimmed;
}

async function resolveCurrentCommandRoute(
  ctx: CommandRouteContext,
  serverConfig: ResolvedEigenFluxServerConfig,
  logger: Logger
) {
  const channel = normalizeChannel(ctx.channel);
  const accountId = readNonEmptyString(ctx.accountId);

  let replyChannel = channel;
  let replyTo =
    normalizeReplyTarget(ctx.to, channel) ?? normalizeReplyTarget(ctx.from, channel, 'user');
  let replyAccountId = accountId;

  if (typeof ctx.getCurrentConversationBinding === 'function') {
    try {
      const binding = await ctx.getCurrentConversationBinding();
      if (binding) {
        replyChannel = normalizeChannel(binding.channel) ?? replyChannel;
        replyTo =
          normalizeReplyTarget(binding.conversationId, replyChannel) ??
          normalizeReplyTarget(binding.parentConversationId, replyChannel) ??
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
      agentId: serverConfig.agentId,
      replyChannel,
      replyTo,
      replyAccountId,
      sessionStorePath: readServerSessionStorePath(serverConfig),
      workdir: serverConfig.workdir,
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
    const configuredSessionKey = readNonEmptyString(serverConfig.sessionKey);
    if (configuredSessionKey && !isInternalAgentSessionKey(configuredSessionKey)) {
      return {
        sessionKey: configuredSessionKey,
        agentId: readNonEmptyString(serverConfig.agentId) ?? route.agentId,
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
  serverConfig: ResolvedEigenFluxServerConfig,
  logger: Logger
): Promise<string> {
  const route = await resolveCurrentCommandRoute(ctx, serverConfig, logger);
  if (!route || route.sessionKey === 'main' || route.sessionKey.endsWith(':main')) {
    return [
      `Unable to resolve the current external session for server=${serverConfig.name}.`,
      'Run `/eigenflux here` inside the target conversation after OpenClaw has already created a session for it.',
    ].join('\n');
  }

  const saved = writeStoredNotificationRoute(serverConfig.workdir, route, logger);
  if (!saved) {
    return `Failed to persist the current EigenFlux route for server=${serverConfig.name}; check plugin logs for details.`;
  }

  return [
    `EigenFlux server ${serverConfig.name} will deliver to this conversation by default:`,
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
  serverConfig: ResolvedEigenFluxServerConfig,
  logger: Logger
): Promise<void> {
  const route = await resolveCurrentCommandRoute(ctx, serverConfig, logger);
  if (!route || route.sessionKey === 'main' || route.sessionKey.endsWith(':main')) {
    return;
  }

  if (writeStoredNotificationRoute(serverConfig.workdir, route, logger)) {
    logger.debug(
      `Remembered current command route for server=${serverConfig.name}: session_key=${route.sessionKey}, channel=${route.replyChannel ?? 'unknown'}, to=${route.replyTo ?? 'unknown'}`
    );
  }
}

async function buildProfileText(
  runtime: ServerRuntime,
  authState: AuthState
): Promise<string> {
  if (authState.status !== 'available') {
    return buildAuthRequiredMessage(runtime.getPromptContext(), {
      authEvent: {
        reason: authState.status === 'expired' ? 'expired_token' : 'missing_token',
        credentialsPath: authState.credentialsPath,
        source: authState.source,
        expiresAt: authState.expiresAt,
      },
      authState,
    });
  }

  try {
    const payload = await fetchJson<ProfileResponseData>(
      `${runtime.server.endpoint}/api/v1/agents/me`,
      authState.accessToken
    );
    return [
      `EigenFlux profile (server=${runtime.server.name}):`,
      '```json',
      safeJsonStringify(payload),
      '```',
    ].join('\n');
  } catch (error) {
    return `Failed to fetch profile for server ${runtime.server.name}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function buildFeedText(
  runtime: ServerRuntime,
  authState: AuthState
): Promise<string> {
  const result = await runtime.pollingClient.pollOnce({
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
      return buildAuthRequiredMessage(runtime.getPromptContext(), {
        authEvent: result.authEvent,
        authState,
      });
    case 'error':
      return `EigenFlux feed failed for server ${runtime.server.name}: ${result.error.message}`;
    default:
      return `EigenFlux feed finished with an unknown result for server ${runtime.server.name}.`;
  }
}

async function buildPmPollText(
  runtime: ServerRuntime,
  authState: AuthState
): Promise<string> {
  const result = await runtime.pmPollingClient.pollOnce({
    notifyFeed: false,
    notifyAuthRequired: false,
  });
  switch (result.kind) {
    case 'success':
      return [
        `EigenFlux PM poll result (server=${runtime.server.name}):`,
        '```json',
        safeJsonStringify(result.payload),
        '```',
      ].join('\n');
    case 'auth_required':
      return buildAuthRequiredMessage(runtime.getPromptContext(), {
        authEvent: result.authEvent,
        authState,
      });
    case 'error':
      return `EigenFlux PM poll failed for server ${runtime.server.name}: ${result.error.message}`;
    default:
      return `EigenFlux PM poll finished with an unknown result for server ${runtime.server.name}.`;
  }
}

async function fetchJson<T extends JsonRecord>(
  url: string,
  accessToken: string
): Promise<JsonApiSuccess<T>> {
  const response = await fetch(url, {
    method: 'GET',
    headers: buildEigenFluxRequestHeaders(accessToken),
  });

  if (response.status === 401) {
    throw new Error('HTTP 401: unauthorized');
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const payload = (await response.json()) as JsonApiSuccess<T>;
  if (payload.code !== 0) {
    throw new Error(`API error: ${payload.msg}`);
  }
  return payload;
}

function buildAuthStatusText(
  serverConfig: ResolvedEigenFluxServerConfig,
  authState: AuthState
): string {
  const lines = [`EigenFlux auth status (server=${serverConfig.name}):`];
  lines.push(`- workdir: ${serverConfig.workdir}`);
  lines.push(`- credentials_path: ${authState.credentialsPath}`);
  lines.push(`- status: ${authState.status}`);
  if (authState.source) {
    lines.push(`- source: ${authState.source}`);
  }
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

function buildAuthRequiredMessage(
  promptContext: EigenFluxPromptServerContext,
  { authEvent, authState }: AuthPromptContext
): string {
  return buildAuthRequiredPromptTemplate({
    ...promptContext,
    authEvent,
    maskedToken: authState?.status === 'available' ? maskToken(authState.accessToken) : undefined,
  });
}

function buildFeedPayloadMessage(
  promptContext: EigenFluxPromptServerContext,
  payload: FeedResponse
): string {
  return buildFeedPayloadPromptTemplate(payload, promptContext);
}

function buildPmPayloadMessage(
  promptContext: EigenFluxPromptServerContext,
  payload: PmFetchResponse
): string {
  return buildPmPayloadPromptTemplate(payload, promptContext);
}

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

function toServiceIdSegment(name: string): string {
  const sanitized = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-');
  return sanitized || 'default';
}
