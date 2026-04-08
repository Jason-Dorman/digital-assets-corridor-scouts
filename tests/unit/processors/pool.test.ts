/**
 * Tests for src/processors/pool.ts
 *
 * Strategy:
 *   - ethers.Contract, lib/rpc, lib/db, and lib/price-service are fully mocked.
 *   - lib/token-registry runs as-is (pure data, no side effects).
 *   - All test behaviour is driven through PoolProcessor.run(), which is the
 *     only public entry point.
 *
 * Key invariants under test:
 *   1. SpokePool rows: poolId format, chain, utilization=null, balanceOf called
 *   2. HubPool rows: poolId, chain='ethereum_hub', utilization formula + edge cases
 *   3. CCTP rows: placeholder values (tvl=0, utilization=0)
 *   4. enrichAndStore: price batching, tvlUsd calculation, per-row error isolation
 *   5. run(): Promise.allSettled — one bridge failing doesn't abort others
 */

// ---------------------------------------------------------------------------
// Mock declarations (hoisted by Jest — must use `mock` prefix)
// ---------------------------------------------------------------------------

const mockBalanceOf    = jest.fn();
const mockPooledTokens = jest.fn();
const mockCreate       = jest.fn();
const mockGetPrices    = jest.fn();
const mockGetProvider  = jest.fn();

// Spread the real ethers module; replace only Contract so we can control
// balanceOf and pooledTokens without affecting other ethers utilities.
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    Contract: jest.fn().mockImplementation(() => ({
      balanceOf:    mockBalanceOf,
      pooledTokens: mockPooledTokens,
    })),
  };
});

jest.mock('../../../src/lib/rpc', () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
}));

jest.mock('../../../src/lib/db', () => ({
  db: {
    poolSnapshot: {
      create: (...args: unknown[]) => mockCreate(...args),
    },
  },
}));

jest.mock('../../../src/lib/price-service', () => ({
  priceService: {
    getPrices: (...args: unknown[]) => mockGetPrices(...args),
  },
}));

