import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import http from 'http';
import { WebSocketServer } from 'ws';

// Shared variable so the os mock factory always returns the test-controlled homeDir
let __testHomeDir: string | undefined;

jest.mock('os', () => {
  const actual = jest.requireActual('os') as typeof import('os');
  return {
    ...actual,
    homedir: jest.fn(() => __testHomeDir ?? actual.homedir()),
  };
});

// Mock discoverServers and resolveEigenfluxHome
const discoverServersMock = jest.fn();
const resolveEigenfluxHomeMock = jest.fn();

jest.mock('./config', () => {
  const actual = jest.requireActual('./config');
  return {
    ...actual,
    discoverServers: (...args: any[]) => discoverServersMock(...args),
    resolveEigenfluxHome: () => resolveEigenfluxHomeMock(),
  };
});

// Mock execEigenflux for CLI calls
const execEigenfluxMock = jest.fn();
jest.mock('./cli-executor', () => ({
  execEigenflux: (...args: any[]) => execEigenfluxMock(...args),
}));

// Mock EigenFluxStreamClient
const streamClientStartMock = jest.fn().mockResolvedValue(undefined);
const streamClientStopMock = jest.fn().mockResolvedValue(undefined);
const streamClientIsRunningMock = jest.fn().mockReturnValue(false);
const streamClientGetLastCursorMock = jest.fn().mockReturnValue(null);

jest.mock('./stream-client', () => ({
  EigenFluxStreamClient: jest.fn().mockImplementation(() => ({
    start: streamClientStartMock,
    stop: streamClientStopMock,
    isRunning: streamClientIsRunningMock,
    getLastCursor: streamClientGetLastCursorMock,
  })),
}));

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
  let eigenfluxHome: string;

  let gatewayHttpServer: http.Server;
  let gatewayWss: WebSocketServer;
  let gatewayPort: number;

  let feedItems: Array<{
    item_id: string;
    group_id?: string;
    broadcast_type: string;
    updated_at: number;
  }>;

  beforeEach(async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-openclaw-home-'));
    eigenfluxHome = path.join(homeDir, '.eigenflux');
    __testHomeDir = homeDir;
    resolveEigenfluxHomeMock.mockReturnValue(eigenfluxHome);

    // Create server credentials
    const serverDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_integration_token' }),
      'utf-8'
    );

    feedItems = [
      {
        item_id: '501',
        group_id: 'group-int-1',
        broadcast_type: 'info',
        updated_at: 1760000000000,
      },
    ];

    // Set up execEigenflux to return feed data
    execEigenfluxMock.mockImplementation(async (bin: string, args: string[]) => {
      if (args[0] === 'feed' && args[1] === 'poll') {
        return {
          kind: 'success',
          data: {
            items: feedItems,
            has_more: false,
            notifications: [],
          },
        };
      }
      return { kind: 'error', error: new Error('unknown command'), exitCode: 1, stderr: '' };
    });

    discoverServersMock.mockResolvedValue([
      { name: 'eigenflux', endpoint: 'http://127.0.0.1:18080', current: true },
    ]);

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
    __testHomeDir = undefined;
    fs.rmSync(homeDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => gatewayWss.close(() => resolve()));
    await new Promise<void>((resolve) => gatewayHttpServer.close(() => resolve()));
  });

  test('falls back to gateway rpc agent when polling feed returns new items', async () => {
    jest.resetModules();
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
        feedPollInterval: 60,
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

    expect(execEigenfluxMock).toHaveBeenCalled();
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
    expect(String(agentParams[0].message)).toContain(`workdir=${eigenfluxHome}`);
    expect(String(agentParams[0].message)).toContain(
      'ef-broadcast skill to process feed payload'
    );
    expect(typeof agentParams[0].idempotencyKey).toBe('string');
    expect(agentParams[0].idempotencyKey.length).toBeGreaterThan(0);

    await services[0].stop();
  });

  test('dispatches the entire feed payload in a single gateway agent message', async () => {
    feedItems = [
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
        feedPollInterval: 60,
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

  test('routes feed notifications via runtime.subagent when available', async () => {
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-subagent-feed' });

    plugin.register({
      config: {},
      pluginConfig: {
        feedPollInterval: 60,
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
      sessionKey: 'main',
      message: expect.stringContaining('[EIGENFLUX_FEED_PAYLOAD]'),
      deliver: true,
      idempotencyKey: expect.any(String),
    });
    expect(String(subagentRun.mock.calls[0]?.[0]?.message)).toContain('"item_id": "501"');

    await services[0].stop();
  });
});
