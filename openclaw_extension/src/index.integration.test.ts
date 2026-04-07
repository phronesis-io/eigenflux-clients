import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import http from 'http';
import { WebSocketServer } from 'ws';

const packageManifest = require('../package.json') as { version: string };

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('condition wait timeout'));
      }
    }, 50);
  });
}

describe('register integration', () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let workdir: string;

  let apiHttpServer: http.Server;
  let apiPort: number;
  let apiRequestCount: number;
  let apiAuthHeader: string | undefined;
  let apiUserAgentHeader: string | undefined;
  let apiPluginVersionHeader: string | undefined;
  let apiHostKindHeader: string | undefined;
  let apiFeedItems: Array<{
    item_id: string;
    group_id?: string;
    broadcast_type: string;
    updated_at: number;
  }>;

  let gatewayHttpServer: http.Server;
  let gatewayWss: WebSocketServer;
  let gatewayPort: number;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-openclaw-home-'));
    process.env.HOME = homeDir;
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-openclaw-workdir-'));
    fs.writeFileSync(
      path.join(workdir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_integration_token' }),
      'utf-8'
    );

    apiRequestCount = 0;
    apiAuthHeader = undefined;
    apiUserAgentHeader = undefined;
    apiPluginVersionHeader = undefined;
    apiHostKindHeader = undefined;
    apiFeedItems = [
      {
        item_id: '501',
        group_id: 'group-int-1',
        broadcast_type: 'info',
        updated_at: 1760000000000,
      },
    ];
    apiHttpServer = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/v1/items/feed')) {
        apiRequestCount++;
        apiAuthHeader = req.headers.authorization;
        apiUserAgentHeader = req.headers['user-agent'];
        apiPluginVersionHeader = readHeaderValue(req.headers['x-plugin-ver']);
        apiHostKindHeader = readHeaderValue(req.headers['x-host-kind']);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            code: 0,
            msg: 'success',
            data: {
              items: apiFeedItems,
              has_more: false,
              notifications: [],
            },
          })
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      apiHttpServer.listen(0, '127.0.0.1', () => {
        apiPort = (apiHttpServer.address() as any).port;
        resolve();
      });
    });

    gatewayHttpServer = http.createServer();
    gatewayWss = new WebSocketServer({ server: gatewayHttpServer });
    await new Promise<void>((resolve) => {
      gatewayHttpServer.listen(0, '127.0.0.1', () => {
        gatewayPort = (gatewayHttpServer.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
    await new Promise<void>((resolve) => apiHttpServer.close(() => resolve()));
    await new Promise<void>((resolve) => gatewayWss.close(() => resolve()));
    await new Promise<void>((resolve) => gatewayHttpServer.close(() => resolve()));
  });

  test('falls back to gateway rpc agent when polling feed returns new items', async () => {
    jest.resetModules();
    const sessionStorePath = path.join(
      homeDir,
      '.openclaw',
      'agents',
      'main',
      'sessions',
      'sessions.json'
    );
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const gatewayMethods: string[] = [];
    const agentParams: any[] = [];

    gatewayWss.on('connection', (socket) => {
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'nonce-integration' },
        })
      );

      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        gatewayMethods.push(String(frame.method || ''));

        if (frame.type !== 'req') {
          return;
        }

        if (frame.method === 'connect') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: {
                type: 'hello-ok',
                protocol: 3,
                server: { version: 'test', connId: 'conn-test' },
                features: { methods: ['agent'], events: [] },
                snapshot: { ts: Date.now() },
                policy: { maxPayload: 1000000, maxBufferedBytes: 1000000, tickIntervalMs: 30000 },
              },
            })
          );
          return;
        }

        if (frame.method === 'agent') {
          agentParams.push(frame.params);
          socket.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: {
                runId: 'run-integration-1',
                status: 'started',
              },
            })
          );
        }
      });
    });

    plugin.register({
      config: {
        gateway: {
          auth: {
            token: 'gw_test_token',
          },
        },
      },
      pluginConfig: {
        gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
        servers: [
          {
            name: 'eigenflux',
            endpoint: `http://127.0.0.1:${apiPort}`,
            workdir,
            pollInterval: 60,
            sessionStorePath,
          },
        ],
      },
      runtime: {},
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => {
        services.push(service);
      },
    } as any);

    expect(services).toHaveLength(1);
    await services[0].start();
    await waitFor(() => agentParams.length === 1);

    expect(apiRequestCount).toBeGreaterThanOrEqual(1);
    expect(apiAuthHeader).toBe('Bearer at_integration_token');
    expect(apiUserAgentHeader).toContain('node/');
    expect(apiUserAgentHeader).not.toContain('eigenflux-plugin');
    expect(apiPluginVersionHeader).toBe(packageManifest.version);
    expect(apiHostKindHeader).toBe('openclaw');
    expect(gatewayMethods).toEqual(['connect', 'agent']);
    expect(agentParams[0]).toEqual(
      expect.objectContaining({
        agentId: 'main',
        sessionKey: 'main',
        message: expect.stringContaining('[EIGENFLUX_FEED_PAYLOAD]'),
        deliver: true,
      })
    );
    expect(String(agentParams[0].message)).toContain('"item_id": "501"');
    expect(String(agentParams[0].message)).toContain('"group_id": "group-int-1"');
    expect(String(agentParams[0].message)).toContain('network=eigenflux');
    expect(String(agentParams[0].message)).toContain(`workdir=${workdir}`);
    expect(String(agentParams[0].message)).toContain(
      `skill_file=http://127.0.0.1:${apiPort}/skill.md`
    );
    expect(String(agentParams[0].message)).toContain(
      `Read http://127.0.0.1:${apiPort}/references/feed.md and follow the skill to process feed payload.`
    );
    expect(typeof agentParams[0].idempotencyKey).toBe('string');
    expect(agentParams[0].idempotencyKey.length).toBeGreaterThan(0);

    await services[0].stop();
  });

  test('dispatches the entire feed payload in a single gateway agent message', async () => {
    apiFeedItems = [
      {
        item_id: '601',
        group_id: 'group-dup-1',
        broadcast_type: 'info',
        updated_at: 1760000000100,
      },
      {
        item_id: '602',
        group_id: 'group-dup-1',
        broadcast_type: 'info',
        updated_at: 1760000000200,
      },
    ];

    jest.resetModules();
    const sessionStorePath = path.join(
      homeDir,
      '.openclaw',
      'agents',
      'main',
      'sessions',
      'sessions.json'
    );
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const agentParams: any[] = [];

    gatewayWss.on('connection', (socket) => {
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'nonce-duplicate-group' },
        })
      );

      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type !== 'req') {
          return;
        }

        if (frame.method === 'connect') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: {
                type: 'hello-ok',
                protocol: 3,
                server: { version: 'test', connId: 'conn-dup' },
                features: { methods: ['agent'], events: [] },
                snapshot: { ts: Date.now() },
                policy: { maxPayload: 1000000, maxBufferedBytes: 1000000, tickIntervalMs: 30000 },
              },
            })
          );
          return;
        }

        if (frame.method === 'agent') {
          agentParams.push(frame.params);
          socket.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: {
                runId: `run-dup-${agentParams.length}`,
                status: 'started',
              },
            })
          );
        }
      });
    });

    plugin.register({
      config: {
        gateway: {
          auth: {
            token: 'gw_test_token',
          },
        },
      },
      pluginConfig: {
        gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
        servers: [
          {
            name: 'eigenflux',
            endpoint: `http://127.0.0.1:${apiPort}`,
            workdir,
            pollInterval: 60,
            sessionStorePath,
          },
        ],
      },
      runtime: {},
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => {
        services.push(service);
      },
    } as any);

    expect(services).toHaveLength(1);
    await services[0].start();
    await waitFor(() => agentParams.length === 1);

    expect(agentParams).toHaveLength(1);
    expect(String(agentParams[0].message)).toContain('"item_id": "601"');
    expect(String(agentParams[0].message)).toContain('"item_id": "602"');
    expect(String(agentParams[0].message)).toContain('"group_id": "group-dup-1"');

    await services[0].stop();
  });

  test('routes mocked feed notifications to the freshest external session for runtime.subagent', async () => {
    jest.resetModules();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-home-'));
    const sessionStoreDir = path.join(homeDir, '.openclaw', 'agents', 'main', 'sessions');
    fs.mkdirSync(sessionStoreDir, { recursive: true });
    const sessionStorePath = path.join(sessionStoreDir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 100,
          deliveryContext: {
            channel: 'webchat',
          },
        },
        'agent:main:feishu:direct:ou_feed_target': {
          updatedAt: 200,
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_feed_target',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-subagent-feed' });

    plugin.register({
      config: {},
      pluginConfig: {
        servers: [
          {
            name: 'eigenflux',
            endpoint: `http://127.0.0.1:${apiPort}`,
            workdir,
            pollInterval: 60,
            sessionStorePath,
          },
        ],
      },
      runtime: {
        subagent: {
          run: subagentRun,
        },
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => {
        services.push(service);
      },
    } as any);

    expect(services).toHaveLength(1);
    await services[0].start();
    await waitFor(() => subagentRun.mock.calls.length === 1);

    expect(subagentRun).toHaveBeenCalledWith({
      sessionKey: 'agent:main:feishu:direct:ou_feed_target',
      message: expect.stringContaining('[EIGENFLUX_FEED_PAYLOAD]'),
      deliver: true,
      idempotencyKey: expect.any(String),
    });
    expect(String(subagentRun.mock.calls[0]?.[0]?.message)).toContain('"item_id": "501"');

    await services[0].stop();
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
});
