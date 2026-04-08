/**
 * Circuit Breaker for database and external service calls.
 *
 * Implements the pattern from SYSTEM-SPEC.md §7 "Database Error":
 *   - Retry once on failure
 *   - Open after 5 consecutive failures
 *   - Half-open after 30 seconds (allow one probe request)
 *   - Close on first success in half-open state
 *
 * Each CircuitBreaker instance is independent — create one per external
 * dependency (database, Redis, etc.) so that a failing DB does not block
 * Redis calls and vice versa.
 *
 * Usage:
 *   const dbBreaker = new CircuitBreaker({ label: 'database' });
 *   const result = await dbBreaker.execute(() => db.transfer.findMany(...));
 */

import { logger } from './logger';
import { retry, type RetryOptions } from './retry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 5. */
  failureThreshold?: number;
  /** Milliseconds to wait before transitioning from open → half-open. Default: 30000. */
  resetTimeoutMs?: number;
  /** Retry options applied to each call before counting it as a failure. */
  retryOptions?: Omit<RetryOptions, 'label'>;
  /** Label for log messages. Default: 'CircuitBreaker'. */
  label?: string;
}

export class CircuitBreakerOpenError extends Error {
  constructor(label: string) {
    super(`Circuit breaker "${label}" is open — call rejected`);
    this.name = 'CircuitBreakerOpenError';
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly retryOptions: Omit<RetryOptions, 'label'>;
  private readonly label: string;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS;
    this.retryOptions = options.retryOptions ?? { maxAttempts: 2 };
    this.label = options.label ?? 'CircuitBreaker';
  }

  /**
   * Execute `fn` through the circuit breaker.
   *
   * - Closed: calls pass through normally (with retry).
   * - Open: calls are rejected immediately with CircuitBreakerOpenError.
   * - Half-open: one probe call is allowed; success closes the circuit,
   *   failure re-opens it.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (this.shouldTransitionToHalfOpen()) {
        this.transitionTo('half-open');
      } else {
        throw new CircuitBreakerOpenError(this.label);
      }
    }

    try {
      const result = await retry(fn, {
        ...this.retryOptions,
        label: this.label,
      });
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Current circuit state — exposed for monitoring and testing. */
  getState(): CircuitState {
    if (this.state === 'open' && this.shouldTransitionToHalfOpen()) {
      return 'half-open';
    }
    return this.state;
  }

  /** Reset to closed state — useful in tests or manual intervention. */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private onSuccess(): void {
    if (this.state === 'half-open') {
      logger.info(`${this.label}: probe succeeded — circuit closed`, {
        previousFailures: this.consecutiveFailures,
      });
    }
    this.consecutiveFailures = 0;
    this.transitionTo('closed');
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      logger.warn(`${this.label}: probe failed — circuit re-opened`, {
        consecutiveFailures: this.consecutiveFailures,
      });
      this.transitionTo('open');
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      logger.error(`${this.label}: failure threshold reached — circuit opened`, {
        consecutiveFailures: this.consecutiveFailures,
        failureThreshold: this.failureThreshold,
        resetTimeoutMs: this.resetTimeoutMs,
      });
      this.transitionTo('open');
    }
  }

  private shouldTransitionToHalfOpen(): boolean {
    return Date.now() - this.lastFailureTime >= this.resetTimeoutMs;
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state !== newState) {
      this.state = newState;
    }
  }
}
