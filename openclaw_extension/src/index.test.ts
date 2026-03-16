import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

const sendMessageMock = jest.fn().mockResolvedValue({
  sessionKey: 'main',
  runId: 'run-test',
});

jest.mock('./acp-client', () => ({
  OpenClawAcpClient: jest.fn().mockImplementation(() => ({
    sendMessage: sendMessageMock,
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
  const originalApiUrl = process.env.EIGENFLUX_API_URL;
  const originalOpenClawHome = process.env.OPENCLAW_HOME;
  const originalGatewayUrl = process.env.EIGENFLUX_OPENCLAW_GATEWAY_URL;

  let openClawHome: string;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    openClawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-openclaw-home-'));
    process.env.OPENCLAW_HOME = openClawHome;
    process.env.EIGENFLUX_API_URL = 'http://127.0.0.1:18080';
    process.env.EIGENFLUX_OPENCLAW_GATEWAY_URL = 'ws://127.0.0.1:18789';
  });

  afterEach(() => {
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
    fs.rmSync(openClawHome, { recursive: true, force: true });
    delete (global as { fetch?: typeof fetch }).fetch;
  });

  test('sends ACP onboarding prompt when service starts without token', async () => {
    const { default: plugin } = await import('./index');
    const services: any[] = [];

    plugin.register({
      config: { enabled: true } as any,
      logger: createLogger(),
      registerService: (service: any) => services.push(service),
      registerCommand: jest.fn(),
      registerHook: jest.fn(),
      on: jest.fn(),
    } as any);

    await services[0].start();

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('[EIGENFLUX_AUTH_REQUIRED]')
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('eigenflux')
    );

    await services[0].stop();
  });

  test('supports /eigenflux auth, profile, and poll commands', async () => {
    const credentialsDir = path.join(openClawHome, 'eigenflux');
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialsDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_command_token' }),
      'utf-8'
    );

    const { default: plugin } = await import('./index');
    const commands: any[] = [];
    plugin.register({
      config: { enabled: true } as any,
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
  });
});
