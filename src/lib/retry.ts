/**
 * Generic retry utility with exponential backoff.
 *
 * Used by resilient-rpc and circuit-breaker to retry transient failures.
 * Implements the "Retry 3x with backoff" pattern from SYSTEM-SPEC.md §7.
 *
 * Design decisions:
 *   - Pure function, no class — retry is a behaviour, not an entity.
 *   - Accepts an async operation and returns its result or throws after
 *     all attempts are exhausted.
 *   - Jitter prevents thundering-herd when multiple callers retry simultaneously.
 *   - Optional shouldRetry predicate lets callers skip retries for non-transient
 *     errors (e.g. 4xx HTTP responses, invalid arguments).
 */

import { logger } from './logger';

export interface RetryOptions {
  /** Maximum number of attempts (including the initial call). Default: 3. */
  maxAttempts?: number;
  /** Base delay in milliseconds before the first retry. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds. Default: 10000. */
  maxDelayMs?: number;
  /** Label for log messages (e.g. "RPC.getBlock", "DB.transfer.upsert"). */
  label?: string;
  /**
   * Predicate that decides whether to retry a given error.
   * Return false to bail out immediately (e.g. for non-transient errors).
   * Default: always retry.
   */
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10_000;

/**
 * Execute `fn` with exponential backoff retries.
 *
 * Delay formula: min(baseDelay * 2^attempt + jitter, maxDelay)
 * where jitter is a random value in [0, baseDelay) to spread retries.
 *
 * Throws the last error if all attempts fail.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    label = 'retry',
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !shouldRetry(error)) {
        break;
      }

      const jitter = Math.random() * baseDelayMs;
      const delay = Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs);

      logger.warn(`${label}: attempt ${attempt + 1}/${maxAttempts} failed — retrying in ${Math.round(delay)}ms`, {
        error: error instanceof Error ? error.message : String(error),
        attempt: attempt + 1,
        maxAttempts,
        delayMs: Math.round(delay),
      });

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
