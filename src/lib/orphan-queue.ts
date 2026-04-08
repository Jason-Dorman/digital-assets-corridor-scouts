/**
 * Orphan Queue for unmatched transfer completions.
 *
 * Implements the "Missing Transfer Match" strategy from SYSTEM-SPEC.md §7:
 *   - Completion arrives without a matching initiation → store as orphan
 *   - Retry match after 5 minutes (initiation may arrive late)
 *   - Discard after 1 hour (initiation was likely missed entirely)
 *   - Alert if a pattern of orphans emerges
 *
 * The queue is in-memory and bounded. Orphans that survive past maxAgeMs
 * are evicted by pruneExpired(). Callers (TransferProcessor or a cron job)
 * should invoke retryMatches() periodically to attempt re-matching.
 *
 * Design:
 *   - Single responsibility: only manages orphan lifecycle, does not
 *     touch the database or Redis directly.
 *   - matchFn callback is injected so the queue is decoupled from DB logic.
 *   - Bounded size prevents unbounded memory growth (CLAUDE.md non-negotiable #5).
 */

import { logger } from './logger';
import type { TransferEvent } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrphanEntry {
  event: TransferEvent;
  enqueuedAt: number;
  lastRetryAt: number;
  retryCount: number;
}

export interface OrphanQueueOptions {
  /** Delay before first retry in milliseconds. Default: 300000 (5 min). */
  retryDelayMs?: number;
  /** Maximum age before discarding in milliseconds. Default: 3600000 (1 hr). */
  maxAgeMs?: number;
  /** Maximum number of orphans to hold. Default: 1000. */
  maxSize?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;  // 5 minutes
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;      // 1 hour
const DEFAULT_MAX_SIZE = 1000;

/** Alert when orphan count exceeds this fraction of maxSize. */
const ALERT_THRESHOLD_FRACTION = 0.5;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class OrphanQueue {
  private readonly orphans: Map<string, OrphanEntry> = new Map();
  private readonly retryDelayMs: number;
  private readonly maxAgeMs: number;
  private readonly maxSize: number;
  private alertFired = false;

  constructor(options: OrphanQueueOptions = {}) {
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  }

  /**
   * Add an unmatched completion event to the orphan queue.
   *
   * If the queue is at capacity, the oldest orphan is evicted to make room.
   * This ensures bounded memory usage per CLAUDE.md non-negotiable #5.
   */
  enqueue(event: TransferEvent): void {
    if (this.orphans.size >= this.maxSize) {
      this.evictOldest();
    }

    const now = Date.now();
    this.orphans.set(event.transferId, {
      event,
      enqueuedAt: now,
      lastRetryAt: now,
      retryCount: 0,
    });

    logger.warn('Orphan queued: completion without matching initiation', {
      transferId: event.transferId,
      bridge: event.bridge,
      sourceChain: event.sourceChain,
      destChain: event.destChain,
      queueSize: this.orphans.size,
    });

    this.checkAlertThreshold();
  }

  /**
   * Attempt to match orphans against the database.
   *
   * `matchFn` should return true if the orphan was successfully matched
   * (i.e. the initiation now exists in the DB and the completion was processed).
   *
   * Only retries orphans that have waited at least retryDelayMs since enqueue
   * or their last retry attempt.
   *
   * Returns the number of successfully matched orphans.
   */
  async retryMatches(
    matchFn: (event: TransferEvent) => Promise<boolean>,
  ): Promise<number> {
    const now = Date.now();
    let matched = 0;

    for (const [transferId, entry] of this.orphans) {
      if (now - entry.lastRetryAt < this.retryDelayMs) {
        continue;
      }

      try {
        const success = await matchFn(entry.event);
        if (success) {
          this.orphans.delete(transferId);
          matched++;
          logger.info('Orphan matched on retry', {
            transferId,
            retryCount: entry.retryCount + 1,
            ageMs: now - entry.enqueuedAt,
          });
        } else {
          entry.retryCount++;
          entry.lastRetryAt = now;
        }
      } catch (error) {
        logger.warn('Orphan retry match failed', {
          transferId,
          error: error instanceof Error ? error.message : String(error),
        });
        entry.retryCount++;
        entry.lastRetryAt = now;
      }
    }

    return matched;
  }

  /**
   * Remove orphans that have exceeded maxAgeMs.
   *
   * Returns the number of expired orphans discarded.
   */
  pruneExpired(): number {
    const cutoff = Date.now() - this.maxAgeMs;
    let discarded = 0;

    for (const [transferId, entry] of this.orphans) {
      if (entry.enqueuedAt < cutoff) {
        this.orphans.delete(transferId);
        discarded++;
        logger.warn('Orphan discarded: exceeded max age', {
          transferId,
          bridge: entry.event.bridge,
          ageMs: Date.now() - entry.enqueuedAt,
          retryCount: entry.retryCount,
        });
      }
    }

    return discarded;
  }

  /** Current number of orphans in the queue. */
  size(): number {
    return this.orphans.size;
  }

  /** Check if a specific transfer is in the orphan queue. */
  has(transferId: string): boolean {
    return this.orphans.has(transferId);
  }

  /** Clear all orphans — used in tests. */
  clear(): void {
    this.orphans.clear();
    this.alertFired = false;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private evictOldest(): void {
    const oldestKey = this.orphans.keys().next().value;
    if (oldestKey !== undefined) {
      const entry = this.orphans.get(oldestKey);
      this.orphans.delete(oldestKey);
      logger.warn('Orphan evicted: queue at capacity', {
        transferId: oldestKey,
        ageMs: entry ? Date.now() - entry.enqueuedAt : 0,
        maxSize: this.maxSize,
      });
    }
  }

  private checkAlertThreshold(): void {
    const threshold = Math.floor(this.maxSize * ALERT_THRESHOLD_FRACTION);
    if (this.orphans.size >= threshold && !this.alertFired) {
      this.alertFired = true;
      logger.error('Orphan queue alert: high orphan count may indicate missed initiations', {
        queueSize: this.orphans.size,
        threshold,
        maxSize: this.maxSize,
      });
    } else if (this.orphans.size < threshold) {
      this.alertFired = false;
    }
  }
}
