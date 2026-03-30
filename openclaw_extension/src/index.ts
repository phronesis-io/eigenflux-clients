import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk';

import {
  EigenFluxPollingClient,
  AuthRequiredEvent,
  FeedResponse,
} from './polling-client';
import { EigenFluxPmPollingClient, PmFetchResponse } from './pm-polling-client';
import { Logger } from './logger';
import { AuthState, CredentialsLoader } from './credentials-loader';
import { PLUGIN_CONFIG } from './config';
import { OpenClawAcpClient } from './acp-client';
import {
  buildAuthRequiredPromptTemplate,
  buildFeedPayloadPromptTemplate,
  buildPmPayloadPromptTemplate,
} from './acp-prompt-templates';

interface PluginConfig {
  enabled?: boolean;
}

interface EigenFluxConfig {
  enabled?: boolean;
  gateway?: {
    auth?: {
      token?: string;
    };
  };
}

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

  const pluginConfig = api.config as PluginConfig | undefined;
  if (pluginConfig?.enabled === false) {
    logger.info('EigenFlux is disabled in configuration');
    return;
  }

  const credentialsLoader = new CredentialsLoader(logger);
  const gatewayToken = resolveGatewayToken(api.config);
  const acpClient = new OpenClawAcpClient({
    gatewayUrl: PLUGIN_CONFIG.OPENCLAW_GATEWAY_URL,
    gatewayToken,
    sessionKey: PLUGIN_CONFIG.OPENCLAW_SESSION_KEY,
    logger,
  });

  if (!gatewayToken) {
    logger.warn(
      'OpenClaw gateway token not found in config.gateway.auth.token or environment; ACP send may fail when gateway auth mode is token'
    );
  }

  let lastAuthPromptKey: string | null = null;

  const resetAuthPromptGate = (): void => {
    lastAuthPromptKey = null;
  };

  const sendAcpMessage = async (message: string): Promise<boolean> => {
    try {
      const result = await acpClient.sendMessage(message);
      logger.info(
        `ACP chat.send dispatched: session_key=${result.sessionKey}, run_id=${result.runId}`
      );
      return true;
    } catch (error) {
      logger.error(
        `Failed to send ACP notification: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  };

  const notifyAuthRequired = async (authEvent: AuthRequiredEvent): Promise<void> => {
    const promptKey = `${authEvent.reason}:${authEvent.credentialsPath}:${authEvent.source || 'unknown'}`;
    if (lastAuthPromptKey === promptKey) {
      logger.debug(`Skipping duplicate auth prompt for key=${promptKey}`);
      return;
    }
    lastAuthPromptKey = promptKey;
    const authState = credentialsLoader.loadAuthState();
    await sendAcpMessage(buildAuthRequiredMessage({ authEvent, authState }));
  };

  const pollingClient = new EigenFluxPollingClient({
    apiUrl: PLUGIN_CONFIG.API_URL,
    getAuthState: () => credentialsLoader.loadAuthState(),
    pollIntervalSec: PLUGIN_CONFIG.POLL_INTERVAL_SEC,
    logger,
    onFeedPolled: async (payload: FeedResponse) => {
      resetAuthPromptGate();
      await sendAcpMessage(buildFeedPayloadMessage(payload));
    },
    onAuthRequired: notifyAuthRequired,
  });

  const pmPollingClient = new EigenFluxPmPollingClient({
    apiUrl: PLUGIN_CONFIG.API_URL,
    getAuthState: () => credentialsLoader.loadAuthState(),
    pollIntervalSec: PLUGIN_CONFIG.PM_POLL_INTERVAL_SEC,
    logger,
    onPmFetched: async (payload: PmFetchResponse) => {
      resetAuthPromptGate();
      await sendAcpMessage(buildPmPayloadMessage(payload));
    },
    onAuthRequired: notifyAuthRequired,
  });

  registerService(api, logger, pollingClient, pmPollingClient);
  registerCommand(api, logger, credentialsLoader, pollingClient, pmPollingClient);

  logger.info('EigenFlux activated');
}

const plugin = {
  id: 'eigenflux',
  name: 'EigenFlux',
  description: 'OpenClaw extension for EigenFlux periodic polling and ACP delivery',
  configSchema: emptyPluginConfigSchema(),
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
  pmPollingClient: EigenFluxPmPollingClient
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
      const command = firstArg(ctx.args);
      switch (command) {
        case 'auth':
          return {
            text: buildAuthStatusText(credentialsLoader.loadAuthState()),
          };
        case 'profile':
          return {
            text: await buildProfileText(credentialsLoader.loadAuthState()),
          };
        case 'poll':
          return {
            text: await buildPollText(pollingClient, credentialsLoader.loadAuthState()),
          };
        case 'pm':
          return {
            text: await buildPmPollText(pmPollingClient, credentialsLoader.loadAuthState()),
          };
        default:
          return {
            text: [
              'Usage: /eigenflux <auth|profile|poll|pm>',
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
            ].join('\n'),
          };
      }
    },
  });
}

function firstArg(args: string | undefined): string {
  return args?.trim().split(/\s+/, 1)[0]?.toLowerCase() || '';
}

async function buildProfileText(authState: AuthState): Promise<string> {
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
      `${PLUGIN_CONFIG.API_URL}/api/v1/agents/me`,
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

function resolveGatewayToken(config: EigenFluxConfig | undefined): string | undefined {
  const fromConfig = typeof config?.gateway?.auth?.token === 'string'
    ? config.gateway.auth.token.trim()
    : '';
  if (fromConfig) {
    return fromConfig;
  }

  for (const key of PLUGIN_CONFIG.GATEWAY_TOKEN_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}
