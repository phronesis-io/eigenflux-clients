import { EigenFluxPollingClient } from './polling-client';
import { Logger } from './logger';
import type { CliResult } from './cli-executor';

jest.mock('./cli-executor');

import { execEigenflux } from './cli-executor';

const execEigenfluxMock = execEigenflux as jest.MockedFunction<typeof execEigenflux>;

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
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('polls feed via CLI and forwards the full payload to callback', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
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
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
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
        msg: 'success',
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

    // Verify CLI was called with correct arguments
    expect(execEigenfluxMock).toHaveBeenCalledWith(
      'eigenflux',
      ['feed', 'poll', '--limit', '20', '--action', 'refresh', '-s', 'eigenflux', '-f', 'json'],
      expect.objectContaining({ logger: expect.any(Logger) })
    );
  });

  test('emits auth-required callback when CLI returns auth_required', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'auth_required',
      stderr: 'token expired',
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      pollIntervalSec: 60,
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired,
    });

    const result = await client.pollOnce();

    expect(result).toEqual({
      kind: 'auth_required',
      authEvent: {
        reason: 'auth_required',
      },
    });
    expect(onAuthRequired).toHaveBeenCalledWith({
      reason: 'auth_required',
    });
    expect(onFeedPolled).not.toHaveBeenCalled();
  });

  test('returns error result when CLI command fails', async () => {
    const loggerSpies = createLoggerSpies();

    execEigenfluxMock.mockResolvedValue({
      kind: 'error',
      error: new Error('connect ECONNREFUSED 127.0.0.1:8080'),
      exitCode: 1,
      stderr: 'connection failed',
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      pollIntervalSec: 60,
      logger: createLogger(loggerSpies),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('error');
  });

  test('does not re-enter feed polling while a previous poll is still running', async () => {
    const loggerSpies = createLoggerSpies();
    const cliDeferred = createDeferred<CliResult<any>>();

    execEigenfluxMock.mockReturnValue(cliDeferred.promise);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      pollIntervalSec: 60,
      logger: createLogger(loggerSpies),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const firstPoll = client.pollOnce();
    const secondPoll = client.pollOnce();

    expect(execEigenfluxMock).toHaveBeenCalledTimes(1);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Skipping feed poll because a previous poll is still in progress'
      )
    );

    cliDeferred.resolve({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const [firstResult, secondResult] = await Promise.all([firstPoll, secondPoll]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.kind).toBe('success');
  });

  test('does not notify feed callback when items and notifications are empty', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      pollIntervalSec: 60,
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('success');
    expect(onFeedPolled).not.toHaveBeenCalled();
  });
});
