/**
 * Tests for src/processors/transfer.ts
 *
 * Strategy:
 *   - db, redis/publish, token-registry, and price-service are all fully mocked.
 *   - handleInitiation is tested via processEvent({ type: 'initiation', ... }).
 *   - handleCompletion is tested via processEvent({ type: 'completion', ... }).
 *   - The fast path (in-memory pendingTransfers) and slow path (DB fallback)
 *     are tested separately for completions.
 */

// ---------------------------------------------------------------------------
// Mock declarations
// ---------------------------------------------------------------------------

const mockUpsert  = jest.fn().mockResolvedValue({});
const mockUpdate  = jest.fn().mockResolvedValue({});
const mockFindUnique = jest.fn();

jest.mock('../../../src/lib/db', () => ({
  db: {
    transfer: {
      upsert:     (...args: unknown[]) => mockUpsert(...args),
      update:     (...args: unknown[]) => mockUpdate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
  },
}));

const mockPublish = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../src/lib/redis', () => ({
  publish:   (...args: unknown[]) => mockPublish(...args),
  subscribe: jest.fn(),
}));

const mockGetTokenInfo   = jest.fn();
const mockNormalizeAmount = jest.fn();

jest.mock('../../../src/lib/token-registry', () => ({
  getTokenInfo:    (...args: unknown[]) => mockGetTokenInfo(...args),
  normalizeAmount: (...args: unknown[]) => mockNormalizeAmount(...args),
}));

const mockGetPrice = jest.fn();

jest.mock('../../../src/lib/price-service', () => ({
  priceService: { getPrice: (...args: unknown[]) => mockGetPrice(...args) },
}));

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { TransferProcessor } from '../../../src/processors/transfer';
import { CHAIN_IDS, REDIS_CHANNELS } from '../../../src/lib/constants';
import type { TransferEvent } from '../../../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT_ARB = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const UNKNOWN_TOKEN = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

const INITIATION_TIMESTAMP = new Date('2026-01-01T12:00:00Z');
const COMPLETION_TIMESTAMP = new Date('2026-01-01T12:05:00Z');
const EXPECTED_DURATION    = 300; // 5 minutes in seconds

function makeInitiation(overrides: Partial<TransferEvent> = {}): TransferEvent {
  return {
    type: 'initiation',
    transferId: 'test-transfer-1',
    bridge: 'across',
    sourceChain: 'ethereum',
    destChain: 'arbitrum',
    tokenAddress: USDC_ETH,
    amount: 10_000_000n, // 10 USDC at 6 decimals
    timestamp: INITIATION_TIMESTAMP,
    txHash: '0xsource111111111111111111111111111111111111111111111111111111111111',
    blockNumber: 20_000_000n,
    ...overrides,
  };
}

function makeCompletion(overrides: Partial<TransferEvent> = {}): TransferEvent {
  return {
    type: 'completion',
    transferId: 'test-transfer-1',
    bridge: 'across',
    sourceChain: 'ethereum',
    destChain: 'arbitrum',
    tokenAddress: USDC_ETH,
    amount: 10_000_000n,
    timestamp: COMPLETION_TIMESTAMP,
    txHash: '0xdest2222222222222222222222222222222222222222222222222222222222222222',
    blockNumber: 20_100_000n,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockUpsert.mockClear();
  mockUpdate.mockClear();
  mockFindUnique.mockClear();
  mockPublish.mockClear();
  mockGetTokenInfo.mockClear();
  mockNormalizeAmount.mockClear();
  mockGetPrice.mockClear();

  // Sensible defaults for the happy path
  mockGetTokenInfo.mockReturnValue({ symbol: 'USDC', decimals: 6 });
  mockNormalizeAmount.mockReturnValue(10.0); // 10 USDC
  mockGetPrice.mockResolvedValue(1.0);       // $1 stablecoin
});

// ---------------------------------------------------------------------------
// processEvent routing
// ---------------------------------------------------------------------------

