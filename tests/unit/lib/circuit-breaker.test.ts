/**
 * Tests for src/lib/circuit-breaker.ts
 *
 * Strategy:
 *   - Logger is mocked to capture state transition messages.
 *   - Timers are faked so resetTimeout transitions can be tested without real waits.
 *   - retry is tested separately — here we focus on circuit state transitions
 *     and the interaction between consecutive failures and the breaker states.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('../../../src/lib/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from '../../../src/lib/circuit-breaker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.useFakeTimers();
  mockLoggerInfo.mockClear();
  mockLoggerWarn.mockClear();
  mockLoggerError.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

/** Create a breaker with fast thresholds for testing. */
function createBreaker(overrides: Record<string, unknown> = {}): CircuitBreaker {
  return new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 5000,
    retryOptions: { maxAttempts: 1 }, // no internal retry — isolate breaker logic
    label: 'test-breaker',
    ...overrides,
  });
}

/** Fail the breaker N times to push it toward/past the threshold. */
async function failNTimes(breaker: CircuitBreaker, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    try {
      await breaker.execute(() => Promise.reject(new Error(`fail-${i}`)));
    } catch {
      // expected
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CircuitBreaker', () => {
  // -------------------------------------------------------------------------
  // Closed state (normal operation)
  // -------------------------------------------------------------------------

  describe('closed state', () => {
    it('starts in closed state', () => {
      const breaker = createBreaker();
      expect(breaker.getState()).toBe('closed');
    });

    it('passes through successful calls', async () => {
      const breaker = createBreaker();
      const result = await breaker.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
      expect(breaker.getState()).toBe('closed');
    });

    it('stays closed when failures are below threshold', async () => {
      const breaker = createBreaker({ failureThreshold: 5 });

      await failNTimes(breaker, 4);

      expect(breaker.getState()).toBe('closed');
    });

    it('resets failure count after a success', async () => {
      const breaker = createBreaker({ failureThreshold: 3 });

      // 2 failures, then a success, then 2 more failures — should NOT open
      await failNTimes(breaker, 2);
      await breaker.execute(() => Promise.resolve('reset'));
      await failNTimes(breaker, 2);

      expect(breaker.getState()).toBe('closed');
    });

    it('propagates errors to the caller', async () => {
      const breaker = createBreaker();

      await expect(
        breaker.execute(() => Promise.reject(new Error('caller-sees-this'))),
      ).rejects.toThrow('caller-sees-this');
    });
  });

  // -------------------------------------------------------------------------
  // Transition to open
  // -------------------------------------------------------------------------

  describe('closed → open transition', () => {
    it('opens after reaching failure threshold', async () => {
      const breaker = createBreaker({ failureThreshold: 3 });

      await failNTimes(breaker, 3);

      expect(breaker.getState()).toBe('open');
    });

    it('logs an error when opening', async () => {
      const breaker = createBreaker({ failureThreshold: 3 });

      await failNTimes(breaker, 3);

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('circuit opened'),
        expect.objectContaining({
          consecutiveFailures: 3,
          failureThreshold: 3,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Open state (rejecting calls)
  // -------------------------------------------------------------------------

  describe('open state', () => {
    it('rejects calls immediately with CircuitBreakerOpenError', async () => {
      const breaker = createBreaker({ failureThreshold: 3 });
      await failNTimes(breaker, 3);

      await expect(
        breaker.execute(() => Promise.resolve('should-not-run')),
      ).rejects.toThrow(CircuitBreakerOpenError);
    });

    it('does not execute the function when open', async () => {
      const breaker = createBreaker({ failureThreshold: 3 });
      await failNTimes(breaker, 3);

      const fn = jest.fn().mockResolvedValue('nope');
      try {
        await breaker.execute(fn);
      } catch {
        // expected
      }
      expect(fn).not.toHaveBeenCalled();
    });

    it('CircuitBreakerOpenError includes the breaker label', async () => {
      const breaker = createBreaker({ failureThreshold: 3, label: 'db-breaker' });
      await failNTimes(breaker, 3);

      try {
        await breaker.execute(() => Promise.resolve('x'));
        fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CircuitBreakerOpenError);
        expect((err as Error).message).toContain('db-breaker');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Open → half-open transition
  // -------------------------------------------------------------------------

  describe('open → half-open transition', () => {
    it('transitions to half-open after resetTimeout elapses', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });
      await failNTimes(breaker, 3);
      expect(breaker.getState()).toBe('open');

      jest.advanceTimersByTime(5000);

      expect(breaker.getState()).toBe('half-open');
    });

    it('stays open before resetTimeout elapses', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });
      await failNTimes(breaker, 3);

      jest.advanceTimersByTime(4999);

      expect(breaker.getState()).toBe('open');
    });
  });

  // -------------------------------------------------------------------------
  // Half-open state (probe)
  // -------------------------------------------------------------------------

  describe('half-open state', () => {
    it('closes on successful probe', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });
      await failNTimes(breaker, 3);

      jest.advanceTimersByTime(5000);

      const result = await breaker.execute(() => Promise.resolve('probe-ok'));
      expect(result).toBe('probe-ok');
      expect(breaker.getState()).toBe('closed');
    });

    it('logs info when probe succeeds and circuit closes', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });
      await failNTimes(breaker, 3);

      jest.advanceTimersByTime(5000);
      await breaker.execute(() => Promise.resolve('ok'));

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining('circuit closed'),
        expect.any(Object),
      );
    });

    it('re-opens on failed probe', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });
      await failNTimes(breaker, 3);

      jest.advanceTimersByTime(5000);

      try {
        await breaker.execute(() => Promise.reject(new Error('probe-fail')));
      } catch {
        // expected
      }

      expect(breaker.getState()).toBe('open');
    });

    it('logs a warning when probe fails and circuit re-opens', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });
      await failNTimes(breaker, 3);

      jest.advanceTimersByTime(5000);

      try {
        await breaker.execute(() => Promise.reject(new Error('probe-fail')));
      } catch {
        // expected
      }

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('re-opened'),
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle
  // -------------------------------------------------------------------------

  describe('full lifecycle: closed → open → half-open → closed', () => {
    it('recovers after transient outage', async () => {
      const breaker = createBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });

      // Phase 1: closed → open
      await failNTimes(breaker, 3);
      expect(breaker.getState()).toBe('open');

      // Phase 2: wait for half-open
      jest.advanceTimersByTime(5000);
      expect(breaker.getState()).toBe('half-open');

      // Phase 3: successful probe → closed
      const result = await breaker.execute(() => Promise.resolve('back'));
      expect(result).toBe('back');
      expect(breaker.getState()).toBe('closed');

      // Phase 4: normal operation resumes
      const result2 = await breaker.execute(() => Promise.resolve('normal'));
      expect(result2).toBe('normal');
    });
  });

  // -------------------------------------------------------------------------
  // reset() method
  // -------------------------------------------------------------------------

  describe('reset()', () => {
    it('resets an open breaker to closed', async () => {
      const breaker = createBreaker({ failureThreshold: 3 });
      await failNTimes(breaker, 3);
      expect(breaker.getState()).toBe('open');

      breaker.reset();

      expect(breaker.getState()).toBe('closed');

      // Should work normally after reset
      const result = await breaker.execute(() => Promise.resolve('after-reset'));
      expect(result).toBe('after-reset');
    });
  });

  // -------------------------------------------------------------------------
  // Default options
  // -------------------------------------------------------------------------

  describe('default options', () => {
    it('creates a breaker with defaults (failureThreshold=5, resetTimeout=30s)', async () => {
      const breaker = new CircuitBreaker({ retryOptions: { maxAttempts: 1 } });

      // Should take 5 failures to open with defaults
      await failNTimes(breaker, 4);
      expect(breaker.getState()).toBe('closed');

      await failNTimes(breaker, 1);
      expect(breaker.getState()).toBe('open');

      // Should need 30s to transition to half-open
      jest.advanceTimersByTime(29_999);
      expect(breaker.getState()).toBe('open');

      jest.advanceTimersByTime(1);
      expect(breaker.getState()).toBe('half-open');
    });
  });
});
