/**
 * Anomaly Detector
 *
 * Scans all monitored corridors and pools for three categories of anomaly:
 *
 *   1. Latency Spike  — current 1-hour p90 > 3× historical 7-day p90  (§9.1)
 *   2. Failure Cluster — failure rate > 10% of transfers in last hour   (§9.2)
 *   3. Liquidity Drop  — TVL drop > 15% in 24 hours per pool            (§9.3)
 *
 * For each detected anomaly an `anomalies` row is inserted with a severity
 * level (low / medium / high) and a `details` JSON payload that gives the
 * full data story: raw numbers, sample sizes, and the specific metric values
 * that triggered the alert.
 *
 * Designed to run every 15 minutes via Vercel Cron (DATA-MODEL.md §11.2).
 *
 * Thresholds:   DATA-MODEL.md §9.1–9.3   (ANOMALY_THRESHOLDS)
 * Severity:     DATA-MODEL.md §9.4        (ANOMALY_SEVERITY_THRESHOLDS)
 * Percentiles:  DATA-MODEL.md §10.1       (calculatePercentile)
 * Time windows: DATA-MODEL.md §11.1       (TIME_WINDOWS)
 */

import type { Prisma } from '@prisma/client';
import type { BridgeName } from '../lib/constants';

import { db } from '../lib/db';
import { logger } from '../lib/logger';
import { calculatePercentile } from '../lib/stats';
import {
  ANOMALY_THRESHOLDS,
  ANOMALY_SEVERITY_THRESHOLDS,
  STUCK_THRESHOLDS_SECONDS,
  TIME_WINDOWS,
} from '../lib/constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnomalySeverity = 'low' | 'medium' | 'high';

export interface AnomalyDetectorResult {
  /** Latency-spike anomaly records created this run. */
  latencySpikes: number;
  /** Failure-cluster anomaly records created this run. */
  failureClusters: number;
  /** Liquidity-drop anomaly records created this run. */
  liquidityDrops: number;
}

// ---------------------------------------------------------------------------
// Pure functions — exported for unit testing
// ---------------------------------------------------------------------------

// Re-export for existing test imports
export { calculatePercentile } from '../lib/stats';

/**
 * Whether `currentP90` constitutes a latency spike relative to `historicalP90`.
 *
 * Mirror of DATA-MODEL.md §9.1:
 *   returns true when currentP90 > historicalP90 × LATENCY_SPIKE_MULTIPLIER
 *
 * Returns false (no false-positive) when:
 *   - either input is not a finite number
 *   - historicalP90 ≤ 0 (no valid baseline to compare against)
 *   - currentP90 ≤ 0   (no measurable latency)
 */
export function detectsLatencySpike(currentP90: number, historicalP90: number): boolean {
  if (!Number.isFinite(currentP90) || !Number.isFinite(historicalP90)) return false;
  if (historicalP90 <= 0 || currentP90 <= 0) return false;
  return currentP90 > historicalP90 * ANOMALY_THRESHOLDS.LATENCY_SPIKE_MULTIPLIER;
}

/**
 * Whether `failedCount / totalCount` exceeds the failure-rate threshold.
 *
 * Mirror of DATA-MODEL.md §9.2:
 *   returns true when (failedCount / totalCount) × 100 > FAILURE_RATE_THRESHOLD
 *
 * Returns false when totalCount is 0 (explicit zero-denominator guard).
 */
export function detectsFailureCluster(failedCount: number, totalCount: number): boolean {
  if (totalCount === 0) return false;
  const failureRate = (failedCount / totalCount) * 100;
  return failureRate > ANOMALY_THRESHOLDS.FAILURE_RATE_THRESHOLD;
}

/**
 * Whether TVL has dropped more than the threshold relative to 24 h ago.
 *
 * Mirror of DATA-MODEL.md §9.3:
 *   dropPct = ((tvl24hAgo - tvlNow) / tvl24hAgo) × 100
 *   returns true when dropPct > LIQUIDITY_DROP_THRESHOLD
 *
 * Returns false (no false-positive) when:
 *   - either input is not a finite number
 *   - tvl24hAgo ≤ 0 (no baseline or CCTP placeholder row with tvl = 0)
 */
export function detectsLiquidityDrop(tvlNow: number, tvl24hAgo: number): boolean {
  if (!Number.isFinite(tvlNow) || !Number.isFinite(tvl24hAgo)) return false;
  if (tvl24hAgo <= 0) return false;
  const dropPct = ((tvl24hAgo - tvlNow) / tvl24hAgo) * 100;
  return dropPct > ANOMALY_THRESHOLDS.LIQUIDITY_DROP_THRESHOLD;
}

