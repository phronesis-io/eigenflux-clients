import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Logger } from './logger';
import { EigenFluxNotifier } from './notifier';

function createLogger(): Logger {
  return new Logger({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  });
}

function createApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return {
    id: 'eigenflux',
    name: 'EigenFlux',
    source: '/tmp/eigenflux',
    config: {},
    pluginConfig: {},
    runtime: {} as OpenClawPluginApi['runtime'],
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    registerService: jest.fn(),
    ...overrides,
  } as unknown as OpenClawPluginApi;
}

function createConfig() {
  return {
    gatewayUrl: 'ws://127.0.0.1:18789',
    sessionKey: 'agent:main:feishu:direct:ou_123',
    agentId: 'main',
    replyChannel: 'feishu',
    replyTo: 'user:ou_123',
    openclawCliBin: 'openclaw',
  };
}

describe('EigenFluxNotifier', () => {
  test('prefers runtime.subagent delivery when available', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-subagent' });
    const sendAgentMessage = jest.fn();

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: {
            run,
          },
        } as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig(),
      () => ({
        sendAgentMessage,
      })
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith({
      sessionKey: 'agent:main:feishu:direct:ou_123',
      message: '[EIGENFLUX_TEST] payload',
      deliver: true,
      idempotencyKey: expect.any(String),
    });
    expect(sendAgentMessage).not.toHaveBeenCalled();
  });

  test('falls back to gateway rpc agent when runtime.subagent is unavailable', async () => {
    const sendAgentMessage = jest.fn().mockResolvedValue({
      sessionKey: 'agent:main:feishu:direct:ou_123',
      runId: 'run-gateway',
    });

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {} as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig(),
      () => ({
        sendAgentMessage,
      })
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(sendAgentMessage).toHaveBeenCalledWith('[EIGENFLUX_TEST] payload');
  });

  test('falls back to runtime command agent when gateway rpc fails', async () => {
    const runCommandWithTimeout = jest.fn().mockResolvedValue({
      code: 0,
      stdout: 'ok',
      stderr: '',
    });

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          system: {
            runCommandWithTimeout,
          },
        } as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig(),
      () => ({
        sendAgentMessage: jest.fn().mockRejectedValue(new Error('gateway failed')),
      })
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        'openclaw',
        'agent',
        '--message',
        '[EIGENFLUX_TEST] payload',
        '--agent',
        'main',
        '--deliver',
        '--reply-channel',
        'feishu',
        '--reply-to',
        'user:ou_123',
      ],
      { timeoutMs: 15000 }
    );
  });

  test('falls back to runtime heartbeat when command path is unavailable', async () => {
    const enqueueSystemEvent = jest.fn().mockReturnValue(true);
    const requestHeartbeatNow = jest.fn();
    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          system: {
            enqueueSystemEvent,
            requestHeartbeatNow,
          },
        } as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig(),
      () => ({
        sendAgentMessage: jest.fn().mockRejectedValue(new Error('gateway failed')),
      })
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(enqueueSystemEvent).toHaveBeenCalledWith('[EIGENFLUX_TEST] payload', {
      sessionKey: 'agent:main:feishu:direct:ou_123',
      deliveryContext: {
        channel: 'feishu',
        to: 'user:ou_123',
      },
    });
    expect(requestHeartbeatNow).toHaveBeenCalledWith({
      reason: 'plugin:eigenflux',
      coalesceMs: 0,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:direct:ou_123',
    });
  });

  test('deliverWithSubagent only uses runtime.subagent', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-subagent-only' });
    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: {
            run,
          },
        } as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig(),
      () => ({
        sendAgentMessage: jest.fn(),
      })
    );

    await expect(notifier.deliverWithSubagent('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('resolves the freshest external session route for runtime.subagent', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-session-store-'));
    const sessionStorePath = path.join(stateDir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 100,
          deliveryContext: { channel: 'webchat' },
        },
        'agent:main:feishu:direct:ou_older': {
          updatedAt: 200,
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_older',
            accountId: 'default',
          },
        },
        'agent:main:feishu:group:oc_latest': {
          updatedAt: 300,
          deliveryContext: {
            channel: 'feishu',
            to: 'chat:oc_latest',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const run = jest.fn().mockResolvedValue({ runId: 'run-external-session' });
    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: {
            run,
          },
        } as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      {
        ...createConfig(),
        sessionKey: 'main',
        replyChannel: undefined,
        replyTo: undefined,
        replyAccountId: undefined,
        sessionStorePath,
      },
      () => ({
        sendAgentMessage: jest.fn(),
      })
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith({
      sessionKey: 'agent:main:feishu:group:oc_latest',
      message: '[EIGENFLUX_TEST] payload',
      deliver: true,
      idempotencyKey: expect.any(String),
    });

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('normalizes explicit reply targets from session store before CLI fallback', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-session-store-'));
    const sessionStorePath = path.join(stateDir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:feishu:direct:ou_123': {
          updatedAt: 300,
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_123',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const runCommandWithTimeout = jest.fn().mockResolvedValue({
      code: 0,
      stdout: 'ok',
      stderr: '',
    });

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          system: {
            runCommandWithTimeout,
          },
        } as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      {
        ...createConfig(),
        sessionKey: 'main',
        replyChannel: 'feishu',
        replyTo: 'user:ou_123',
        sessionStorePath,
      },
      () => ({
        sendAgentMessage: jest.fn().mockRejectedValue(new Error('gateway failed')),
      })
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        'openclaw',
        'agent',
        '--message',
        '[EIGENFLUX_TEST] payload',
        '--agent',
        'main',
        '--deliver',
        '--reply-channel',
        'feishu',
        '--reply-to',
        'user:ou_123',
        '--reply-account',
        'default',
      ],
      { timeoutMs: 15000 }
    );

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('remembers the resolved route after a successful delivery', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-notifier-memory-'));
    const run = jest.fn().mockResolvedValue({ runId: 'run-subagent-memory' });
    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: {
            run,
          },
        } as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      {
        ...createConfig(),
        workdir,
      },
      () => ({
        sendAgentMessage: jest.fn(),
      })
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);

    const remembered = JSON.parse(
      fs.readFileSync(path.join(workdir, 'session.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(remembered.sessionKey).toBe('agent:main:feishu:direct:ou_123');
    expect(remembered.agentId).toBe('main');
    expect(remembered.replyChannel).toBe('feishu');
    expect(remembered.replyTo).toBe('user:ou_123');

    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('does not overwrite remembered external routes with an internal main fallback', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-notifier-main-memory-'));
    fs.writeFileSync(
      path.join(workdir, 'session.json'),
      JSON.stringify(
        {
          sessionKey: 'agent:main:feishu:group:oc_saved',
          agentId: 'main',
          replyChannel: 'feishu',
          replyTo: 'chat:oc_saved',
          replyAccountId: 'default',
          updatedAt: 1,
        },
        null,
        2
      ),
      'utf-8'
    );

    const run = jest.fn().mockResolvedValue({ runId: 'run-subagent-main' });
    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: {
            run,
          },
        } as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      {
        ...createConfig(),
        workdir,
        sessionKey: 'main',
        agentId: 'main',
        replyChannel: undefined,
        replyTo: undefined,
        replyAccountId: undefined,
      },
      () => ({
        sendAgentMessage: jest.fn(),
      })
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);

    const remembered = JSON.parse(
      fs.readFileSync(path.join(workdir, 'session.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(remembered.sessionKey).toBe('agent:main:feishu:group:oc_saved');
    expect(remembered.replyTo).toBe('chat:oc_saved');

    fs.rmSync(workdir, { recursive: true, force: true });
  });
});
