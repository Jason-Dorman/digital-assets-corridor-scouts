/**
 * Health Calculator
 *
 * Classifies a corridor's health status based on success rate, latency relative
 * to historical baseline, and transfer volume.
 *
 * Formula and thresholds: docs/DATA-MODEL.md §8 (labeled Section 10 in file).
 *
 * Evaluation order (must not be changed — spec §8.2):
 *   1. DOWN     – successRate < 95  OR latencyMultiplier > 5  OR transferCount === 0
 *   2. DEGRADED – successRate < 99  OR latencyMultiplier > 2
 *   3. HEALTHY  – default
 */

import type { HealthStatus } from '../types/index';
import { HEALTH_THRESHOLDS } from '../lib/constants';
import { logger } from '../lib/logger';

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface HealthInput {
  /** Success rate over the last hour as a percentage (0–100). */
  successRate1h: number;
  /** Current p90 settlement latency in seconds. Must be ≥ 0. */
  currentP90: number;
  /** 7-day historical p90 latency in seconds. 0 means no baseline exists. */
  historicalP90: number;
  /**
   * Number of transfers initiated in the last hour.
   * Must be a non-negative integer. Strict equality to 0 triggers DOWN.
   */
  transferCount1h: number;
  /**
   * Optional caller context included verbatim in structured log output.
   * Pass bridge, corridor, or chain identifiers so warnings can be traced
   * without additional wrapping.
   *
   * @example
   * calculateHealthStatus({ ..., context: { bridge: 'across', corridor: 'across_ethereum_arbitrum' } })
   */
  context?: Record<string, unknown>;
}

