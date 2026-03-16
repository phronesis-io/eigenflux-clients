import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CredentialsLoader } from './credentials-loader';
import { Logger } from './logger';

function createLogger(): Logger {
  return new Logger({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  });
}

describe('CredentialsLoader', () => {
  let openClawHome: string;
  const envKey = 'EIGENFLUX_ACCESS_TOKEN';
  const openClawHomeKey = 'OPENCLAW_HOME';

  beforeEach(() => {
    openClawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-openclaw-home-'));
    delete process.env[envKey];
    delete process.env[openClawHomeKey];
  });

  afterEach(() => {
    delete process.env[envKey];
    delete process.env[openClawHomeKey];
    fs.rmSync(openClawHome, { recursive: true, force: true });
  });

  test('prefers openclaw credentials file over environment variable', () => {
    process.env[envKey] = 'at_env_token';
    const credentialsDir = path.join(openClawHome, 'eigenflux');
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialsDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_file_token' }),
      'utf-8'
    );

    const loader = new CredentialsLoader(createLogger(), openClawHome);
    expect(loader.loadAccessToken()).toBe('at_file_token');
  });

  test('uses environment variable when credentials file does not exist', () => {
    process.env[envKey] = 'at_env_token';
    const loader = new CredentialsLoader(createLogger(), openClawHome);
    expect(loader.loadAccessToken()).toBe('at_env_token');
  });

  test('uses OPENCLAW_HOME when constructor path is not provided', () => {
    process.env[openClawHomeKey] = openClawHome;
    const credentialsDir = path.join(openClawHome, 'eigenflux');
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialsDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_file_token_from_env_home' }),
      'utf-8'
    );

    const loader = new CredentialsLoader(createLogger());
    expect(loader.loadAccessToken()).toBe('at_file_token_from_env_home');
  });

  test('returns null when neither credentials file nor env token is available', () => {
    const loader = new CredentialsLoader(createLogger(), openClawHome);
    expect(loader.loadAccessToken()).toBeNull();
  });

  test('returns expired auth state when credentials file token is stale', () => {
    const credentialsDir = path.join(openClawHome, 'eigenflux');
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialsDir, 'credentials.json'),
      JSON.stringify({
        access_token: 'at_expired_token',
        expires_at: Date.now() - 1_000,
      }),
      'utf-8'
    );

    const loader = new CredentialsLoader(createLogger(), openClawHome);
    expect(loader.loadAuthState()).toEqual(
      expect.objectContaining({
        status: 'expired',
        source: 'file',
      })
    );
    expect(loader.loadAccessToken()).toBeNull();
  });

  test('saveAccessToken creates the eigenflux directory and writes credentials.json', () => {
    const loader = new CredentialsLoader(createLogger(), openClawHome);

    loader.saveAccessToken('at_saved_token', 'bot@example.com', 1_760_000_000_000);

    const credentialsPath = path.join(openClawHome, 'eigenflux', 'credentials.json');
    expect(fs.existsSync(credentialsPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'))).toEqual({
      access_token: 'at_saved_token',
      email: 'bot@example.com',
      expires_at: 1_760_000_000_000,
    });
  });
});
