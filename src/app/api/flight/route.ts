/**
 * GET /api/flight
 *
 * Liquidity Flight Velocity (LFV) by chain.
 *
 * Response schema: docs/API-SPEC.md FlightResponse / ChainFlight
 * Response format: UPDATED-SPEC.md "GET /api/flight" (flat — no data wrapper)
 * LFV formula: docs/DATA-MODEL.md §9 (§7 in file)
 * Alert trigger: interpretation === 'rapid_flight' (lfv24h < -0.10)
 * Rounding: lfv24h to 3 decimals per DATA-MODEL.md §12
 * Sort: lfv24h ascending (most negative first)
 * Cache: 60 seconds via Redis (graceful fallback if Redis is unavailable)
 */

import { NextResponse } from 'next/server';
import { db } from '../../../lib/db';
import { dbBreaker } from '../../../lib/db-breaker';
import { redis } from '../../../lib/redis';
import { calculateLFV } from '../../../calculators/lfv';
import { round2, round3 } from '../../../lib/round';
import { logger } from '../../../lib/logger';
import { STABLECOINS, ANOMALY_THRESHOLDS } from '../../../lib/constants';

export const dynamic = 'force-dynamic';

const CACHE_KEY = 'api:flight';
const CACHE_TTL = 60; // seconds

export async function GET(): Promise<NextResponse> {
  try {
    // Attempt to serve from Redis cache
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        try {
          return NextResponse.json(JSON.parse(cached));
        } catch {
          logger.warn('[api/flight] Corrupted cache entry – recomputing', { key: CACHE_KEY });
        }
      }
    } catch (cacheErr) {
      logger.warn('[api/flight] Redis unavailable – computing fresh', {
        error: String(cacheErr),
      });
    }

    const data = await computeFlight();

    try {
      await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(data));
    } catch (cacheErr) {
      logger.warn('[api/flight] Failed to write cache', { error: String(cacheErr) });
    }

    return NextResponse.json(data);
  } catch (error) {
    logger.error('[api/flight] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

async function computeFlight(): Promise<{
  chains: Array<{
    chain: string;
    lfv24h: number;
    lfvAnnualized: number;
    interpretation: string;
    netFlowUsd: number;
    tvlStartUsd: number;
    tvlNowUsd: number;
    poolsMonitored: number;
    alert?: boolean;
  }>;
  updatedAt: string;
}> {
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 86_400_000);

  // Fetch all stablecoin pool snapshots within the 24h window.
  // Ordered desc so the first row per (poolId) is the latest snapshot.
  // Exclude HubPool aggregate rows (chain = 'ethereum_hub') — those represent
  // cross-chain aggregate TVL, not per-chain liquidity. Including them would
  // create a phantom 'ethereum_hub' chain in the LFV response.
  const snapshots = await dbBreaker.execute(() =>
    db.poolSnapshot.findMany({
      where: {
        recordedAt: { gte: twentyFourHoursAgo },
        asset: { in: [...STABLECOINS] },
        chain: { not: 'ethereum_hub' },
      },
      select: {
        poolId: true,
        chain: true,
        tvlUsd: true,
        recordedAt: true,
      },
      orderBy: { recordedAt: 'desc' },
      take: ANOMALY_THRESHOLDS.MAX_POOL_SNAPSHOT_QUERY_ROWS,
    }),
  );

  if (snapshots.length === ANOMALY_THRESHOLDS.MAX_POOL_SNAPSHOT_QUERY_ROWS) {
    logger.warn('[api/flight] Pool snapshot query hit row cap – some chains may be missing', {
      cap: ANOMALY_THRESHOLDS.MAX_POOL_SNAPSHOT_QUERY_ROWS,
      windowHours: 24,
    });
  }

  // Build per-chain collections: latest TVL per pool, oldest TVL per pool
  // "oldest in the window" = best proxy for TVL 24h ago
  type SnapRow = (typeof snapshots)[0];

  const latestPerPool = new Map<string, SnapRow>();  // poolId → latest
  const oldestPerPool = new Map<string, SnapRow>();  // poolId → oldest in window

  for (const snap of snapshots) {
    if (!latestPerPool.has(snap.poolId)) latestPerPool.set(snap.poolId, snap);
    oldestPerPool.set(snap.poolId, snap); // repeatedly overwritten → last = oldest
  }

  // Aggregate by chain: sum TVL (now) and TVL (start of window)
  const chainNow = new Map<string, number>();
  const chainStart = new Map<string, number>();
  const chainPools = new Map<string, Set<string>>();

  for (const [poolId, snap] of latestPerPool.entries()) {
    const chain = snap.chain;
    const tvl = snap.tvlUsd ? Number(snap.tvlUsd) : 0;
    chainNow.set(chain, (chainNow.get(chain) ?? 0) + tvl);
    if (!chainPools.has(chain)) chainPools.set(chain, new Set());
    const poolSet = chainPools.get(chain);
    if (poolSet) poolSet.add(poolId);
  }

  for (const [poolId, snap] of oldestPerPool.entries()) {
    const chain = snap.chain;
    const tvl = snap.tvlUsd ? Number(snap.tvlUsd) : 0;
    chainStart.set(chain, (chainStart.get(chain) ?? 0) + tvl);
    // Ensure chain is registered even if only in oldestPerPool
    if (!chainPools.has(chain)) chainPools.set(chain, new Set());
    const poolSet2 = chainPools.get(chain);
    if (poolSet2) poolSet2.add(poolId);
  }

  // Compute LFV per chain
  const chains = [...new Set([...chainNow.keys(), ...chainStart.keys()])];

  const results = chains
    .map(chain => {
      const tvlNowUsd = chainNow.get(chain) ?? 0;
      const tvlStartUsd = chainStart.get(chain) ?? tvlNowUsd;
      const poolsMonitored = chainPools.get(chain)?.size ?? 0;

      const lfv = calculateLFV({
        chain,
        tvlStartUsd,
        tvlNowUsd,
        timeWindowHours: 24,
        poolsMonitored,
      });

      return {
        chain,
        lfv24h: round3(lfv.lfv24h),
        lfvAnnualized: round2(lfv.lfvAnnualized),
        interpretation: lfv.interpretation,
        netFlowUsd: round2(lfv.netFlowUsd),
        tvlStartUsd: round2(lfv.tvlStartUsd),
        tvlNowUsd: round2(lfv.tvlNowUsd),
        poolsMonitored: lfv.poolsMonitored,
        ...(lfv.interpretation === 'rapid_flight' ? { alert: true } : {}),
      };
    })
    // Sort by lfv24h ascending (most negative first per spec Prompt 5.2)
    .sort((a, b) => a.lfv24h - b.lfv24h);

  return {
    chains: results,
    updatedAt: now.toISOString(),
  };
}

