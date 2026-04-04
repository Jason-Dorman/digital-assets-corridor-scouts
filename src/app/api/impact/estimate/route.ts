/**
 * GET /api/impact/estimate
 *
 * Calculate liquidity impact for a potential transfer.
 *
 * Response schema: docs/API-SPEC.md ImpactEstimateResponse
 * Response format: UPDATED-SPEC.md "GET /api/impact/estimate"
 * Impact formula: docs/DATA-MODEL.md §8 (§6 in file)
 * Rounding: poolSharePct to 2 decimals, estimatedSlippageBps to 1 decimal (DATA-MODEL.md §12)
 * Disclaimer: always present per DATA-MODEL.md §8.4
 *
 * Required query parameters:
 *   bridge     – bridge protocol (across | cctp | stargate)
 *   source     – source chain
 *   dest       – destination chain
 *   amountUsd  – transfer amount in USD (positive number)
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '../../../../lib/db';
import { calculateImpact, IMPACT_DISCLAIMER } from '../../../../calculators/impact';
import { calculateFragility } from '../../../../calculators/fragility';
import { calculateHealthStatus } from '../../../../calculators/health';
import { calculatePercentile } from '../../../../lib/corridor-metrics';
import { round2 } from '../../../../lib/round';
import { logger } from '../../../../lib/logger';
import { ANOMALY_THRESHOLDS, VALID_BRIDGES, VALID_CHAIN_NAMES, STABLECOINS } from '../../../../lib/constants';
import type { BridgeName } from '../../../../lib/constants';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = request.nextUrl;

    const bridge = searchParams.get('bridge');
    const source = searchParams.get('source');
    const dest = searchParams.get('dest');
    const rawAmount = searchParams.get('amountUsd');

    // Validate required params
    if (!bridge || !source || !dest || !rawAmount) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Required parameters: bridge, source, dest, amountUsd',
          },
        },
        { status: 400 },
      );
    }

    if (!VALID_BRIDGES.has(bridge)) {
      return validationError('bridge', bridge, 'Must be one of: across, cctp, stargate');
    }
    if (!VALID_CHAIN_NAMES.has(source)) {
      return validationError('source', source, `Must be one of: ${[...VALID_CHAIN_NAMES].join(', ')}`);
    }
    if (!VALID_CHAIN_NAMES.has(dest)) {
      return validationError('dest', dest, `Must be one of: ${[...VALID_CHAIN_NAMES].join(', ')}`);
    }

    const amountUsd = parseFloat(rawAmount);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return validationError('amountUsd', rawAmount, 'Must be a positive number');
    }

    const corridorId = `${bridge}_${source}_${dest}`;
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3_600_000);
    const twentyFourHoursAgo = new Date(now.getTime() - 86_400_000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);

    // Fetch pool snapshots + corridor transfer data in parallel.
    // Pool snapshots: fetch all stablecoin pools for this bridge+chain in the 24h window.
    // A bridge may have multiple pools on the same chain (e.g. USDC + USDT);
    // aggregating avoids returning data for whichever pool sorts first.
    const [poolSnapshots24h, transfers7d] = await Promise.all([
      db.poolSnapshot.findMany({
        where: {
          bridge: bridge as BridgeName,
          chain: dest,
          asset: { in: [...STABLECOINS] },
          recordedAt: { gte: twentyFourHoursAgo },
        },
        orderBy: { recordedAt: 'desc' },
        take: ANOMALY_THRESHOLDS.MAX_POOL_SNAPSHOT_QUERY_ROWS,
      }),
      db.transfer.findMany({
        where: { bridge: bridge as BridgeName, sourceChain: source, destChain: dest, initiatedAt: { gte: sevenDaysAgo } },
        select: { status: true, durationSeconds: true, initiatedAt: true },
        orderBy: { initiatedAt: 'desc' },
        take: ANOMALY_THRESHOLDS.MAX_TRANSFER_QUERY_ROWS,
      }),
    ]);

    // Aggregate pool snapshots: latest and oldest snapshot per poolId, then sum across pools.
    type SnapRow = (typeof poolSnapshots24h)[0];
    const latestByPool = new Map<string, SnapRow>();
    const oldestByPool = new Map<string, SnapRow>();
    for (const snap of poolSnapshots24h) {
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
    const utilization =
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
    const netFlow24h = tvlUsd - tvlStart;

    // Impact calculation (DATA-MODEL.md §8)
    const impactResult = calculateImpact({
      transferAmountUsd: amountUsd,
      poolTvlUsd: tvlUsd,
      bridge: bridge as BridgeName,
    });

    // Current fragility (DATA-MODEL.md §7 / §5)
    const currentFragility = calculateFragility({
      utilization,
      tvlUsd,
      netFlow24h,
      context: { corridor: corridorId },
    });

    // Post-transfer fragility (estimated):
    //   utilization increases by the pool share percentage
    //   net flow increases in outflow direction by the transfer amount
    const postUtilization = Math.min(100, utilization + impactResult.poolSharePct);
    const postNetFlow = netFlow24h - amountUsd;
    const postFragility = calculateFragility({
      utilization: postUtilization,
      tvlUsd,
      netFlow24h: postNetFlow,
      context: { corridor: corridorId, postTransfer: true },
    });

    // Corridor health from transfer data
    const t1h = transfers7d.filter(t => t.initiatedAt >= oneHourAgo);
    const comp1h = t1h.filter(t => t.status === 'completed').length;
    const fail1h = t1h.filter(t => t.status === 'failed').length;
    const stuck1h = t1h.filter(t => t.status === 'stuck').length;
    const dur1h = t1h
      .filter(t => t.durationSeconds != null)
      .map(t => t.durationSeconds as number);
    const dur7d = transfers7d
      .filter(t => t.status === 'completed' && t.durationSeconds != null)
      .map(t => t.durationSeconds as number);

    const sr1h = successRate(comp1h, fail1h, stuck1h);
    const currentP90 = calculatePercentile(dur1h, 90);
    const historicalP90 = calculatePercentile(dur7d, 90);
    const p50 = calculatePercentile(dur1h, 50);

    const healthResult = calculateHealthStatus({
      successRate1h: sr1h,
      currentP90,
      historicalP90,
      transferCount1h: t1h.length,
      context: { corridor: corridorId },
    });

    // Build recommendation
    const recommendation = buildRecommendation(impactResult.impactLevel, currentFragility.level);

    return NextResponse.json({
      corridorId,
      transferAmountUsd: round2(amountUsd),
      pool: {
        tvlUsd: round2(tvlUsd),
        utilization: round2(utilization),
        availableLiquidity: round2(availableLiquidity),
      },
      impact: {
        poolSharePct: round2(impactResult.poolSharePct),
        estimatedSlippageBps: round2(impactResult.estimatedSlippageBps),
        impactLevel: impactResult.impactLevel,
        warning: impactResult.warning,
      },
      fragility: {
        current: currentFragility.level,
        reason: currentFragility.reason,
        postTransfer: postFragility.level,
      },
      corridorHealth: {
        status: healthResult.status,
        // null when no duration data — 0 would be indistinguishable from "instant"
        p50DurationSeconds: dur1h.length > 0 ? Math.round(p50) : null,
        p90DurationSeconds: dur1h.length > 0 ? Math.round(currentP90) : null,
        successRate1h: t1h.length === 0 ? null : round2(sr1h),
      },
      recommendation,
      disclaimer: IMPACT_DISCLAIMER,
    });
  } catch (error) {
    logger.error('[api/impact/estimate] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successRate(completed: number, failed: number, stuck: number): number {
  const total = completed + failed + stuck;
  return total === 0 ? 100 : (completed / total) * 100;
}


/**
 * Generate an actionable recommendation based on impact level and pool fragility.
 * Returns null when no specific advice is warranted.
 */
function buildRecommendation(
  impactLevel: string,
  fragilityLevel: string,
): string | null {
  if (impactLevel === 'severe') {
    return 'Split your transfer into multiple smaller transactions to reduce pool impact.';
  }
  if (impactLevel === 'high' && fragilityLevel === 'high') {
    return 'High impact on an already fragile pool. Consider splitting or routing via a different bridge.';
  }
  if (impactLevel === 'high') {
    return 'Consider splitting this transfer to reduce liquidity impact.';
  }
  if (fragilityLevel === 'high') {
    return 'Pool is under stress. Monitor for delays or consider an alternative bridge.';
  }
  return null;
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
