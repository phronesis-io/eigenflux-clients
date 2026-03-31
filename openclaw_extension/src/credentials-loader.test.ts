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
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-workdir-'));
  });

  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('loads access token from credentials.json', () => {
    fs.writeFileSync(
      path.join(workdir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_file_token' }),
      'utf-8'
    );

    const loader = new CredentialsLoader(createLogger(), workdir);
    expect(loader.loadAccessToken()).toBe('at_file_token');
  });

  test('returns null when credentials file is missing', () => {
    const loader = new CredentialsLoader(createLogger(), workdir);
    expect(loader.loadAccessToken()).toBeNull();
  });

  test('returns expired auth state when credentials file token is stale', () => {
    fs.writeFileSync(
      path.join(workdir, 'credentials.json'),
      JSON.stringify({
        access_token: 'at_expired_token',
        expires_at: Date.now() - 1_000,
      }),
      'utf-8'
    );

    const loader = new CredentialsLoader(createLogger(), workdir);
    expect(loader.loadAuthState()).toEqual(
      expect.objectContaining({
        status: 'expired',
        source: 'file',
      })
    );
    expect(loader.loadAccessToken()).toBeNull();
  });

  test('saveAccessToken creates the workdir and writes credentials.json', () => {
    const nestedWorkdir = path.join(workdir, 'nested/eigenflux');
    const loader = new CredentialsLoader(createLogger(), nestedWorkdir);

    loader.saveAccessToken('at_saved_token', 'bot@example.com', 1_760_000_000_000);

    const credentialsPath = path.join(nestedWorkdir, 'credentials.json');
    expect(fs.existsSync(credentialsPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'))).toEqual({
      access_token: 'at_saved_token',
      email: 'bot@example.com',
      expires_at: 1_760_000_000_000,
    });
  });
});
