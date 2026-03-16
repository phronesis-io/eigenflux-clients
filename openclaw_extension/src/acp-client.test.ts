import http from 'http';
import { WebSocketServer } from 'ws';
import { OpenClawAcpClient } from './acp-client';
import { Logger } from './logger';

describe('OpenClawAcpClient', () => {
  let server: http.Server;
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    server = http.createServer();
    wss = new WebSocketServer({ server });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('uses configured session key and sends chat.send directly', async () => {
    const methods: string[] = [];
    let chatSendParams: any = null;

    wss.on('connection', (socket) => {
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'nonce-test-1' },
        })
      );

      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        methods.push(String(frame.method || ''));

        if (frame.method === 'connect') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: {
                protocol: 3,
                server: { version: 'test', connId: 'conn-1' },
                features: { methods: ['chat.send'], events: [] },
                snapshot: { ts: Date.now() },
                policy: { maxPayload: 1000000, maxBufferedBytes: 1000000, tickIntervalMs: 30000 },
              },
            })
          );
          return;
        }

        if (frame.method === 'chat.send') {
          chatSendParams = frame.params;
          socket.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: { status: 'started', runId: 'run-1' },
            })
          );
        }
      });
    });

    const client = new OpenClawAcpClient({
      gatewayUrl: `ws://127.0.0.1:${port}`,
      gatewayToken: 'gw_token_1',
      sessionKey: 'agent:test:main',
      logger: new Logger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    });

    const result = await client.sendMessage('[EIGENFLUX_TEST] first payload');

    expect(result).toEqual({
      sessionKey: 'agent:test:main',
      runId: 'run-1',
    });
    expect(methods).toEqual(['connect', 'chat.send']);
    expect(chatSendParams).toEqual(
      expect.objectContaining({
        sessionKey: 'agent:test:main',
        message: '[EIGENFLUX_TEST] first payload',
      })
    );
  });

  test('resolves session key from sessions.list when not configured', async () => {
    const methods: string[] = [];
    let chatSendParams: any = null;

    wss.on('connection', (socket) => {
      socket.send(
        JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'nonce-test-2' },
        })
      );

      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        methods.push(String(frame.method || ''));

        if (frame.method === 'connect') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: {
                protocol: 3,
                server: { version: 'test', connId: 'conn-2' },
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
                sessions: [{ key: 'main' }, { key: 'agent:foo:bar' }],
              },
            })
          );
          return;
        }

        if (frame.method === 'chat.send') {
          chatSendParams = frame.params;
          socket.send(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: true,
              payload: { status: 'started', runId: 'run-2' },
            })
          );
        }
      });
    });

    const client = new OpenClawAcpClient({
      gatewayUrl: `ws://127.0.0.1:${port}`,
      gatewayToken: 'gw_token_2',
      logger: new Logger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    });

    const result = await client.sendMessage('[EIGENFLUX_TEST] second payload');

    expect(result).toEqual({
      sessionKey: 'main',
      runId: 'run-2',
    });
    expect(methods).toEqual(['connect', 'sessions.list', 'chat.send']);
    expect(chatSendParams).toEqual(
      expect.objectContaining({
        sessionKey: 'main',
        message: '[EIGENFLUX_TEST] second payload',
      })
    );
  });
});
