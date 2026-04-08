/**
 * GET /api/health
 *
 * System-wide health overview.
 *
 * Response schema: docs/API-SPEC.md HealthResponse
 * Response format: UPDATED-SPEC.md "GET /api/health" (flat — no data wrapper)
 * Health status formula: docs/DATA-MODEL.md §8
 * Rounding: successRate24h to 2 decimals per DATA-MODEL.md §12
 * Cache: 60 seconds via shared corridor-metrics Redis cache (graceful fallback
 *   if Redis is unavailable). 60s is preferred over 30s because health is derived
 *   from 1h windows and pool snapshots are taken every 5 minutes — the marginal
 *   freshness gain does not justify doubling DB load.
 */

import { NextResponse } from 'next/server';
import { db } from '../../../lib/db';
import { dbBreaker } from '../../../lib/db-breaker';
import { redis } from '../../../lib/redis';
import {
  fetchAllCorridorMetrics,
  CORRIDOR_METRICS_CACHE_KEY,
  CORRIDOR_METRICS_CACHE_TTL,
} from '../../../lib/corridor-metrics';
import { logger } from '../../../lib/logger';
import { SYSTEM_STATUS_THRESHOLDS } from '../../../lib/constants';
import type { CorridorDataResult } from '../../../lib/corridor-metrics';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    let metricsResult: CorridorDataResult | null = null;

    // Attempt to read corridor metrics from the shared Redis cache.
    try {
      const cached = await redis.get(CORRIDOR_METRICS_CACHE_KEY);
      if (cached) {
        try {
          metricsResult = JSON.parse(cached) as CorridorDataResult;
        } catch {
          logger.warn('[api/health] Corrupted cache entry – recomputing', {
            key: CORRIDOR_METRICS_CACHE_KEY,
          });
        }
      }
    } catch (cacheErr) {
      logger.warn('[api/health] Redis unavailable – computing fresh', {
        error: String(cacheErr),
      });
    }

    if (!metricsResult) {
      metricsResult = await fetchAllCorridorMetrics();
      try {
        await redis.setex(
          CORRIDOR_METRICS_CACHE_KEY,
          CORRIDOR_METRICS_CACHE_TTL,
          JSON.stringify(metricsResult),
        );
      } catch (cacheErr) {
        logger.warn('[api/health] Failed to write cache', { error: String(cacheErr) });
      }
    }

    const data = await computeHealth(metricsResult);

    return NextResponse.json(data);
  } catch (error) {
    logger.error('[api/health] Unhandled error', {
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

async function computeHealth(metricsResult: CorridorDataResult): Promise<{
  status: 'operational' | 'degraded' | 'down';
  corridorsMonitored: number;
  corridorsHealthy: number;
  corridorsDegraded: number;
  corridorsDown: number;
  transfers24h: number;
  successRate24h: number | null;
  activeAnomalies: number;
  updatedAt: string;
}> {
  const now = new Date();

  const [{ corridors, totalTransfers24h, overallSuccessRate24h }, activeAnomalyCount] =
    await Promise.all([
      Promise.resolve(metricsResult),
      dbBreaker.execute(() => db.anomaly.count({ where: { resolvedAt: null } })),
    ]);

  const corridorsHealthy = corridors.filter(c => c.status === 'healthy').length;
  const corridorsDegraded = corridors.filter(c => c.status === 'degraded').length;
  const corridorsDown = corridors.filter(c => c.status === 'down').length;
  const corridorsMonitored = corridors.length;

  return {
    status: computeSystemStatus(corridorsMonitored, corridorsDown, corridorsDegraded),
    corridorsMonitored,
    corridorsHealthy,
    corridorsDegraded,
    corridorsDown,
    transfers24h: totalTransfers24h,
    // null when no transfers have resolved — avoids phantom 100% with only pending transfers
    successRate24h: overallSuccessRate24h,
    activeAnomalies: activeAnomalyCount,
    updatedAt: now.toISOString(),
  };
}

/**
 * Derive overall system status from corridor health distribution.
 * Thresholds are defined in SYSTEM_STATUS_THRESHOLDS (constants.ts).
 */
function computeSystemStatus(
  total: number,
  down: number,
  degraded: number,
): 'operational' | 'degraded' | 'down' {
  if (total === 0) return 'operational';
  if (down / total >= SYSTEM_STATUS_THRESHOLDS.FRACTION_DOWN_FOR_DOWN) return 'down';
  if (
    down / total >= SYSTEM_STATUS_THRESHOLDS.FRACTION_DOWN_FOR_DEGRADED ||
    degraded / total >= SYSTEM_STATUS_THRESHOLDS.FRACTION_DEGRADED_FOR_DEGRADED
  ) {
    return 'degraded';
  }
  return 'operational';
}