describe('processEvent routing', () => {
  it('calls handleInitiation for type="initiation"', async () => {
    const processor = new TransferProcessor();
    const event = makeInitiation();
    await processor.processEvent(event);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('calls handleCompletion for type="completion" (fast path — initiation in memory)', async () => {
    const processor = new TransferProcessor();
    // First register the initiation so fast path works
    await processor.processEvent(makeInitiation());
    mockUpsert.mockClear();
    mockPublish.mockClear();

    await processor.processEvent(makeCompletion());
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an unrecognised type', async () => {
    const processor = new TransferProcessor();
    // Cast to any to bypass TypeScript so we can test runtime safety
    await processor.processEvent({ type: 'unknown' } as any);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleInitiation — token enrichment
// ---------------------------------------------------------------------------

describe('handleInitiation — token enrichment', () => {
  it('calls getTokenInfo with the correct chainId and tokenAddress', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockGetTokenInfo).toHaveBeenCalledWith(CHAIN_IDS.ethereum, USDC_ETH);
  });

  it('uses the symbol from token registry for the asset field', async () => {
    mockGetTokenInfo.mockReturnValue({ symbol: 'USDC', decimals: 6 });
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ asset: 'USDC' }) }),
    );
  });

  it('falls back to tokenAddress as asset when token is not in registry', async () => {
    mockGetTokenInfo.mockReturnValue(null);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ tokenAddress: UNKNOWN_TOKEN }));
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ asset: UNKNOWN_TOKEN }) }),
    );
  });

  it('sets assetRaw to the rawSymbol when it differs from the canonical symbol', async () => {
    // Arbitrum USDT — rawSymbol is 'USD₮0'
    mockGetTokenInfo.mockReturnValue({ symbol: 'USDT', rawSymbol: 'USD₮0', decimals: 6 });
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ tokenAddress: USDT_ARB }));
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ assetRaw: 'USD₮0' }) }),
    );
  });

  it('sets assetRaw to null when the token has no rawSymbol (canonical = on-chain)', async () => {
    mockGetTokenInfo.mockReturnValue({ symbol: 'USDC', decimals: 6 }); // no rawSymbol
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ assetRaw: null }) }),
    );
  });

  it('sets assetRaw to null when token is unknown (no registry entry)', async () => {
    mockGetTokenInfo.mockReturnValue(null);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ tokenAddress: UNKNOWN_TOKEN }));
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ assetRaw: null }) }),
    );
  });

  it('uses 18 as default decimals when token is not in registry', async () => {
    mockGetTokenInfo.mockReturnValue(null);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ tokenAddress: UNKNOWN_TOKEN }));
    // normalizeAmount should have been called with decimals=18
    expect(mockNormalizeAmount).toHaveBeenCalledWith(expect.anything(), 18);
  });

  it('uses decimals from registry when token is known', async () => {
    mockGetTokenInfo.mockReturnValue({ symbol: 'USDC', decimals: 6 });
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockNormalizeAmount).toHaveBeenCalledWith(expect.anything(), 6);
  });
});

// ---------------------------------------------------------------------------
// handleInitiation — USD calculation and size bucket
// ---------------------------------------------------------------------------

describe('handleInitiation — USD calculation', () => {
  it('calls priceService.getPrice with the resolved symbol', async () => {
    mockGetTokenInfo.mockReturnValue({ symbol: 'USDC', decimals: 6 });
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockGetPrice).toHaveBeenCalledWith('USDC');
  });

  it('stores the transfer with amountUsd=null when price service throws', async () => {
    // A price service outage must not drop the transfer — the DB write must
    // still happen, with amountUsd=null as the fallback (price unknown).
    mockGetPrice.mockRejectedValue(new Error('CoinGecko rate limit'));
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ amountUsd: null }) }),
    );
    consoleSpy.mockRestore();
  });

  it('publishes to Redis even when price service throws', async () => {
    mockGetPrice.mockRejectedValue(new Error('CoinGecko timeout'));
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockPublish).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('calls priceService.getPrice with the tokenAddress when token is unknown', async () => {
    mockGetTokenInfo.mockReturnValue(null);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ tokenAddress: UNKNOWN_TOKEN }));
    expect(mockGetPrice).toHaveBeenCalledWith(UNKNOWN_TOKEN);
  });

  it('sets amountUsd to normalizedAmount * price', async () => {
    mockNormalizeAmount.mockReturnValue(10.0);
    mockGetPrice.mockResolvedValue(1.0);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ amountUsd: 10.0 }) }),
    );
  });

  it('sets amountUsd to null when price is 0', async () => {
    mockGetPrice.mockResolvedValue(0);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ amountUsd: null }) }),
    );
  });

  it('sets amountUsd to 0 (not null) when normalizedAmount is 0 and price > 0', async () => {
    // The null guard is `price > 0`, not `amount > 0`.
    // A zero-value transfer is stored as amountUsd=0; transferSizeBucket is null.
    mockNormalizeAmount.mockReturnValue(0);
    mockGetPrice.mockResolvedValue(1.0);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ amount: 0n }));
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ amountUsd: 0, transferSizeBucket: null }),
      }),
    );
  });

  it('computes correct amountUsd for WETH at $3000', async () => {
    mockGetTokenInfo.mockReturnValue({ symbol: 'WETH', decimals: 18 });
    mockNormalizeAmount.mockReturnValue(2.5); // 2.5 ETH
    mockGetPrice.mockResolvedValue(3000);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ amountUsd: 7500 }) }),
    );
  });

  it('sets transferSizeBucket to "small" for < $10K', async () => {
    mockNormalizeAmount.mockReturnValue(100);
    mockGetPrice.mockResolvedValue(1.0); // $100
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ transferSizeBucket: 'small' }) }),
    );
  });

  it('sets transferSizeBucket to "medium" for $10K–$99,999', async () => {
    mockNormalizeAmount.mockReturnValue(50_000);
    mockGetPrice.mockResolvedValue(1.0);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ transferSizeBucket: 'medium' }) }),
    );
  });

  it('sets transferSizeBucket to "large" for $100K–$999,999', async () => {
    mockNormalizeAmount.mockReturnValue(500_000);
    mockGetPrice.mockResolvedValue(1.0);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ transferSizeBucket: 'large' }) }),
    );
  });

  it('sets transferSizeBucket to "whale" for >= $1M', async () => {
    mockNormalizeAmount.mockReturnValue(1_000_000);
    mockGetPrice.mockResolvedValue(1.0);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ transferSizeBucket: 'whale' }) }),
    );
  });

  it('sets transferSizeBucket to null when amountUsd is null (price=0)', async () => {
    mockGetPrice.mockResolvedValue(0);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ transferSizeBucket: null }) }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleInitiation — DB record fields
