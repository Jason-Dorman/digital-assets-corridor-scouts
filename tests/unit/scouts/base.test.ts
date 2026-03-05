/**
 * Tests for src/scouts/base.ts
 *
 * BaseScout is abstract. All tests drive through StubScout — a minimal
 * concrete subclass that implements every abstract method as a no-op so
 * the protected helpers can be exercised directly.
 *
 * External modules (lib/redis, lib/rpc) are fully mocked so no real
 * Redis connections or RPC calls are made.
 */

// ---------------------------------------------------------------------------
// Mock setup — variable declarations must precede jest.mock() factory refs
// ---------------------------------------------------------------------------

const mockPublish = jest.fn().mockResolvedValue(undefined);
const mockRedisInstance = { publish: jest.fn() };

jest.mock('../../../src/lib/redis', () => ({
  redis: mockRedisInstance,
  publish: mockPublish,
  subscribe: jest.fn(),
}));

const mockGetProvider = jest.fn().mockImplementation((chain: string) => ({
  _chain: chain,
  _isMock: true,
}));

jest.mock('../../../src/lib/rpc', () => ({
  getProvider: mockGetProvider,
}));

// ---------------------------------------------------------------------------
// Imports — after jest.mock() declarations
// ---------------------------------------------------------------------------

import type { Log } from 'ethers';
import { BaseScout } from '../../../src/scouts/base';
import { REDIS_CHANNELS } from '../../../src/lib/constants';
import type { ChainName } from '../../../src/lib/constants';
import type { TransferEvent, TransferSizeBucket } from '../../../src/types';

// ---------------------------------------------------------------------------
// Concrete test double
// ---------------------------------------------------------------------------

class StubScout extends BaseScout {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  getContractAddress(_chain: ChainName): string {
    return '0x000000000000000000000000000000000000dead';
  }

  parseDepositEvent(_log: Log, _chainId: number, _timestamp: Date): TransferEvent | null {
    return null;
  }

  parseFillEvent(_log: Log, _chainId: number, _timestamp: Date): TransferEvent | null {
    return null;
  }

  // Expose protected methods
  callEmit(event: TransferEvent): Promise<void> {
    return this.emit(event);
  }
  callGenerateTransferId(chainId: number | string, identifier: number | string): string {
    return this.generateTransferId(chainId, identifier);
  }
  callGetSizeBucket(amountUsd: number): TransferSizeBucket {
    return this.getSizeBucket(amountUsd);
  }