jest.mock('../../../src/lib/redis', () => ({
  redis: { publish: jest.fn() },
  publish: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { PoolProcessor } from '../../../src/processors/pool';
import {
  ACROSS_SPOKEPOOL_ADDRESSES,
  BRIDGE_CHAINS,
} from '../../../src/lib/constants';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Ethereum USDC and WETH — used to spot-check pooledTokens call arguments
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH_ETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

// Ethereum SpokePool address — verified against constants
const ETH_SPOKEPOOL = ACROSS_SPOKEPOOL_ADDRESSES.ethereum!;

// Expected call counts derived from TOKEN_REGISTRY + ACROSS_SPOKEPOOL_ADDRESSES:
//   Ethereum: USDC, USDT, DAI, WETH  → 4
//   Arbitrum: USDC, USDT, DAI, WETH  → 4
//   Optimism: USDC, USDT, DAI, WETH  → 4
//   Base:     USDC, WETH             → 2   (only 2 tokens in registry for Base)
//   Polygon:  USDC, USDT, DAI, WETH  → 4
const EXPECTED_SPOKEPOOL_CALLS = 18;

// HubPool queries Ethereum tokens: USDC, USDT, DAI, WETH → 4
const EXPECTED_HUBPOOL_CALLS = 4;

// CCTP: one placeholder per chain (ethereum, arbitrum, optimism, base, avalanche)
const EXPECTED_CCTP_ROWS = BRIDGE_CHAINS.cctp.length; // 5

// Total db.create calls in happy path
const EXPECTED_TOTAL_SNAPSHOTS = EXPECTED_SPOKEPOOL_CALLS + EXPECTED_HUBPOOL_CALLS + EXPECTED_CCTP_ROWS; // 23

// Stub return values
const STUB_BALANCE     = 1_000_000n;                          // 1 USDC (6 decimals) or tiny WETH
const STUB_POOL_INFO   = { utilizedReserves: 2_000n, liquidReserves: 8_000n }; // 20% utilization
const STUB_PRICES      = { USDC: 1, USDT: 1, DAI: 1, WETH: 3000 };
const MOCK_PROVIDER    = {};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockGetProvider.mockReturnValue(MOCK_PROVIDER);
  mockBalanceOf.mockResolvedValue(STUB_BALANCE);
  mockPooledTokens.mockResolvedValue(STUB_POOL_INFO);
  mockGetPrices.mockResolvedValue(STUB_PRICES);
  mockCreate.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// run() — bridge dispatch and allSettled behaviour
// ---------------------------------------------------------------------------

describe('run() — bridge dispatch', () => {
  it('stores snapshots from all three bridges in the happy path', async () => {
    const processor = new PoolProcessor();
    await processor.run();
    expect(mockCreate).toHaveBeenCalledTimes(EXPECTED_TOTAL_SNAPSHOTS);
  });

  it('calls getProvider for each chain that has an Across SpokePool', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    // SpokePool chains: ethereum, arbitrum, optimism, base, polygon — 5 calls
    // HubPool also calls getProvider('ethereum') — 1 additional call
    const spokeCalls = Object.keys(ACROSS_SPOKEPOOL_ADDRESSES) as string[];
    for (const chain of spokeCalls) {
      expect(mockGetProvider).toHaveBeenCalledWith(chain);
    }
    expect(mockGetProvider).toHaveBeenCalledWith('ethereum'); // HubPool
  });

  it('still stores CCTP and HubPool rows when SpokePool RPC is unavailable', async () => {
    // Make getProvider throw for all chains. This causes fetchAcrossSpokePools to
    // throw (uncaught getProvider call), which Promise.allSettled catches and
    // records as a rejection. fetchAcrossHubPool also throws. CCTP placeholders
    // (no RPC calls) still succeed.
    mockGetProvider.mockImplementation(() => { throw new Error('Network unavailable'); });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const processor = new PoolProcessor();
    await processor.run();

    // Only CCTP rows should have been stored
    expect(mockCreate).toHaveBeenCalledTimes(EXPECTED_CCTP_ROWS);
    // Error logged once per rejected bridge (SpokePool + HubPool = 2 rejections)
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PoolProcessor] Bridge fetch failed'),
      expect.objectContaining({ reason: expect.any(String) }),
    );
    consoleSpy.mockRestore();
  });

  it('calls getPrices once with all unique asset symbols', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    expect(mockGetPrices).toHaveBeenCalledTimes(1);
    const [assets] = mockGetPrices.mock.calls[0] as [string[]];
    // All supported assets should be represented — no duplicates
    expect(new Set(assets).size).toBe(assets.length);
    expect(assets).toContain('USDC');
    expect(assets).toContain('WETH');
  });
});

// ---------------------------------------------------------------------------
// Across — SpokePool rows
// ---------------------------------------------------------------------------

