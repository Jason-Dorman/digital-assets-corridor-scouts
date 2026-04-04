/**
 * GET /api/corridors
 *
 * List all monitored corridors with health metrics.
 *
 * Response schema: docs/API-SPEC.md CorridorsResponse / Corridor
 * Response format: UPDATED-SPEC.md "GET /api/corridors"
 * Corridor ID format: docs/DATA-MODEL.md §13.2 — {bridge}_{sourceChain}_{destChain}
 * Health status: docs/DATA-MODEL.md §8
 * Fragility: docs/DATA-MODEL.md §5
 *
 * Query parameters (all optional):
 *   bridge  – filter by bridge name (across | cctp | stargate)
 *   source  – filter by source chain
 *   dest    – filter by destination chain
 *   status  – filter by health status (healthy | degraded | down)
 *   sort    – sort field (p50 | p90 | transfers | fragility)
 *   order   – sort direction (asc | desc), default asc
 *   limit   – max results, default 100, max 500
 *   offset  – pagination offset, default 0
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  fetchAllCorridorMetrics,
  CORRIDOR_METRICS_CACHE_KEY,
  CORRIDOR_METRICS_CACHE_TTL,
} from '../../../lib/corridor-metrics';
import { redis } from '../../../lib/redis';
import { logger } from '../../../lib/logger';
import { VALID_BRIDGES, VALID_CHAIN_NAMES } from '../../../lib/constants';
import type { CorridorMetrics, CorridorDataResult } from '../../../lib/corridor-metrics';

export const dynamic = 'force-dynamic';

const FRAGILITY_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };
const VALID_STATUSES = new Set(['healthy', 'degraded', 'down']);
const VALID_SORT_FIELDS = new Set(['p50', 'p90', 'transfers', 'fragility']);

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = request.nextUrl;

    // Parse and validate query params
    const bridge = searchParams.get('bridge') ?? undefined;
    const source = searchParams.get('source') ?? undefined;
    const dest = searchParams.get('dest') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const sort = searchParams.get('sort') ?? 'p50';
    const order = searchParams.get('order') ?? 'asc';
    const rawLimit = parseInt(searchParams.get('limit') ?? '100', 10);
    const rawOffset = parseInt(searchParams.get('offset') ?? '0', 10);

    if (bridge && !VALID_BRIDGES.has(bridge)) {
      return validationError('bridge', bridge, 'Must be one of: across, cctp, stargate');
    }
    if (source && !VALID_CHAIN_NAMES.has(source)) {
      return validationError('source', source, `Must be one of: ${[...VALID_CHAIN_NAMES].join(', ')}`);
    }
    if (dest && !VALID_CHAIN_NAMES.has(dest)) {
      return validationError('dest', dest, `Must be one of: ${[...VALID_CHAIN_NAMES].join(', ')}`);
    }
    if (status && !VALID_STATUSES.has(status)) {
      return validationError('status', status, 'Must be one of: healthy, degraded, down');
    }
    if (!VALID_SORT_FIELDS.has(sort)) {
      return validationError('sort', sort, 'Must be one of: p50, p90, transfers, fragility');
    }
    if (order !== 'asc' && order !== 'desc') {
      return validationError('order', order, 'Must be asc or desc');
    }

    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 100 : rawLimit), 500);
    const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

    // Read from the shared corridor-metrics cache (written by /api/health and here).
    // Filtering/sorting/pagination happen in memory on the cached set so the cache
    // key covers the full unfiltered dataset.
    let allCorridors: CorridorMetrics[];
    try {
      const cached = await redis.get(CORRIDOR_METRICS_CACHE_KEY);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as CorridorDataResult;
          if (!Array.isArray(parsed.corridors)) {
            throw new Error('cached corridors is not an array');
          }
          allCorridors = parsed.corridors;
        } catch {
          logger.warn('[api/corridors] Corrupted cache entry – recomputing', {
            key: CORRIDOR_METRICS_CACHE_KEY,
          });
          allCorridors = (await fetchAllCorridorMetrics()).corridors;
        }
      } else {
        const result = await fetchAllCorridorMetrics();
        allCorridors = result.corridors;
        try {
          await redis.setex(
            CORRIDOR_METRICS_CACHE_KEY,
            CORRIDOR_METRICS_CACHE_TTL,
            JSON.stringify(result),
          );
        } catch (writeErr) {
          logger.warn('[api/corridors] Failed to write cache', { error: String(writeErr) });
        }
      }
    } catch (cacheErr) {
      logger.warn('[api/corridors] Redis unavailable – computing fresh', {
        error: String(cacheErr),
      });
      allCorridors = (await fetchAllCorridorMetrics()).corridors;
    }

    // Filter
    let filtered = allCorridors;
    if (bridge) filtered = filtered.filter(c => c.bridge === bridge);
    if (source) filtered = filtered.filter(c => c.sourceChain === source);
    if (dest) filtered = filtered.filter(c => c.destChain === dest);
    if (status) filtered = filtered.filter(c => c.status === status);

    // Sort
    const dir = order === 'desc' ? -1 : 1;
    filtered = [...filtered].sort((a, b) => {
      switch (sort) {
        case 'p50':
          return dir * ((a.metrics.p50DurationSeconds ?? 0) - (b.metrics.p50DurationSeconds ?? 0));
        case 'p90':
          return dir * ((a.metrics.p90DurationSeconds ?? 0) - (b.metrics.p90DurationSeconds ?? 0));
        case 'transfers':
          return dir * (a.metrics.transferCount24h - b.metrics.transferCount24h);
        case 'fragility':
          return (
            dir *
            ((FRAGILITY_ORDER[a.pool.fragility] ?? 0) -
              (FRAGILITY_ORDER[b.pool.fragility] ?? 0))
          );
        default:
          return 0;
      }
    });

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);

    return NextResponse.json({
      corridors: page.map(serializeCorridor),
      total,
      limit,
      offset,
    });
  } catch (error) {
    logger.error('[api/corridors] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeCorridor(c: CorridorMetrics) {
  // When corridors are read back from the Redis cache, Date objects are
  // deserialized as strings. Handle both to avoid a TypeError on cache hits.
  const lastTransferAt =
    c.lastTransferAt instanceof Date
      ? c.lastTransferAt.toISOString()
      : (c.lastTransferAt as string | null) ?? null;

  return {
    corridorId: c.corridorId,
    bridge: c.bridge,
    sourceChain: c.sourceChain,
    destChain: c.destChain,
    status: c.status,
    metrics: {
      ...c.metrics,
      // Return null instead of 100 when there are no transfers — 100% with zero
      // samples is misleading; null signals "no data" to consumers.
      successRate1h: c.metrics.transferCount1h === 0 ? null : c.metrics.successRate1h,
      successRate24h: c.metrics.transferCount24h === 0 ? null : c.metrics.successRate24h,
    },
    pool: {
      tvlUsd: c.pool.tvlUsd,
      utilization: c.pool.utilization,
      availableLiquidity: c.pool.availableLiquidity,
      fragility: c.pool.fragility,
      fragilityReason: c.pool.fragilityReason,
    },
    lastTransferAt,
  };
}

function validationError(field: string, value: string, message: string) {
  return NextResponse.json(
    {
      error: {
        code: 'VALIDATION_ERROR',
        message,
        details: { field, value },
      },
    },
    { status: 400 },
  );
}
