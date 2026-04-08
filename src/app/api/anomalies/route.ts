/**
 * GET /api/anomalies
 *
 * List detected anomalies with human-readable descriptions.
 *
 * Response schema: docs/API-SPEC.md AnomaliesResponse / Anomaly
 * Anomaly types: docs/DATA-MODEL.md §1.6
 * Severity levels: docs/DATA-MODEL.md §1.7
 * Severity assignment: docs/DATA-MODEL.md §9.4
 * Order: detectedAt DESC
 *
 * Query parameters (all optional):
 *   active     – boolean, only unresolved anomalies (default true)
 *   severity   – filter by severity (low | medium | high)
 *   type       – filter by type (latency_spike | failure_cluster | liquidity_drop | stuck_transfer)
 *   bridge     – filter by bridge
 *   corridorId – filter by corridor ID
 *   limit      – max results (default 50)
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '../../../lib/db';
import { dbBreaker } from '../../../lib/db-breaker';
import { logger } from '../../../lib/logger';
import { VALID_BRIDGES } from '../../../lib/constants';

export const dynamic = 'force-dynamic';

const VALID_SEVERITIES = new Set(['low', 'medium', 'high']);
const VALID_TYPES = new Set([
  'latency_spike',
  'failure_cluster',
  'liquidity_drop',
  'stuck_transfer',
]);

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = request.nextUrl;

    // Parse query params
    const activeParam = searchParams.get('active');
    const VALID_ACTIVE_VALUES = new Set([null, 'true', '1', 'false', '0']);
    if (!VALID_ACTIVE_VALUES.has(activeParam)) {
      return validationError('active', activeParam ?? '', 'Must be true, false, 1, or 0');
    }
    const active = activeParam === null || activeParam === 'true' || activeParam === '1';
    const severity = searchParams.get('severity') ?? undefined;
    const type = searchParams.get('type') ?? undefined;
    const bridge = searchParams.get('bridge') ?? undefined;
    const corridorId = searchParams.get('corridorId') ?? undefined;
    const rawLimit = parseInt(searchParams.get('limit') ?? '50', 10);
    const rawOffset = parseInt(searchParams.get('offset') ?? '0', 10);

    // Validate
    if (severity && !VALID_SEVERITIES.has(severity)) {
      return validationError('severity', severity, 'Must be one of: low, medium, high');
    }
    if (type && !VALID_TYPES.has(type)) {
      return validationError(
        'type',
        type,
        'Must be one of: latency_spike, failure_cluster, liquidity_drop, stuck_transfer',
      );
    }
    if (bridge && !VALID_BRIDGES.has(bridge)) {
      return validationError('bridge', bridge, 'Must be one of: across, cctp, stargate');
    }

    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 500);
    const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

    // Build where clause using spread to avoid Prisma enum import issues
    const where = {
      ...(active ? { resolvedAt: null } : {}),
      ...(severity ? { severity: severity as 'low' | 'medium' | 'high' } : {}),
      ...(type
        ? {
            anomalyType: type as
              | 'latency_spike'
              | 'failure_cluster'
              | 'liquidity_drop'
              | 'stuck_transfer',
          }
        : {}),
      ...(bridge ? { bridge: bridge as 'across' | 'cctp' | 'stargate' } : {}),
      ...(corridorId ? { corridorId } : {}),
    };

    const [anomalies, total] = await dbBreaker.execute(() =>
      Promise.all([
        db.anomaly.findMany({
          where,
          orderBy: { detectedAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        db.anomaly.count({ where }),
      ]),
    );

    const serialized = anomalies.map(a => {
      const details = (a.details as Record<string, unknown> | null) ?? null;
      return {
        id: a.id.toString(),
        anomalyType: a.anomalyType,
        corridorId: a.corridorId,
        bridge: a.bridge,
        sourceChain: a.sourceChain ?? null,
        destChain: a.destChain ?? null,
        severity: a.severity,
        detectedAt: a.detectedAt.toISOString(),
        resolvedAt: a.resolvedAt?.toISOString() ?? null,
        details,
        description: generateDescription(
          a.anomalyType,
          a.bridge,
          a.sourceChain ?? null,
          a.destChain ?? null,
          details,
        ),
      };
    });

    return NextResponse.json({ anomalies: serialized, total, limit, offset });
  } catch (error) {
    logger.error('[api/anomalies] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Description generation
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable description for an anomaly.
 *
 * Format follows the API-SPEC.md example:
 *   "Latency 6.9x normal on Stargate Ethereum→Avalanche"
 */
function generateDescription(
  anomalyType: string,
  bridge: string,
  sourceChain: string | null,
  destChain: string | null,
  details: Record<string, unknown> | null,
): string {
  const corridorLabel = formatCorridorLabel(bridge, sourceChain, destChain);

  switch (anomalyType) {
    case 'latency_spike': {
      const multiplier = details?.multiplier;
      if (typeof multiplier === 'number') {
        return `Latency ${multiplier.toFixed(1)}x normal on ${corridorLabel}`;
      }
      return `Latency spike detected on ${corridorLabel}`;
    }
    case 'failure_cluster': {
      const failureRate = details?.failureRate;
      if (typeof failureRate === 'number') {
        return `${failureRate.toFixed(0)}% failure rate on ${corridorLabel}`;
      }
      return `Failure cluster detected on ${corridorLabel}`;
    }
    case 'liquidity_drop': {
      const dropPct = details?.dropPct;
      if (typeof dropPct === 'number') {
        return `Liquidity dropped ${dropPct.toFixed(0)}% on ${corridorLabel}`;
      }
      return `Liquidity drop detected on ${corridorLabel}`;
    }
    case 'stuck_transfer': {
      const pendingMinutes = details?.pendingMinutes;
      const amountUsd = details?.amountUsd;
      const amountStr =
        typeof amountUsd === 'number'
          ? ` ($${Math.round(amountUsd).toLocaleString()})`
          : '';
      if (typeof pendingMinutes === 'number') {
        return `Transfer stuck ${pendingMinutes}m on ${corridorLabel}${amountStr}`;
      }
      return `Stuck transfer on ${corridorLabel}${amountStr}`;
    }
    default:
      return `Anomaly detected on ${corridorLabel}`;
  }
}

/**
 * Format a corridor label for human-readable descriptions.
 * Example: bridge=stargate, source=ethereum, dest=avalanche
 *   → "Stargate Ethereum→Avalanche"
 */
function formatCorridorLabel(
  bridge: string,
  sourceChain: string | null,
  destChain: string | null,
): string {
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const bridgePart = cap(bridge);
  if (sourceChain && destChain) {
    return `${bridgePart} ${cap(sourceChain)}→${cap(destChain)}`;
  }
  if (sourceChain) return `${bridgePart} ${cap(sourceChain)}`;
  if (destChain) return `${bridgePart} →${cap(destChain)}`;
  return bridgePart;
}

function validationError(field: string, value: string, message: string): NextResponse {
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