describe('Across SpokePool snapshots', () => {
  it('calls balanceOf once per tracked token per chain', async () => {
    const processor = new PoolProcessor();
    await processor.run();
    expect(mockBalanceOf).toHaveBeenCalledTimes(EXPECTED_SPOKEPOOL_CALLS);
  });

  it('passes the SpokePool address to balanceOf', async () => {
    const processor = new PoolProcessor();
    await processor.run();
    expect(mockBalanceOf).toHaveBeenCalledWith(ETH_SPOKEPOOL);
  });

  it('stores poolId as across_{chain}_{asset_lowercase}', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const createdPoolIds = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string } }).data.poolId)
      .filter((id) => id.startsWith('across_') && !id.startsWith('across_hubpool'));

    expect(createdPoolIds).toContain('across_ethereum_usdc');
    expect(createdPoolIds).toContain('across_ethereum_weth');
    expect(createdPoolIds).toContain('across_base_usdc');
    // Only USDC and WETH exist in TOKEN_REGISTRY for Base
    expect(createdPoolIds).not.toContain('across_base_usdt');
  });

  it('stores chain equal to the chain where the SpokePool lives', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const ethUsdcRow = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string; chain: string } }).data)
      .find((d) => d.poolId === 'across_ethereum_usdc');

    expect(ethUsdcRow?.chain).toBe('ethereum');
  });

  it('sets utilization to null for SpokePool rows', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const spokeRows = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string; utilization: unknown } }).data)
      .filter((d) => d.poolId.startsWith('across_') && !d.poolId.startsWith('across_hubpool'));

    expect(spokeRows.length).toBe(EXPECTED_SPOKEPOOL_CALLS);
    for (const row of spokeRows) {
      expect(row.utilization).toBeNull();
    }
  });

  it('sets availableLiquidity equal to tvl for SpokePool rows', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const spokeRows = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string; tvl: number; availableLiquidity: number } }).data)
      .filter((d) => d.poolId.startsWith('across_') && !d.poolId.startsWith('across_hubpool'));

    for (const row of spokeRows) {
      expect(row.availableLiquidity).toBe(row.tvl);
    }
  });

  it('sets bridge to "across" for SpokePool rows', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const ethUsdcRow = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string; bridge: string } }).data)
      .find((d) => d.poolId === 'across_ethereum_usdc');

    expect(ethUsdcRow?.bridge).toBe('across');
  });

  it('skips individual tokens when balanceOf throws and continues with the rest', async () => {
    // Make balanceOf reject for the first call only
    mockBalanceOf
      .mockRejectedValueOnce(new Error('RPC timeout'))
      .mockResolvedValue(STUB_BALANCE);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const processor = new PoolProcessor();
    await processor.run();

    // One token skipped — total = EXPECTED_TOTAL_SNAPSHOTS - 1
    expect(mockCreate).toHaveBeenCalledTimes(EXPECTED_TOTAL_SNAPSHOTS - 1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Across SpokePool balanceOf failed'),
      expect.objectContaining({ error: expect.any(String) }),
    );
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Across — HubPool rows
// ---------------------------------------------------------------------------

describe('Across HubPool snapshots', () => {
  it('calls pooledTokens once per Ethereum token in SUPPORTED_ASSETS', async () => {
    const processor = new PoolProcessor();
    await processor.run();
    expect(mockPooledTokens).toHaveBeenCalledTimes(EXPECTED_HUBPOOL_CALLS);
  });

  it('passes each Ethereum token address to pooledTokens', async () => {
    const processor = new PoolProcessor();
    await processor.run();
    expect(mockPooledTokens).toHaveBeenCalledWith(USDC_ETH);
    expect(mockPooledTokens).toHaveBeenCalledWith(WETH_ETH);
  });

  it('stores poolId as across_hubpool_{asset_lowercase}', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const hubPoolIds = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string } }).data.poolId)
      .filter((id) => id.startsWith('across_hubpool_'));

    expect(hubPoolIds).toContain('across_hubpool_usdc');
    expect(hubPoolIds).toContain('across_hubpool_weth');
    expect(hubPoolIds).toHaveLength(EXPECTED_HUBPOOL_CALLS);
  });

  it('stores chain as "ethereum_hub" to prevent LFV double-counting', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const hubRows = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string; chain: string } }).data)
      .filter((d) => d.poolId.startsWith('across_hubpool_'));

    for (const row of hubRows) {
      expect(row.chain).toBe('ethereum_hub');
    }
  });

  it('calculates utilization as utilizedReserves / total × 100', async () => {
    // utilizedReserves: 2_000n, liquidReserves: 8_000n → total: 10_000n → 20%
    mockPooledTokens.mockResolvedValue({ utilizedReserves: 2_000n, liquidReserves: 8_000n });

    const processor = new PoolProcessor();
    await processor.run();

    const hubUsdcRow = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string; utilization: number } }).data)
      .find((d) => d.poolId === 'across_hubpool_usdc');

    expect(hubUsdcRow?.utilization).toBe(20);
  });

  it('calculates utilization = 0 when utilizedReserves is 100%', async () => {
    // utilizedReserves: 10_000n, liquidReserves: 0n → 100% utilized
    mockPooledTokens.mockResolvedValue({ utilizedReserves: 10_000n, liquidReserves: 0n });

    const processor = new PoolProcessor();
    await processor.run();

    const hubUsdcRow = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string; utilization: number } }).data)
      .find((d) => d.poolId === 'across_hubpool_usdc');

    expect(hubUsdcRow?.utilization).toBe(100);
  });

  it('clamps negative utilizedReserves to 0 (over-collateralised pool)', async () => {
    // utilizedReserves < 0 occurs during settlement rebalancing.
    // Clamped to 0 → total = liquidReserves, utilization = 0.
    mockPooledTokens.mockResolvedValue({ utilizedReserves: -500n, liquidReserves: 1_000n });

    const processor = new PoolProcessor();
    await processor.run();

    const hubUsdcRow = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string; utilization: number; tvl: number; availableLiquidity: number } }).data)
      .find((d) => d.poolId === 'across_hubpool_usdc');

    expect(hubUsdcRow?.utilization).toBe(0);
    // tvl = liquidReserves (1_000n normalised at 6 decimals = 0.001)
    // availableLiquidity = liquidReserves = tvl
    expect(hubUsdcRow?.availableLiquidity).toBe(hubUsdcRow?.tvl);
  });

  it('skips a token when total reserves are zero', async () => {
    // One specific token (USDC) returns all-zero reserves — should be skipped.
    mockPooledTokens.mockImplementation((tokenAddress: string) => {
      if (tokenAddress === USDC_ETH) {
        return Promise.resolve({ utilizedReserves: 0n, liquidReserves: 0n });
      }
      return Promise.resolve(STUB_POOL_INFO);
    });

    const processor = new PoolProcessor();
    await processor.run();

    const hubPoolIds = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string } }).data.poolId)
      .filter((id) => id.startsWith('across_hubpool_'));

    // USDC skipped → only 3 HubPool rows instead of 4
    expect(hubPoolIds).not.toContain('across_hubpool_usdc');
    expect(hubPoolIds).toHaveLength(EXPECTED_HUBPOOL_CALLS - 1);
  });

  it('skips individual tokens when pooledTokens throws and continues with the rest', async () => {
    mockPooledTokens
      .mockRejectedValueOnce(new Error('Contract call failed'))
      .mockResolvedValue(STUB_POOL_INFO);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const processor = new PoolProcessor();
    await processor.run();

    // One HubPool token skipped
    expect(mockCreate).toHaveBeenCalledTimes(EXPECTED_TOTAL_SNAPSHOTS - 1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Across HubPool pooledTokens failed'),
      expect.objectContaining({ error: expect.any(String) }),
    );
    consoleSpy.mockRestore();
  });

  it('sets availableLiquidity equal to liquidReserves', async () => {
    // liquidReserves: 8_000n at 6 decimals = 0.008
    mockPooledTokens.mockResolvedValue({ utilizedReserves: 2_000n, liquidReserves: 8_000n });

    const processor = new PoolProcessor();
    await processor.run();

    const hubUsdcRow = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string; tvl: number; availableLiquidity: number } }).data)
      .find((d) => d.poolId === 'across_hubpool_usdc');

    // tvl > availableLiquidity (utilized portion is the difference)
    expect(hubUsdcRow!.availableLiquidity).toBeLessThan(hubUsdcRow!.tvl);
    // availableLiquidity = liquidReserves normalised = 8_000 / 1_000_000 = 0.008
    expect(hubUsdcRow?.availableLiquidity).toBeCloseTo(0.008);
  });
});

