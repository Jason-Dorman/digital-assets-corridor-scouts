/**
 * Shared statistical utility functions.
 *
 * Used by corridor-metrics, anomaly-detector, and API routes to avoid
 * duplicating percentile and success-rate calculations.
 */

/**
 * Compute the Nth percentile of an array of numbers using linear interpolation.
 * Returns 0 for empty arrays.
 *
 * Formula: DATA-MODEL.md §10.1
 */
export function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

/**
 * Calculate success rate as a percentage (0–100).
 *
 * Returns 100 when no transfers have resolved (total === 0) to avoid
 * division by zero. Callers should check for total === 0 separately if
 * they want to distinguish "no data" from "100% success".
 *
 * Formula: DATA-MODEL.md §10.2
 */
export function successRate(completed: number, failed: number, stuck: number): number {
  const total = completed + failed + stuck;
  return total === 0 ? 100 : (completed / total) * 100;
}