// ---------------------------------------------------------------------------

describe('handleInitiation — DB record fields', () => {
  it('creates a transfer with status "pending"', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ status: 'pending' }) }),
    );
  });

  it('stores the raw amount as a string (Prisma Decimal field)', async () => {
    const processor = new TransferProcessor();
    const event = makeInitiation({ amount: 10_000_000n });
    await processor.processEvent(event);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ amount: '10000000' }) }),
    );
  });

  it('stores txHash as txHashSource', async () => {
    const processor = new TransferProcessor();
    const event = makeInitiation();
    await processor.processEvent(event);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ txHashSource: event.txHash }) }),
    );
  });

  it('stores blockNumber as blockInitiated', async () => {
    const processor = new TransferProcessor();
    const event = makeInitiation({ blockNumber: 19_999_999n });
    await processor.processEvent(event);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ blockInitiated: 19_999_999n }) }),
    );
  });

  it('stores the correct initiatedAt timestamp', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ initiatedAt: INITIATION_TIMESTAMP }) }),
    );
  });

  it('stores hourOfDay derived from UTC timestamp', async () => {
    // INITIATION_TIMESTAMP = 2026-01-01T12:00:00Z → hour = 12
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ hourOfDay: 12 }) }),
    );
  });

  it('stores dayOfWeek derived from UTC timestamp (Thursday = 4)', async () => {
    // 2026-01-01 is a Thursday (day 4)
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ dayOfWeek: 4 }) }),
    );
  });

  it('stores gasPriceGwei as null', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ gasPriceGwei: null }) }),
    );
  });

  it('stores the correct transferId, bridge, sourceChain, destChain', async () => {
    const processor = new TransferProcessor();
    const event = makeInitiation();
    await processor.processEvent(event);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          transferId: 'test-transfer-1',
          bridge: 'across',
          sourceChain: 'ethereum',
          destChain: 'arbitrum',
        }),
      }),
    );
  });

  it('upsert where clause uses transferId', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { transferId: 'test-transfer-1' } }),
    );
  });

  it('upsert update block is empty (duplicate initiation is a no-op)', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleInitiation — Redis publish
// ---------------------------------------------------------------------------

describe('handleInitiation — Redis publish', () => {
  it('publishes to TRANSFER_INITIATED channel after DB write', async () => {
    const processor = new TransferProcessor();
    const event = makeInitiation();
    await processor.processEvent(event);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(REDIS_CHANNELS.TRANSFER_INITIATED, event);
  });

  it('does not publish to TRANSFER_COMPLETED on initiation', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    const completedCalls = mockPublish.mock.calls.filter(
      ([channel]) => channel === REDIS_CHANNELS.TRANSFER_COMPLETED,
    );
    expect(completedCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleInitiation — in-memory tracking
// ---------------------------------------------------------------------------

describe('handleInitiation — pendingTransfers tracking', () => {
  it('adds the event to pendingTransfers after processing', async () => {
    const processor = new TransferProcessor();
    const event = makeInitiation();
    await processor.processEvent(event);
    // Verify via completion fast path: if in memory, findUnique is NOT called
    mockFindUnique.mockResolvedValue(null);
    await processor.processEvent(makeCompletion());
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('tracks each unique transferId independently', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ transferId: 'id-A' }));
    await processor.processEvent(makeInitiation({ transferId: 'id-B' }));

    // Both should be fast-path completable (no DB fallback needed)
    await processor.processEvent(makeCompletion({ transferId: 'id-A' }));
    await processor.processEvent(makeCompletion({ transferId: 'id-B' }));
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleCompletion — fast path (in-memory)
// ---------------------------------------------------------------------------

describe('handleCompletion — fast path (initiation in memory)', () => {
  it('does NOT query the database for initiatedAt when initiation is in memory', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    mockFindUnique.mockClear();
    await processor.processEvent(makeCompletion());
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('calculates durationSeconds correctly from in-memory initiatedAt', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    await processor.processEvent(makeCompletion());
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationSeconds: EXPECTED_DURATION }),
      }),
    );
  });

  it('updates DB record with completedAt, status, txHashDest, blockCompleted', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    const completion = makeCompletion();
    await processor.processEvent(completion);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { transferId: 'test-transfer-1' },
        data: expect.objectContaining({
          completedAt: COMPLETION_TIMESTAMP,
          status: 'completed',
          txHashDest: completion.txHash,
          blockCompleted: completion.blockNumber,
        }),
      }),
    );
  });

  it('removes the transferId from pendingTransfers after completion', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    await processor.processEvent(makeCompletion());

    // A second completion for the same ID must now fall through to the slow path
    mockFindUnique.mockResolvedValue(null);
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await processor.processEvent(makeCompletion());
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('publishes to TRANSFER_COMPLETED with durationSeconds', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    mockPublish.mockClear();
    const completion = makeCompletion();
    await processor.processEvent(completion);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      REDIS_CHANNELS.TRANSFER_COMPLETED,
      expect.objectContaining({ durationSeconds: EXPECTED_DURATION }),
    );
  });

  it('does not publish to TRANSFER_INITIATED on completion', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation());
    mockPublish.mockClear();
    await processor.processEvent(makeCompletion());
    const initiatedCalls = mockPublish.mock.calls.filter(
      ([channel]) => channel === REDIS_CHANNELS.TRANSFER_INITIATED,
    );
    expect(initiatedCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleCompletion — slow path (DB fallback)
// ---------------------------------------------------------------------------

describe('handleCompletion — slow path (DB fallback after restart)', () => {
  it('queries DB for initiatedAt when transfer is not in memory', async () => {
    mockFindUnique.mockResolvedValue({ initiatedAt: INITIATION_TIMESTAMP });
    const processor = new TransferProcessor();
    await processor.processEvent(makeCompletion());
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { transferId: 'test-transfer-1' },
      select: { initiatedAt: true },
    });
  });

  it('calculates durationSeconds correctly using DB initiatedAt', async () => {
    mockFindUnique.mockResolvedValue({ initiatedAt: INITIATION_TIMESTAMP });
    const processor = new TransferProcessor();
    await processor.processEvent(makeCompletion());
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationSeconds: EXPECTED_DURATION }),
      }),
    );
  });

  it('publishes TRANSFER_COMPLETED after successful DB fallback', async () => {
    mockFindUnique.mockResolvedValue({ initiatedAt: INITIATION_TIMESTAMP });
    const processor = new TransferProcessor();
    await processor.processEvent(makeCompletion());
    expect(mockPublish).toHaveBeenCalledWith(
      REDIS_CHANNELS.TRANSFER_COMPLETED,
      expect.objectContaining({ durationSeconds: EXPECTED_DURATION }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleCompletion — orphaned completion (no matching initiation)
// ---------------------------------------------------------------------------

describe('handleCompletion — orphaned (no initiation found)', () => {
  it('logs a warning and does NOT update the database', async () => {
    mockFindUnique.mockResolvedValue(null);
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const processor = new TransferProcessor();
    await processor.processEvent(makeCompletion());
    expect(mockUpdate).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('logs a warning that includes the transferId', async () => {
    mockFindUnique.mockResolvedValue(null);
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const processor = new TransferProcessor();
    await processor.processEvent(makeCompletion({ transferId: 'orphan-99' }));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('orphan-99'),
    );
    consoleSpy.mockRestore();
  });

  it('does NOT publish to Redis for an orphaned completion', async () => {
    mockFindUnique.mockResolvedValue(null);
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const processor = new TransferProcessor();
    await processor.processEvent(makeCompletion());
    expect(mockPublish).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// durationSeconds precision
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// clearPending
// ---------------------------------------------------------------------------

describe('clearPending', () => {
  it('removes a single entry from pendingTransfers so the slow path is used on completion', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ transferId: 'id-clear' }));

    processor.clearPending('id-clear');

    // Now a completion must fall through to the slow path (DB lookup)
    mockFindUnique.mockResolvedValue({ initiatedAt: INITIATION_TIMESTAMP });
    await processor.processEvent(makeCompletion({ transferId: 'id-clear' }));
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  it('is a no-op for a transferId that was never registered', () => {
    const processor = new TransferProcessor();
    expect(() => processor.clearPending('non-existent')).not.toThrow();
  });

  it('does not affect other entries in pendingTransfers', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ transferId: 'keep' }));
    await processor.processEvent(makeInitiation({ transferId: 'remove' }));

    processor.clearPending('remove');

    // 'keep' is still in memory — its completion should not hit the DB
    await processor.processEvent(makeCompletion({ transferId: 'keep' }));
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// pruneStalePending
// ---------------------------------------------------------------------------

describe('pruneStalePending', () => {
  it('returns 0 when pendingTransfers is empty', () => {
    const processor = new TransferProcessor();
    expect(processor.pruneStalePending(60_000)).toBe(0);
  });

  it('returns 0 when no entries are older than maxAgeMs', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ transferId: 'fresh' }));
    // maxAgeMs = 1 hour — nothing is that old
    expect(processor.pruneStalePending(3_600_000)).toBe(0);
  });

  it('evicts entries whose insertedAt is older than cutoff and returns the count', async () => {
    // Pin insertedAt to t=1000 so real Date.now() is guaranteed to be greater.
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ transferId: 'stale-1' }));
    await processor.processEvent(makeInitiation({ transferId: 'stale-2' }));
    dateSpy.mockRestore();

    // maxAgeMs = 0: cutoff = real Date.now() >> 1000, both entries are stale
    const evicted = processor.pruneStalePending(0);
    expect(evicted).toBe(2);
  });

  it('evicted entries fall through to the slow path on completion', async () => {
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ transferId: 'to-prune' }));
    dateSpy.mockRestore();

    processor.pruneStalePending(0); // evict all (insertedAt=1000 < real now)

    mockFindUnique.mockResolvedValue({ initiatedAt: INITIATION_TIMESTAMP });
    await processor.processEvent(makeCompletion({ transferId: 'to-prune' }));
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  it('does not evict entries younger than maxAgeMs', async () => {
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ transferId: 'fresh-1' }));
    await processor.processEvent(makeInitiation({ transferId: 'fresh-2' }));

    // maxAgeMs = 1 hour; entries were just inserted — none should be evicted
    expect(processor.pruneStalePending(3_600_000)).toBe(0);

    // Both completions should still use the fast path
    await processor.processEvent(makeCompletion({ transferId: 'fresh-1' }));
    await processor.processEvent(makeCompletion({ transferId: 'fresh-2' }));
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// durationSeconds precision
// ---------------------------------------------------------------------------

describe('durationSeconds calculation', () => {
  it('floors fractional seconds (rounds down)', async () => {
    const initiated = new Date('2026-01-01T12:00:00.000Z');
    const completed = new Date('2026-01-01T12:00:01.999Z'); // 1.999s gap → floors to 1
    mockFindUnique.mockResolvedValue({ initiatedAt: initiated });
    const processor = new TransferProcessor();
    await processor.processEvent(makeCompletion({ timestamp: completed }));
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationSeconds: 1 }),
      }),
    );
  });

  it('produces durationSeconds=0 when completion and initiation are simultaneous', async () => {
    const ts = new Date('2026-01-01T12:00:00.000Z');
    const processor = new TransferProcessor();
    await processor.processEvent(makeInitiation({ timestamp: ts }));
    await processor.processEvent(makeCompletion({ timestamp: ts }));
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationSeconds: 0 }),
      }),
    );
  });
});
