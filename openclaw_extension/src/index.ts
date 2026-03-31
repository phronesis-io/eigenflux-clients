import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

import {
  EigenFluxPollingClient,
  AuthRequiredEvent,
  FeedResponse,
} from './polling-client';
import { EigenFluxPmPollingClient, PmFetchResponse } from './pm-polling-client';
import { Logger } from './logger';
import { AuthState, CredentialsLoader } from './credentials-loader';
import { PLUGIN_CONFIG, PLUGIN_CONFIG_SCHEMA, resolvePluginConfig } from './config';
import { resolveNotificationRoute } from './notification-route-resolver';
import {
  buildAuthRequiredPromptTemplate,
  buildFeedPayloadPromptTemplate,
  buildPmPayloadPromptTemplate,
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

function register(api: OpenClawPluginApi): void {
  const logger = new Logger(api.logger);
  logger.info('EigenFlux activating...');

  const pluginConfig = resolvePluginConfig(api.pluginConfig, api.config as any);
  if (!pluginConfig.enabled) {
    logger.info('EigenFlux is disabled in configuration');
    return;
  }

  const credentialsLoader = new CredentialsLoader(logger, pluginConfig.workdir);
  const notifier = new EigenFluxNotifier(api, logger, {
    gatewayUrl: pluginConfig.gatewayUrl,
    gatewayToken: pluginConfig.gatewayToken,
    workdir: pluginConfig.workdir,
    sessionKey: pluginConfig.sessionKey,
    agentId: pluginConfig.agentId,
    replyChannel: pluginConfig.replyChannel,
    replyTo: pluginConfig.replyTo,
    replyAccountId: pluginConfig.replyAccountId,
    openclawCliBin: pluginConfig.openclawCliBin,
    sessionStorePath: pluginConfig.sessionStorePath,
    routeOverrides: pluginConfig.routeOverrides,
  });

  if (!pluginConfig.gatewayToken) {
    logger.warn(
      'OpenClaw gateway token not found in config.gateway.auth.token or plugin config; Gateway RPC fallback may fail when gateway auth mode is token'
    );
  }

  let lastAuthPromptKey: string | null = null;

  const resetAuthPromptGate = (): void => {
    lastAuthPromptKey = null;
  };

  const notifyAuthRequired = async (authEvent: AuthRequiredEvent): Promise<void> => {
    const promptKey = `${authEvent.reason}:${authEvent.credentialsPath}:${authEvent.source || 'unknown'}`;
    if (lastAuthPromptKey === promptKey) {
      logger.debug(`Skipping duplicate auth prompt for key=${promptKey}`);
      return;
    }
    lastAuthPromptKey = promptKey;
    const authState = credentialsLoader.loadAuthState();
    await notifier.deliver(buildAuthRequiredMessage({ authEvent, authState }));
  };

  const pollingClient = new EigenFluxPollingClient({
    apiUrl: pluginConfig.endpoint,
    getAuthState: () => credentialsLoader.loadAuthState(),
    pollIntervalSec: pluginConfig.pollIntervalSec,
    logger,
    onFeedPolled: async (payload: FeedResponse) => {
      resetAuthPromptGate();
      await notifier.deliver(buildFeedPayloadMessage(payload));
    },
    onAuthRequired: notifyAuthRequired,
  });

  const pmPollingClient = new EigenFluxPmPollingClient({
    apiUrl: pluginConfig.endpoint,
    getAuthState: () => credentialsLoader.loadAuthState(),
    pollIntervalSec: pluginConfig.pmPollIntervalSec,
    logger,
    onPmFetched: async (payload: PmFetchResponse) => {
      resetAuthPromptGate();
      await notifier.deliver(buildPmPayloadMessage(payload));
    },
    onAuthRequired: notifyAuthRequired,
  });

  registerService(api, logger, pollingClient, pmPollingClient);
  registerCommand(
    api,
    logger,
    credentialsLoader,
    pollingClient,
    pmPollingClient,
    pluginConfig.endpoint,
    notifier,
    pluginConfig
  );

  logger.info('EigenFlux activated');
}

const plugin = {
  id: 'eigenflux',
  name: 'EigenFlux',
  description: 'OpenClaw extension for EigenFlux periodic polling with subagent delivery',
  configSchema: PLUGIN_CONFIG_SCHEMA,
  register,
};

export default plugin;

function registerService(
  api: OpenClawPluginApi,
  logger: Logger,
  pollingClient: EigenFluxPollingClient,
  pmPollingClient: EigenFluxPmPollingClient
): void {
  api.registerService({
    id: 'eigenflux',
    start: async () => {
      logger.info('Starting EigenFlux polling services...');
      await pollingClient.start();
      await pmPollingClient.start();
    },
    stop: async () => {
      logger.info('Stopping EigenFlux polling services...');
      pollingClient.stop();
      pmPollingClient.stop();
    },
  });
}

function registerCommand(
  api: OpenClawPluginApi,
  logger: Logger,
  credentialsLoader: CredentialsLoader,
  pollingClient: EigenFluxPollingClient,
  pmPollingClient: EigenFluxPmPollingClient,
  apiUrl: string,
  notifier: EigenFluxNotifier,
  pluginConfig: ReturnType<typeof resolvePluginConfig>
): void {
  if (!api.registerCommand) {
    logger.warn('registerCommand API unavailable; skipping /eigenflux command registration');
    return;
  }

  api.registerCommand({
    name: 'eigenflux',
    description: 'EigenFlux plugin commands: auth, profile, poll, pm',
    acceptsArgs: true,
    handler: async (ctx) => {
      await rememberCurrentCommandRouteIfPossible(ctx, pluginConfig, logger);
      const command = firstArg(ctx.args);
      switch (command) {
        case 'auth':
          return {
            text: buildAuthStatusText(credentialsLoader.loadAuthState()),
          };
        case 'profile':
          return {
            text: await buildProfileText(credentialsLoader.loadAuthState(), apiUrl),
          };
        case 'poll':
          return {
            text: await buildPollText(pollingClient, credentialsLoader.loadAuthState()),
          };
        case 'pm':
          return {
            text: await buildPmPollText(pmPollingClient, credentialsLoader.loadAuthState()),
          };
        case 'sendwithsubagent':
          return {
            text: await buildSendWithSubagentText(
              notifier,
              commandRest(ctx.args),
              'sendwithsubagent'
            ),
          };
        case 'here':
          return {
            text: await buildHereText(ctx, pluginConfig, logger),
          };
        default:
          return {
            text: [
              'Usage: /eigenflux <auth|profile|poll|pm|here|sendwithsubagent>',
              '',
              '/eigenflux auth',
              'Show current EigenFlux credential status.',
              '',
              '/eigenflux profile',
              'Fetch /api/v1/agents/me with the current access token.',
              '',
              '/eigenflux poll',
              'Run one feed refresh and return the raw feed payload.',
              '',
              '/eigenflux pm',
              'Run one PM fetch and return the raw PM payload.',
              '',
              '/eigenflux here',
              'Remember the current conversation as the default EigenFlux delivery route.',
              '',
              '/eigenflux sendwithsubagent <message>',
              'Send a test message only through runtime.subagent.',
            ].join('\n'),
          };
      }
    },
  });
}

function firstArg(args: string | undefined): string {
  return args?.trim().split(/\s+/, 1)[0]?.toLowerCase() || '';
}

function commandRest(args: string | undefined): string {
  const trimmed = args?.trim() || '';
  if (!trimmed) {
    return '';
  }
  const firstSpace = trimmed.indexOf(' ');
  return firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();
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
  ctx: {
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
  },
  pluginConfig: ReturnType<typeof resolvePluginConfig>,
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
      agentId: pluginConfig.agentId,
      replyChannel,
      replyTo,
      replyAccountId,
      sessionStorePath: pluginConfig.sessionStorePath,
      workdir: pluginConfig.workdir,
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

  return route;
}

async function buildHereText(
  ctx: {
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
  },
  pluginConfig: ReturnType<typeof resolvePluginConfig>,
  logger: Logger
): Promise<string> {
  const route = await resolveCurrentCommandRoute(ctx, pluginConfig, logger);
  if (!route || route.sessionKey === 'main' || route.sessionKey.endsWith(':main')) {
    return [
      'Unable to resolve the current external session.',
      'Run `/eigenflux here` inside the target conversation after OpenClaw has already created a session for it.',
    ].join('\n');
  }

  const saved = writeStoredNotificationRoute(pluginConfig.workdir, route, logger);
  if (!saved) {
    return 'Failed to persist the current EigenFlux route; check plugin logs for details.';
  }

  return [
    'EigenFlux will deliver to this conversation by default:',
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
  ctx: {
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
  },
  pluginConfig: ReturnType<typeof resolvePluginConfig>,
  logger: Logger
): Promise<void> {
  const route = await resolveCurrentCommandRoute(ctx, pluginConfig, logger);
  if (!route || route.sessionKey === 'main' || route.sessionKey.endsWith(':main')) {
    return;
  }

  if (
    writeStoredNotificationRoute(pluginConfig.workdir, route, logger)
  ) {
    logger.debug(
      `Remembered current command route: session_key=${route.sessionKey}, channel=${route.replyChannel ?? 'unknown'}, to=${route.replyTo ?? 'unknown'}`
    );
  }
}

async function buildProfileText(authState: AuthState, apiUrl: string): Promise<string> {
  if (authState.status !== 'available') {
    return buildAuthRequiredMessage({
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
      `${apiUrl}/api/v1/agents/me`,
      authState.accessToken
    );
    return [
      'EigenFlux profile:',
      '```json',
      safeJsonStringify(payload),
      '```',
    ].join('\n');
  } catch (error) {
    return `Failed to fetch profile: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function buildPollText(
  pollingClient: EigenFluxPollingClient,
  authState: AuthState
): Promise<string> {
  const result = await pollingClient.pollOnce({
    notifyFeed: false,
    notifyAuthRequired: false,
  });
  switch (result.kind) {
    case 'success':
      return [
        'EigenFlux poll result:',
        '```json',
        safeJsonStringify(result.payload),
        '```',
      ].join('\n');
    case 'auth_required':
      return buildAuthRequiredMessage({
        authEvent: result.authEvent,
        authState,
      });
    case 'error':
      return `EigenFlux poll failed: ${result.error.message}`;
    default:
      return 'EigenFlux poll finished with an unknown result.';
  }
}

async function buildPmPollText(
  pmPollingClient: EigenFluxPmPollingClient,
  authState: AuthState
): Promise<string> {
  const result = await pmPollingClient.pollOnce({
    notifyFeed: false,
    notifyAuthRequired: false,
  });
  switch (result.kind) {
    case 'success':
      return [
        'EigenFlux PM poll result:',
        '```json',
        safeJsonStringify(result.payload),
        '```',
      ].join('\n');
    case 'auth_required':
      return buildAuthRequiredMessage({
        authEvent: result.authEvent,
        authState,
      });
    case 'error':
      return `EigenFlux PM poll failed: ${result.error.message}`;
    default:
      return 'EigenFlux PM poll finished with an unknown result.';
  }
}

async function buildSendWithSubagentText(
  notifier: EigenFluxNotifier,
  rawArgs: string,
  commandName: string
): Promise<string> {
  const message = rawArgs.trim();
  if (!message) {
    return `Usage: /eigenflux ${commandName} <message>`;
  }

  const delivered = await notifier.deliverWithSubagent(message);
  return delivered
    ? `runtime.subagent dispatched: ${message}`
    : 'runtime.subagent dispatch failed; check plugin logs for details.';
}

async function fetchJson<T extends JsonRecord>(
  url: string,
  accessToken: string
): Promise<JsonApiSuccess<T>> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': PLUGIN_CONFIG.USER_AGENT,
    },
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

function buildAuthStatusText(authState: AuthState): string {
  const lines = ['EigenFlux auth status:'];
  lines.push(`- status: ${authState.status}`);
  lines.push(`- credentials_path: ${authState.credentialsPath}`);
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

function buildAuthRequiredMessage({ authEvent, authState }: AuthPromptContext): string {
  return buildAuthRequiredPromptTemplate({
    authEvent,
    maskedToken: authState?.status === 'available' ? maskToken(authState.accessToken) : undefined,
  });
}

function buildFeedPayloadMessage(payload: FeedResponse): string {
  return buildFeedPayloadPromptTemplate(payload);
}

function buildPmPayloadMessage(payload: PmFetchResponse): string {
  return buildPmPayloadPromptTemplate(payload);
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