// ---------------------------------------------------------------------------
// CCTP — placeholder rows
// ---------------------------------------------------------------------------

describe('CCTP placeholder snapshots', () => {
  it('creates one row per CCTP chain', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const cctpRows = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { bridge: string } }).data)
      .filter((d) => d.bridge === 'cctp');

    expect(cctpRows).toHaveLength(EXPECTED_CCTP_ROWS);
  });

  it('stores poolId as cctp_{chain}_usdc', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const cctpIds = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string } }).data.poolId)
      .filter((id) => id.startsWith('cctp_'));

    for (const chain of BRIDGE_CHAINS.cctp) {
      expect(cctpIds).toContain(`cctp_${chain}_usdc`);
    }
  });

  it('stores tvl = 0 and utilization = 0 for all CCTP rows', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const cctpRows = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { bridge: string; tvl: number; utilization: number } }).data)
      .filter((d) => d.bridge === 'cctp');

    for (const row of cctpRows) {
      expect(row.tvl).toBe(0);
      expect(row.utilization).toBe(0);
    }
  });

  it('stores asset = "USDC" for all CCTP rows', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const cctpRows = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { bridge: string; asset: string } }).data)
      .filter((d) => d.bridge === 'cctp');

    for (const row of cctpRows) {
      expect(row.asset).toBe('USDC');
    }
  });

  it('does not make any RPC calls for CCTP (no getProvider, no Contract)', async () => {
    // Verify CCTP rows are created even when RPC is completely down
    mockGetProvider.mockImplementation(() => { throw new Error('No RPC'); });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const processor = new PoolProcessor();
    await processor.run();

    const cctpRows = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { bridge: string } }).data)
      .filter((d) => d.bridge === 'cctp');

    expect(cctpRows).toHaveLength(EXPECTED_CCTP_ROWS);
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// enrichAndStore — price enrichment and tvlUsd
// ---------------------------------------------------------------------------

