import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Shared variable so the os mock factory always returns the test-controlled homeDir
let __testHomeDir: string | undefined;

jest.mock('os', () => {
  const actual = jest.requireActual('os') as typeof import('os');
  return {
    ...actual,
    homedir: jest.fn(() => __testHomeDir ?? actual.homedir()),
  };
});

// Mock discoverServers and resolveEigenfluxHome from config
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

// Mock execEigenflux from cli-executor
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

// Mock EigenFluxPollingClient with inline feed polling behavior
let capturedPollOnFeedPolled: ((payload: any) => Promise<void>) | null = null;
let capturedPollOnAuthRequired: ((event: any) => Promise<void>) | null = null;
const pollingClientStartMock = jest.fn().mockResolvedValue(undefined);
const pollingClientStopMock = jest.fn();
const pollingClientPollOnceMock = jest.fn();

jest.mock('./polling-client', () => ({
  EigenFluxPollingClient: jest.fn().mockImplementation((config: any) => {
    capturedPollOnFeedPolled = config.onFeedPolled;
    capturedPollOnAuthRequired = config.onAuthRequired;
    return {
      start: pollingClientStartMock,
      stop: pollingClientStopMock,
      pollOnce: pollingClientPollOnceMock,
    };
  }),
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
  let eigenfluxHome: string;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-openclaw-home-'));
    eigenfluxHome = path.join(homeDir, '.eigenflux');
    fs.mkdirSync(eigenfluxHome, { recursive: true });
    __testHomeDir = homeDir;
    resolveEigenfluxHomeMock.mockReturnValue(eigenfluxHome);

    // Reset captured callbacks
    capturedPollOnFeedPolled = null;
    capturedPollOnAuthRequired = null;

    // Default eigenflux CLI response so session-route-memory reads succeed (unset key).
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: undefined });
  });

  afterEach(() => {
    __testHomeDir = undefined;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test('sends auth prompt through runtime.subagent when service starts without token', async () => {
    const serverDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
    fs.mkdirSync(serverDir, { recursive: true });
    // No credentials.json, so auth is required

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'eigenflux', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    // When the polling client starts, it will call pollOnce, which triggers onAuthRequired
    pollingClientStartMock.mockImplementation(async () => {
      if (capturedPollOnAuthRequired) {
        await capturedPollOnAuthRequired({ reason: 'auth_required' });
      }
    });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-auth' });

    plugin.register({
      config: {},
      pluginConfig: {},
      runtime: {
        subagent: { run: subagentRun },
      },
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    // There should be a single discovery service
    expect(services).toHaveLength(1);
    expect(services[0].id).toBe('eigenflux:discovery');

    await services[0].start();

    expect(subagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'main',
        message: expect.stringContaining('[EIGENFLUX_AUTH_REQUIRED]'),
        deliver: true,
      })
    );
    const promptMessage = String(subagentRun.mock.calls[0]?.[0]?.message);
    expect(promptMessage).toContain('server=eigenflux');
    expect(promptMessage).toContain(`homedir=${eigenfluxHome}`);
    expect(promptMessage).toContain('eigenflux auth login --email <email> -s eigenflux');

    await services[0].stop();
  });

  test('supports /eigenflux auth command with discovered servers', async () => {
    const serverDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_command_token' }),
      'utf-8'
    );

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'eigenflux', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];

    plugin.register({
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    // Start the discovery service to populate runtimes
    await services[0].start();

    expect(commands).toHaveLength(1);
    const command = commands[0];

    const authResp = await command.handler({ args: 'auth' });
    expect(authResp.text).toContain('EigenFlux auth status (server=eigenflux):');
    expect(authResp.text).toContain('status: available');
    expect(authResp.text).toContain('at_com');

    await services[0].stop();
  });

  test('supports /eigenflux profile command via CLI', async () => {
    const serverDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
    fs.mkdirSync(serverDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'eigenflux', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: {
        code: 0,
        msg: 'success',
        data: {
          agent: { id: '1', name: 'bot' },
          profile: { status: 3, keywords: ['ai'] },
          influence: { total_items: 1 },
        },
      },
    });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];

    plugin.register({
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    const profileResp = await commands[0].handler({ args: 'profile' });
    expect(profileResp.text).toContain('EigenFlux profile (server=eigenflux):');
    expect(profileResp.text).toContain('"name": "bot"');

    await services[0].stop();
  });

  test('supports /eigenflux feed command via polling client', async () => {
    const serverDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
    fs.mkdirSync(serverDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'eigenflux', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    pollingClientPollOnceMock.mockResolvedValue({
      kind: 'success',
      payload: {
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
      },
    });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];

    plugin.register({
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    const feedResp = await commands[0].handler({ args: 'feed' });
    expect(feedResp.text).toContain('EigenFlux feed result (server=eigenflux):');
    expect(feedResp.text).toContain('"item_id": "901"');

    await services[0].stop();
  });

  test('supports /eigenflux here and persists the current conversation route', async () => {
    const serverDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
    fs.mkdirSync(serverDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'eigenflux', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];
    plugin.register({
      config: {},
      pluginConfig: {
        serverRouting: {
          eigenflux: {
            sessionKey: 'agent:mengtian:feishu:direct:ou_current',
            agentId: 'mengtian',
            replyChannel: 'feishu',
            replyTo: 'user:ou_current',
            replyAccountId: 'default',
          },
        },
      },
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

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

    // Persistence now happens via `eigenflux config set --key openclaw_deliver_session`
    const configSetCall = execEigenfluxMock.mock.calls.find(([, args]: any[]) =>
      Array.isArray(args) &&
      args[0] === 'config' &&
      args[1] === 'set' &&
      args.includes('openclaw_deliver_session')
    );
    expect(configSetCall).toBeDefined();
    const [, argv] = configSetCall!;
    const valueIndex = argv.indexOf('--value') + 1;
    const serverIndex = argv.indexOf('--server') + 1;
    expect(argv[serverIndex]).toBe('eigenflux');
    const remembered = JSON.parse(argv[valueIndex]) as Record<string, unknown>;
    expect(remembered.sessionKey).toBe('agent:mengtian:feishu:direct:ou_current');
    expect(remembered.agentId).toBe('mengtian');
    expect(remembered.replyChannel).toBe('feishu');
    expect(remembered.replyTo).toBe('user:ou_current');
    expect(remembered.replyAccountId).toBe('default');

    await services[0].stop();
  });

  test('prefers runtime.subagent delivery when available', async () => {
    const serverDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
    fs.mkdirSync(serverDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'eigenflux', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    pollingClientStartMock.mockImplementation(async () => {
      if (capturedPollOnAuthRequired) {
        await capturedPollOnAuthRequired({ reason: 'auth_required' });
      }
    });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-subagent' });

    plugin.register({
      config: {},
      pluginConfig: {},
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
      sessionKey: 'main',
      message: expect.stringContaining('[EIGENFLUX_AUTH_REQUIRED]'),
      deliver: true,
      idempotencyKey: expect.any(String),
    });

    await services[0].stop();
  });

  test('starts feed poller and stream client for each discovered server', async () => {
    const eigenfluxDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
    const alphaDir = path.join(eigenfluxHome, 'servers', 'alpha');
    fs.mkdirSync(eigenfluxDir, { recursive: true });
    fs.mkdirSync(alphaDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'eigenflux', endpoint: 'https://www.eigenflux.ai', current: true },
      { name: 'alpha', endpoint: 'https://alpha.example.com', current: false },
    ] });

    const { default: plugin } = await import('./index');
    const services: any[] = [];

    plugin.register({
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    expect(services).toHaveLength(1);
    await services[0].start();

    // Both pollers and stream clients should be started
    expect(pollingClientStartMock).toHaveBeenCalledTimes(2);
    expect(streamClientStartMock).toHaveBeenCalledTimes(2);

    await services[0].stop();
  });

  test('supports selecting a non-default server with --server', async () => {
    const eigenfluxDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
    const alphaDir = path.join(eigenfluxHome, 'servers', 'alpha');
    fs.mkdirSync(eigenfluxDir, { recursive: true });
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.writeFileSync(
      path.join(alphaDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_alpha_token' }),
      'utf-8'
    );

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'eigenflux', endpoint: 'https://www.eigenflux.ai', current: true },
      { name: 'alpha', endpoint: 'http://127.0.0.1:18080', current: false },
    ] });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];
    plugin.register({
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    const authResp = await commands[0].handler({ args: '--server alpha auth' });
    expect(authResp.text).toContain('EigenFlux auth status (server=alpha):');
    expect(authResp.text).toContain('status: available');

    const listResp = await commands[0].handler({ args: 'servers' });
    expect(listResp.text).toContain('EigenFlux servers (discovered via CLI):');
    expect(listResp.text).toContain('- eigenflux:');
    expect(listResp.text).toContain('- alpha:');

    await services[0].stop();
  });

  test('shows pm stream status via /eigenflux pm command', async () => {
    const serverDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
    fs.mkdirSync(serverDir, { recursive: true });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'eigenflux', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });
    streamClientIsRunningMock.mockReturnValue(true);
    streamClientGetLastCursorMock.mockReturnValue('cursor-123');

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const commands: any[] = [];

    plugin.register({
      config: {},
      pluginConfig: {},
      runtime: {},
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: (command: any) => commands.push(command),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    const pmResp = await commands[0].handler({ args: 'pm' });
    expect(pmResp.text).toContain('EigenFlux PM stream status (server=eigenflux):');
    expect(pmResp.text).toContain('streaming: active');
    expect(pmResp.text).toContain('last_cursor: cursor-123');

    await services[0].stop();
  });

  test('delivers install prompt when eigenflux CLI is not installed', async () => {
    discoverServersMock.mockResolvedValue({
      kind: 'not_installed',
      bin: 'eigenflux',
    });

    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-install' });

    plugin.register({
      config: {},
      pluginConfig: {},
      runtime: {
        subagent: { run: subagentRun },
      },
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    expect(pollingClientStartMock).not.toHaveBeenCalled();
    expect(streamClientStartMock).not.toHaveBeenCalled();
    expect(
      fs.existsSync(path.join(eigenfluxHome, 'bootstrap'))
    ).toBe(false);
    expect(subagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('[EIGENFLUX_NOT_INSTALLED]'),
        deliver: true,
      })
    );
    expect(String(subagentRun.mock.calls[0]?.[0]?.message)).toContain(
      'curl -fsSL https://eigenflux.ai/install.sh | bash'
    );
    expect(subagentRun).toHaveBeenCalledTimes(1);

    // second start should not deliver again (guarded) unless stop() resets it
    await services[0].start();
    expect(subagentRun).toHaveBeenCalledTimes(1);

    await services[0].stop();
  });
});
