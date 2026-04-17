import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';

const readStoredNotificationRouteMock = jest.fn();
jest.mock('./session-route-memory', () => ({
  readStoredNotificationRoute: (...args: any[]) => readStoredNotificationRouteMock(...args),
  writeStoredNotificationRoute: jest.fn(),
}));

import { isInternalSessionKey, resolveNotificationRoute } from './notification-route-resolver';

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

describe('isInternalSessionKey', () => {
  test('bare "main" is internal', () => {
    expect(isInternalSessionKey('main')).toBe(true);
  });

  test('bare "heartbeat" is internal', () => {
    expect(isInternalSessionKey('heartbeat')).toBe(true);
  });

  test('empty / whitespace is internal', () => {
    expect(isInternalSessionKey('')).toBe(true);
    expect(isInternalSessionKey('   ')).toBe(true);
  });

  test('agent:<id>:heartbeat is internal', () => {
    expect(isInternalSessionKey('agent:main:heartbeat')).toBe(true);
    expect(isInternalSessionKey('agent:mengtian:heartbeat')).toBe(true);
  });

  test('agent:<id>:main is NOT internal (legacy DM scope)', () => {
    expect(isInternalSessionKey('agent:main:main')).toBe(false);
    expect(isInternalSessionKey('agent:mengtian:main')).toBe(false);
  });

  test('channel-scoped keys are not internal', () => {
    expect(isInternalSessionKey('agent:main:feishu:direct:ou_123')).toBe(false);
    expect(isInternalSessionKey('agent:main:feishu:group:oc_456')).toBe(false);
    expect(isInternalSessionKey('agent:main:discord:direct:user789')).toBe(false);
  });
});

import { isGroupEntry, isDirectSessionKey } from './notification-route-resolver';

describe('isGroupEntry', () => {
  test('sessionKey with :group: is a group', () => {
    expect(isGroupEntry('agent:main:feishu:group:oc_123', {})).toBe(true);
  });

  test('sessionKey with :channel: is a group', () => {
    expect(isGroupEntry('agent:main:discord:channel:c_123', {})).toBe(true);
  });

  test('sessionKey with :room: is a group', () => {
    expect(isGroupEntry('agent:main:matrix:room:r_123', {})).toBe(true);
  });

  test('entry.chatType=group overrides DM-shaped key', () => {
    expect(
      isGroupEntry('agent:main:main', {
        deliveryContext: { channel: 'feishu', to: 'user:ou_1' },
        chatType: 'group' as any,
      } as any)
    ).toBe(true);
  });

  test('entry.origin.chatType=group', () => {
    expect(
      isGroupEntry('agent:main:main', {
        origin: { provider: 'feishu', chatType: 'group' as any },
      } as any)
    ).toBe(true);
  });

  test('deliveryContext.to with chat: prefix is a group', () => {
    expect(
      isGroupEntry('agent:main:main', {
        deliveryContext: { channel: 'feishu', to: 'chat:oc_123' },
      } as any)
    ).toBe(true);
  });

  test('lastTo with channel: prefix is a group', () => {
    expect(
      isGroupEntry('agent:main:main', { lastTo: 'channel:c_123' } as any)
    ).toBe(true);
  });

  test('origin.to with room: prefix is a group', () => {
    expect(
      isGroupEntry('agent:main:main', { origin: { to: 'room:r_123' } } as any)
    ).toBe(true);
  });

  test('DM session is NOT a group', () => {
    expect(
      isGroupEntry('agent:main:main', {
        deliveryContext: { channel: 'feishu', to: 'user:ou_1' },
      } as any)
    ).toBe(false);
  });

  test('channel-scoped DM is NOT a group', () => {
    expect(
      isGroupEntry('agent:main:feishu:direct:ou_1', {
        deliveryContext: { channel: 'feishu', to: 'user:ou_1' },
      } as any)
    ).toBe(false);
  });

  test('empty entry with plain DM-shaped key is NOT a group', () => {
    expect(isGroupEntry('agent:main:main', {})).toBe(false);
  });
});

describe('isDirectSessionKey', () => {
  test('sessionKey parts contain "direct"', () => {
    expect(isDirectSessionKey('agent:main:feishu:direct:ou_1', {})).toBe(true);
  });

  test('sessionKey parts contain "dm"', () => {
    expect(isDirectSessionKey('agent:main:discord:dm:user1', {})).toBe(true);
  });

  test('entry.chatType=direct marks key as direct even without "direct" in sessionKey', () => {
    expect(
      isDirectSessionKey('agent:main:main', { chatType: 'direct' } as any)
    ).toBe(true);
  });

  test('entry.origin.chatType=direct is recognized', () => {
    expect(
      isDirectSessionKey('agent:main:main', { origin: { chatType: 'direct' } } as any)
    ).toBe(true);
  });

  test('deliveryContext.to with user: prefix is direct', () => {
    expect(
      isDirectSessionKey('agent:main:main', {
        deliveryContext: { to: 'user:ou_1' },
      } as any)
    ).toBe(true);
  });

  test('lastTo with user: prefix is direct', () => {
    expect(
      isDirectSessionKey('agent:main:main', { lastTo: 'user:ou_1' } as any)
    ).toBe(true);
  });

  test('group key is not direct', () => {
    expect(isDirectSessionKey('agent:main:feishu:group:oc_1', {})).toBe(false);
  });

  test('empty entry with plain key is not direct', () => {
    expect(isDirectSessionKey('agent:main:main', {})).toBe(false);
  });
});
