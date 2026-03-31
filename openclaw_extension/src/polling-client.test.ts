import { PLUGIN_CONFIG } from './config';
import { EigenFluxPollingClient } from './polling-client';
import { Logger } from './logger';

function createLoggerSpies() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function createLogger(spies = createLoggerSpies()): Logger {
  return new Logger(spies);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('EigenFluxPollingClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('polls feed and forwards the full payload to callback', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);

    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            items: [
              {
                item_id: 'item-101',
                group_id: 'group-101',
                summary: 'Important signal',
                broadcast_type: 'info',
                updated_at: 1760000000000,
              },
            ],
            has_more: false,
            notifications: [
              {
                notification_id: 'notif-1',
                type: 'system',
                content: 'Feed refreshed successfully',
                created_at: 1760000000100,
              },
            ],
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )
    ) as typeof fetch;

    const client = new EigenFluxPollingClient({
      apiUrl: 'http://127.0.0.1:8080',
      getAuthState: () => ({
        status: 'available',
        accessToken: 'at_test_token',
        source: 'file',
        credentialsPath: '/tmp/eigenflux/credentials.json',
      }),
      pollIntervalSec: 60,
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired,
    });

    const result = await client.pollOnce();

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'success',
      })
    );
    expect(onFeedPolled).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 0,
        data: expect.objectContaining({
          items: [
            expect.objectContaining({
              item_id: 'item-101',
              summary: 'Important signal',
            }),
          ],
          notifications: [
            expect.objectContaining({
              notification_id: 'notif-1',
            }),
          ],
        }),
      })
    );
    expect(onAuthRequired).not.toHaveBeenCalled();
  });

  test('emits auth-required callback when token is missing', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);

    const client = new EigenFluxPollingClient({
      apiUrl: 'http://127.0.0.1:8080',
      getAuthState: () => ({
        status: 'missing',
        credentialsPath: '/tmp/eigenflux/credentials.json',
      }),
      pollIntervalSec: 60,
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired,
    });

    const result = await client.pollOnce();

    expect(result).toEqual({
      kind: 'auth_required',
      authEvent: {
        reason: 'missing_token',
        credentialsPath: '/tmp/eigenflux/credentials.json',
        source: undefined,
        expiresAt: undefined,
      },
    });
    expect(onAuthRequired).toHaveBeenCalledWith({
      reason: 'missing_token',
      credentialsPath: '/tmp/eigenflux/credentials.json',
      source: undefined,
      expiresAt: undefined,
    });
    expect(onFeedPolled).not.toHaveBeenCalled();
    expect(global.fetch).toBe(originalFetch);
  });

  test('emits auth-required callback when feed returns 401', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);

    global.fetch = jest.fn().mockResolvedValue(
      new Response('', {
        status: 401,
        statusText: 'Unauthorized',
      })
    ) as typeof fetch;

    const client = new EigenFluxPollingClient({
      apiUrl: 'http://127.0.0.1:8080',
      getAuthState: () => ({
        status: 'available',
        accessToken: 'at_test_token',
        source: 'file',
        credentialsPath: '/tmp/eigenflux/credentials.json',
      }),
      pollIntervalSec: 60,
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired,
    });

    const result = await client.pollOnce();

    expect(result).toEqual({
      kind: 'auth_required',
      authEvent: {
        reason: 'unauthorized',
        credentialsPath: '/tmp/eigenflux/credentials.json',
        source: 'file',
        expiresAt: undefined,
        statusCode: 401,
      },
    });
    expect(onAuthRequired).toHaveBeenCalledWith({
      reason: 'unauthorized',
      credentialsPath: '/tmp/eigenflux/credentials.json',
      source: 'file',
      expiresAt: undefined,
      statusCode: 401,
    });
    expect(onFeedPolled).not.toHaveBeenCalled();
  });

  test('sends plugin metadata headers on feed requests', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);

    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: { items: [], has_more: false, notifications: [] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ) as typeof fetch;

    const client = new EigenFluxPollingClient({
      apiUrl: 'http://127.0.0.1:8080',
      getAuthState: () => ({
        status: 'available',
        accessToken: 'at_test_token',
        source: 'file',
        credentialsPath: '/tmp/eigenflux/credentials.json',
      }),
      pollIntervalSec: 60,
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired,
    });

    await client.pollOnce();

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers['User-Agent']).toContain('node/');
    expect(headers['User-Agent']).not.toContain('eigenflux-plugin');
    expect(headers['X-Plugin-Ver']).toBe(PLUGIN_CONFIG.PLUGIN_VERSION);
    expect(headers['X-Host-Kind']).toBe(PLUGIN_CONFIG.HOST_KIND);
  });

  test('logs detailed fetch failure diagnostics', async () => {
    const loggerSpies = createLoggerSpies();
    const networkCause = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:8080'),
      {
        code: 'ECONNREFUSED',
        errno: -61,
        syscall: 'connect',
        address: '127.0.0.1',
        port: 8080,
      }
    );

    global.fetch = jest.fn().mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: networkCause })
    ) as typeof fetch;

    const client = new EigenFluxPollingClient({
      apiUrl: 'http://127.0.0.1:8080',
      getAuthState: () => ({
        status: 'available',
        accessToken: 'at_test_token',
        source: 'file',
        credentialsPath: '/tmp/eigenflux/credentials.json',
      }),
      pollIntervalSec: 60,
      logger: createLogger(loggerSpies),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('error');
    expect(loggerSpies.error).toHaveBeenCalledWith(
      expect.stringContaining(
        '[EigenFlux] Failed to poll feed (url=http://127.0.0.1:8080/api/v1/items/feed?action=refresh&limit=20): TypeError: fetch failed'
      )
    );
    expect(loggerSpies.error).toHaveBeenCalledWith(
      expect.stringContaining('cause=Error: connect ECONNREFUSED 127.0.0.1:8080')
    );
    expect(loggerSpies.error).toHaveBeenCalledWith(
      expect.stringContaining('code=ECONNREFUSED')
    );
    expect(loggerSpies.error).toHaveBeenCalledWith(
      expect.stringContaining('address=127.0.0.1')
    );
    expect(loggerSpies.error).toHaveBeenCalledWith(
      expect.stringContaining('port=8080')
    );
  });

  test('does not re-enter feed polling while a previous poll is still running', async () => {
    const loggerSpies = createLoggerSpies();
    const responseDeferred = createDeferred<Response>();

    global.fetch = jest.fn().mockReturnValue(responseDeferred.promise) as typeof fetch;

    const client = new EigenFluxPollingClient({
      apiUrl: 'http://127.0.0.1:8080',
      getAuthState: () => ({
        status: 'available',
        accessToken: 'at_test_token',
        source: 'file',
        credentialsPath: '/tmp/eigenflux/credentials.json',
      }),
      pollIntervalSec: 60,
      logger: createLogger(loggerSpies),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const firstPoll = client.pollOnce();
    const secondPoll = client.pollOnce();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[EigenFlux] Skipping feed poll because a previous poll is still in progress'
      )
    );

    responseDeferred.resolve(
      new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: { items: [], has_more: false, notifications: [] },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const [firstResult, secondResult] = await Promise.all([firstPoll, secondPoll]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.kind).toBe('success');
  });
});
