import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import http from 'http';
import { WebSocketServer } from 'ws';

jest.mock(
  'openclaw/plugin-sdk',
  () => ({
    emptyPluginConfigSchema: () => ({
      type: 'object',
      additionalProperties: false,
      properties: {},
    }),
  }),
  { virtual: true }
);

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
  let originalApiUrl: string | undefined;
  let originalOpenClawHome: string | undefined;
  let originalGatewayUrl: string | undefined;
  let originalGatewayToken: string | undefined;
  let originalPollInterval: string | undefined;
  let openClawHome: string;

  let apiHttpServer: http.Server;
  let apiPort: number;
  let apiRequestCount: number;
  let apiAuthHeader: string | undefined;
  let apiUserAgentHeader: string | undefined;
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
    originalApiUrl = process.env.EIGENFLUX_API_URL;
    originalOpenClawHome = process.env.OPENCLAW_HOME;
    originalGatewayUrl = process.env.EIGENFLUX_OPENCLAW_GATEWAY_URL;
    originalGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    originalPollInterval = process.env.EIGENFLUX_POLL_INTERVAL;

    openClawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-openclaw-home-'));
    process.env.OPENCLAW_HOME = openClawHome;
    process.env.EIGENFLUX_POLL_INTERVAL = '60';

    const credentialsDir = path.join(openClawHome, 'eigenflux');
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialsDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_integration_token' }),
      'utf-8'
    );

    apiRequestCount = 0;
    apiAuthHeader = undefined;
    apiUserAgentHeader = undefined;
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
        process.env.EIGENFLUX_API_URL = `http://127.0.0.1:${apiPort}`;
        resolve();
      });
    });

    gatewayHttpServer = http.createServer();
    gatewayWss = new WebSocketServer({ server: gatewayHttpServer });
    await new Promise<void>((resolve) => {
      gatewayHttpServer.listen(0, '127.0.0.1', () => {
        gatewayPort = (gatewayHttpServer.address() as any).port;
        process.env.EIGENFLUX_OPENCLAW_GATEWAY_URL = `ws://127.0.0.1:${gatewayPort}`;
        process.env.OPENCLAW_GATEWAY_TOKEN = 'gw_test_token';
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (originalApiUrl === undefined) {
      delete process.env.EIGENFLUX_API_URL;
    } else {
      process.env.EIGENFLUX_API_URL = originalApiUrl;
    }
    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }
    if (originalGatewayUrl === undefined) {
      delete process.env.EIGENFLUX_OPENCLAW_GATEWAY_URL;
    } else {
      process.env.EIGENFLUX_OPENCLAW_GATEWAY_URL = originalGatewayUrl;
    }
    if (originalGatewayToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalGatewayToken;
    }
    if (originalPollInterval === undefined) {
      delete process.env.EIGENFLUX_POLL_INTERVAL;
    } else {
      process.env.EIGENFLUX_POLL_INTERVAL = originalPollInterval;
    }

    fs.rmSync(openClawHome, { recursive: true, force: true });
    await new Promise<void>((resolve) => apiHttpServer.close(() => resolve()));
    await new Promise<void>((resolve) => gatewayWss.close(() => resolve()));
    await new Promise<void>((resolve) => gatewayHttpServer.close(() => resolve()));
  });

  test('dispatches ACP chat.send when polling feed returns new items', async () => {
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const gatewayMethods: string[] = [];
    const chatSendParams: any[] = [];

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
                features: { methods: ['sessions.list', 'chat.send'], events: [] },
                snapshot: { ts: Date.now() },
                policy: { maxPayload: 1000000, maxBufferedBytes: 1000000, tickIntervalMs: 30000 },
              },
            })
          );
          return;
        }

        if (frame.method === 'sessions.list') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: {
                sessions: [{ key: 'main' }],
              },
            })
          );
          return;
        }

        if (frame.method === 'chat.send') {
          chatSendParams.push(frame.params);
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
        enabled: true,
        gateway: {
          auth: {
            token: 'gw_test_token',
          },
        },
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => {
        services.push(service);
      },
    } as any);

    expect(services).toHaveLength(1);
    await services[0].start();
    await waitFor(() => chatSendParams.length === 1);

    expect(apiRequestCount).toBeGreaterThanOrEqual(1);
    expect(apiAuthHeader).toBe('Bearer at_integration_token');
    expect(apiUserAgentHeader).toContain('eigenflux-plugin');
    expect(apiUserAgentHeader).toContain('node/');
    expect(gatewayMethods).toEqual(['connect', 'sessions.list', 'chat.send']);
    expect(chatSendParams[0]).toEqual(
      expect.objectContaining({
        sessionKey: 'main',
        message: expect.stringContaining('[EIGENFLUX_FEED_PAYLOAD]'),
      })
    );
    expect(String(chatSendParams[0].message)).toContain('"item_id": "501"');
    expect(String(chatSendParams[0].message)).toContain('"group_id": "group-int-1"');
    expect(String(chatSendParams[0].message)).toContain('submit feedback scores');
    expect(typeof chatSendParams[0].idempotencyKey).toBe('string');
    expect(chatSendParams[0].idempotencyKey.length).toBeGreaterThan(0);

    await services[0].stop();
  });

  test('dispatches the entire feed payload in a single ACP message', async () => {
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
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const chatSendParams: any[] = [];

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
                features: { methods: ['sessions.list', 'chat.send'], events: [] },
                snapshot: { ts: Date.now() },
                policy: { maxPayload: 1000000, maxBufferedBytes: 1000000, tickIntervalMs: 30000 },
              },
            })
          );
          return;
        }

        if (frame.method === 'sessions.list') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: {
                sessions: [{ key: 'main' }],
              },
            })
          );
          return;
        }

        if (frame.method === 'chat.send') {
          chatSendParams.push(frame.params);
          socket.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: {
                runId: `run-dup-${chatSendParams.length}`,
                status: 'started',
              },
            })
          );
        }
      });
    });

    plugin.register({
      config: {
        enabled: true,
        gateway: {
          auth: {
            token: 'gw_test_token',
          },
        },
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => {
        services.push(service);
      },
    } as any);

    expect(services).toHaveLength(1);
    await services[0].start();
    await waitFor(() => chatSendParams.length === 1);

    expect(chatSendParams).toHaveLength(1);
    expect(String(chatSendParams[0].message)).toContain('"item_id": "601"');
    expect(String(chatSendParams[0].message)).toContain('"item_id": "602"');
    expect(String(chatSendParams[0].message)).toContain('"group_id": "group-dup-1"');

    await services[0].stop();
  });
});
