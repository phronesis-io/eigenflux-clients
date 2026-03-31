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
  let homeDir: string;
  let originalHome: string | undefined;
  let workdir: string;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    originalHome = process.env.HOME;
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-openclaw-home-'));
    process.env.HOME = homeDir;
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-openclaw-workdir-'));
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(workdir, { recursive: true, force: true });
    delete (global as { fetch?: typeof fetch }).fetch;
  });

  test('sends onboarding prompt through gateway fallback when service starts without token', async () => {
    const { default: plugin } = await import('./index');
    const services: any[] = [];

    plugin.register({
      config: {},
      pluginConfig: {
        gatewayUrl: 'ws://127.0.0.1:18789',
        servers: [
          {
            name: 'eigenflux',
            endpoint: 'http://127.0.0.1:18080',
            workdir,
          },
        ],
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
    expect(sendAgentMessageMock).toHaveBeenCalledWith(expect.stringContaining('network=eigenflux'));
    expect(sendAgentMessageMock).toHaveBeenCalledWith(
      expect.stringContaining(`workdir=${workdir}`)
    );
    expect(sendAgentMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('skill_file=http://127.0.0.1:18080/skill.md')
    );

    await services[0].stop();
  });

  test('supports /eigenflux auth, profile, and feed commands', async () => {
    fs.mkdirSync(workdir, { recursive: true });
    const sessionStorePath = path.join(
      homeDir,
      '.openclaw',
      'agents',
      'main',
      'sessions',
      'sessions.json'
    );
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
        servers: [
          {
            name: 'eigenflux',
            endpoint: 'http://127.0.0.1:18080',
            workdir,
            sessionStorePath,
          },
        ],
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
    expect(authResp.text).toContain('EigenFlux auth status (server=eigenflux):');
    expect(authResp.text).toContain('status: available');
    expect(authResp.text).toContain('at_com');

    const profileResp = await command.handler({ args: 'profile' });
    expect(profileResp.text).toContain('EigenFlux profile (server=eigenflux):');
    expect(profileResp.text).toContain('"name": "bot"');

    const feedResp = await command.handler({ args: 'feed' });
    expect(feedResp.text).toContain('EigenFlux feed result (server=eigenflux):');
    expect(feedResp.text).toContain('"item_id": "901"');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('supports /eigenflux here and persists the current conversation route', async () => {
    const { default: plugin } = await import('./index');
    const commands: any[] = [];
    plugin.register({
      config: {},
      pluginConfig: {
        servers: [
          {
            name: 'eigenflux',
            endpoint: 'http://127.0.0.1:18080',
            workdir,
            sessionKey: 'agent:mengtian:feishu:direct:ou_current',
            agentId: 'mengtian',
            replyChannel: 'feishu',
            replyTo: 'user:ou_current',
            replyAccountId: 'default',
          },
        ],
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

    expect(hereResp.text).toContain(
      'EigenFlux server eigenflux will deliver to this conversation by default:'
    );
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
    const sessionStorePath = path.join(
      homeDir,
      '.openclaw',
      'agents',
      'main',
      'sessions',
      'sessions.json'
    );
    fs.mkdirSync(path.dirname(sessionStorePath), { recursive: true });
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
        servers: [
          {
            name: 'eigenflux',
            endpoint: 'http://127.0.0.1:18080',
            workdir,
            sessionKey: 'agent:main:feishu:group:oc_current',
            agentId: 'main',
            replyChannel: 'feishu',
            replyTo: 'chat:oc_current',
            replyAccountId: 'default',
            sessionStorePath,
          },
        ],
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
        servers: [
          {
            name: 'eigenflux',
            endpoint: 'http://127.0.0.1:18080',
            workdir,
            sessionKey: 'agent:main:main',
          },
        ],
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

  test('registers one service per enabled server and injects server-specific skill paths', async () => {
    const eigenfluxWorkdir = path.join(workdir, 'eigenflux');
    const alphaWorkdir = path.join(workdir, 'alpha');
    fs.mkdirSync(eigenfluxWorkdir, { recursive: true });
    fs.mkdirSync(alphaWorkdir, { recursive: true });
    fs.writeFileSync(path.join(eigenfluxWorkdir, 'skill.md'), '# eigenflux local skill\n', 'utf-8');

    const { default: plugin } = await import('./index');
    const services: any[] = [];

    plugin.register({
      config: {},
      pluginConfig: {
        servers: [
          {
            name: 'eigenflux',
            workdir: eigenfluxWorkdir,
          },
          {
            name: 'alpha',
            endpoint: 'https://alpha.example.com',
            workdir: alphaWorkdir,
          },
        ],
      },
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    expect(services).toHaveLength(2);

    await services[0].start();
    await services[1].start();

    expect(sendAgentMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('network=eigenflux')
    );
    expect(sendAgentMessageMock).toHaveBeenCalledWith(
      expect.stringContaining(`skill_file=${path.join(eigenfluxWorkdir, 'skill.md')}`)
    );
    expect(sendAgentMessageMock).toHaveBeenCalledWith(expect.stringContaining('network=alpha'));
    expect(sendAgentMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('skill_file=https://alpha.example.com/skill.md')
    );

    await services[0].stop();
    await services[1].stop();
  });

  test('supports selecting a non-default server with --server', async () => {
    const eigenfluxWorkdir = path.join(workdir, 'eigenflux');
    const alphaWorkdir = path.join(workdir, 'alpha');
    fs.mkdirSync(eigenfluxWorkdir, { recursive: true });
    fs.mkdirSync(alphaWorkdir, { recursive: true });
    fs.writeFileSync(
      path.join(alphaWorkdir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_alpha_token' }),
      'utf-8'
    );

    const { default: plugin } = await import('./index');
    const commands: any[] = [];
    plugin.register({
      config: {},
      pluginConfig: {
        servers: [
          {
            name: 'eigenflux',
            workdir: eigenfluxWorkdir,
          },
          {
            name: 'alpha',
            endpoint: 'http://127.0.0.1:18080',
            workdir: alphaWorkdir,
          },
        ],
      },
      runtime: {},
      logger: createLogger(),
      registerService: jest.fn(),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    const authResp = await commands[0].handler({ args: '--server alpha auth' });
    expect(authResp.text).toContain('EigenFlux auth status (server=alpha):');
    expect(authResp.text).toContain(`workdir: ${alphaWorkdir}`);
    expect(authResp.text).toContain('status: available');

    const listResp = await commands[0].handler({ args: 'servers' });
    expect(listResp.text).toContain('EigenFlux servers:');
    expect(listResp.text).toContain('- eigenflux: enabled, default;');
    expect(listResp.text).toContain('- alpha: enabled;');
  });
});
