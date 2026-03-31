/**
 * Liquidity Flight Velocity (LFV) Calculator
 *
 * Measures the rate of net stablecoin liquidity change across monitored bridge
 * pools per chain. This is the ONE structural metric exposed in Phase 0.
 *
 * Formula and thresholds: docs/DATA-MODEL.md §9
 *
 * Key formulas:
 *   netFlow       = tvlNow - tvlStart
 *   lfv           = netFlow / tvlStart
 *   lfv24h        = lfv × (24 / timeWindowHours)   ← normalized to 24 h
 *   lfvAnnualized = lfv24h × 365
 *
 * Design note: this is a pure function — all TVL data is fetched by the caller
 * (API route / service layer) before calling calculateLFV. This keeps the
 * calculator testable and decoupled from the database.
 */

import type { LFVInterpretation } from '../types/index';
import { LFV_THRESHOLDS } from '../lib/constants';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LFVInput {
  /** Chain identifier (e.g. 'ethereum', 'base'). */
  chain: string;
  /** Aggregate stablecoin TVL across all monitored pools at the start of the window (USD). */
  tvlStartUsd: number;
  /** Aggregate stablecoin TVL across all monitored pools at the current time (USD). */
  tvlNowUsd: number;
  /**
   * Width of the measurement window in hours. Default 24.
   * LFV is normalized to a 24 h rate regardless of window size.
   * Must be > 0.
   */
  timeWindowHours: number;
  /** Number of stablecoin pools included in the TVL aggregation. Informational only. */
  poolsMonitored: number;
}

export interface LFVResult {
  chain: string;
  /**
   * Net flow rate normalized to 24 hours.
   * Decimal fraction: -0.10 = -10%.
   */
  lfv24h: number;
  /** lfv24h × 365. Annualized projection of the current 24 h rate. */
  lfvAnnualized: number;
  interpretation: LFVInterpretation;
  /** Net flow in USD (tvlNow − tvlStart). Negative = outflow. */
  netFlowUsd: number;
  tvlStartUsd: number;
  tvlNowUsd: number;
  poolsMonitored: number;
}

// ---------------------------------------------------------------------------
// Interpretation helper (exported for independent testing and API reuse)
// ---------------------------------------------------------------------------

/**
 * Maps a normalized 24 h LFV rate to an interpretation label.
 *
 * Thresholds (docs/DATA-MODEL.md §9, §7.5):
 *   lfv24h < -0.10  → rapid_flight
 *   lfv24h < -0.03  → moderate_outflow
 *   lfv24h <  0.03  → stable
 *   lfv24h <  0.10  → moderate_inflow
 *   lfv24h ≥  0.10  → rapid_inflow
 *
 * Boundaries use strict less-than, so values at exactly ±3 % and ±10 % fall
 * into the more-active category. This is intentional: a 10 % daily rate IS
 * rapid, not merely moderate.
 */
export function interpretLFV(lfv24h: number): LFVInterpretation {
  if (lfv24h < LFV_THRESHOLDS.RAPID_FLIGHT)    return 'rapid_flight';
  if (lfv24h < LFV_THRESHOLDS.MODERATE_OUTFLOW) return 'moderate_outflow';
  if (lfv24h < LFV_THRESHOLDS.MODERATE_INFLOW)  return 'stable';
  if (lfv24h < LFV_THRESHOLDS.RAPID_INFLOW)     return 'moderate_inflow';
  return 'rapid_inflow';
}

// ---------------------------------------------------------------------------
// Main calculator
// ---------------------------------------------------------------------------

/**
 * Calculate Liquidity Flight Velocity for a chain.
 *
 * Fail-safe on bad inputs: logs a warning and returns a zeroed stable result
 * rather than throwing, so callers always receive a valid LFVResult.
 *
 * @example
 *   calculateLFV({
 *     chain: 'base',
 *     tvlStartUsd: 50_000_000,
 *     tvlNowUsd:   42_000_000,
 *     timeWindowHours: 24,
 *     poolsMonitored: 3,
 *   })
 *   // → { lfv24h: -0.16, interpretation: 'rapid_flight', netFlowUsd: -8_000_000, … }
 */
export function calculateLFV(input: LFVInput): LFVResult {
  const { chain, tvlStartUsd, tvlNowUsd, timeWindowHours, poolsMonitored } = input;

  // Guard: NaN or Infinity in any numeric field — cannot produce a meaningful
  // result. Fail safe (zeroed stable) rather than propagate nonsense to callers.
  if (
    !Number.isFinite(tvlStartUsd) ||
    !Number.isFinite(tvlNowUsd) ||
    !Number.isFinite(timeWindowHours) ||
    !Number.isFinite(poolsMonitored)
  ) {
    console.warn('[LFV] Invalid input – NaN or Infinity detected', input);
    return buildStableZero(chain, tvlNowUsd, poolsMonitored);
  }

  // Guard: time window must be positive to avoid dividing by zero when
  // normalizing to 24 h (lfv24h = lfv × 24 / timeWindowHours).
  if (timeWindowHours <= 0) {
    console.warn('[LFV] Invalid timeWindowHours – must be > 0', input);
    return buildStableZero(chain, tvlNowUsd, poolsMonitored);
  }

  // Guard: zero or negative tvlStart means there is no baseline to measure
  // against. Per spec §9 (§7.3), return zeroed stable when tvlStart === 0.
  // Negative values indicate data corruption; also return zeroed stable but
  // emit an additional warning so affected records can be traced.
  if (tvlStartUsd <= 0) {
    if (tvlStartUsd < 0) {
      console.warn('[LFV] Negative tvlStartUsd – pool data may be corrupt', input);
    }
    return buildStableZero(chain, tvlNowUsd, poolsMonitored);
  }

  // Step 1: Net flow (positive = inflow, negative = outflow).
  const netFlow = tvlNowUsd - tvlStartUsd;

  // Step 2: Raw LFV ratio over the actual measurement window.
  const lfv = netFlow / tvlStartUsd;

  // Step 3: Normalize to a 24 h rate.
  const lfv24h = lfv * (24 / timeWindowHours);

  // Step 4: Annualize (informational — not used for thresholds).
  const lfvAnnualized = lfv24h * 365;

  // Step 5: Interpret.
  const interpretation = interpretLFV(lfv24h);

  return {
    chain,
    lfv24h,
    lfvAnnualized,
    interpretation,
    netFlowUsd: netFlow,
    tvlStartUsd,
    tvlNowUsd,
    poolsMonitored,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns a zeroed stable result. Used when LFV cannot be computed because
 * the denominator (tvlStart) is zero/negative, or inputs contain NaN/Infinity.
 *
 * tvlNowUsd and poolsMonitored are passed through so callers can still surface
 * the current observed state even when the rate cannot be determined.
 * Both are safety-clamped to 0 in case they themselves were corrupt.
 */
function buildStableZero(
  chain: string,
  tvlNowUsd: number,
  poolsMonitored: number,
): LFVResult {
  return {
    chain,
    lfv24h: 0,
    lfvAnnualized: 0,
    interpretation: 'stable',
    netFlowUsd: 0,
    tvlStartUsd: 0,
    tvlNowUsd: Number.isFinite(tvlNowUsd) ? tvlNowUsd : 0,
    poolsMonitored: Number.isFinite(poolsMonitored) ? poolsMonitored : 0,
  };
}
