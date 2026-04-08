/**
 * GET /api/corridors/:corridorId
 *
 * Detailed view of a single corridor.
 *
 * Response schema: docs/API-SPEC.md CorridorDetailResponse
 * Corridor ID format: docs/DATA-MODEL.md §13.2 — {bridge}_{sourceChain}_{destChain}
 *
 * Returns:
 *   - corridor: current health + pool metrics (same shape as /api/corridors list)
 *   - recentTransfers: last 20 transfers
 *   - hourlyStats: last 24 hours, one bucket per hour
 *   - dailyStats: last 7 days, one bucket per day
 *   - anomalies: active anomalies for this corridor
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '../../../../lib/db';
import { dbBreaker } from '../../../../lib/db-breaker';
import { calculateHealthStatus } from '../../../../calculators/health';
import { calculateFragility } from '../../../../calculators/fragility';
import { calculatePercentile, successRate } from '../../../../lib/stats';
import { round2 } from '../../../../lib/round';
import { logger } from '../../../../lib/logger';
import { ANOMALY_THRESHOLDS, VALID_BRIDGES, VALID_CHAIN_NAMES, STABLECOINS } from '../../../../lib/constants';
import type { BridgeName } from '../../../../lib/constants';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id: corridorId } = await params;

    // Parse corridorId → bridge, sourceChain, destChain
    // Format: {bridge}_{sourceChain}_{destChain}  (DATA-MODEL.md §13.2)
    // All bridge names and chain names are single words with no underscores.
    const parts = corridorId.split('_');
    if (parts.length !== 3) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid corridor ID format. Expected {bridge}_{sourceChain}_{destChain}',
            details: { field: 'id', value: corridorId },
          },
        },
        { status: 400 },
      );
    }

    const [bridgeRaw, sourceChain, destChain] = parts;
    if (!VALID_BRIDGES.has(bridgeRaw)) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid bridge in corridor ID. Must be one of: across, cctp, stargate',
            details: { field: 'id', value: corridorId },
          },
        },
        { status: 400 },
      );
    }
    if (!VALID_CHAIN_NAMES.has(sourceChain) || !VALID_CHAIN_NAMES.has(destChain)) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid chain in corridor ID. Must be one of: ${[...VALID_CHAIN_NAMES].join(', ')}`,
            details: { field: 'id', value: corridorId },
          },
        },
        { status: 400 },
      );
    }
    const bridge = bridgeRaw as BridgeName;

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3_600_000);
    const twentyFourHoursAgo = new Date(now.getTime() - 86_400_000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);

    // All queries for this corridor run in parallel, wrapped in the DB circuit breaker.
    const [transfers7d, activeAnomalies, poolSnapshots24h] = await dbBreaker.execute(() =>
      Promise.all([
        db.transfer.findMany({
          where: { bridge, sourceChain, destChain, initiatedAt: { gte: sevenDaysAgo } },
          select: {
            transferId: true,
            amount: true,
            amountUsd: true,
            asset: true,
            status: true,
            initiatedAt: true,
            completedAt: true,
            durationSeconds: true,
            txHashSource: true,
            txHashDest: true,
          },
          orderBy: { initiatedAt: 'desc' },
          take: ANOMALY_THRESHOLDS.MAX_TRANSFER_QUERY_ROWS,
        }),
        db.anomaly.findMany({
          where: { corridorId, resolvedAt: null },
          orderBy: { detectedAt: 'desc' },
        }),
        // Fetch stablecoin pool snapshots for both dest and source chains so we can
        // fall back to source-chain data if destChain has no snapshots.
        // Ordered DESC so the first occurrence per poolId is the latest snapshot.
        db.poolSnapshot.findMany({
          where: {
            bridge,
            chain: { in: [destChain, sourceChain] },
            asset: { in: [...STABLECOINS] },
            recordedAt: { gte: twentyFourHoursAgo },
          },
          orderBy: { recordedAt: 'desc' },
          take: ANOMALY_THRESHOLDS.MAX_POOL_SNAPSHOT_QUERY_ROWS,
        }),
      ]),
    );

    // If we have no transfers AND no pool snapshots for this corridor, it is not
    // being monitored — returning zeros would silently misrepresent the corridor
    // state (e.g. health='healthy' from 100% of zero transfers is misleading).
    if (transfers7d.length === 0 && poolSnapshots24h.length === 0) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: `Corridor '${corridorId}' not found` } },
        { status: 404 },
      );
    }

    if (transfers7d.length === ANOMALY_THRESHOLDS.MAX_TRANSFER_QUERY_ROWS) {
      logger.warn('[api/corridors/[id]] Transfer query hit row cap – metrics may be incomplete', {
        corridorId,
        cap: ANOMALY_THRESHOLDS.MAX_TRANSFER_QUERY_ROWS,
      });
    }

    // Prefer dest-chain snapshots; fall back to source-chain if dest has no data.
    // This matches the behaviour of corridor-metrics.ts which also prefers destChain.
    const destSnaps = poolSnapshots24h.filter(s => s.chain === destChain);
    const relevantSnaps = destSnaps.length > 0
      ? destSnaps
      : poolSnapshots24h.filter(s => s.chain === sourceChain);

    // Aggregate pool snapshots across all stablecoin pools for the chosen chain.
    // Latest = first occurrence per poolId (DESC order); oldest = last occurrence.
    type SnapRow = (typeof poolSnapshots24h)[0];
    const latestByPool = new Map<string, SnapRow>();
    const oldestByPool = new Map<string, SnapRow>();
    for (const snap of relevantSnaps) {
      if (!latestByPool.has(snap.poolId)) latestByPool.set(snap.poolId, snap);
      oldestByPool.set(snap.poolId, snap);
    }
    const latestSnaps = [...latestByPool.values()];
    const tvlUsd = latestSnaps.reduce((s, p) => s + (p.tvlUsd ? Number(p.tvlUsd) : 0), 0);
    const availableLiquidity = latestSnaps.reduce(
      (s, p) => s + (p.availableLiquidity ? Number(p.availableLiquidity) : 0),
      0,
    );
    // Utilization: TVL-weighted average across pools
    const util =
      tvlUsd > 0
        ? latestSnaps.reduce((s, p) => {
            const poolTvl = p.tvlUsd ? Number(p.tvlUsd) : 0;
            return s + (poolTvl / tvlUsd) * (p.utilization ? Number(p.utilization) : 0);
          }, 0)
        : 0;
    const tvlStart = [...oldestByPool.values()].reduce(
      (s, p) => s + (p.tvlUsd ? Number(p.tvlUsd) : 0),
      0,
    );

    // ── Corridor summary ────────────────────────────────────────────────────

    const t1h = transfers7d.filter(t => t.initiatedAt >= oneHourAgo);
    const t24h = transfers7d.filter(t => t.initiatedAt >= twentyFourHoursAgo);

    const comp1h = t1h.filter(t => t.status === 'completed').length;
    const fail1h = t1h.filter(t => t.status === 'failed').length;
    const stuck1h = t1h.filter(t => t.status === 'stuck').length;
    const dur1h = t1h.filter(t => t.status === 'completed' && t.durationSeconds != null).map(t => t.durationSeconds as number);

    const comp24h = t24h.filter(t => t.status === 'completed').length;
    const fail24h = t24h.filter(t => t.status === 'failed').length;
    const stuck24h = t24h.filter(t => t.status === 'stuck').length;
    const vol24h = t24h.reduce((s, t) => s + (t.amountUsd ? Number(t.amountUsd) : 0), 0);

    const dur7d = transfers7d
      .filter(t => t.status === 'completed' && t.durationSeconds != null)
      .map(t => t.durationSeconds as number);

    const sr1h = successRate(comp1h, fail1h, stuck1h);
    const sr24h = successRate(comp24h, fail24h, stuck24h);
    const currentP90 = calculatePercentile(dur1h, 90);
    const historicalP90 = calculatePercentile(dur7d, 90);
    const p50 = calculatePercentile(dur1h, 50);

    const health = calculateHealthStatus({
      successRate1h: sr1h,
      currentP90,
      historicalP90,
      transferCount1h: t1h.length,
      context: { corridor: corridorId },
    });

    const fragility = calculateFragility({
      utilization: util,
      tvlUsd,
      netFlow24h: tvlUsd - tvlStart,
      context: { corridor: corridorId },
    });

    const corridor = {
      corridorId,
      bridge,
      sourceChain,
      destChain,
      status: health.status,
      metrics: {
        transferCount1h: t1h.length,
        transferCount24h: t24h.length,
        // null when no transfers have resolved — avoids phantom 100% from successRate(0,0,0)
        successRate1h: (comp1h + fail1h + stuck1h) === 0 ? null : round2(sr1h),
        successRate24h: (comp24h + fail24h + stuck24h) === 0 ? null : round2(sr24h),
        // null when no duration data — 0 would be indistinguishable from "instant"
        p50DurationSeconds: dur1h.length > 0 ? Math.round(p50) : null,
        p90DurationSeconds: dur1h.length > 0 ? Math.round(currentP90) : null,
        volumeUsd24h: round2(vol24h),
      },
      pool: {
        tvlUsd: round2(tvlUsd),
        utilization: Math.round(util),
        availableLiquidity: round2(availableLiquidity),
        fragility: fragility.level,
        fragilityReason: fragility.reason,
      },
      lastTransferAt: transfers7d[0]?.initiatedAt?.toISOString() ?? null,
    };

    // ── Recent transfers (last 20) ──────────────────────────────────────────

    const recentTransfers = transfers7d.slice(0, 20).map(t => ({
      transferId: t.transferId,
      amount: t.amount.toString(),
      amountUsd: t.amountUsd ? round2(Number(t.amountUsd)) : null,
      asset: t.asset,
      status: t.status,
      initiatedAt: t.initiatedAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
      durationSeconds: t.durationSeconds ?? null,
      txHashSource: t.txHashSource ?? null,
      txHashDest: t.txHashDest ?? null,
    }));

    // ── Hourly stats (last 24h) ─────────────────────────────────────────────

    const hourlyStats = buildHourlyStats(transfers7d, now);

    // ── Daily stats (last 7d) ───────────────────────────────────────────────

    const dailyStats = buildDailyStats(transfers7d, sevenDaysAgo);

    // ── Active anomalies ───────────────────────────────────────────────────

    const anomalies = activeAnomalies.map(a => ({
      id: a.id.toString(),
      anomalyType: a.anomalyType,
      corridorId: a.corridorId,
      bridge: a.bridge,
      sourceChain: a.sourceChain ?? null,
      destChain: a.destChain ?? null,
      severity: a.severity,
      detectedAt: a.detectedAt.toISOString(),
      resolvedAt: a.resolvedAt?.toISOString() ?? null,
      details: (a.details as Record<string, unknown> | null) ?? null,
    }));

    return NextResponse.json({ corridor, recentTransfers, hourlyStats, dailyStats, anomalies });
  } catch (error) {
    logger.error('[api/corridors/[id]] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Hourly / daily aggregation helpers
// ---------------------------------------------------------------------------

type TransferRow = {
  status: string;
  initiatedAt: Date;
  durationSeconds: number | null;
  amountUsd: unknown;
};

function buildHourlyStats(transfers: TransferRow[], now: Date): Array<{
  hour: string;
  transferCount: number;
  successRate: number | null;
  p50DurationSeconds: number | null;
  p90DurationSeconds: number | null;
  volumeUsd: number;
}> {
  const stats: Array<{
    hour: string;
    transferCount: number;
    successRate: number | null;
    p50DurationSeconds: number | null;
    p90DurationSeconds: number | null;
    volumeUsd: number;
  }> = [];

  // Generate 24 hourly buckets (oldest first)
  for (let h = 23; h >= 0; h--) {
    const bucketStart = new Date(now.getTime() - (h + 1) * 3_600_000);
    const bucketEnd = new Date(now.getTime() - h * 3_600_000);

    const bucket = transfers.filter(
      t => t.initiatedAt >= bucketStart && t.initiatedAt < bucketEnd,
    );

    const comp = bucket.filter(t => t.status === 'completed').length;
    const fail = bucket.filter(t => t.status === 'failed').length;
    const stuck = bucket.filter(t => t.status === 'stuck').length;
    const durations = bucket
      .filter(t => t.status === 'completed' && t.durationSeconds != null)
      .map(t => t.durationSeconds as number);
    const vol = bucket.reduce((s, t) => s + (t.amountUsd ? Number(t.amountUsd) : 0), 0);

    const resolved = comp + fail + stuck;
    stats.push({
      hour: bucketStart.toISOString(),
      transferCount: bucket.length,
      successRate: resolved === 0 ? null : round2(successRate(comp, fail, stuck)),
      p50DurationSeconds: durations.length > 0 ? Math.round(calculatePercentile(durations, 50)) : null,
      p90DurationSeconds: durations.length > 0 ? Math.round(calculatePercentile(durations, 90)) : null,
      volumeUsd: round2(vol),
    });
  }

  return stats;
}

function buildDailyStats(transfers: TransferRow[], from: Date): Array<{
  date: string;
  transferCount: number;
  successRate: number | null;
  avgDurationSeconds: number | null;
  volumeUsd: number;
  status: 'healthy' | 'degraded' | 'down';
}> {
  // Bucket by UTC date string (YYYY-MM-DD)
  const buckets = new Map<string, TransferRow[]>();

  for (const t of transfers) {
    if (t.initiatedAt < from) continue;
    const date = t.initiatedAt.toISOString().slice(0, 10);
    if (!buckets.has(date)) buckets.set(date, []);
    const bucket = buckets.get(date);
    if (bucket) bucket.push(t);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => {
      const comp = bucket.filter(t => t.status === 'completed').length;
      const fail = bucket.filter(t => t.status === 'failed').length;
      const stuck = bucket.filter(t => t.status === 'stuck').length;
      const durations = bucket
        .filter(t => t.status === 'completed' && t.durationSeconds != null)
        .map(t => t.durationSeconds as number);
      const vol = bucket.reduce((s, t) => s + (t.amountUsd ? Number(t.amountUsd) : 0), 0);
      const resolved = comp + fail + stuck;
      const sr = successRate(comp, fail, stuck);
      const avgDuration =
        durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

      return {
        date,
        transferCount: bucket.length,
        successRate: resolved === 0 ? null : round2(sr),
        avgDurationSeconds: avgDuration,
        volumeUsd: round2(vol),
        // No resolved transfers → 'down', consistent with health calculator's
        // transferCount1h === 0 → DOWN rule (DATA-MODEL.md §8.2)
        status: resolved === 0 ? 'down' as const : dailyStatus(sr),
      };
    });
}

/**
 * Derive a daily status from the day's success rate.
 * Uses the same thresholds as the health calculator (DATA-MODEL.md §8.3)
 * but only the success-rate dimension (no latency data for daily rollups).
 */
function dailyStatus(sr: number): 'healthy' | 'degraded' | 'down' {
  if (sr < 95) return 'down';
  if (sr < 99) return 'degraded';
  return 'healthy';
}