/**
 * Severity for a latency-spike anomaly given the observed multiplier
 * (currentP90 / historicalP90).  DATA-MODEL.md §9.4.
 *
 *   ≥ 10×  → high
 *   ≥ 5×   → medium
 *   otherwise (3–5×, triggered but below medium watermark) → low
 */
export function getLatencySpikeSeverity(multiplier: number): AnomalySeverity {
  if (multiplier >= ANOMALY_SEVERITY_THRESHOLDS.LATENCY_SPIKE.HIGH) return 'high';
  if (multiplier >= ANOMALY_SEVERITY_THRESHOLDS.LATENCY_SPIKE.MEDIUM) return 'medium';
  return 'low';
}

/**
 * Severity for a failure-cluster anomaly given the failure rate (0–100 %).
 * DATA-MODEL.md §9.4.
 *
 *   > 40%  → high
 *   > 20%  → medium
 *   otherwise (10–20%, triggered but below medium watermark) → low
 */
export function getFailureClusterSeverity(failureRate: number): AnomalySeverity {
  if (failureRate > ANOMALY_SEVERITY_THRESHOLDS.FAILURE_CLUSTER.HIGH) return 'high';
  if (failureRate > ANOMALY_SEVERITY_THRESHOLDS.FAILURE_CLUSTER.MEDIUM) return 'medium';
  return 'low';
}

/**
 * Severity for a liquidity-drop anomaly given the drop percentage (0–100 %).
 * DATA-MODEL.md §9.4.
 *
 *   > 40%  → high
 *   > 25%  → medium
 *   otherwise (15–25%, triggered but below medium watermark) → low
 */
