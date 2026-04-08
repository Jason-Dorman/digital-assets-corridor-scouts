/**
 * Database circuit breaker.
 *
 * Wraps database calls through a CircuitBreaker per SYSTEM-SPEC.md §7:
 *   - Retry once on failure
 *   - Open after 5 consecutive failures
 *   - Half-open after 30 seconds
 *   - Close on first success in half-open state
 *
 * API routes use dbBreaker.execute(() => db.transfer.findMany(...)) to
 * benefit from automatic retry + circuit breaking without changing
 * every Prisma call site.
 *
 * When the circuit is open, callers receive a CircuitBreakerOpenError.
 * API routes should catch this and return cached/stale data or a 503.
 */

import { CircuitBreaker } from './circuit-breaker';

export const dbBreaker = new CircuitBreaker({
  label: 'database',
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  retryOptions: { maxAttempts: 2 },
});
