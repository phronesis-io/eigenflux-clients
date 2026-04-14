import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';

const readStoredNotificationRouteMock = jest.fn();
jest.mock('./session-route-memory', () => ({
  readStoredNotificationRoute: (...args: any[]) => readStoredNotificationRouteMock(...args),
  writeStoredNotificationRoute: jest.fn(),
}));

import { resolveNotificationRoute } from './notification-route-resolver';

function createLogger(): Logger {
  return new Logger({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  });
}

describe('resolveNotificationRoute', () => {
  beforeEach(() => {
    readStoredNotificationRouteMock.mockReset();
    readStoredNotificationRouteMock.mockResolvedValue(undefined);
  });

  test('prefers remembered session route over dynamically fresher session when config is automatic', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-route-memory-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');

    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 100,
          deliveryContext: { channel: 'webchat' },
        },
        'agent:main:feishu:group:oc_newer': {
          updatedAt: 400,
          deliveryContext: {
            channel: 'feishu',
            to: 'chat:oc_newer',
            accountId: 'default',
          },
        },
        'agent:mengtian:feishu:direct:ou_saved': {
          updatedAt: 200,
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_saved',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    readStoredNotificationRouteMock.mockResolvedValue({
      sessionKey: 'agent:mengtian:feishu:direct:ou_saved',
      agentId: 'mengtian',
      replyChannel: 'feishu',
      replyTo: 'user:ou_saved',
      replyAccountId: 'default',
      updatedAt: 0,
    });

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
        routeOverrides: {
          sessionKey: false,
          agentId: false,
          replyChannel: false,
          replyTo: false,
          replyAccountId: false,
        },
      },
      createLogger()
    );

    expect(route).toEqual({
      sessionKey: 'agent:mengtian:feishu:direct:ou_saved',
      agentId: 'mengtian',
      replyChannel: 'feishu',
      replyTo: 'user:ou_saved',
      replyAccountId: 'default',
    });

    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('respects explicit route overrides while still enriching exact session metadata', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-route-explicit-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');

    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:feishu:direct:ou_explicit': {
          updatedAt: 300,
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_explicit',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'agent:main:feishu:direct:ou_explicit',
        agentId: 'main',
        replyChannel: 'feishu',
        sessionStorePath,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
        routeOverrides: {
          sessionKey: true,
          agentId: true,
          replyChannel: true,
          replyTo: false,
          replyAccountId: false,
        },
      },
      createLogger()
    );

    expect(route).toEqual({
      sessionKey: 'agent:main:feishu:direct:ou_explicit',
      agentId: 'main',
      replyChannel: 'feishu',
      replyTo: 'user:ou_explicit',
      replyAccountId: 'default',
    });

    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('normalizes remembered legacy feishu targets from session memory', async () => {
    readStoredNotificationRouteMock.mockResolvedValue({
      sessionKey: 'agent:mengtian:feishu:direct:ou_legacy',
      agentId: 'mengtian',
      replyChannel: 'feishu',
      replyTo: 'user:ou_legacy',
      replyAccountId: 'default',
      updatedAt: 0,
    });

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
        routeOverrides: {
          sessionKey: false,
          agentId: false,
          replyChannel: false,
          replyTo: false,
          replyAccountId: false,
        },
      },
      createLogger()
    );

    expect(route).toEqual({
      sessionKey: 'agent:mengtian:feishu:direct:ou_legacy',
      agentId: 'mengtian',
      replyChannel: 'feishu',
      replyTo: 'user:ou_legacy',
      replyAccountId: 'default',
    });
  });

  test('prefers the session-store route whose peer shape matches the normalized target', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-route-peer-shape-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');

    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 100,
          deliveryContext: { channel: 'webchat' },
        },
        'agent:main:feishu:group:oc_group_target': {
          updatedAt: 200,
          deliveryContext: {
            channel: 'feishu',
            to: 'chat:oc_group_target',
            accountId: 'default',
          },
        },
        'agent:mengtian:feishu:direct:oc_group_target': {
          updatedAt: 300,
          origin: {
            provider: 'feishu',
            to: 'oc_group_target',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    readStoredNotificationRouteMock.mockResolvedValue({
      sessionKey: 'main',
      agentId: 'main',
      replyChannel: 'feishu',
      replyTo: 'chat:oc_group_target',
      replyAccountId: 'default',
      updatedAt: 0,
    });

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
        routeOverrides: {
          sessionKey: false,
          agentId: false,
          replyChannel: false,
          replyTo: false,
          replyAccountId: false,
        },
      },
      createLogger()
    );

    expect(route).toEqual({
      sessionKey: 'agent:main:feishu:group:oc_group_target',
      agentId: 'main',
      replyChannel: 'feishu',
      replyTo: 'chat:oc_group_target',
      replyAccountId: 'default',
    });

    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('derives channel and target from sessionKey when entry metadata is sparse', async () => {
    // Real-world case: sessions.json has an external entry with only updatedAt
    // set (no deliveryContext.to), plus a webchat bookkeeping entry. The
    // external sessionKey shape alone must be enough to route to it.
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-route-sparse-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:mengtian:main': {
          updatedAt: 9000,
          deliveryContext: { channel: 'webchat', to: 'heartbeat' },
        },
        'agent:mengtian:feishu:direct:ou_sparse': {
          updatedAt: 1000,
        },
      }),
      'utf-8'
    );

    const route = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(route.route.sessionKey).toBe('agent:mengtian:feishu:direct:ou_sparse');
    expect(route.route.replyChannel).toBe('feishu');
    expect(route.route.replyTo).toBe('user:ou_sparse');
    expect(route.source).toBe('session-store');

    fs.rmSync(workdir, { recursive: true, force: true });
  });
});
