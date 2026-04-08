/**
 * Resilient RPC call wrapper with retry and fallback.
 *
 * Implements the RPC error handling strategy from SYSTEM-SPEC.md §7:
 *   1. Retry 3x with exponential backoff
 *   2. Fall back to alternate RPC provider (if configured)
 *   3. Return cached data and mark stale (caller decides caching)
 *
 * This module wraps arbitrary RPC operations — it does not replace rpc.ts
 * (which manages provider instances). Instead, callers pass the operation
 * to execute and this module adds resilience around it.
 *
 * Usage:
 *   const block = await resilientRpcCall(
 *     () => provider.getBlock(blockNumber),
 *     { label: 'getBlock', chain: 'ethereum' },
 *   );
 */

import { JsonRpcProvider } from 'ethers';

import { retry } from './retry';
import { logger } from './logger';
import { CHAIN_IDS, type ChainName } from './constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResilientRpcOptions {
  /** Human-readable label for log messages. */
  label?: string;
  /** Chain to use for fallback provider lookup. */
  chain?: ChainName;
  /** Maximum retry attempts before trying fallback. Default: 3. */
  maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// Fallback provider cache
// ---------------------------------------------------------------------------

/**
 * Fallback RPC URLs per chain. Uses public endpoints as a last resort.
 * These are rate-limited and slower, but prevent total outage when
 * the primary Alchemy endpoint is down.
 */
const FALLBACK_RPC_URLS: Partial<Record<ChainName, string>> = {
  ethereum: 'https://eth.llamarpc.com',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  optimism: 'https://mainnet.optimism.io',
  base: 'https://mainnet.base.org',
  polygon: 'https://polygon-rpc.com',
  avalanche: 'https://api.avax.network/ext/bc/C/rpc',
};

const fallbackProviderCache = new Map<ChainName, JsonRpcProvider>();

function getFallbackProvider(chain: ChainName): JsonRpcProvider | null {
  const cached = fallbackProviderCache.get(chain);
  if (cached) return cached;

  const url = FALLBACK_RPC_URLS[chain];
  if (!url) return null;

  const provider = new JsonRpcProvider(url, CHAIN_IDS[chain]);
  fallbackProviderCache.set(chain, provider);
  return provider;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute an RPC operation with retry and optional fallback.
 *
 * The `fn` callback receives a JsonRpcProvider and returns a Promise.
 * On primary failure (after retries), if a chain is specified, the same
 * operation is attempted once against the fallback provider.
 */
export async function resilientRpcCall<T>(
  fn: (provider?: JsonRpcProvider) => Promise<T>,
  options: ResilientRpcOptions = {},
): Promise<T> {
  const { label = 'RPC', chain, maxAttempts = 3 } = options;

  // Attempt with primary provider (retries built-in)
  try {
    return await retry(() => fn(), {
      maxAttempts,
      label: `${label}:primary`,
      shouldRetry: isTransientRpcError,
    });
  } catch (primaryError) {
    // If no chain specified, we can't try a fallback
    if (!chain) {
      throw primaryError;
    }

    const fallback = getFallbackProvider(chain);
    if (!fallback) {
      logger.error(`${label}: primary failed and no fallback available`, {
        chain,
        error: primaryError instanceof Error ? primaryError.message : String(primaryError),
      });
      throw primaryError;
    }

    // Single attempt on fallback — don't retry aggressively on public endpoints
    logger.warn(`${label}: primary exhausted — trying fallback`, { chain });
    try {
      return await fn(fallback);
    } catch (fallbackError) {
      logger.error(`${label}: fallback also failed`, {
        chain,
        primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
        fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      throw fallbackError;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine if an RPC error is transient and worth retrying.
 *
 * Non-transient errors (invalid params, method not found) should not be
 * retried — they will fail every time.
 */
function isTransientRpcError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;

  const message = error.message.toLowerCase();

  // Non-transient JSON-RPC errors
  const nonTransient = [
    'invalid argument',
    'invalid params',
    'method not found',
    'execution reverted',
  ];

  return !nonTransient.some(pattern => message.includes(pattern));
}