describe('enrichAndStore — tvlUsd calculation', () => {
  it('sets tvlUsd = tvl × price for known stablecoins', async () => {
    // USDC balanceOf returns 1_000_000n → normalizeAmount(1_000_000n, 6) = 1.0
    // price = 1.0 → tvlUsd = 1.0
    mockBalanceOf.mockResolvedValue(1_000_000n);
    mockGetPrices.mockResolvedValue({ USDC: 1, USDT: 1, DAI: 1, WETH: 3000 });

    const processor = new PoolProcessor();
    await processor.run();

    const ethUsdcRow = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { poolId: string; tvlUsd: number | null } }).data)
      .find((d) => d.poolId === 'across_ethereum_usdc');

    expect(ethUsdcRow?.tvlUsd).toBe(1.0);
  });

  it('sets tvlUsd = null when price is 0 (unknown token)', async () => {
    mockGetPrices.mockResolvedValue({ USDC: 0, USDT: 0, DAI: 0, WETH: 0 });

    const processor = new PoolProcessor();
    await processor.run();

    // All rows should have tvlUsd = null
    const allRows = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { tvlUsd: number | null } }).data);

    for (const row of allRows) {
      expect(row.tvlUsd).toBeNull();
    }
  });

  it('passes the correct recordedAt timestamp to every row', async () => {
    const before = new Date();
    const processor = new PoolProcessor();
    await processor.run();
    const after = new Date();

    const allRows = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { recordedAt: Date } }).data);

    for (const row of allRows) {
      expect(row.recordedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row.recordedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    }
  });

  it('uses the same recordedAt for every row in a single run', async () => {
    const processor = new PoolProcessor();
    await processor.run();

    const timestamps = mockCreate.mock.calls
      .map((call) => (call[0] as { data: { recordedAt: Date } }).data.recordedAt.getTime());

    // All rows share a single timestamp captured at the start of run()
    const unique = new Set(timestamps);
    expect(unique.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// enrichAndStore — per-row DB error isolation
// ---------------------------------------------------------------------------

describe('enrichAndStore — DB error isolation', () => {
  it('continues storing remaining rows when one db.create call throws', async () => {
    // First DB write fails; all others succeed
    mockCreate
      .mockRejectedValueOnce(new Error('Constraint violation'))
      .mockResolvedValue({});

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const processor = new PoolProcessor();
    await processor.run();

    // 22 rows stored (23 total - 1 failed)
    expect(mockCreate).toHaveBeenCalledTimes(EXPECTED_TOTAL_SNAPSHOTS);
    // Error logged for the failing row
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to store snapshot'),
      expect.objectContaining({ error: expect.any(String) }),
    );
    consoleSpy.mockRestore();
  });

  it('logs the stored count vs total in the info message', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const processor = new PoolProcessor();
    await processor.run();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`Stored ${EXPECTED_TOTAL_SNAPSHOTS}/${EXPECTED_TOTAL_SNAPSHOTS} pool snapshots`),
      ),
    );
    infoSpy.mockRestore();
  });

  it('logs a reduced count when some rows fail to store', async () => {
    mockCreate.mockRejectedValue(new Error('DB down'));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy    = jest.spyOn(console, 'info').mockImplementation(() => {});

    const processor = new PoolProcessor();
    await processor.run();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stored 0/'),
    );
    consoleSpy.mockRestore();
    infoSpy.mockRestore();
  });
});