export function getLiquidityDropSeverity(dropPct: number): AnomalySeverity {
  if (dropPct > ANOMALY_SEVERITY_THRESHOLDS.LIQUIDITY_DROP.HIGH) return 'high';
  if (dropPct > ANOMALY_SEVERITY_THRESHOLDS.LIQUIDITY_DROP.MEDIUM) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// AnomalyDetector
// ---------------------------------------------------------------------------

export class AnomalyDetector {
  /**
   * Run all three detection passes and return a count breakdown.
   *
   * The passes run concurrently; a failure in one does not abort the others.
   */
  async run(): Promise<AnomalyDetectorResult> {
    const now = new Date();

    const [latencySpikes, failureClusters, liquidityDrops] = await Promise.all([
      this.detectLatencySpikes(now).catch((error) => {
        logger.error('[AnomalyDetector] detectLatencySpikes failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return 0;
      }),
      this.detectFailureClusters(now).catch((error) => {
        logger.error('[AnomalyDetector] detectFailureClusters failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return 0;
      }),
      this.detectLiquidityDrops(now).catch((error) => {
        logger.error('[AnomalyDetector] detectLiquidityDrops failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        return 0;
      }),
    ]);

    const result: AnomalyDetectorResult = { latencySpikes, failureClusters, liquidityDrops };
    logger.info('[AnomalyDetector] Run complete', { ...result });
    return result;
  }

  // ---------------------------------------------------------------------------
  // 1. Latency Spike Detection  (DATA-MODEL.md §9.1)
  // ---------------------------------------------------------------------------

  /**
   * For every corridor that has completed transfers in the last 7 days, compare
   * the 1-hour p90 against the 7-day historical p90.
   *
   * A single bulk query fetches all eligible transfers; corridor grouping and
   * window splitting happen in memory to avoid N+1 DB calls.
   *
   * The two windows are kept mutually exclusive: historical = [−7d, −1h) and
   * current = [−1h, now]. This prevents an active spike from inflating the
   * baseline and dampening its own detection signal.
   *
   * Corridors with fewer than MIN_SAMPLE_SIZE completions in either window, or
   * already flagged this cron cycle, are skipped.
   */
  private async detectLatencySpikes(now: Date): Promise<number> {
    const sevenDaysAgo = new Date(now.getTime() - TIME_WINDOWS.SEVEN_DAYS * 1000);
    const oneHourAgo = new Date(now.getTime() - TIME_WINDOWS.ONE_HOUR * 1000);
    const recentWindow = new Date(now.getTime() - TIME_WINDOWS.CRON_INTERVAL * 1000);

    // Idempotency: skip corridors that already have a latency_spike anomaly
    // created this cron cycle, preventing duplicate rows on sustained spikes.
    const existingAnomalies = await db.anomaly.findMany({
      where: {
        anomalyType: 'latency_spike',
        detectedAt: { gte: recentWindow },
      },
      select: { corridorId: true },
    });
    const alreadyDetected = new Set(existingAnomalies.map((a) => a.corridorId));

    const transfers = await db.transfer.findMany({
      where: {
        status: 'completed',
        completedAt: { gte: sevenDaysAgo },
        durationSeconds: { not: null },
      },
      select: {
        bridge: true,
        sourceChain: true,
        destChain: true,
        durationSeconds: true,
        completedAt: true,
      },
      orderBy: { completedAt: 'desc' },
      take: ANOMALY_THRESHOLDS.MAX_TRANSFER_QUERY_ROWS,
    });

    if (transfers.length === ANOMALY_THRESHOLDS.MAX_TRANSFER_QUERY_ROWS) {
      logger.warn(
        '[AnomalyDetector] detectLatencySpikes: transfer query hit row cap — oldest data may be excluded',
        { cap: ANOMALY_THRESHOLDS.MAX_TRANSFER_QUERY_ROWS },
      );
    }

    // Group durations by corridor.
    // historical = [−7d, −1h)  — baseline, excludes the current spike window.
    // current    = [−1h, now]  — the window being evaluated.
    const historical = new Map<string, number[]>();
    const current = new Map<string, {
      bridge: string;
      sourceChain: string;
      destChain: string;
      durations: number[];
    }>();

    for (const t of transfers) {
      if (t.durationSeconds === null || t.completedAt === null) continue;

      const corridorId = `${t.bridge}_${t.sourceChain}_${t.destChain}`;

      if (t.completedAt >= oneHourAgo) {
        if (!current.has(corridorId)) {
          current.set(corridorId, {
            bridge: t.bridge,
            sourceChain: t.sourceChain,
            destChain: t.destChain,
            durations: [],
          });
        }
        const cur = current.get(corridorId);
        if (cur) cur.durations.push(t.durationSeconds);
      } else {
        // Historical baseline excludes the current window so an active spike
        // cannot dampen its own detection signal.
        if (!historical.has(corridorId)) historical.set(corridorId, []);
        const hist = historical.get(corridorId);
        if (hist) hist.push(t.durationSeconds);
      }
    }

    let created = 0;

    for (const [corridorId, info] of current.entries()) {
      if (alreadyDetected.has(corridorId)) continue;

      const historicalDurations = historical.get(corridorId) ?? [];

      // Require a minimum sample size in both windows so the p90 is meaningful.
      if (
        historicalDurations.length < ANOMALY_THRESHOLDS.MIN_SAMPLE_SIZE ||
        info.durations.length < ANOMALY_THRESHOLDS.MIN_SAMPLE_SIZE
      ) continue;

      const currentP90 = calculatePercentile(info.durations, 90);
      const historicalP90 = calculatePercentile(historicalDurations, 90);

      if (!detectsLatencySpike(currentP90, historicalP90)) continue;

      const multiplier = currentP90 / historicalP90;
      const severity = getLatencySpikeSeverity(multiplier);

      try {
        await db.anomaly.create({
          data: {
            anomalyType: 'latency_spike',
            corridorId,
            bridge: info.bridge as BridgeName,
            sourceChain: info.sourceChain,
            destChain: info.destChain,
            severity,
            detectedAt: now,
            details: {
              currentP90Seconds: Math.round(currentP90),
              historicalP90Seconds: Math.round(historicalP90),
              multiplier: Math.round(multiplier * 100) / 100,
              currentSampleSize: info.durations.length,
              historicalSampleSize: historicalDurations.length,
              windowCurrentHours: 1,
              windowHistoricalDays: 7,
            },
          },
        });

        created++;
        logger.info('[AnomalyDetector] Latency spike detected', {
          corridorId,
          currentP90Seconds: Math.round(currentP90),
          historicalP90Seconds: Math.round(historicalP90),
          multiplier: Math.round(multiplier * 100) / 100,
          severity,
        });
      } catch (error) {
        logger.error('[AnomalyDetector] Failed to create latency_spike anomaly', {
          corridorId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return created;
  }

  // ---------------------------------------------------------------------------
  // 2. Failure Cluster Detection  (DATA-MODEL.md §9.2)
  // ---------------------------------------------------------------------------

  /**
   * For every corridor with settled (non-pending) transfers in the last hour,
   * compute the failure rate = (stuck + failed) / (completed + stuck + failed).
   *
   * Pending transfers are excluded from both numerator and denominator —
   * consistent with calculateSuccessRate in DATA-MODEL.md §10.2.
   *
   * The query has a ceiling of (now − MIN_STUCK_THRESHOLD) so that only
   * transfers old enough to have been classified by the stuck-detector are
   * included. Transfers initiated within the minimum stuck window (30 min for
   * Across/Stargate) may still be legitimately pending; excluding them prevents
   * understating the failure rate due to unclassified transfers.
   *
   * Corridors with fewer than MIN_SAMPLE_SIZE settled transfers, or already
   * flagged this cron cycle, are skipped.
   */
  private async detectFailureClusters(now: Date): Promise<number> {
    const oneHourAgo = new Date(now.getTime() - TIME_WINDOWS.ONE_HOUR * 1000);
    const minStuckThreshold = Math.min(...Object.values(STUCK_THRESHOLDS_SECONDS));
    const settledCeiling = new Date(now.getTime() - minStuckThreshold * 1000);
    const recentWindow = new Date(now.getTime() - TIME_WINDOWS.CRON_INTERVAL * 1000);

    // Idempotency: skip corridors already flagged this cron cycle.
    const existingAnomalies = await db.anomaly.findMany({
      where: {
        anomalyType: 'failure_cluster',
        detectedAt: { gte: recentWindow },
      },
      select: { corridorId: true },
    });
    const alreadyDetected = new Set(existingAnomalies.map((a) => a.corridorId));

    const transfers = await db.transfer.findMany({
      where: {
        initiatedAt: { gte: oneHourAgo, lte: settledCeiling },
        status: { in: ['completed', 'stuck', 'failed'] },
      },
      select: {
        bridge: true,
        sourceChain: true,
        destChain: true,
        status: true,
      },
    });

    // Aggregate counts per corridor.
    const corridors = new Map<string, {
      bridge: string;
      sourceChain: string;
      destChain: string;
      completed: number;
      failed: number;
    }>();

    for (const t of transfers) {
      const corridorId = `${t.bridge}_${t.sourceChain}_${t.destChain}`;

      if (!corridors.has(corridorId)) {
        corridors.set(corridorId, {
          bridge: t.bridge,
          sourceChain: t.sourceChain,
          destChain: t.destChain,
          completed: 0,
          failed: 0,
        });
      }

      const entry = corridors.get(corridorId);
      if (entry && t.status === 'completed') {
        entry.completed++;
      } else if (entry) {
        // 'stuck' and 'failed' both count as failures (matches §10.2 logic)
        entry.failed++;
      }
    }

    let created = 0;

    for (const [corridorId, info] of corridors.entries()) {
      if (alreadyDetected.has(corridorId)) continue;

      const total = info.completed + info.failed;

      // Require a minimum sample size so the failure rate is statistically meaningful.
      if (total < ANOMALY_THRESHOLDS.MIN_SAMPLE_SIZE) continue;

      if (!detectsFailureCluster(info.failed, total)) continue;

      const failureRate = (info.failed / total) * 100;
      const severity = getFailureClusterSeverity(failureRate);

      try {
        await db.anomaly.create({
          data: {
            anomalyType: 'failure_cluster',
            corridorId,
            bridge: info.bridge as BridgeName,
            sourceChain: info.sourceChain,
            destChain: info.destChain,
            severity,
            detectedAt: now,
            details: {
              failureRate: Math.round(failureRate * 10) / 10,
              failedCount: info.failed,
              completedCount: info.completed,
              totalCount: total,
              windowHours: 1,
            },
          },
        });

        created++;
        logger.info('[AnomalyDetector] Failure cluster detected', {
          corridorId,
          failureRate: Math.round(failureRate * 10) / 10,
          failedCount: info.failed,
          totalCount: total,
          severity,
        });
      } catch (error) {
        logger.error('[AnomalyDetector] Failed to create failure_cluster anomaly', {
          corridorId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return created;
  }

  // ---------------------------------------------------------------------------
  // 3. Liquidity Drop Detection  (DATA-MODEL.md §9.3)
  // ---------------------------------------------------------------------------

  /**
   * For every pool, compare the most recent TVL snapshot against the closest
   * snapshot in the 20–25 hour look-back window.
   *
   * The baseline window [−25h, −20h] ensures:
   *   • Upper bound (−25h): captures a snapshot from around 24h ago.
   *   • Lower bound (−20h): excludes pools with < 20h of history, preventing
   *     initialization artifacts from triggering false alerts.
   *
   * CCTP placeholder rows (tvlUsd = 0) are handled safely: detectsLiquidityDrop
   * returns false when tvl24hAgo ≤ 0.
   *
   * Pool anomalies are scoped to a single chain (no destChain).
   * corridorId = poolId  (e.g. "across_ethereum_usdc").
   */
  private async detectLiquidityDrops(now: Date): Promise<number> {
    // baselineNearBound: the most-recent edge of the 24-hour baseline window
    // (closer to now). Upper bound is −20h; lower bound is −25h.
    const baselineNearBound = new Date(now.getTime() - (TIME_WINDOWS.TWENTY_FOUR_HOURS - 4 * 3600) * 1000);
    const baselineStart = new Date(now.getTime() - (TIME_WINDOWS.TWENTY_FOUR_HOURS + TIME_WINDOWS.ONE_HOUR) * 1000);
    const currentWindowStart = new Date(now.getTime() - TIME_WINDOWS.ONE_HOUR * 1000);
    const recentWindow = new Date(now.getTime() - TIME_WINDOWS.CRON_INTERVAL * 1000);

    // Idempotency: skip pools already flagged this cron cycle.
    const existingAnomalies = await db.anomaly.findMany({
      where: {
        anomalyType: 'liquidity_drop',
        detectedAt: { gte: recentWindow },
      },
      select: { corridorId: true },
    });
    const alreadyDetected = new Set(existingAnomalies.map((a) => a.corridorId));

    const [baselineSnaps, currentSnaps] = await Promise.all([
      db.poolSnapshot.findMany({
        where: {
          recordedAt: { gte: baselineStart, lte: baselineNearBound },
          tvlUsd: { not: null },
        },
        select: {
          poolId: true,
          bridge: true,
          chain: true,
          asset: true,
          tvlUsd: true,
          recordedAt: true,
        },
        orderBy: { recordedAt: 'desc' },
      }),
      db.poolSnapshot.findMany({
        where: {
          recordedAt: { gte: currentWindowStart },
          tvlUsd: { not: null },
        },
        select: {
          poolId: true,
          bridge: true,
          chain: true,
          asset: true,
          tvlUsd: true,
          recordedAt: true,
        },
        orderBy: { recordedAt: 'desc' },
      }),
    ]);

    // Keep the most recent snapshot per pool for each window.
    const baseline = this.latestPerPool(baselineSnaps);
    const current = this.latestPerPool(currentSnaps);

    let created = 0;

    for (const [poolId, curr] of current.entries()) {
      if (alreadyDetected.has(poolId)) continue;

      const base = baseline.get(poolId);
      if (!base) continue; // no baseline snapshot in the window — skip

      const tvlNow = this.decimalToNumber(curr.tvlUsd);
      const tvl24hAgo = this.decimalToNumber(base.tvlUsd);

      if (tvlNow === null || tvl24hAgo === null) continue;
      if (!detectsLiquidityDrop(tvlNow, tvl24hAgo)) continue;

      const dropPct = ((tvl24hAgo - tvlNow) / tvl24hAgo) * 100;
      const severity = getLiquidityDropSeverity(dropPct);

      try {
        await db.anomaly.create({
          data: {
            anomalyType: 'liquidity_drop',
            corridorId: poolId,
            bridge: curr.bridge,
            sourceChain: curr.chain,
            destChain: null,
            severity,
            detectedAt: now,
            details: {
              poolId,
              asset: curr.asset,
              chain: curr.chain,
              tvlNowUsd: Math.round(tvlNow),
              tvl24hAgoUsd: Math.round(tvl24hAgo),
              dropPct: Math.round(dropPct * 10) / 10,
              windowHours: 24,
              baselineRecordedAt: base.recordedAt.toISOString(),
              currentRecordedAt: curr.recordedAt.toISOString(),
            },
          },
        });

        created++;
        logger.info('[AnomalyDetector] Liquidity drop detected', {
          poolId,
          tvlNowUsd: Math.round(tvlNow),
          tvl24hAgoUsd: Math.round(tvl24hAgo),
          dropPct: Math.round(dropPct * 10) / 10,
          severity,
        });
      } catch (error) {
        logger.error('[AnomalyDetector] Failed to create liquidity_drop anomaly', {
          poolId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return created;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * From a list ordered by recordedAt DESC, return the first (most recent)
   * snapshot per poolId. Assumes the input is already sorted descending.
   */
  private latestPerPool<T extends { poolId: string }>(snapshots: T[]): Map<string, T> {
    const map = new Map<string, T>();
    for (const snap of snapshots) {
      if (!map.has(snap.poolId)) map.set(snap.poolId, snap);
    }
    return map;
  }

  /**
   * Safely convert a Prisma Decimal (or null) to a plain JS number.
   * Returns null when the value is null or the result is not finite,
   * so callers never receive NaN or Infinity.
   */
  private decimalToNumber(value: Prisma.Decimal | null): number | null {
    if (value === null) return null;
    const n = value.toNumber();
    return Number.isFinite(n) ? n : null;
  }
}
