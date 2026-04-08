/**
 * Tests for src/lib/retry.ts
 *
 * Strategy:
 *   - Logger is mocked to prevent console noise and to assert warning messages.
 *   - Timers are faked to avoid real delays in tests.
 *   - Tests cover: success on first try, success after retries, all attempts
 *     exhausted, shouldRetry bail-out, backoff delay calculation, and edge cases.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoggerWarn = jest.fn();

jest.mock('../../../src/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: jest.fn(),
  },
}));

import { retry } from '../../../src/lib/retry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  mockLoggerWarn.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

/**
 * Advance fake timers through a pending retry sleep.
 * retry() uses setTimeout internally — we flush pending timers so the
 * await in retry() resolves without actually waiting.
 */
async function flushRetryDelay(): Promise<void> {
  await jest.advanceTimersByTimeAsync(15_000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('retry', () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('returns the result on first successful call', async () => {
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await retry(fn, { maxAttempts: 3, label: 'test' });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('succeeds after transient failures', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('recovered');

    const promise = retry(fn, { maxAttempts: 3, baseDelayMs: 100, label: 'test' });

    // Flush the backoff sleep between attempt 1 and 2
    await flushRetryDelay();

    const result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('succeeds on the last attempt', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValueOnce('last-chance');

    const promise = retry(fn, { maxAttempts: 3, baseDelayMs: 50, label: 'test' });

    await flushRetryDelay();
    await flushRetryDelay();

    const result = await promise;
    expect(result).toBe('last-chance');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // Exhausted retries
  // -------------------------------------------------------------------------

  it('throws the last error when all attempts are exhausted', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockRejectedValueOnce(new Error('fail-3'));

    const promise = retry(fn, { maxAttempts: 3, baseDelayMs: 50, label: 'test' });

    // Attach a catch handler immediately to avoid unhandled rejection warnings,
    // then flush timers so the internal sleeps resolve.
    const caught = promise.catch((e: Error) => e);

    await flushRetryDelay();
    await flushRetryDelay();

    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('fail-3');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after a single attempt when maxAttempts is 1', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('one-shot'));

    await expect(
      retry(fn, { maxAttempts: 1, label: 'test' }),
    ).rejects.toThrow('one-shot');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // shouldRetry predicate
  // -------------------------------------------------------------------------

  it('stops retrying when shouldRetry returns false', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('non-transient'));

    await expect(
      retry(fn, {
        maxAttempts: 3,
        label: 'test',
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('non-transient');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('continues retrying when shouldRetry returns true', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');

    const promise = retry(fn, {
      maxAttempts: 3,
      baseDelayMs: 50,
      label: 'test',
      shouldRetry: () => true,
    });

    await flushRetryDelay();

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('shouldRetry receives the thrown error', async () => {
    const shouldRetry = jest.fn().mockReturnValue(false);
    const thrownError = new Error('specific');
    const fn = jest.fn().mockRejectedValue(thrownError);

    await expect(
      retry(fn, { maxAttempts: 3, label: 'test', shouldRetry }),
    ).rejects.toThrow('specific');

    expect(shouldRetry).toHaveBeenCalledWith(thrownError);
  });

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  it('logs a warning on each failed attempt (except the last)', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockRejectedValueOnce(new Error('fail-3'));

    const promise = retry(fn, { maxAttempts: 3, baseDelayMs: 50, label: 'myOp' });

    const caught = promise.catch((e: Error) => e);

    await flushRetryDelay();
    await flushRetryDelay();

    const error = await caught;
    expect((error as Error).message).toBe('fail-3');

    // Only attempts 1 and 2 log warnings; attempt 3 is the last and breaks out
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('myOp'),
      expect.objectContaining({ attempt: 1, maxAttempts: 3 }),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('myOp'),
      expect.objectContaining({ attempt: 2, maxAttempts: 3 }),
    );
  });

  // -------------------------------------------------------------------------
  // Delay capping
  // -------------------------------------------------------------------------

  it('respects maxDelayMs cap', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('ok');

    // baseDelay=5000, maxDelay=6000 → 5000 * 2^0 + jitter should be capped at 6000
    const promise = retry(fn, {
      maxAttempts: 3,
      baseDelayMs: 5000,
      maxDelayMs: 6000,
      label: 'test',
    });

    await flushRetryDelay();

    const result = await promise;
    expect(result).toBe('ok');

    // Verify the logged delay is at most maxDelayMs
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        delayMs: expect.any(Number),
      }),
    );
    const loggedDelay = (mockLoggerWarn.mock.calls[0][1] as { delayMs: number }).delayMs;
    expect(loggedDelay).toBeLessThanOrEqual(6000);
  });

  // -------------------------------------------------------------------------
  // Default options
  // -------------------------------------------------------------------------

  it('uses default options when none are provided', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('default-ok');

    const promise = retry(fn);

    await flushRetryDelay();

    const result = await promise;
    expect(result).toBe('default-ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Non-Error throws
  // -------------------------------------------------------------------------

  it('handles non-Error thrown values', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce('string-error')
      .mockResolvedValueOnce('ok');

    const promise = retry(fn, { maxAttempts: 2, baseDelayMs: 50, label: 'test' });

    await flushRetryDelay();

    const result = await promise;
    expect(result).toBe('ok');
  });
});
