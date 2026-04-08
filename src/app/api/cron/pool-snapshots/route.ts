/**
 * Cron Route — Pool Snapshots
 *
 * Triggered by Vercel Cron every 5 minutes (configured in vercel.json).
 * Runs PoolProcessor which queries on-chain contracts for TVL, computes
 * utilization, and writes rows to pool_snapshots.
 *
 * Security
 * ────────
 * When CRON_SECRET is set (production), Vercel passes it as:
 *   Authorization: Bearer <CRON_SECRET>
 * Requests without a matching header are rejected with 401.
 *
 * When CRON_SECRET is absent (local development), the check is skipped so
 * the route can be called manually without configuration.
 *
 * Add to Vercel dashboard: Settings → Environment Variables → CRON_SECRET
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { logger } from '../../../../lib/logger';
import { PoolProcessor } from '../../../../processors/pool';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const processor = new PoolProcessor();
    await processor.run();
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('[cron/pool-snapshots] Unhandled error', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
