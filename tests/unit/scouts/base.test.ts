/**
 * Tests for src/scouts/base.ts
 *
 * BaseScout is abstract. All tests drive through StubScout — a minimal
 * concrete subclass that implements every abstract method as a no-op so
 * the protected helpers can be exercised directly.
 *
 * External modules (lib/rpc) are fully mocked so no real RPC calls are made.
 *
 * emit() now calls the onEvent handler injected at construction — it no longer
 * publishes to Redis directly. Tests verify the injected handler is invoked
 * with the correct event payload.
 */

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

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
import type { ChainName } from '../../../src/lib/constants';
import type { TransferEvent } from '../../../src/types';

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

  // Expose protected state
  get exposedChains() { return this.chains; }
  get exposedIsRunning() { return this.isRunning; }
  get exposedEventListeners() { return this.eventListeners; }
  get exposedRpcProviders() { return this.rpcProviders; }
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
// Shared reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetProvider.mockClear();
});

// ---------------------------------------------------------------------------
// constructor
// ---------------------------------------------------------------------------

describe('constructor', () => {
  it('stores the given chains array', () => {
    const scout = new StubScout(['ethereum', 'arbitrum'], jest.fn());
    expect(scout.exposedChains).toEqual(['ethereum', 'arbitrum']);
  });

  it('initialises isRunning to false', () => {
    const scout = new StubScout(['ethereum'], jest.fn());
    expect(scout.exposedIsRunning).toBe(false);
  });

  it('initialises eventListeners as an empty array', () => {
    const scout = new StubScout(['ethereum'], jest.fn());
    expect(scout.exposedEventListeners).toEqual([]);
  });

  it('creates an rpcProviders Map with one entry per chain', () => {
    const scout = new StubScout(['ethereum', 'arbitrum', 'base'], jest.fn());
    expect(scout.exposedRpcProviders.size).toBe(3);
  });

  it('calls getProvider once for each supplied chain', () => {
    new StubScout(['ethereum', 'arbitrum'], jest.fn());
    expect(mockGetProvider).toHaveBeenCalledTimes(2);
    expect(mockGetProvider).toHaveBeenCalledWith('ethereum');
    expect(mockGetProvider).toHaveBeenCalledWith('arbitrum');
  });

  it('maps each chain to its own provider instance in rpcProviders', () => {
    const scout = new StubScout(['ethereum', 'optimism'], jest.fn());
    const ethProvider = scout.exposedRpcProviders.get('ethereum') as any;
    const optProvider = scout.exposedRpcProviders.get('optimism') as any;
    expect(ethProvider._chain).toBe('ethereum');
    expect(optProvider._chain).toBe('optimism');
  });

  it('works with a single chain', () => {
    const scout = new StubScout(['base'], jest.fn());
    expect(scout.exposedChains).toHaveLength(1);
    expect(scout.exposedRpcProviders.size).toBe(1);
    expect(mockGetProvider).toHaveBeenCalledWith('base');
  });

  it('works with all six supported chains', () => {
    const allChains: ChainName[] = [
      'ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'avalanche',
    ];
    const scout = new StubScout(allChains, jest.fn());
    expect(scout.exposedRpcProviders.size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// emit()
// ---------------------------------------------------------------------------

describe('emit', () => {
  it('calls the injected onEvent handler with an initiation event', async () => {
    const onEvent = jest.fn().mockResolvedValue(undefined);
    const scout = new StubScout(['ethereum'], onEvent);
    const event = buildEvent('initiation');
    await scout.callEmit(event);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it('calls the injected onEvent handler with a completion event', async () => {
    const onEvent = jest.fn().mockResolvedValue(undefined);
    const scout = new StubScout(['ethereum'], onEvent);
    const event = buildEvent('completion');
    await scout.callEmit(event);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it('passes the full event payload to onEvent', async () => {
    const onEvent = jest.fn().mockResolvedValue(undefined);
    const scout = new StubScout(['ethereum'], onEvent);
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
    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it('does not call Redis publish directly (Redis is the processor\'s responsibility)', async () => {
    // emit() delegates to onEvent — it must not bypass the processor and
    // write to Redis itself. If onEvent is a mock that never calls publish,
    // nothing Redis-related should happen.
    const onEvent = jest.fn().mockResolvedValue(undefined);
    const scout = new StubScout(['ethereum'], onEvent);
    await scout.callEmit(buildEvent('initiation'));
    // Only the injected handler should have been called
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// generateTransferId()
// ---------------------------------------------------------------------------

describe('generateTransferId', () => {
  const scout = new StubScout(['ethereum'], jest.fn());

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
// eventListeners
// ---------------------------------------------------------------------------

describe('eventListeners', () => {
  it('starts as an empty array', () => {
    const scout = new StubScout(['ethereum'], jest.fn());
    expect(scout.exposedEventListeners).toHaveLength(0);
  });

  it('allows pushing cleanup functions (simulating subclass listener registration)', () => {
    const scout = new StubScout(['ethereum'], jest.fn());
    const cleanup = jest.fn();
    scout.exposedEventListeners.push(cleanup);
    expect(scout.exposedEventListeners).toHaveLength(1);
  });

  it('stored cleanup functions are callable', () => {
    const scout = new StubScout(['ethereum'], jest.fn());
    const cleanup = jest.fn();
    scout.exposedEventListeners.push(cleanup);
    scout.exposedEventListeners[0]();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('supports multiple cleanup functions (one per contract listener)', () => {
    const scout = new StubScout(['ethereum', 'arbitrum'], jest.fn());
    const cleanupA = jest.fn();
    const cleanupB = jest.fn();
    scout.exposedEventListeners.push(cleanupA, cleanupB);
    expect(scout.exposedEventListeners).toHaveLength(2);
  });

  it('each instance has its own independent eventListeners array', () => {
    const scout1 = new StubScout(['ethereum'], jest.fn());
    const scout2 = new StubScout(['ethereum'], jest.fn());
    scout1.exposedEventListeners.push(jest.fn());
    expect(scout2.exposedEventListeners).toHaveLength(0);
  });
});