export interface HealthResult {
  /** Classified health status. */
  status: HealthStatus;
  /**
   * Ratio of currentP90 to historicalP90.
   * 1.0 when historicalP90 ≤ 0 (no usable baseline — see latency multiplier note below).
   * 0.0 when currentP90 was clamped to 0 (clock skew).
   * null when a data integrity guard fired (NaN, Infinity, or negative transferCount).
   */
  latencyMultiplier: number | null;
  /** Clamped success rate (0–100) used for classification. */
  successRate1h: number;
  /** Transfer count used for classification (floored if non-integer). */
  transferCount1h: number;
  /** Human-readable explanation of the classification. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

/**
 * Classify corridor health status.
 *
 * **Latency multiplier note:** when `historicalP90 ≤ 0` (corridor has no
 * 7-day history, or baseline is negative from clock skew), the multiplier
 * defaults to `1.0`. This means a brand-new corridor cannot be flagged as
 * DOWN or DEGRADED via the latency signal alone. Negative values are clamped
 * to 0 (same treatment as `currentP90` clock skew). A `warn` log is emitted
 * so callers can decide whether to treat the missing baseline as an
 * additional risk signal.
 *
 * **Success rate note:** values outside 0–100 are clamped with a `warn` log.
 * Clamping to 0 (rather than returning an error) is consistent with the
 * fragility calculator's handling of out-of-range utilization.
 *
 * **Transfer count note:** non-integer values are floored with a `warn` log
 * before classification. `Math.floor(0.3)` becomes `0`, which then correctly
 * triggers the DOWN condition via strict equality (`=== 0`).
 */
export function calculateHealthStatus(input: HealthInput): HealthResult {
  const { context } = input;

  // ------------------------------------------------------------------
  // Guard: NaN or Infinity — cannot trust any part of the calculation.
  // Fail-safe to DOWN rather than silently returning a wrong status.
  // ------------------------------------------------------------------
  if (
    !Number.isFinite(input.successRate1h) ||
    !Number.isFinite(input.currentP90) ||
    !Number.isFinite(input.historicalP90) ||
    !Number.isFinite(input.transferCount1h)
  ) {
    logger.warn('[Health] Invalid input – NaN or Infinity detected', {
      successRate1h: input.successRate1h,
      currentP90: input.currentP90,
      historicalP90: input.historicalP90,
      transferCount1h: input.transferCount1h,
      ...context,
    });
    return {
      status: 'down',
      latencyMultiplier: null,
      successRate1h: 0,
      transferCount1h: 0,
      reason: 'Data integrity error – unable to calculate',
    };
  }

  // ------------------------------------------------------------------
  // Guard: negative transfer count — upstream data corruption.
  // Fail-safe to DOWN.
  // ------------------------------------------------------------------
  if (input.transferCount1h < 0) {
    logger.warn('[Health] Negative transferCount1h – upstream data error', {
      transferCount1h: input.transferCount1h,
      ...context,
    });
    return {
      status: 'down',
      latencyMultiplier: null,
      successRate1h: 0,
      transferCount1h: input.transferCount1h,
      reason: 'Data integrity error – negative transfer count',
    };
  }

  // ------------------------------------------------------------------
  // Guard: fractional transferCount — upstream data anomaly. Floor to
  // nearest integer with a warning. Math.floor(0.3) → 0, which then
  // correctly triggers the DOWN condition for zero transfers.
  // ------------------------------------------------------------------
  let { transferCount1h } = input;
  if (!Number.isInteger(transferCount1h)) {
    logger.warn('[Health] Non-integer transferCount1h – flooring', {
      transferCount1h,
      ...context,
    });
    transferCount1h = Math.floor(transferCount1h);
  }

  // ------------------------------------------------------------------
  // Guard: negative currentP90 — can occur due to clock skew between
  // source and destination chains (CLAUDE.md §Troubleshooting). Clamp
  // to 0; latency multiplier will then be 0 (no latency signal fires).
  // ------------------------------------------------------------------
  let { currentP90 } = input;
  if (currentP90 < 0) {
    logger.warn('[Health] Negative currentP90 – possible clock skew, clamping to 0', {
      currentP90,
      ...context,
    });
    currentP90 = 0;
  }

  // ------------------------------------------------------------------
  // Guard: successRate1h out of range (0–100). Clamp with a warning so
  // upstream data corruption is surfaced without crashing the pipeline.
  // ------------------------------------------------------------------
  let { successRate1h } = input;
  if (successRate1h < 0 || successRate1h > 100) {
    logger.warn('[Health] successRate1h out of range – clamping', {
      successRate1h,
      ...context,
    });
    successRate1h = Math.max(0, Math.min(100, successRate1h));
  }

  // ------------------------------------------------------------------
  // Guard: negative historicalP90 — clock-skew in baseline latency
  // data (same root cause as negative currentP90). Clamp to 0; the
  // multiplier then defaults to 1.0 (no usable baseline).
  // ------------------------------------------------------------------
  let historicalP90 = input.historicalP90;
  if (historicalP90 < 0) {
    logger.warn(
      '[Health] Negative historicalP90 – possible clock skew in baseline, clamping to 0',
      { historicalP90, ...context },
    );
    historicalP90 = 0;
  } else if (historicalP90 === 0) {
    logger.warn(
      '[Health] historicalP90 is zero – latency multiplier defaulted to 1 (no baseline)',
      { currentP90, historicalP90, ...context },
    );
  }

  // ------------------------------------------------------------------
  // Latency multiplier (spec §8.2 / §8.4).
  //
  // historicalP90 > 0  → ratio of current to historical baseline
  // historicalP90 === 0 → no baseline; default to 1.0 (neutral)
  // ------------------------------------------------------------------
  const latencyMultiplier =
    historicalP90 > 0 ? currentP90 / historicalP90 : 1;

  // ------------------------------------------------------------------
  // DOWN conditions — evaluated first (spec §8.2).
  // Each is an independent OR; the first match wins.
  // ------------------------------------------------------------------
  if (successRate1h < HEALTH_THRESHOLDS.SUCCESS_RATE_DOWN) {
    return {
      status: 'down',
      latencyMultiplier,
      successRate1h,
      transferCount1h,
      reason: `Low success rate (${successRate1h.toFixed(1)}%)`,
    };
  }

  if (latencyMultiplier > HEALTH_THRESHOLDS.LATENCY_DOWN_MULTIPLIER) {
    return {
      status: 'down',
      latencyMultiplier,
      successRate1h,
      transferCount1h,
      reason: `High latency (${latencyMultiplier.toFixed(1)}x normal)`,
    };
  }

  if (transferCount1h === 0) {
    return {
      status: 'down',
      latencyMultiplier,
      successRate1h,
      transferCount1h,
      reason: 'No transfers in last hour',
    };
  }

  // ------------------------------------------------------------------
  // DEGRADED conditions.
  // Each is an independent OR; the first match wins.
  // ------------------------------------------------------------------
  if (successRate1h < HEALTH_THRESHOLDS.SUCCESS_RATE_HEALTHY) {
    return {
      status: 'degraded',
      latencyMultiplier,
      successRate1h,
      transferCount1h,
      reason: `Degraded success rate (${successRate1h.toFixed(1)}%)`,
    };
  }

  if (latencyMultiplier > HEALTH_THRESHOLDS.LATENCY_DEGRADED_MULTIPLIER) {
    return {
      status: 'degraded',
      latencyMultiplier,
      successRate1h,
      transferCount1h,
      reason: `Elevated latency (${latencyMultiplier.toFixed(1)}x normal)`,
    };
  }

  // ------------------------------------------------------------------
  // HEALTHY — default.
  // ------------------------------------------------------------------
  return {
    status: 'healthy',
    latencyMultiplier,
    successRate1h,
    transferCount1h,
    reason: 'All systems normal',
  };
}
