import * as os from 'os';
import * as path from 'path';

import { PLUGIN_CONFIG, resolvePluginConfig } from './config';

describe('resolvePluginConfig', () => {
  test('reads runtime settings from plugin config', () => {
    const config = resolvePluginConfig({
      endpoint: 'https://example.com',
      workdir: '~/custom/eigenflux',
      pollInterval: 45,
      pmPollInterval: 30,
      gatewayUrl: 'ws://127.0.0.1:29999',
      sessionKey: 'agent:main:main',
      gatewayToken: 'gw_plugin_token',
    });

    expect(config).toEqual({
      enabled: true,
      endpoint: 'https://example.com',
      workdir: path.join(os.homedir(), 'custom/eigenflux'),
      pollIntervalSec: 45,
      pmPollIntervalSec: 30,
      gatewayUrl: 'ws://127.0.0.1:29999',
      sessionKey: 'agent:main:main',
      gatewayToken: 'gw_plugin_token',
      agentId: 'main',
      replyChannel: undefined,
      replyTo: undefined,
      replyAccountId: undefined,
      openclawCliBin: 'openclaw',
      sessionStorePath: undefined,
      routeOverrides: {
        sessionKey: true,
        agentId: false,
        replyChannel: false,
        replyTo: false,
        replyAccountId: false,
      },
    });
  });

  test('falls back to defaults for invalid values', () => {
    const config = resolvePluginConfig({
      pollInterval: 0,
      pmPollInterval: 'bad',
      endpoint: '   ',
    });

    expect(config.endpoint).toBe(PLUGIN_CONFIG.DEFAULT_ENDPOINT);
    expect(config.workdir).toBe(path.join(os.homedir(), '.openclaw/eigenflux'));
    expect(config.pollIntervalSec).toBe(PLUGIN_CONFIG.DEFAULT_POLL_INTERVAL_SEC);
    expect(config.pmPollIntervalSec).toBe(PLUGIN_CONFIG.DEFAULT_PM_POLL_INTERVAL_SEC);
    expect(config.gatewayUrl).toBe(PLUGIN_CONFIG.DEFAULT_GATEWAY_URL);
    expect(config.sessionKey).toBe(PLUGIN_CONFIG.DEFAULT_SESSION_KEY);
    expect(config.agentId).toBe(PLUGIN_CONFIG.DEFAULT_AGENT_ID);
    expect(config.openclawCliBin).toBe(PLUGIN_CONFIG.DEFAULT_OPENCLAW_CLI_BIN);
    expect(config.routeOverrides).toEqual({
      sessionKey: false,
      agentId: false,
      replyChannel: false,
      replyTo: false,
      replyAccountId: false,
    });
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

  test('derives agent and reply route from a channel-scoped session key', () => {
    const config = resolvePluginConfig({
      sessionKey: 'agent:main:feishu:direct:ou_2c1e5b60963ed271ea8ea5db9f4b1440',
    });

    expect(config.agentId).toBe('main');
    expect(config.replyChannel).toBe('feishu');
    expect(config.replyTo).toBe('ou_2c1e5b60963ed271ea8ea5db9f4b1440');
    expect(config.replyAccountId).toBeUndefined();
  });

  test('derives account-scoped reply route from a session key when available', () => {
    const config = resolvePluginConfig({
      sessionKey: 'agent:ops:telegram:primary:direct:123456',
    });

    expect(config.agentId).toBe('ops');
    expect(config.replyChannel).toBe('telegram');
    expect(config.replyAccountId).toBe('primary');
    expect(config.replyTo).toBe('123456');
  });
});

describe('PLUGIN_CONFIG USER_AGENT', () => {
  test('includes eigenflux plugin version', () => {
    expect(PLUGIN_CONFIG.USER_AGENT).toContain('eigenflux-plugin');
    expect(PLUGIN_CONFIG.USER_AGENT).toContain('node/');
    expect(PLUGIN_CONFIG.USER_AGENT).toMatch(/\(.*;\s*.*;\s*.*\)/);
    expect(PLUGIN_CONFIG.PLUGIN_VERSION).toBe('0.0.1-alpha.0');
  });
});
