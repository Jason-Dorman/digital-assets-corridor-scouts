/**
 * Corridor metrics computation.
 *
 * Fetches transfer and pool snapshot data from the database and computes
 * per-corridor health status, transfer metrics, and pool fragility.
 *
 * Used by /api/health and /api/corridors to share a single pair of DB queries
 * rather than duplicating the fetch + computation logic in each route.
 *
 * Design: two queries (transfers 7d, pool snapshots 24h) run in parallel.
 * All aggregation happens in memory so subsequent filtering/sorting in the
 * routes avoids additional round-trips.
 */

import { db } from './db';
import { dbBreaker } from './db-breaker';
import { calculateHealthStatus } from '../calculators/health';
import { calculateFragility } from '../calculators/fragility';
import { logger } from './logger';
import { round2 } from './round';
import { calculatePercentile, successRate } from './stats';
import type { HealthStatus, FragilityLevel } from '../types/index';
import type { BridgeName } from './constants';
import { ANOMALY_THRESHOLDS, STABLECOINS } from './constants';

// Re-export for existing consumers (corridors/[id]/route.ts, impact/estimate/route.ts)
export { calculatePercentile } from './stats';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PoolInfo {
  tvlUsd: number;
  utilization: number;
  fragility: FragilityLevel;
  fragilityReason: string;
  availableLiquidity: number;
}

export interface CorridorMetrics {
  corridorId: string;
  bridge: BridgeName;
  sourceChain: string;
  destChain: string;
  status: HealthStatus;
  metrics: {
    transferCount1h: number;
    transferCount24h: number;
    successRate1h: number | null;
    successRate24h: number | null;
    /** null when no completed transfers with duration data in the last hour */
    p50DurationSeconds: number | null;
    /** null when no completed transfers with duration data in the last hour */
    p90DurationSeconds: number | null;
    volumeUsd24h: number;
  };
  pool: PoolInfo;
  lastTransferAt: Date | null;
}

// ---------------------------------------------------------------------------
// Shared cache configuration
// Used by /api/health and /api/corridors to read from the same DB snapshot.
// ---------------------------------------------------------------------------

export const CORRIDOR_METRICS_CACHE_KEY = 'api:corridor-metrics';
export const CORRIDOR_METRICS_CACHE_TTL = 60; // seconds

