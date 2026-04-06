/**
 * Shared rounding utilities for API response serialization.
 *
 * Internal calculations must NOT round intermediate values — only apply
 * rounding at the final serialization step.
 */

/** Round to 1 decimal place. Used for estimatedSlippageBps. */
export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Round to 2 decimal places. Used for most USD values, percentages. */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Round to 3 decimal places.
 *
 * Used for LFV (lfv24h) where thresholds sit at the 2nd decimal place
 * (e.g. -0.03, -0.10). Rounding to 2 decimals would destroy threshold
 * visibility — consumers couldn't tell which side of -0.10 they're on.
 */
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
