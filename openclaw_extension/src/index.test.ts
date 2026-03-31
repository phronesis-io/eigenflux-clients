import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const sendAgentMessageMock = jest.fn().mockResolvedValue({
  sessionKey: 'main',
  runId: 'run-test',
});

jest.mock('./gateway-rpc-client', () => ({
  OpenClawGatewayRpcClient: jest.fn().mockImplementation(() => ({
    sendAgentMessage: sendAgentMessageMock,
  })),
}));

function createLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

describe('register unit', () => {
  let workdir: string;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-openclaw-workdir-'));
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
    delete (global as { fetch?: typeof fetch }).fetch;
  });

  test('sends onboarding prompt through gateway fallback when service starts without token', async () => {
    const { default: plugin } = await import('./index');
    const services: any[] = [];

    plugin.register({
      config: {},
      pluginConfig: {
        endpoint: 'http://127.0.0.1:18080',
        workdir,
        gatewayUrl: 'ws://127.0.0.1:18789',
        sessionStorePath: path.join(workdir, 'missing-sessions.json'),
      },
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    expect(sendAgentMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('[EIGENFLUX_AUTH_REQUIRED]')
    );
    expect(sendAgentMessageMock).toHaveBeenCalledWith(
      expect.stringContaining(`credentials_path=${path.join(workdir, 'credentials.json')}`)
    );

    await services[0].stop();
  });

  test('supports /eigenflux auth, profile, and poll commands', async () => {
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(
      path.join(workdir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_command_token' }),
      'utf-8'
    );

    const { default: plugin } = await import('./index');
    const commands: any[] = [];
    plugin.register({
      config: {},
      pluginConfig: {
        endpoint: 'http://127.0.0.1:18080',
        workdir,
        sessionStorePath: path.join(workdir, 'missing-sessions.json'),
      },
      runtime: {},
      logger: createLogger(),
      registerService: jest.fn(),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    expect(commands).toHaveLength(1);
    const command = commands[0];

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: 'success',
            data: {
              agent: { id: '1', name: 'bot' },
              profile: { status: 3, keywords: ['ai'] },
              influence: { total_items: 1 },
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: 'success',
            data: {
              items: [
                {
                  item_id: '901',
                  broadcast_type: 'info',
                  updated_at: 1760000000000,
                },
              ],
              has_more: false,
              notifications: [],
            },
          }),
          { status: 200 }
        )
      );
    global.fetch = fetchMock as typeof fetch;

    const authResp = await command.handler({ args: 'auth' });
    expect(authResp.text).toContain('status: available');
    expect(authResp.text).toContain('at_com');

    const profileResp = await command.handler({ args: 'profile' });
    expect(profileResp.text).toContain('EigenFlux profile:');
    expect(profileResp.text).toContain('"name": "bot"');

    const pollResp = await command.handler({ args: 'poll' });
    expect(pollResp.text).toContain('EigenFlux poll result:');
    expect(pollResp.text).toContain('"item_id": "901"');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const sendResp = await command.handler({ args: 'sendwithsubagent hello-subagent' });
    expect(sendResp.text).toBe('runtime.subagent dispatch failed; check plugin logs for details.');
  });

  test('supports /eigenflux here and persists the current conversation route', async () => {
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 100,
          deliveryContext: { channel: 'webchat' },
        },
        'agent:mengtian:feishu:direct:ou_current': {
          updatedAt: 300,
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_current',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const { default: plugin } = await import('./index');
    const commands: any[] = [];
    plugin.register({
      config: {},
      pluginConfig: {
        endpoint: 'http://127.0.0.1:18080',
        workdir,
        sessionStorePath,
      },
      runtime: {},
      logger: createLogger(),
      registerService: jest.fn(),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    const hereResp = await commands[0].handler({
      args: 'here',
      channel: 'feishu',
      to: 'user:ou_current',
      accountId: 'default',
      getCurrentConversationBinding: jest.fn().mockResolvedValue({
        channel: 'feishu',
        accountId: 'default',
        conversationId: 'user:ou_current',
      }),
    });

    expect(hereResp.text).toContain('EigenFlux will deliver to this conversation by default:');
    expect(hereResp.text).toContain('sessionKey: agent:mengtian:feishu:direct:ou_current');

    const remembered = JSON.parse(
      fs.readFileSync(path.join(workdir, 'session.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(remembered.sessionKey).toBe('agent:mengtian:feishu:direct:ou_current');
    expect(remembered.agentId).toBe('mengtian');
    expect(remembered.replyChannel).toBe('feishu');
    expect(remembered.replyTo).toBe('user:ou_current');
    expect(remembered.replyAccountId).toBe('default');
  });

  test('automatically remembers the current conversation when any eigenflux command runs', async () => {
    fs.mkdirSync(workdir, { recursive: true });
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:feishu:group:oc_current': {
          updatedAt: 300,
          deliveryContext: {
            channel: 'feishu',
            to: 'chat:oc_current',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const { default: plugin } = await import('./index');
    const commands: any[] = [];
    plugin.register({
      config: {},
      pluginConfig: {
        endpoint: 'http://127.0.0.1:18080',
        workdir,
        sessionStorePath,
      },
      runtime: {},
      logger: createLogger(),
      registerService: jest.fn(),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    const authResp = await commands[0].handler({
      args: 'auth',
      channel: 'feishu',
      to: 'chat:oc_current',
      accountId: 'default',
      getCurrentConversationBinding: jest.fn().mockResolvedValue({
        channel: 'feishu',
        accountId: 'default',
        conversationId: 'chat:oc_current',
      }),
    });

    expect(authResp.text).toContain('status: missing');

    const remembered = JSON.parse(
      fs.readFileSync(path.join(workdir, 'session.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(remembered.sessionKey).toBe('agent:main:feishu:group:oc_current');
    expect(remembered.replyTo).toBe('chat:oc_current');
  });

  test('prefers runtime.subagent delivery when available', async () => {
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-subagent' });

    plugin.register({
      config: {},
      pluginConfig: {
        endpoint: 'http://127.0.0.1:18080',
        workdir,
        sessionKey: 'agent:main:main',
        sessionStorePath: path.join(workdir, 'missing-sessions.json'),
      },
      runtime: {
        subagent: {
          run: subagentRun,
        },
      },
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(),
    } as any);

    await services[0].start();

    expect(subagentRun).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      message: expect.stringContaining('[EIGENFLUX_AUTH_REQUIRED]'),
      deliver: true,
      idempotencyKey: expect.any(String),
    });
    expect(sendAgentMessageMock).not.toHaveBeenCalled();

    await services[0].stop();
  });
});
