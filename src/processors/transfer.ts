/**
 * Transfer Processor
 *
 * Matches bridge transfer initiations to their completions, persists both to
 * the database, and publishes real-time status updates to Redis.
 *
 * Design:
 *   - pendingTransfers Map provides O(1) in-memory matching for the common case
 *     (initiation and completion observed within the same process lifetime).
 *   - Falls back to a database lookup when the matching initiation is not in
 *     memory (e.g. after a process restart).
 *   - Completions with no matching initiation in either memory or the database
 *     are logged as warnings and discarded — they are tracked by the
 *     reconciliation job (docs/UPDATED-SPEC.md "Data Integrity").
 *
 * Field mapping from TransferEvent to the transfers table:
 *   initiation: timestamp → initiatedAt, txHash → txHashSource, blockNumber → blockInitiated
 *   completion: timestamp → completedAt, txHash → txHashDest, blockNumber → blockCompleted
 *
 * Enrichment flow (docs/DATA-MODEL.md §4.3):
 *   1. Resolve chainId from event.sourceChain via CHAIN_IDS
 *   2. Look up token symbol, rawSymbol, and decimals from TOKEN_REGISTRY
 *   3. Normalize raw bigint amount to a human-readable float
 *   4. Fetch USD price (stablecoins = $1, ETH/WETH = CoinGecko)
 *   5. Calculate amountUsd and transferSizeBucket
 *   6. Store asset (canonical) and assetRaw (null when same as canonical)
 */

import { db } from '../lib/db';
import { publish } from '../lib/redis';
import { CHAIN_IDS, REDIS_CHANNELS, getSizeBucket } from '../lib/constants';
import { getTokenInfo, normalizeAmount } from '../lib/token-registry';
import { priceService } from '../lib/price-service';
import type { TransferEvent } from '../types';

export class TransferProcessor {
  /**
   * In-memory map from transferId → initiation event.
   *
   * Populated on initiation; cleared on completion or process restart.
   * Gives O(1) matching for the common case where both events are observed
   * within the same process lifetime.
   */
  private readonly pendingTransfers: Map<string, TransferEvent> = new Map();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async processEvent(event: TransferEvent): Promise<void> {
    if (event.type === 'initiation') {
      await this.handleInitiation(event);
    } else if (event.type === 'completion') {
      await this.handleCompletion(event);
    }
  }

  // ---------------------------------------------------------------------------
  // Initiation
  // ---------------------------------------------------------------------------

  private async handleInitiation(event: TransferEvent): Promise<void> {
    // Enrich with token symbol, USD value, and size bucket (docs/DATA-MODEL.md §4.3)
    const chainId = CHAIN_IDS[event.sourceChain];
    const tokenInfo = getTokenInfo(chainId, event.tokenAddress);
    const symbol = tokenInfo?.symbol ?? event.tokenAddress;
    // null when on-chain symbol matches canonical (null-means-same convention)
    const assetRaw = tokenInfo?.rawSymbol ?? null;
    const decimals = tokenInfo?.decimals ?? 18;

    const normalizedAmount = normalizeAmount(event.amount, decimals);
    const price = await priceService.getPrice(symbol);
    const amountUsd = price > 0 ? normalizedAmount * price : null;
    const transferSizeBucket = amountUsd != null && amountUsd > 0
      ? getSizeBucket(amountUsd)
      : null;

    await db.transfer.create({
      data: {
        transferId: event.transferId,
        bridge: event.bridge,
        sourceChain: event.sourceChain,
        destChain: event.destChain,
        asset: symbol,
        assetRaw,
        // amount is a bigint; Prisma accepts string for Decimal fields.
        amount: event.amount.toString(),
        amountUsd,
        initiatedAt: event.timestamp,
        status: 'pending',
        txHashSource: event.txHash,
        blockInitiated: event.blockNumber,
        gasPriceGwei: null,
        transferSizeBucket,
        hourOfDay: event.timestamp.getUTCHours(),
        dayOfWeek: event.timestamp.getUTCDay(),
      },
    });

    this.pendingTransfers.set(event.transferId, event);

    await publish(REDIS_CHANNELS.TRANSFER_INITIATED, event);
  }

  // ---------------------------------------------------------------------------
  // Completion
  // ---------------------------------------------------------------------------

  private async handleCompletion(event: TransferEvent): Promise<void> {
    const pendingEvent = this.pendingTransfers.get(event.transferId);

    let initiatedAt: Date;

    if (pendingEvent) {
      // Fast path: initiation is still in memory.
      initiatedAt = pendingEvent.timestamp;
    } else {
      // Slow path: process was restarted since the initiation was received.
      const dbTransfer = await db.transfer.findUnique({
        where: { transferId: event.transferId },
        select: { initiatedAt: true },
      });

      if (!dbTransfer) {
        console.warn(`[TransferProcessor] Completion without initiation: ${event.transferId}`);
        return;
      }

      initiatedAt = dbTransfer.initiatedAt;
    }

    const durationSeconds = Math.floor(
      (event.timestamp.getTime() - initiatedAt.getTime()) / 1000,
    );

    await db.transfer.update({
      where: { transferId: event.transferId },
      data: {
        completedAt: event.timestamp,
        durationSeconds,
        status: 'completed',
        txHashDest: event.txHash,
        blockCompleted: event.blockNumber,
      },
    });

    this.pendingTransfers.delete(event.transferId);

    await publish(REDIS_CHANNELS.TRANSFER_COMPLETED, { ...event, durationSeconds });
  }
}
