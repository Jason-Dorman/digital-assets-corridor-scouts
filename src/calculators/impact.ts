/**
 * Liquidity Impact Calculator
 *
 * Estimates the market impact of a transfer relative to bridge pool liquidity.
 *
 * Formula and thresholds: docs/DATA-MODEL.md §8
 *
 * Key formula:
 *   poolSharePct       = (transferAmountUsd / poolTvlUsd) × 100
 *   estimatedSlippageBps = poolSharePct × slippageFactor
 */

import type { ImpactLevel, BridgeName } from '../types/index';
import { SLIPPAGE_FACTORS, IMPACT_THRESHOLDS } from '../lib/constants';
import { logger } from '../lib/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ImpactInput {
  /** Transfer amount in USD. Must be >= 0. */
  transferAmountUsd: number;
  /** Pool TVL in USD at the time of the estimate. */
  poolTvlUsd: number;
  /**
   * Bridge identifier. Unknown bridges fall back to a slippage factor of 1.0
   * (conservative) if a runtime cast bypasses the type constraint.
   */
  bridge: BridgeName;
}

export interface ImpactResult {
  /** Transfer as a percentage of pool TVL. Full precision — callers apply display rounding. */
  poolSharePct: number;
  /**
   * Estimated slippage in basis points.
   * Formula: poolSharePct × slippageFactor  (docs/DATA-MODEL.md §8.3)
   * Full precision — callers apply display rounding.
   */
  estimatedSlippageBps: number;
  impactLevel: ImpactLevel;
  /** Human-readable warning for moderate, high, and severe levels. Null otherwise. */
  warning: string | null;
}

// ---------------------------------------------------------------------------
// Disclaimer
// ---------------------------------------------------------------------------

/**
 * Required disclaimer for every API response that surfaces an ImpactResult.
 * Exported so the API route can attach it without duplicating the string.
 */
export const IMPACT_DISCLAIMER =
  'Directional estimate only. Not an execution guarantee.' as const;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns the slippage factor for a bridge.
 * Defaults to 1.0 (full pool-based slippage) for bridges not yet in the registry.
 */
function resolveSlippageFactor(bridge: BridgeName): number {
  // TypeScript guarantees coverage for valid BridgeName values, but a runtime
  // cast at the call site could still produce an unknown key, so keep the fallback.
  return SLIPPAGE_FACTORS[bridge] ?? 1.0;
}

/**
 * Maps raw pool share percentage to an impact level and warning string.
 * Uses the raw (pre-rounded) value so warning text is consistent with thresholds.
 * Warning precision: toFixed(2) per rounding spec (docs/DATA-MODEL.md §14).
 */
function classifyImpact(rawPoolSharePct: number): {
  impactLevel: ImpactLevel;
  warning: string | null;
} {
  if (rawPoolSharePct < IMPACT_THRESHOLDS.NEGLIGIBLE) {
    return { impactLevel: 'negligible', warning: null };
  }
  if (rawPoolSharePct < IMPACT_THRESHOLDS.LOW) {
    return { impactLevel: 'low', warning: null };
  }
  if (rawPoolSharePct < IMPACT_THRESHOLDS.MODERATE) {
    return {
      impactLevel: 'moderate',
      warning: `Your transfer is ${rawPoolSharePct.toFixed(2)}% of pool liquidity`,
    };
  }
  if (rawPoolSharePct < IMPACT_THRESHOLDS.HIGH) {
    return {
      impactLevel: 'high',
      warning: `Large transfer: ${rawPoolSharePct.toFixed(2)}% of pool. Consider splitting.`,
    };
  }
  return {
    impactLevel: 'severe',
    warning: `Transfer exceeds safe threshold (${rawPoolSharePct.toFixed(2)}% of pool). Split recommended.`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculate the liquidity impact of a transfer.
 *
 * Fail-safe on bad inputs: logs a warning and returns a conservative result
 * rather than throwing, so callers always receive a valid ImpactResult.
 *
 * @example
 *   calculateImpact({ transferAmountUsd: 500_000, poolTvlUsd: 10_000_000, bridge: 'across' })
 *   // → { poolSharePct: 5, estimatedSlippageBps: 2.5, impactLevel: 'moderate', warning: '...' }
 */
export function calculateImpact(input: ImpactInput): ImpactResult {
  const { transferAmountUsd, poolTvlUsd, bridge } = input;

  // Guard: NaN or Infinity in any numeric field — cannot produce a meaningful
  // result. Fail safe (severe) rather than propagate nonsense to callers.
  if (!Number.isFinite(transferAmountUsd) || !Number.isFinite(poolTvlUsd)) {
    logger.warn('[Impact] Invalid input – NaN or Infinity detected', {
      transferAmountUsd: String(input.transferAmountUsd),
      poolTvlUsd: String(input.poolTvlUsd),
      bridge: input.bridge,
    });
    return {
      poolSharePct: 100,
      estimatedSlippageBps: resolveSlippageFactor(bridge) * 100,
      impactLevel: 'severe',
      warning: 'Transfer exceeds safe threshold (100.00% of pool). Split recommended.',
    };
  }

  // Guard: negative transfer amount is not a valid input. Treat as zero rather
  // than returning a negative pool share that would corrupt downstream logic.
  if (transferAmountUsd < 0) {
    logger.warn('[Impact] Negative transferAmountUsd – treating as zero', {
      transferAmountUsd,
      bridge: input.bridge,
    });
    return {
      poolSharePct: 0,
      estimatedSlippageBps: 0,
      impactLevel: 'negligible',
      warning: null,
    };
  }

  // Step 1: Pool share percentage.
  // Zero or negative TVL means the pool is drained or the data fetch returned
  // corrupt data. Default to 100% pool share (worst-case) per spec §8.3.
  if (poolTvlUsd <= 0) {
    logger.warn('[Impact] Zero or negative poolTvlUsd – defaulting to 100% pool share', {
      poolTvlUsd,
      transferAmountUsd,
      bridge: input.bridge,
    });
  }

  const rawPoolSharePct: number =
    poolTvlUsd > 0 ? (transferAmountUsd / poolTvlUsd) * 100 : 100;

  // Step 2: Estimated slippage.
  // Formula: poolSharePct × slippageFactor  (docs/DATA-MODEL.md §8.3)
  const slippageFactor = resolveSlippageFactor(bridge);
  const rawSlippageBps = rawPoolSharePct * slippageFactor;

  // Step 3: Classify impact level and build warning from the raw share so the
  // warning text aligns with the unrounded value used for threshold comparison.
  const { impactLevel, warning } = classifyImpact(rawPoolSharePct);

  return {
    poolSharePct: rawPoolSharePct,
    estimatedSlippageBps: rawSlippageBps,
    impactLevel,
    warning,
  };
}