export interface CorridorDataResult {
  corridors: CorridorMetrics[];
  /** Total transfer count across all corridors in the last 24 hours. */
  totalTransfers24h: number;
  /** Overall success rate across all corridors in last 24h. Null when no transfers have resolved. */
  overallSuccessRate24h: number | null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Fetch all corridor metrics in two DB queries.
 *
 * Transfers are capped at MAX_TRANSFER_QUERY_ROWS (50k) to prevent OOM on
 * large datasets. On a Phase 0 system with ~3 bridges this limit should not
 * be reached within a 7-day window.
 */
export async function fetchAllCorridorMetrics(): Promise<CorridorDataResult> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);
  const twentyFourHoursAgo = new Date(now.getTime() - 86_400_000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);

  const [rawTransfers, rawPools] = await dbBreaker.execute(() =>
    Promise.all([
      db.transfer.findMany({
        where: { initiatedAt: { gte: sevenDaysAgo } },
        select: {
          bridge: true,
          sourceChain: true,
          destChain: true,
          status: true,
          durationSeconds: true,
          amountUsd: true,
          initiatedAt: true,
        },
        orderBy: { initiatedAt: 'desc' },
        take: ANOMALY_THRESHOLDS.MAX_TRANSFER_QUERY_ROWS,
      }),
      db.poolSnapshot.findMany({
        where: {
          recordedAt: { gte: twentyFourHoursAgo },
          asset: { in: [...STABLECOINS] },
        },
        select: {
          poolId: true,
          bridge: true,
          chain: true,
          tvlUsd: true,
          utilization: true,
          availableLiquidity: true,
          recordedAt: true,
        },
        orderBy: { recordedAt: 'desc' },
        take: ANOMALY_THRESHOLDS.MAX_POOL_SNAPSHOT_QUERY_ROWS,
      }),
    ]),
  );

  if (rawTransfers.length === ANOMALY_THRESHOLDS.MAX_TRANSFER_QUERY_ROWS) {
    logger.warn('[corridor-metrics] Transfer query hit row cap – corridor metrics may be incomplete', {
      cap: ANOMALY_THRESHOLDS.MAX_TRANSFER_QUERY_ROWS,
      windowDays: 7,
    });
  }
  if (rawPools.length === ANOMALY_THRESHOLDS.MAX_POOL_SNAPSHOT_QUERY_ROWS) {
    logger.warn('[corridor-metrics] Pool snapshot query hit row cap – pool metrics may be incomplete', {
      cap: ANOMALY_THRESHOLDS.MAX_POOL_SNAPSHOT_QUERY_ROWS,
      windowHours: 24,
    });
  }

  // Group transfers by corridor key
  type TransferRow = (typeof rawTransfers)[0];
  const corridorMap = new Map<string, TransferRow[]>();
  for (const t of rawTransfers) {
    const key = `${t.bridge}_${t.sourceChain}_${t.destChain}`;
    if (!corridorMap.has(key)) corridorMap.set(key, []);
    const corridor = corridorMap.get(key);
    if (corridor) corridor.push(t);
  }

  // Build per-poolId latest/oldest snapshots (rawPools ordered recordedAt DESC,
  // so first occurrence per poolId = latest, last occurrence = oldest in window).
  type PoolRow = (typeof rawPools)[0];
  const latestByPoolId = new Map<string, PoolRow>();
  const oldestByPoolId = new Map<string, PoolRow>();
  for (const snap of rawPools) {
    if (!latestByPoolId.has(snap.poolId)) latestByPoolId.set(snap.poolId, snap);
    oldestByPoolId.set(snap.poolId, snap);
  }

  // Aggregate per (bridge_chain): sum TVL and availableLiquidity across all pools,
  // compute TVL-weighted utilization. Multiple pools per chain (e.g. USDC + USDT)
  // are combined so no single pool's data silently wins.
  type ChainAgg = { tvlUsd: number; utilizationWeightedSum: number; availableLiquidity: number };
  const latestPoolAgg = new Map<string, ChainAgg>();
  const oldestTvlAgg = new Map<string, number>();

  for (const snap of latestByPoolId.values()) {
    const key = `${snap.bridge}_${snap.chain}`;
    const tvl = snap.tvlUsd ? Number(snap.tvlUsd) : 0;
    const avail = snap.availableLiquidity ? Number(snap.availableLiquidity) : 0;
    const util = snap.utilization ? Number(snap.utilization) : 0;
    const existing = latestPoolAgg.get(key) ?? { tvlUsd: 0, utilizationWeightedSum: 0, availableLiquidity: 0 };
    latestPoolAgg.set(key, {
      tvlUsd: existing.tvlUsd + tvl,
      utilizationWeightedSum: existing.utilizationWeightedSum + util * tvl,
      availableLiquidity: existing.availableLiquidity + avail,
    });
  }

  for (const snap of oldestByPoolId.values()) {
    const key = `${snap.bridge}_${snap.chain}`;
    const tvl = snap.tvlUsd ? Number(snap.tvlUsd) : 0;
    oldestTvlAgg.set(key, (oldestTvlAgg.get(key) ?? 0) + tvl);
  }

  // Aggregate 24h stats across all corridors
  let totalComp24h = 0;
  let totalFail24h = 0;
  let totalStuck24h = 0;
  let totalTransfers24h = 0;   // all transfers (including pending)
  let totalResolved24h = 0;    // completed + failed + stuck (denominator for success rate)

  const corridors: CorridorMetrics[] = [];

  for (const [corridorId, transfers] of corridorMap.entries()) {
    const { bridge, sourceChain, destChain } = transfers[0];

    const t1h = transfers.filter(t => t.initiatedAt >= oneHourAgo);
    const t24h = transfers.filter(t => t.initiatedAt >= twentyFourHoursAgo);

    // 1h aggregates
    const comp1h = t1h.filter(t => t.status === 'completed').length;
    const fail1h = t1h.filter(t => t.status === 'failed').length;
    const stuck1h = t1h.filter(t => t.status === 'stuck').length;
    const dur1h = t1h
      .filter(t => t.status === 'completed' && t.durationSeconds != null)
      .map(t => t.durationSeconds as number);

    // 24h aggregates
    const comp24h = t24h.filter(t => t.status === 'completed').length;
    const fail24h = t24h.filter(t => t.status === 'failed').length;
    const stuck24h = t24h.filter(t => t.status === 'stuck').length;
    const vol24h = t24h.reduce((s, t) => s + (t.amountUsd ? Number(t.amountUsd) : 0), 0);

    totalComp24h += comp24h;
    totalFail24h += fail24h;
    totalStuck24h += stuck24h;
    totalTransfers24h += t24h.length;
    totalResolved24h += comp24h + fail24h + stuck24h;

    // 7d completed durations for historical p90 baseline
    const dur7d = transfers
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

    // Pool: prefer dest-chain aggregate (liquidity destination); fall back to source chain.
    const destKey = `${bridge}_${destChain}`;
    const srcKey = `${bridge}_${sourceChain}`;
    const latestAgg = latestPoolAgg.get(destKey) ?? latestPoolAgg.get(srcKey);
    const oldestTvl = oldestTvlAgg.get(destKey) ?? oldestTvlAgg.get(srcKey);

    const tvlUsd = latestAgg?.tvlUsd ?? 0;
    const util =
      latestAgg && latestAgg.tvlUsd > 0
        ? latestAgg.utilizationWeightedSum / latestAgg.tvlUsd
        : 0;
    const avail = latestAgg?.availableLiquidity ?? 0;
    const tvlStart = oldestTvl ?? tvlUsd;

    const fragility = calculateFragility({
      utilization: util,
      tvlUsd,
      netFlow24h: tvlUsd - tvlStart,
      context: { corridor: corridorId },
    });

    corridors.push({
      corridorId,
      bridge: bridge as BridgeName,
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
        fragility: fragility.level,
        fragilityReason: fragility.reason,
        availableLiquidity: round2(avail),
      },
      lastTransferAt: transfers[0]?.initiatedAt ?? null,
    });
  }

  const overallSuccessRate24h = totalResolved24h === 0
    ? null
    : round2(successRate(totalComp24h, totalFail24h, totalStuck24h));

  return { corridors, totalTransfers24h, overallSuccessRate24h };
}

