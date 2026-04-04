/**
 * Shared rounding utility for API response serialization.
 *
 * Rule: all numeric values displayed in API responses are rounded to 2 decimal
 * places. Internal calculations must NOT round intermediate values — only apply
 * rounding at the final serialization step.
 */
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
