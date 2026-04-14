import * as os from 'os';

import {
  PLUGIN_CONFIG,
  resolvePluginConfig,
  resolveEigenfluxHome,
} from './config';
import { Logger } from './logger';

const packageManifest = require('../package.json') as { version: string };
const pluginManifest = require('../openclaw.plugin.json') as { version: string };

function createLoggerSpies() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

describe('resolvePluginConfig', () => {
  test('returns defaults when config is empty', () => {
    const config = resolvePluginConfig({});

    expect(config.eigenfluxBin).toBe(PLUGIN_CONFIG.DEFAULT_EIGENFLUX_BIN);
    expect(config.feedPollIntervalSec).toBe(PLUGIN_CONFIG.DEFAULT_FEED_POLL_INTERVAL_SEC);
    expect(config.skills).toEqual(['ef-broadcast', 'ef-communication']);
    expect(config.gatewayUrl).toBe(PLUGIN_CONFIG.DEFAULT_GATEWAY_URL);
    expect(config.openclawCliBin).toBe(PLUGIN_CONFIG.DEFAULT_OPENCLAW_CLI_BIN);
    expect(config.serverRouting).toEqual({});
    expect(config.gatewayToken).toBeUndefined();
  });

  test('uses gateway auth token from host config when plugin config omits it', () => {
    const config = resolvePluginConfig(
      {},
      {
        gateway: {
          auth: {
            token: 'gw_host_token',
          },
        },
      }
    );

    expect(config.gatewayToken).toBe('gw_host_token');
  });

  test('plugin-level gatewayToken overrides host config token', () => {
    const config = resolvePluginConfig(
      { gatewayToken: 'plugin_token' },
      {
        gateway: {
          auth: {
            token: 'gw_host_token',
          },
        },
      }
    );

    expect(config.gatewayToken).toBe('plugin_token');
  });

  test('resolves custom eigenfluxBin and openclawCliBin', () => {
    const config = resolvePluginConfig({
      eigenfluxBin: '/opt/bin/eigenflux',
      openclawCliBin: '/opt/bin/openclaw',
    });

    expect(config.eigenfluxBin).toBe('/opt/bin/eigenflux');
    expect(config.openclawCliBin).toBe('/opt/bin/openclaw');
  });

  test('resolves custom skills array', () => {
    const config = resolvePluginConfig({
      skills: ['ef-broadcast', 'ef-profile', 'custom-skill'],
    });

    expect(config.skills).toEqual(['ef-broadcast', 'ef-profile', 'custom-skill']);
  });

  test('filters out non-string and empty skills entries', () => {
    const config = resolvePluginConfig({
      skills: ['ef-broadcast', '', 42, null, 'ef-communication'] as any,
    });

    expect(config.skills).toEqual(['ef-broadcast', 'ef-communication']);
  });

  test('resolves serverRouting with defaults for missing fields', () => {
    const config = resolvePluginConfig({
      serverRouting: {
        alpha: {
          sessionKey: 'agent:ops:feishu:direct:ou_alpha',
        },
      },
    });

    const routing = config.serverRouting['alpha'];
    expect(routing).toBeDefined();
    expect(routing.sessionKey).toBe('agent:ops:feishu:direct:ou_alpha');
    expect(routing.agentId).toBe('ops');
    expect(routing.replyChannel).toBe('feishu');
    expect(routing.replyTo).toBe('user:ou_alpha');
  });

  test('ignores schema-defaulted main session fields so route discovery stays automatic', () => {
    const config = resolvePluginConfig({
      serverRouting: {
        eigenflux: {
          sessionKey: 'main',
          agentId: 'main',
        },
      },
    });

    const routing = config.serverRouting['eigenflux'];
    expect(routing).toBeDefined();
    expect(routing.routeOverrides).toEqual({
      sessionKey: false,
      agentId: false,
      replyChannel: false,
      replyTo: false,
      replyAccountId: false,
    });
  });

  test('clamps oversized feedPollInterval to one day and logs a warning', () => {
    const loggerSpies = createLoggerSpies();
    const config = resolvePluginConfig(
      { feedPollInterval: 3600000 },
      undefined,
      new Logger(loggerSpies)
    );

    expect(config.feedPollIntervalSec).toBe(PLUGIN_CONFIG.MAX_POLL_INTERVAL_SEC);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('feedPollInterval exceeds 86400s; clamping to 86400s')
    );
  });

  test('clamps undersized feedPollInterval to ten seconds and logs a warning', () => {
    const loggerSpies = createLoggerSpies();
    const config = resolvePluginConfig(
      { feedPollInterval: 1 },
      undefined,
      new Logger(loggerSpies)
    );

    expect(config.feedPollIntervalSec).toBe(PLUGIN_CONFIG.MIN_POLL_INTERVAL_SEC);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('feedPollInterval is below 10s; clamping to 10s')
    );
  });
});

describe('resolveEigenfluxHome', () => {
  const originalEnv = process.env.EIGENFLUX_HOME;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EIGENFLUX_HOME;
    } else {
      process.env.EIGENFLUX_HOME = originalEnv;
    }
  });

  test('defaults to ~/.eigenflux when EIGENFLUX_HOME is not set', () => {
    delete process.env.EIGENFLUX_HOME;

    const home = resolveEigenfluxHome();
    expect(home).toBe(`${os.homedir()}/.eigenflux`);
  });

  test('uses EIGENFLUX_HOME env var with .eigenflux suffix appended', () => {
    process.env.EIGENFLUX_HOME = '/custom/path';

    const home = resolveEigenfluxHome();
    expect(home).toBe('/custom/path/.eigenflux');
  });

  test('does not double-append .eigenflux if already present', () => {
    process.env.EIGENFLUX_HOME = '/custom/path/.eigenflux';

    const home = resolveEigenfluxHome();
    expect(home).toBe('/custom/path/.eigenflux');
  });
});

describe('PLUGIN_CONFIG metadata', () => {
  test('keeps runtime metadata aligned with manifests', () => {
    expect(PLUGIN_CONFIG.PLUGIN_VERSION).toBe(packageManifest.version);
    expect(PLUGIN_CONFIG.PLUGIN_VERSION).toBe(pluginManifest.version);
    expect(PLUGIN_CONFIG.HOST_KIND).toBe('openclaw');
  });

  test('exports expected constant keys', () => {
    expect(PLUGIN_CONFIG.DEFAULT_EIGENFLUX_BIN).toBe('eigenflux');
    expect(PLUGIN_CONFIG.DEFAULT_GATEWAY_URL).toBeDefined();
    expect(PLUGIN_CONFIG.DEFAULT_SESSION_KEY).toBe('main');
    expect(PLUGIN_CONFIG.DEFAULT_AGENT_ID).toBe('main');
    expect(PLUGIN_CONFIG.DEFAULT_FEED_POLL_INTERVAL_SEC).toBeGreaterThan(0);
    expect(PLUGIN_CONFIG.MIN_POLL_INTERVAL_SEC).toBe(10);
    expect(PLUGIN_CONFIG.MAX_POLL_INTERVAL_SEC).toBe(86400);
  });
});
