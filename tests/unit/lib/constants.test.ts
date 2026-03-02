import {
  CHAIN_IDS,
  CHAIN_NAMES,
  BRIDGES,
  BRIDGE_CHAINS,
  SUPPORTED_ASSETS,
  STABLECOINS,
  ACROSS_SPOKEPOOL_ADDRESSES,
  STUCK_THRESHOLDS_SECONDS,
  SIZE_BUCKET_THRESHOLDS,
  SLIPPAGE_FACTORS,
  FRAGILITY_THRESHOLDS,
  IMPACT_THRESHOLDS,
  HEALTH_THRESHOLDS,
  ANOMALY_THRESHOLDS,
  LFV_THRESHOLDS,
  TIME_WINDOWS,
  REDIS_CHANNELS,
} from '../../../src/lib/constants';

// ---------------------------------------------------------------------------
// CHAIN_IDS
// ---------------------------------------------------------------------------

describe('CHAIN_IDS', () => {
  it('has the correct chain ID for each of the 6 chains', () => {
    expect(CHAIN_IDS.ethereum).toBe(1);
    expect(CHAIN_IDS.arbitrum).toBe(42161);
    expect(CHAIN_IDS.optimism).toBe(10);
    expect(CHAIN_IDS.base).toBe(8453);
    expect(CHAIN_IDS.polygon).toBe(137);
    expect(CHAIN_IDS.avalanche).toBe(43114);
  });

  it('contains exactly 6 chains', () => {
    expect(Object.keys(CHAIN_IDS)).toHaveLength(6);
  });

  it('all chain IDs are positive integers', () => {
    for (const id of Object.values(CHAIN_IDS)) {
      expect(id).toBeGreaterThan(0);
      expect(Number.isInteger(id)).toBe(true);
    }
  });

  it('all chain IDs are unique', () => {
    const ids = Object.values(CHAIN_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// CHAIN_NAMES
// ---------------------------------------------------------------------------

describe('CHAIN_NAMES', () => {
  it('has a human-readable name for every chain in CHAIN_IDS', () => {
    for (const chain of Object.keys(CHAIN_IDS) as Array<keyof typeof CHAIN_IDS>) {
      expect(CHAIN_NAMES[chain]).toBeTruthy();
      expect(typeof CHAIN_NAMES[chain]).toBe('string');
    }
  });

  it('contains exactly as many entries as CHAIN_IDS', () => {
    expect(Object.keys(CHAIN_NAMES)).toHaveLength(Object.keys(CHAIN_IDS).length);
  });
});

// ---------------------------------------------------------------------------
// BRIDGES
// ---------------------------------------------------------------------------

describe('BRIDGES', () => {
  it('contains across, cctp, and stargate', () => {
    expect(BRIDGES).toContain('across');
    expect(BRIDGES).toContain('cctp');
    expect(BRIDGES).toContain('stargate');
  });

  it('contains exactly 3 bridges', () => {
    expect(BRIDGES).toHaveLength(3);
  });

  it('all entries are non-empty strings', () => {
    for (const bridge of BRIDGES) {
      expect(typeof bridge).toBe('string');
      expect(bridge.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// BRIDGE_CHAINS
// ---------------------------------------------------------------------------

describe('BRIDGE_CHAINS', () => {
  it('has an entry for every bridge', () => {
    for (const bridge of BRIDGES) {
      expect(BRIDGE_CHAINS[bridge]).toBeDefined();
    }
  });

  it('Across supports ethereum, arbitrum, optimism, base, polygon', () => {
    expect(BRIDGE_CHAINS.across).toEqual(
      expect.arrayContaining(['ethereum', 'arbitrum', 'optimism', 'base', 'polygon']),
    );
    expect(BRIDGE_CHAINS.across).toHaveLength(5);
  });

  it('CCTP supports ethereum, arbitrum, optimism, base, avalanche', () => {
    expect(BRIDGE_CHAINS.cctp).toEqual(
      expect.arrayContaining(['ethereum', 'arbitrum', 'optimism', 'base', 'avalanche']),
    );
    expect(BRIDGE_CHAINS.cctp).toHaveLength(5);
  });

  it('Stargate supports ethereum, arbitrum, optimism, avalanche, polygon', () => {
    expect(BRIDGE_CHAINS.stargate).toEqual(
      expect.arrayContaining(['ethereum', 'arbitrum', 'optimism', 'avalanche', 'polygon']),
    );
    expect(BRIDGE_CHAINS.stargate).toHaveLength(5);
  });

  it('every listed chain is a valid key in CHAIN_IDS', () => {
    const validChains = Object.keys(CHAIN_IDS);
    for (const chains of Object.values(BRIDGE_CHAINS)) {
      for (const chain of chains) {
        expect(validChains).toContain(chain);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// SUPPORTED_ASSETS
// ---------------------------------------------------------------------------

describe('SUPPORTED_ASSETS', () => {
  it('includes USDC, USDT, ETH, WETH, DAI', () => {
    expect(SUPPORTED_ASSETS).toContain('USDC');
    expect(SUPPORTED_ASSETS).toContain('USDT');
    expect(SUPPORTED_ASSETS).toContain('ETH');
    expect(SUPPORTED_ASSETS).toContain('WETH');
    expect(SUPPORTED_ASSETS).toContain('DAI');
  });

  it('has exactly 5 entries', () => {
    expect(SUPPORTED_ASSETS).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// STABLECOINS
// ---------------------------------------------------------------------------

describe('STABLECOINS', () => {
  it('includes USDC, USDT, DAI', () => {
    expect(STABLECOINS).toContain('USDC');
    expect(STABLECOINS).toContain('USDT');
    expect(STABLECOINS).toContain('DAI');
  });

  it('has exactly 3 entries', () => {
    expect(STABLECOINS).toHaveLength(3);
  });

  it('is a strict subset of SUPPORTED_ASSETS', () => {
    for (const stable of STABLECOINS) {
      expect(SUPPORTED_ASSETS).toContain(stable);
    }
  });

  it('does not include non-stablecoins ETH or WETH', () => {
    expect(STABLECOINS).not.toContain('ETH');
    expect(STABLECOINS).not.toContain('WETH');
  });
});

// ---------------------------------------------------------------------------
// ACROSS_SPOKEPOOL_ADDRESSES
// ---------------------------------------------------------------------------

describe('ACROSS_SPOKEPOOL_ADDRESSES', () => {
  const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

  it('has addresses for ethereum, arbitrum, optimism, base', () => {
    expect(ACROSS_SPOKEPOOL_ADDRESSES.ethereum).toBeDefined();
    expect(ACROSS_SPOKEPOOL_ADDRESSES.arbitrum).toBeDefined();
    expect(ACROSS_SPOKEPOOL_ADDRESSES.optimism).toBeDefined();
    expect(ACROSS_SPOKEPOOL_ADDRESSES.base).toBeDefined();
  });

  it('all addresses are valid 0x-prefixed 42-character hex strings', () => {
    for (const address of Object.values(ACROSS_SPOKEPOOL_ADDRESSES)) {
      expect(address).toMatch(ADDRESS_REGEX);
    }
  });

  it('all addresses are unique', () => {
    const addresses = Object.values(ACROSS_SPOKEPOOL_ADDRESSES);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it('does not include a polygon address (not in spec)', () => {
    expect(ACROSS_SPOKEPOOL_ADDRESSES.polygon).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// STUCK_THRESHOLDS_SECONDS
// ---------------------------------------------------------------------------

describe('STUCK_THRESHOLDS_SECONDS', () => {
  it('has the correct threshold for each protocol', () => {
    expect(STUCK_THRESHOLDS_SECONDS['across']).toBe(1800);   // 30 min
    expect(STUCK_THRESHOLDS_SECONDS['cctp']).toBe(2700);     // 45 min
    expect(STUCK_THRESHOLDS_SECONDS['stargate']).toBe(1800); // 30 min
    expect(STUCK_THRESHOLDS_SECONDS['wormhole']).toBe(3600); // 60 min
    expect(STUCK_THRESHOLDS_SECONDS['layerzero']).toBe(1800);// 30 min
  });

  it('covers all 5 protocols', () => {
    expect(Object.keys(STUCK_THRESHOLDS_SECONDS)).toHaveLength(5);
  });

  it('all thresholds are positive integers', () => {
    for (const threshold of Object.values(STUCK_THRESHOLDS_SECONDS)) {
      expect(threshold).toBeGreaterThan(0);
      expect(Number.isInteger(threshold)).toBe(true);
    }
  });

  it('cctp has the longest threshold (hardest to fill)', () => {
    expect(STUCK_THRESHOLDS_SECONDS['cctp']).toBeGreaterThan(
      STUCK_THRESHOLDS_SECONDS['across'],
    );
  });

  it('wormhole has the longest threshold overall', () => {
    const max = Math.max(...Object.values(STUCK_THRESHOLDS_SECONDS));
    expect(STUCK_THRESHOLDS_SECONDS['wormhole']).toBe(max);
  });
});

// ---------------------------------------------------------------------------
// SIZE_BUCKET_THRESHOLDS
// ---------------------------------------------------------------------------

describe('SIZE_BUCKET_THRESHOLDS', () => {
  it('has the correct USD boundaries', () => {
    expect(SIZE_BUCKET_THRESHOLDS.small).toBe(10_000);
    expect(SIZE_BUCKET_THRESHOLDS.medium).toBe(100_000);
    expect(SIZE_BUCKET_THRESHOLDS.large).toBe(1_000_000);
  });

  it('thresholds are in strictly ascending order', () => {
    expect(SIZE_BUCKET_THRESHOLDS.small).toBeLessThan(SIZE_BUCKET_THRESHOLDS.medium);
    expect(SIZE_BUCKET_THRESHOLDS.medium).toBeLessThan(SIZE_BUCKET_THRESHOLDS.large);
  });
});

// ---------------------------------------------------------------------------
// SLIPPAGE_FACTORS
// ---------------------------------------------------------------------------

describe('SLIPPAGE_FACTORS', () => {
  it('cctp has zero slippage (burn/mint mechanism)', () => {
    expect(SLIPPAGE_FACTORS['cctp']).toBe(0.0);
  });

  it('stargate has the highest slippage factor (pool-based AMM)', () => {
    expect(SLIPPAGE_FACTORS['stargate']).toBe(1.0);
    expect(SLIPPAGE_FACTORS['stargate']).toBeGreaterThan(SLIPPAGE_FACTORS['across']);
  });

  it('across is lower than stargate (intent-based, relayers absorb slippage)', () => {
    expect(SLIPPAGE_FACTORS['across']).toBeLessThan(SLIPPAGE_FACTORS['stargate']);
  });

  it('all factors are non-negative numbers', () => {
    for (const factor of Object.values(SLIPPAGE_FACTORS)) {
      expect(typeof factor).toBe('number');
      expect(factor).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// FRAGILITY_THRESHOLDS
// ---------------------------------------------------------------------------

describe('FRAGILITY_THRESHOLDS', () => {
  it('high utilization threshold (60) is above medium (30)', () => {
    expect(FRAGILITY_THRESHOLDS.HIGH_UTILIZATION).toBe(60);
    expect(FRAGILITY_THRESHOLDS.MEDIUM_UTILIZATION).toBe(30);
    expect(FRAGILITY_THRESHOLDS.HIGH_UTILIZATION).toBeGreaterThan(
      FRAGILITY_THRESHOLDS.MEDIUM_UTILIZATION,
    );
  });

  it('outflow thresholds are negative (representing net outflow)', () => {
    expect(FRAGILITY_THRESHOLDS.HIGH_OUTFLOW).toBeLessThan(0);
    expect(FRAGILITY_THRESHOLDS.MEDIUM_OUTFLOW).toBeLessThan(0);
  });

  it('high outflow threshold is more extreme than medium (-20 vs -10)', () => {
    expect(FRAGILITY_THRESHOLDS.HIGH_OUTFLOW).toBe(-20);
    expect(FRAGILITY_THRESHOLDS.MEDIUM_OUTFLOW).toBe(-10);
    expect(FRAGILITY_THRESHOLDS.HIGH_OUTFLOW).toBeLessThan(
      FRAGILITY_THRESHOLDS.MEDIUM_OUTFLOW,
    );
  });
});

// ---------------------------------------------------------------------------
// IMPACT_THRESHOLDS
// ---------------------------------------------------------------------------

describe('IMPACT_THRESHOLDS', () => {
  it('has the correct pool share boundaries', () => {
    expect(IMPACT_THRESHOLDS.NEGLIGIBLE).toBe(1);
    expect(IMPACT_THRESHOLDS.LOW).toBe(5);
    expect(IMPACT_THRESHOLDS.MODERATE).toBe(15);
    expect(IMPACT_THRESHOLDS.HIGH).toBe(30);
  });

  it('thresholds are in strictly ascending order', () => {
    expect(IMPACT_THRESHOLDS.NEGLIGIBLE).toBeLessThan(IMPACT_THRESHOLDS.LOW);
    expect(IMPACT_THRESHOLDS.LOW).toBeLessThan(IMPACT_THRESHOLDS.MODERATE);
    expect(IMPACT_THRESHOLDS.MODERATE).toBeLessThan(IMPACT_THRESHOLDS.HIGH);
  });
});

// ---------------------------------------------------------------------------
// HEALTH_THRESHOLDS
// ---------------------------------------------------------------------------

describe('HEALTH_THRESHOLDS', () => {
  it('healthy success rate (99) is above down threshold (95)', () => {
    expect(HEALTH_THRESHOLDS.SUCCESS_RATE_HEALTHY).toBe(99);
    expect(HEALTH_THRESHOLDS.SUCCESS_RATE_DOWN).toBe(95);
    expect(HEALTH_THRESHOLDS.SUCCESS_RATE_HEALTHY).toBeGreaterThan(
      HEALTH_THRESHOLDS.SUCCESS_RATE_DOWN,
    );
  });

  it('latency down multiplier (5) is above degraded multiplier (2)', () => {
    expect(HEALTH_THRESHOLDS.LATENCY_DOWN_MULTIPLIER).toBe(5);
    expect(HEALTH_THRESHOLDS.LATENCY_DEGRADED_MULTIPLIER).toBe(2);
    expect(HEALTH_THRESHOLDS.LATENCY_DOWN_MULTIPLIER).toBeGreaterThan(
      HEALTH_THRESHOLDS.LATENCY_DEGRADED_MULTIPLIER,
    );
  });
});

// ---------------------------------------------------------------------------
// ANOMALY_THRESHOLDS
// ---------------------------------------------------------------------------

describe('ANOMALY_THRESHOLDS', () => {
  it('latency spike multiplier is 3x', () => {
    expect(ANOMALY_THRESHOLDS.LATENCY_SPIKE_MULTIPLIER).toBe(3);
  });

  it('failure rate threshold is 10%', () => {
    expect(ANOMALY_THRESHOLDS.FAILURE_RATE_THRESHOLD).toBe(10);
  });

  it('liquidity drop threshold is 15%', () => {
    expect(ANOMALY_THRESHOLDS.LIQUIDITY_DROP_THRESHOLD).toBe(15);
  });

  it('all thresholds are positive numbers', () => {
    for (const value of Object.values(ANOMALY_THRESHOLDS)) {
      expect(value).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// LFV_THRESHOLDS
// ---------------------------------------------------------------------------

describe('LFV_THRESHOLDS', () => {
  it('rapid_flight is below moderate_outflow (more extreme negative)', () => {
    expect(LFV_THRESHOLDS.RAPID_FLIGHT).toBe(-0.10);
    expect(LFV_THRESHOLDS.MODERATE_OUTFLOW).toBe(-0.03);
    expect(LFV_THRESHOLDS.RAPID_FLIGHT).toBeLessThan(LFV_THRESHOLDS.MODERATE_OUTFLOW);
  });

  it('moderate_inflow and rapid_inflow are positive', () => {
    expect(LFV_THRESHOLDS.MODERATE_INFLOW).toBe(0.03);
    expect(LFV_THRESHOLDS.RAPID_INFLOW).toBe(0.10);
    expect(LFV_THRESHOLDS.MODERATE_INFLOW).toBeGreaterThan(0);
    expect(LFV_THRESHOLDS.RAPID_INFLOW).toBeGreaterThan(0);
  });

  it('thresholds form a symmetric band around zero', () => {
    expect(Math.abs(LFV_THRESHOLDS.RAPID_FLIGHT)).toBe(LFV_THRESHOLDS.RAPID_INFLOW);
    expect(Math.abs(LFV_THRESHOLDS.MODERATE_OUTFLOW)).toBe(LFV_THRESHOLDS.MODERATE_INFLOW);
  });

  it('rapid_inflow threshold is above moderate_inflow', () => {
    expect(LFV_THRESHOLDS.RAPID_INFLOW).toBeGreaterThan(LFV_THRESHOLDS.MODERATE_INFLOW);
  });
});

// ---------------------------------------------------------------------------
// TIME_WINDOWS
// ---------------------------------------------------------------------------

describe('TIME_WINDOWS', () => {
  it('has the correct seconds for each window', () => {
    expect(TIME_WINDOWS.ONE_HOUR).toBe(3600);
    expect(TIME_WINDOWS.TWENTY_FOUR_HOURS).toBe(86400);
    expect(TIME_WINDOWS.SEVEN_DAYS).toBe(604800);
  });

  it('windows are in strictly ascending order', () => {
    expect(TIME_WINDOWS.ONE_HOUR).toBeLessThan(TIME_WINDOWS.TWENTY_FOUR_HOURS);
    expect(TIME_WINDOWS.TWENTY_FOUR_HOURS).toBeLessThan(TIME_WINDOWS.SEVEN_DAYS);
  });

  it('24h is exactly 24 × 1h', () => {
    expect(TIME_WINDOWS.TWENTY_FOUR_HOURS).toBe(TIME_WINDOWS.ONE_HOUR * 24);
  });

  it('7d is exactly 7 × 24h', () => {
    expect(TIME_WINDOWS.SEVEN_DAYS).toBe(TIME_WINDOWS.TWENTY_FOUR_HOURS * 7);
  });
});

// ---------------------------------------------------------------------------
// REDIS_CHANNELS
// ---------------------------------------------------------------------------

describe('REDIS_CHANNELS', () => {
  it('has the correct channel name for TRANSFER_INITIATED', () => {
    expect(REDIS_CHANNELS.TRANSFER_INITIATED).toBe('transfer:initiated');
  });

  it('has the correct channel name for TRANSFER_COMPLETED', () => {
    expect(REDIS_CHANNELS.TRANSFER_COMPLETED).toBe('transfer:completed');
  });

  it('has the correct channel name for POOL_SNAPSHOT', () => {
    expect(REDIS_CHANNELS.POOL_SNAPSHOT).toBe('pool:snapshot');
  });

  it('contains exactly 3 channels', () => {
    expect(Object.keys(REDIS_CHANNELS)).toHaveLength(3);
  });

  it('all channel names are non-empty strings using colon namespace convention', () => {
    for (const channel of Object.values(REDIS_CHANNELS)) {
      expect(typeof channel).toBe('string');
      expect(channel).toContain(':');
    }
  });

  it('all channel names are unique', () => {
    const channels = Object.values(REDIS_CHANNELS);
    expect(new Set(channels).size).toBe(channels.length);
  });
});
