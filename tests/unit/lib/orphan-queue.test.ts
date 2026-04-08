/**
 * Tests for src/lib/orphan-queue.ts
 *
 * Strategy:
 *   - Logger is mocked to capture warnings/errors without console noise.
 *   - Tests use real timers where needed (Date.now manipulation) but
 *     the queue itself doesn't use setTimeout, so no fake timers needed.
 *   - TransferEvent fixtures are minimal — only the fields the queue reads.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('../../../src/lib/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

import { OrphanQueue } from '../../../src/lib/orphan-queue';
import type { TransferEvent } from '../../../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(transferId: string): TransferEvent {
  return {
    type: 'completion',
    transferId,
    bridge: 'across',
    sourceChain: 'ethereum',
    destChain: 'arbitrum',
    tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amount: BigInt(1_000_000),
    timestamp: new Date(),
    txHash: `0x${transferId}`,
    blockNumber: BigInt(100),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let realDateNow: () => number;

beforeEach(() => {
  realDateNow = Date.now;
  mockLoggerInfo.mockClear();
  mockLoggerWarn.mockClear();
  mockLoggerError.mockClear();
});

afterEach(() => {
  Date.now = realDateNow;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OrphanQueue', () => {
  // -------------------------------------------------------------------------
  // Enqueue
  // -------------------------------------------------------------------------

  describe('enqueue', () => {
    it('adds an event to the queue', () => {
      const queue = new OrphanQueue();
      queue.enqueue(makeEvent('tx-1'));

      expect(queue.size()).toBe(1);
      expect(queue.has('tx-1')).toBe(true);
    });

    it('logs a warning when enqueuing', () => {
      const queue = new OrphanQueue();
      queue.enqueue(makeEvent('tx-1'));

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('completion without matching initiation'),
        expect.objectContaining({ transferId: 'tx-1' }),
      );
    });

    it('replaces a duplicate transferId', () => {
      const queue = new OrphanQueue();
      queue.enqueue(makeEvent('tx-1'));
      queue.enqueue(makeEvent('tx-1'));

      expect(queue.size()).toBe(1);
    });

    it('evicts the oldest entry when at capacity', () => {
      const queue = new OrphanQueue({ maxSize: 3 });

      queue.enqueue(makeEvent('tx-1'));
      queue.enqueue(makeEvent('tx-2'));
      queue.enqueue(makeEvent('tx-3'));
      queue.enqueue(makeEvent('tx-4'));

      expect(queue.size()).toBe(3);
      expect(queue.has('tx-1')).toBe(false);
      expect(queue.has('tx-4')).toBe(true);
    });

    it('logs when evicting due to capacity', () => {
      const queue = new OrphanQueue({ maxSize: 1 });

      queue.enqueue(makeEvent('tx-1'));
      queue.enqueue(makeEvent('tx-2'));

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('queue at capacity'),
        expect.objectContaining({ transferId: 'tx-1' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Alert threshold
  // -------------------------------------------------------------------------

  describe('alert threshold', () => {
    it('logs an error when queue reaches 50% capacity', () => {
      const queue = new OrphanQueue({ maxSize: 4 });

      queue.enqueue(makeEvent('tx-1'));
      expect(mockLoggerError).not.toHaveBeenCalled();

      queue.enqueue(makeEvent('tx-2')); // 50% of maxSize=4

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining('high orphan count'),
        expect.objectContaining({ queueSize: 2, threshold: 2 }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // retryMatches
  // -------------------------------------------------------------------------

  describe('retryMatches', () => {
    it('does not retry before retryDelayMs has elapsed', async () => {
      const now = 1000000;
      Date.now = () => now;

      const queue = new OrphanQueue({ retryDelayMs: 5000 });
      queue.enqueue(makeEvent('tx-1'));

      // Only 1 second later
      Date.now = () => now + 1000;
      const matchFn = jest.fn().mockResolvedValue(true);
      const matched = await queue.retryMatches(matchFn);

      expect(matched).toBe(0);
      expect(matchFn).not.toHaveBeenCalled();
    });

    it('retries after retryDelayMs has elapsed', async () => {
      const now = 1000000;
      Date.now = () => now;

      const queue = new OrphanQueue({ retryDelayMs: 5000 });
      queue.enqueue(makeEvent('tx-1'));

      Date.now = () => now + 5001;
      const matchFn = jest.fn().mockResolvedValue(true);
      const matched = await queue.retryMatches(matchFn);

      expect(matched).toBe(1);
      expect(matchFn).toHaveBeenCalledTimes(1);
      expect(queue.size()).toBe(0);
    });

    it('removes matched orphans from the queue', async () => {
      const now = 1000000;
      Date.now = () => now;

      const queue = new OrphanQueue({ retryDelayMs: 100 });
      queue.enqueue(makeEvent('tx-1'));
      queue.enqueue(makeEvent('tx-2'));

      Date.now = () => now + 200;
      const matchFn = jest.fn()
        .mockResolvedValueOnce(true)   // tx-1 matches
        .mockResolvedValueOnce(false); // tx-2 doesn't

      const matched = await queue.retryMatches(matchFn);

      expect(matched).toBe(1);
      expect(queue.has('tx-1')).toBe(false);
      expect(queue.has('tx-2')).toBe(true);
    });

    it('logs info when an orphan is matched on retry', async () => {
      const now = 1000000;
      Date.now = () => now;

      const queue = new OrphanQueue({ retryDelayMs: 100 });
      queue.enqueue(makeEvent('tx-1'));

      Date.now = () => now + 200;
      await queue.retryMatches(jest.fn().mockResolvedValue(true));

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining('Orphan matched on retry'),
        expect.objectContaining({ transferId: 'tx-1' }),
      );
    });

    it('increments retryCount on failed match and requires another delay', async () => {
      const now = 1000000;
      Date.now = () => now;

      const queue = new OrphanQueue({ retryDelayMs: 100 });
      queue.enqueue(makeEvent('tx-1'));

      // First retry at +150ms — eligible (150ms since enqueue > retryDelay 100), no match
      Date.now = () => now + 150;
      await queue.retryMatches(jest.fn().mockResolvedValue(false));
      expect(queue.has('tx-1')).toBe(true);

      // Second attempt at +180ms — too soon: only 30ms since lastRetryAt (150) < 100
      Date.now = () => now + 180;
      const matchFn2 = jest.fn().mockResolvedValue(true);
      const matched2 = await queue.retryMatches(matchFn2);
      expect(matched2).toBe(0);
      expect(matchFn2).not.toHaveBeenCalled();

      // Third attempt at +260ms — eligible: 110ms since lastRetryAt (150) >= 100
      Date.now = () => now + 260;
      const matchFn3 = jest.fn().mockResolvedValue(true);
      const matched3 = await queue.retryMatches(matchFn3);
      expect(matched3).toBe(1);
      expect(queue.has('tx-1')).toBe(false);
    });

    it('handles matchFn throwing an error gracefully', async () => {
      const now = 1000000;
      Date.now = () => now;

      const queue = new OrphanQueue({ retryDelayMs: 100 });
      queue.enqueue(makeEvent('tx-1'));

      Date.now = () => now + 200;
      const matchFn = jest.fn().mockRejectedValue(new Error('db-down'));
      const matched = await queue.retryMatches(matchFn);

      expect(matched).toBe(0);
      expect(queue.has('tx-1')).toBe(true); // not discarded on error
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('retry match failed'),
        expect.objectContaining({ transferId: 'tx-1' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // pruneExpired
  // -------------------------------------------------------------------------

  describe('pruneExpired', () => {
    it('removes orphans older than maxAgeMs', () => {
      const now = 1000000;
      Date.now = () => now;

      const queue = new OrphanQueue({ maxAgeMs: 60_000 });
      queue.enqueue(makeEvent('tx-old'));

      Date.now = () => now + 60_001;
      const discarded = queue.pruneExpired();

      expect(discarded).toBe(1);
      expect(queue.size()).toBe(0);
    });

    it('keeps orphans younger than maxAgeMs', () => {
      const now = 1000000;
      Date.now = () => now;

      const queue = new OrphanQueue({ maxAgeMs: 60_000 });
      queue.enqueue(makeEvent('tx-young'));

      Date.now = () => now + 30_000;
      const discarded = queue.pruneExpired();

      expect(discarded).toBe(0);
      expect(queue.size()).toBe(1);
    });

    it('only removes expired entries from a mixed queue', () => {
      const now = 1000000;
      Date.now = () => now;

      const queue = new OrphanQueue({ maxAgeMs: 60_000 });
      queue.enqueue(makeEvent('tx-old'));

      Date.now = () => now + 50_000;
      queue.enqueue(makeEvent('tx-new'));

      Date.now = () => now + 61_000;
      const discarded = queue.pruneExpired();

      expect(discarded).toBe(1);
      expect(queue.has('tx-old')).toBe(false);
      expect(queue.has('tx-new')).toBe(true);
    });

    it('logs a warning for each discarded orphan', () => {
      const now = 1000000;
      Date.now = () => now;

      const queue = new OrphanQueue({ maxAgeMs: 1000 });
      queue.enqueue(makeEvent('tx-1'));
      mockLoggerWarn.mockClear();

      Date.now = () => now + 2000;
      queue.pruneExpired();

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('exceeded max age'),
        expect.objectContaining({ transferId: 'tx-1' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Utility methods
  // -------------------------------------------------------------------------

  describe('utility methods', () => {
    it('clear() removes all orphans', () => {
      const queue = new OrphanQueue();
      queue.enqueue(makeEvent('tx-1'));
      queue.enqueue(makeEvent('tx-2'));

      queue.clear();

      expect(queue.size()).toBe(0);
      expect(queue.has('tx-1')).toBe(false);
    });

    it('has() returns false for non-existent transferId', () => {
      const queue = new OrphanQueue();
      expect(queue.has('nonexistent')).toBe(false);
    });

    it('size() returns 0 for empty queue', () => {
      const queue = new OrphanQueue();
      expect(queue.size()).toBe(0);
    });
  });
});
