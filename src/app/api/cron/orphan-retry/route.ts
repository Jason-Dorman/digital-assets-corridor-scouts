/**
 * Cron Route — Orphan Transfer Retry
 *
 * Triggered by Vercel Cron every 5 minutes (configured in vercel.json).
 * Retries unmatched completion events stored in the TransferProcessor's
 * orphan queue (SYSTEM-SPEC.md §7 "Missing Transfer Match").
 *
 * Schedule: every 5 minutes  (matches OrphanQueue retryDelayMs default)
 *
 * Security
 * ────────
 * Same CRON_SECRET pattern as stuck-detector.
 *
 * vercel.json entry:
 *   { "path": "/api/cron/orphan-retry", "schedule": "every 5 minutes" }
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { getTransferProcessor } from '../../../../lib/transfer-processor-singleton';
import { logger } from '../../../../lib/logger';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === 'production') {
    logger.warn('[cron/orphan-retry] CRON_SECRET is not set — endpoint is unauthenticated');
  }

  try {
    const processor = getTransferProcessor();
    const result = await processor.retryOrphans();

    logger.info('[cron/orphan-retry] Run complete', {
      matched: result.matched,
      pruned: result.pruned,
      queueSize: processor.orphanQueue.size(),
    });

    return NextResponse.json({
      ok: true,
      result: {
        matched: result.matched,
        pruned: result.pruned,
        queueSize: processor.orphanQueue.size(),
      },
    });
  } catch (error) {
    logger.error('[cron/orphan-retry] Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
