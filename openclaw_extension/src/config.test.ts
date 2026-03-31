import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  PLUGIN_CONFIG,
  resolvePluginConfig,
  resolveServerSkillPath,
} from './config';

describe('resolvePluginConfig', () => {
  test('prepends the default eigenflux server when servers is omitted', () => {
    const config = resolvePluginConfig({});

    expect(config.gatewayUrl).toBe(PLUGIN_CONFIG.DEFAULT_GATEWAY_URL);
    expect(config.openclawCliBin).toBe(PLUGIN_CONFIG.DEFAULT_OPENCLAW_CLI_BIN);
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0]).toEqual({
      enabled: true,
      name: 'eigenflux',
      endpoint: PLUGIN_CONFIG.DEFAULT_ENDPOINT,
      workdir: path.join(os.homedir(), '.openclaw/eigenflux'),
      pollIntervalSec: PLUGIN_CONFIG.DEFAULT_POLL_INTERVAL_SEC,
      pmPollIntervalSec: PLUGIN_CONFIG.DEFAULT_PM_POLL_INTERVAL_SEC,
      sessionKey: PLUGIN_CONFIG.DEFAULT_SESSION_KEY,
      agentId: PLUGIN_CONFIG.DEFAULT_AGENT_ID,
      replyChannel: undefined,
      replyTo: undefined,
      replyAccountId: undefined,
      routeOverrides: {
        sessionKey: false,
        agentId: false,
        replyChannel: false,
        replyTo: false,
        replyAccountId: false,
      },
    });
  });

  test('prepends the default eigenflux server when no explicit eigenflux server exists', () => {
    const config = resolvePluginConfig({
      gatewayUrl: 'ws://127.0.0.1:29999',
      openclawCliBin: '/opt/bin/openclaw',
      servers: [
        {
          name: 'alpha',
          endpoint: 'https://alpha.example.com',
          workdir: '~/custom/alpha',
          pollInterval: 45,
          pmPollInterval: 30,
          sessionKey: 'agent:ops:feishu:direct:ou_alpha',
        },
      ],
    });

    expect(config.gatewayUrl).toBe('ws://127.0.0.1:29999');
    expect(config.openclawCliBin).toBe('/opt/bin/openclaw');
    expect(config.servers).toHaveLength(2);
    expect(config.servers[0]).toEqual(
      expect.objectContaining({
        name: 'eigenflux',
        endpoint: PLUGIN_CONFIG.DEFAULT_ENDPOINT,
        workdir: path.join(os.homedir(), '.openclaw/eigenflux'),
      })
    );
    expect(config.servers[1]).toEqual({
      enabled: true,
      name: 'alpha',
      endpoint: 'https://alpha.example.com',
      workdir: path.join(os.homedir(), 'custom/alpha'),
      pollIntervalSec: 45,
      pmPollIntervalSec: 30,
      sessionKey: 'agent:ops:feishu:direct:ou_alpha',
      agentId: 'ops',
      replyChannel: 'feishu',
      replyTo: 'ou_alpha',
      replyAccountId: undefined,
      routeOverrides: {
        sessionKey: true,
        agentId: false,
        replyChannel: false,
        replyTo: false,
        replyAccountId: false,
      },
    });
  });

  test('does not prepend another default server when eigenflux is explicitly configured', () => {
    const config = resolvePluginConfig({
      servers: [
        {
          name: 'eigenflux',
          workdir: '~/custom/eigenflux',
          pollInterval: 15,
        },
        {
          name: 'alpha',
          endpoint: 'https://alpha.example.com',
        },
      ],
    });

    expect(config.servers).toHaveLength(2);
    expect(config.servers[0]).toEqual(
      expect.objectContaining({
        name: 'eigenflux',
        endpoint: 'https://www.eigenflux.ai',
        workdir: path.join(os.homedir(), 'custom/eigenflux'),
        pollIntervalSec: 15,
      })
    );
    expect(config.servers[1]).toEqual(
      expect.objectContaining({
        name: 'alpha',
        endpoint: 'https://alpha.example.com',
      })
    );
  });

  test('creates unique names when duplicate server names are configured', () => {
    const config = resolvePluginConfig({
      servers: [{ name: 'eigenflux' }, { name: 'eigenflux' }, {}],
    });

    expect(config.servers.map((server) => server.name)).toEqual([
      'eigenflux',
      'eigenflux-2',
      'server-3',
    ]);
    expect(config.servers[2].workdir).toBe(path.join(os.homedir(), '.openclaw/server-3'));
  });

  test('uses gateway auth token from host config when plugin config omits it', () => {
    const config = resolvePluginConfig(
      {
        servers: [{ name: 'eigenflux' }],
      },
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
});

describe('resolveServerSkillPath', () => {
  test('prefers local workdir skill.md when it exists', () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-skill-path-'));
    const localSkillPath = path.join(workdir, 'skill.md');
    fs.writeFileSync(localSkillPath, '# local skill\n', 'utf-8');

    expect(
      resolveServerSkillPath({
        endpoint: 'https://example.com/root',
        workdir,
      })
    ).toBe(localSkillPath);

    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('falls back to endpoint skill.md when local file is absent', () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-skill-path-'));

    expect(
      resolveServerSkillPath({
        endpoint: 'https://example.com/root',
        workdir,
      })
    ).toBe('https://example.com/root/skill.md');

    fs.rmSync(workdir, { recursive: true, force: true });
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
