/**
 * Fragility Calculator
 *
 * Classifies a bridge pool's fragility level based on utilization and
 * 24-hour net flow relative to TVL.
 *
 * Formula and thresholds: docs/DATA-MODEL.md §7
 */

import type { FragilityLevel } from '../types/index';
import { FRAGILITY_THRESHOLDS } from '../lib/constants';

export interface FragilityInput {
  /** Pool utilization as a percentage (0–100). */
  utilization: number;
  /** Total value locked in USD. */
  tvlUsd: number;
  /** Net flow over the last 24 hours in USD. Positive = inflow, negative = outflow. */
  netFlow24h: number;
}

export interface FragilityResult {
  level: FragilityLevel;
  utilization: number;
  netFlow24hPct: number;
  reason: string;
}

/**
 * Calculate pool fragility.
 *
 * Evaluation order:
 *   1. HIGH  – utilization > 60 %  OR  netFlow24hPct < -20 %
 *   2. MEDIUM – utilization > 30 %  OR  netFlow24hPct < -10 %
 *   3. LOW   – default (stable)
 */
export function calculateFragility(input: FragilityInput): FragilityResult {
  // Guard: NaN or Infinity in any input field means we cannot trust the
  // calculation. Fail safe (high) rather than fail silent (low).
  if (
    !Number.isFinite(input.utilization) ||
    !Number.isFinite(input.tvlUsd) ||
    !Number.isFinite(input.netFlow24h)
  ) {
    console.warn('[Fragility] Invalid input – NaN or Infinity detected', input);
    return { level: 'high', utilization: 0, netFlow24hPct: 0, reason: 'Data integrity error – unable to calculate' };
  }

  // Guard: zero or negative TVL means the pool is either drained or the data fetch
  // returned corrupt data. Both are fragile states; fail safe (high) rather than
  // computing a nonsensical or sign-flipped netFlow24hPct.
  //
  // Note: the DATA-MODEL.md §7.1 formula specifies `tvlUsd > 0 ? … : 0`, which
  // would return netFlow24hPct = 0 for zero TVL. We intentionally deviate by
  // returning HIGH immediately — fail-safe is safer than silently masking the
  // drain/corruption signal.
  if (input.tvlUsd <= 0) {
    console.warn('[Fragility] Zero or negative TVL – pool may be drained or data fetch failed', input);
    return { level: 'high', utilization: input.utilization, netFlow24hPct: 0, reason: 'Zero TVL detected' };
  }

  // Clamp utilization to the valid 0–100 range. Values outside this range
  // indicate upstream data corruption; log so affected records can be traced.
  let { utilization } = input;
  if (utilization < 0 || utilization > 100) {
    console.warn('[Fragility] Utilization out of range – clamping', { utilization });
    utilization = Math.max(0, Math.min(100, utilization));
  }

  const { tvlUsd, netFlow24h } = input;

  // Derive net-flow percentage relative to TVL.
  // Note: floating-point arithmetic at exact threshold boundaries (e.g. -20.0)
  // may produce values like -19.999999999999996. This is acceptable — a
  // difference of <0.001% has no practical impact on fragility classification.
  const netFlow24hPct: number = (netFlow24h / tvlUsd) * 100;

  // HIGH conditions (evaluated first per spec §7.2).
  // Both conditions are evaluated independently so that when both fire
  // simultaneously the reason string surfaces the full picture.
  const highUtil    = utilization > FRAGILITY_THRESHOLDS.HIGH_UTILIZATION;
  const highOutflow = netFlow24hPct < FRAGILITY_THRESHOLDS.HIGH_OUTFLOW;

  if (highUtil || highOutflow) {
    const reasons: string[] = [];
    if (highUtil)    reasons.push(`High utilization (${utilization.toFixed(0)}%)`);
    if (highOutflow) reasons.push(`Large outflow (${netFlow24hPct.toFixed(1)}% in 24h)`);
    return { level: 'high', utilization, netFlow24hPct, reason: reasons.join('; ') };
  }

  // MEDIUM conditions (same dual-visibility pattern).
  const medUtil    = utilization > FRAGILITY_THRESHOLDS.MEDIUM_UTILIZATION;
  const medOutflow = netFlow24hPct < FRAGILITY_THRESHOLDS.MEDIUM_OUTFLOW;

  if (medUtil || medOutflow) {
    const reasons: string[] = [];
    if (medUtil)    reasons.push(`Moderate utilization (${utilization.toFixed(0)}%)`);
    if (medOutflow) reasons.push(`Moderate outflow (${netFlow24hPct.toFixed(1)}% in 24h)`);
    return { level: 'medium', utilization, netFlow24hPct, reason: reasons.join('; ') };
  }

  // LOW – default.
  return {
    level: 'low',
    utilization,
    netFlow24hPct,
    reason: 'Pool is stable',
  };
}
