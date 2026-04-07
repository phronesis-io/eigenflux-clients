import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import { resolveNotificationRoute } from './notification-route-resolver';
import { writeStoredNotificationRoute } from './session-route-memory';

function createLogger(): Logger {
  return new Logger({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  });
}

describe('resolveNotificationRoute', () => {
  test('prefers remembered session route over dynamically fresher session when config is automatic', () => {
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

    writeStoredNotificationRoute(
      workdir,
      {
        sessionKey: 'agent:mengtian:feishu:direct:ou_saved',
        agentId: 'mengtian',
        replyChannel: 'feishu',
        replyTo: 'user:ou_saved',
        replyAccountId: 'default',
      },
      createLogger()
    );

    const route = resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        workdir,
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

  test('respects explicit route overrides while still enriching exact session metadata', () => {
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

    const route = resolveNotificationRoute(
      {
        sessionKey: 'agent:main:feishu:direct:ou_explicit',
        agentId: 'main',
        replyChannel: 'feishu',
        sessionStorePath,
        workdir,
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

  test('normalizes remembered legacy feishu targets from session memory', () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-route-legacy-memory-'));

    writeStoredNotificationRoute(
      workdir,
      {
        sessionKey: 'agent:mengtian:feishu:direct:ou_legacy',
        agentId: 'mengtian',
        replyChannel: 'feishu',
        replyTo: 'ou_legacy',
        replyAccountId: 'default',
      },
      createLogger()
    );

    const route = resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        workdir,
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

    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('prefers the session-store route whose peer shape matches the normalized target', () => {
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

    writeStoredNotificationRoute(
      workdir,
      {
        sessionKey: 'main',
        agentId: 'main',
        replyChannel: 'feishu',
        replyTo: 'chat:oc_group_target',
        replyAccountId: 'default',
      },
      createLogger()
    );

    const route = resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        workdir,
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
});