  // Expose protected state
  get exposedChains() { return this.chains; }
  get exposedIsRunning() { return this.isRunning; }
  get exposedEventListeners() { return this.eventListeners; }
  get exposedRpcProviders() { return this.rpcProviders; }
  get exposedRedis() { return this.redis; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEvent(type: TransferEvent['type']): TransferEvent {
  return {
    type,
    transferId: '1_12345',
    bridge: 'across',
    sourceChain: 'ethereum',
    destChain: 'arbitrum',
    tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    amount: 10000000000n,
    timestamp: new Date('2026-01-01T00:00:00Z'),
    txHash: '0xabc',
    blockNumber: 20000000n,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockPublish.mockClear();
  mockGetProvider.mockClear();
});

// ---------------------------------------------------------------------------
// constructor
// ---------------------------------------------------------------------------

describe('constructor', () => {
  it('stores the given chains array', () => {
    const scout = new StubScout(['ethereum', 'arbitrum']);
    expect(scout.exposedChains).toEqual(['ethereum', 'arbitrum']);
  });

  it('initialises isRunning to false', () => {
    const scout = new StubScout(['ethereum']);
    expect(scout.exposedIsRunning).toBe(false);
  });

  it('initialises eventListeners as an empty array', () => {
    const scout = new StubScout(['ethereum']);
    expect(scout.exposedEventListeners).toEqual([]);
  });

  it('creates an rpcProviders Map with one entry per chain', () => {
    const scout = new StubScout(['ethereum', 'arbitrum', 'base']);
    expect(scout.exposedRpcProviders.size).toBe(3);
  });

  it('calls getProvider once for each supplied chain', () => {
    new StubScout(['ethereum', 'arbitrum']);
    expect(mockGetProvider).toHaveBeenCalledTimes(2);
    expect(mockGetProvider).toHaveBeenCalledWith('ethereum');
    expect(mockGetProvider).toHaveBeenCalledWith('arbitrum');
  });

  it('maps each chain to its own provider instance in rpcProviders', () => {
    const scout = new StubScout(['ethereum', 'optimism']);
    const ethProvider = scout.exposedRpcProviders.get('ethereum') as any;
    const optProvider = scout.exposedRpcProviders.get('optimism') as any;
    expect(ethProvider._chain).toBe('ethereum');
    expect(optProvider._chain).toBe('optimism');
  });

  it('stores the shared redis singleton', () => {
    const scout = new StubScout(['ethereum']);
    expect(scout.exposedRedis).toBe(mockRedisInstance);
  });

  it('works with a single chain', () => {
    const scout = new StubScout(['base']);
    expect(scout.exposedChains).toHaveLength(1);
    expect(scout.exposedRpcProviders.size).toBe(1);
    expect(mockGetProvider).toHaveBeenCalledWith('base');
  });

  it('works with all six supported chains', () => {
    const allChains: ChainName[] = [
      'ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'avalanche',
    ];
    const scout = new StubScout(allChains);
    expect(scout.exposedRpcProviders.size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// emit()
// ---------------------------------------------------------------------------

describe('emit', () => {
  it("routes type 'initiation' to the transfer:initiated channel", async () => {
    const scout = new StubScout(['ethereum']);
    await scout.callEmit(buildEvent('initiation'));
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      REDIS_CHANNELS.TRANSFER_INITIATED,
      expect.objectContaining({ type: 'initiation' }),
    );
  });

  it("routes type 'completion' to the transfer:completed channel", async () => {
    const scout = new StubScout(['ethereum']);
    await scout.callEmit(buildEvent('completion'));
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      REDIS_CHANNELS.TRANSFER_COMPLETED,
      expect.objectContaining({ type: 'completion' }),
    );
  });

  it('passes the full event payload to publish', async () => {
    const scout = new StubScout(['ethereum']);
    const event: TransferEvent = {
      type: 'initiation',
      transferId: '1_99999',
      bridge: 'across',
      sourceChain: 'ethereum',
      destChain: 'arbitrum',
      tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      amount: 5000000000n,
      timestamp: new Date('2026-01-01T00:00:00Z'),
      txHash: '0xabc',
      blockNumber: 19000000n,
    };
    await scout.callEmit(event);
    expect(mockPublish).toHaveBeenCalledWith(REDIS_CHANNELS.TRANSFER_INITIATED, event);
  });

  it('uses the exact channel strings defined in REDIS_CHANNELS', async () => {
    const scout = new StubScout(['ethereum']);

    await scout.callEmit(buildEvent('initiation'));
    expect(mockPublish.mock.calls[0][0]).toBe('transfer:initiated');

    mockPublish.mockClear();

    await scout.callEmit(buildEvent('completion'));
    expect(mockPublish.mock.calls[0][0]).toBe('transfer:completed');
  });
});

// ---------------------------------------------------------------------------
// generateTransferId()
// ---------------------------------------------------------------------------

describe('generateTransferId', () => {
  const scout = new StubScout(['ethereum']);

  it('produces the Across format: originChainId_depositId', () => {
    expect(scout.callGenerateTransferId(1, 12345)).toBe('1_12345');
  });

  it('produces the CCTP format: sourceDomain_nonce', () => {
    expect(scout.callGenerateTransferId(0, 67890)).toBe('0_67890');
  });

  it('produces the Stargate format: chainId_txHash', () => {
    expect(scout.callGenerateTransferId(1, '0xabc123def456')).toBe('1_0xabc123def456');
  });

  it('accepts number chainId and number identifier', () => {
    expect(scout.callGenerateTransferId(42161, 999)).toBe('42161_999');
  });

  it('accepts string chainId', () => {
    expect(scout.callGenerateTransferId('ethereum', 1)).toBe('ethereum_1');
  });

  it('accepts string identifier', () => {
    expect(scout.callGenerateTransferId(1, 'nonce-abc')).toBe('1_nonce-abc');
  });

  it('uses underscore as the separator', () => {
    const id = scout.callGenerateTransferId(1, 100);
    expect(id).toContain('_');
    const parts = id.split('_');
    expect(parts[0]).toBe('1');
    expect(parts[1]).toBe('100');
  });

  it('produces distinct IDs for different chainId values', () => {
    expect(scout.callGenerateTransferId(1, 100)).not.toBe(
      scout.callGenerateTransferId(2, 100),
    );
  });

  it('produces distinct IDs for different identifier values', () => {
    expect(scout.callGenerateTransferId(1, 100)).not.toBe(
      scout.callGenerateTransferId(1, 200),
    );
  });
});

// ---------------------------------------------------------------------------
// getSizeBucket()
// ---------------------------------------------------------------------------

describe('getSizeBucket', () => {
  const scout = new StubScout(['ethereum']);

  // Bucket: small (< $10,000)
  it('classifies $0 as small', () => {
    expect(scout.callGetSizeBucket(0)).toBe('small');
  });

  it('classifies $1 as small', () => {
    expect(scout.callGetSizeBucket(1)).toBe('small');
  });

  it('classifies $9,999 as small (just below the $10k boundary)', () => {
    expect(scout.callGetSizeBucket(9_999)).toBe('small');
  });

  // Bucket: medium ($10,000 – $99,999)
  it('classifies $10,000 as medium (at the lower boundary)', () => {
    expect(scout.callGetSizeBucket(10_000)).toBe('medium');
  });

  it('classifies $50,000 as medium', () => {
    expect(scout.callGetSizeBucket(50_000)).toBe('medium');
  });

  it('classifies $99,999 as medium (just below the $100k boundary)', () => {
    expect(scout.callGetSizeBucket(99_999)).toBe('medium');
  });

  // Bucket: large ($100,000 – $999,999)
  it('classifies $100,000 as large (at the lower boundary)', () => {
    expect(scout.callGetSizeBucket(100_000)).toBe('large');
  });

  it('classifies $500,000 as large', () => {
    expect(scout.callGetSizeBucket(500_000)).toBe('large');
  });

  it('classifies $999,999 as large (just below the $1M boundary)', () => {
    expect(scout.callGetSizeBucket(999_999)).toBe('large');
  });

  // Bucket: whale ($1,000,000+)
  it('classifies $1,000,000 as whale (at the lower boundary)', () => {
    expect(scout.callGetSizeBucket(1_000_000)).toBe('whale');
  });

  it('classifies $5,000,000 as whale', () => {
    expect(scout.callGetSizeBucket(5_000_000)).toBe('whale');
  });

  it('classifies very large amounts as whale', () => {
    expect(scout.callGetSizeBucket(100_000_000)).toBe('whale');
  });

  // All four buckets are reachable
  it('covers all four buckets across the threshold range', () => {
    const buckets = new Set([
      scout.callGetSizeBucket(0),
      scout.callGetSizeBucket(10_000),
      scout.callGetSizeBucket(100_000),
      scout.callGetSizeBucket(1_000_000),
    ]);
    expect(buckets).toEqual(new Set(['small', 'medium', 'large', 'whale']));
  });
});

// ---------------------------------------------------------------------------
// eventListeners
// ---------------------------------------------------------------------------

describe('eventListeners', () => {
  it('starts as an empty array', () => {
    const scout = new StubScout(['ethereum']);
    expect(scout.exposedEventListeners).toHaveLength(0);
  });

  it('allows pushing cleanup functions (simulating subclass listener registration)', () => {
    const scout = new StubScout(['ethereum']);
    const cleanup = jest.fn();
    scout.exposedEventListeners.push(cleanup);
    expect(scout.exposedEventListeners).toHaveLength(1);
  });

  it('stored cleanup functions are callable', () => {
    const scout = new StubScout(['ethereum']);
    const cleanup = jest.fn();
    scout.exposedEventListeners.push(cleanup);
    scout.exposedEventListeners[0]();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('supports multiple cleanup functions (one per contract listener)', () => {
    const scout = new StubScout(['ethereum', 'arbitrum']);
    const cleanupA = jest.fn();
    const cleanupB = jest.fn();
    scout.exposedEventListeners.push(cleanupA, cleanupB);
    expect(scout.exposedEventListeners).toHaveLength(2);
  });

  it('each instance has its own independent eventListeners array', () => {
    const scout1 = new StubScout(['ethereum']);
    const scout2 = new StubScout(['ethereum']);
    scout1.exposedEventListeners.push(jest.fn());
    expect(scout2.exposedEventListeners).toHaveLength(0);
  });
});
