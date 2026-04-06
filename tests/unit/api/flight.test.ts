/**
 * Unit tests for GET /api/flight
 *
 * Tests the route handler in isolation by mocking:
 *   - src/lib/redis        (cache read/write)
 *   - src/lib/db           (pool snapshot queries)
 *   - src/calculators/lfv  (LFV calculation)
 *   - src/lib/constants    (STABLECOINS)
 *   - src/lib/logger       (suppress log noise)
 */

// ---------------------------------------------------------------------------
// Hoisted mock declarations
// ---------------------------------------------------------------------------

const mockRedisGet   = jest.fn();
const mockRedisSetex = jest.fn();
const mockPoolFindMany = jest.fn();
const mockCalculateLFV = jest.fn();

jest.mock('../../../src/lib/redis', () => ({
  redis: {
    get:   (...args: unknown[]) => mockRedisGet(...args),
    setex: (...args: unknown[]) => mockRedisSetex(...args),
  },
}));

jest.mock('../../../src/lib/db', () => ({
  db: {
    poolSnapshot: {
      findMany: (...args: unknown[]) => mockPoolFindMany(...args),
    },
  },
}));

jest.mock('../../../src/calculators/lfv', () => ({
  calculateLFV: (...args: unknown[]) => mockCalculateLFV(...args),
}));

jest.mock('../../../src/lib/constants', () => ({
  STABLECOINS: ['USDC', 'USDT', 'DAI'],
}));

jest.mock('../../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { GET } from '../../../src/app/api/flight/route';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLFVResult(overrides: {
  chain?: string;
  lfv24h?: number;
  interpretation?: string;
  netFlowUsd?: number;
  tvlStartUsd?: number;
  tvlNowUsd?: number;
  poolsMonitored?: number;
}) {
  return {
    chain: overrides.chain ?? 'ethereum',
    lfv24h: overrides.lfv24h ?? 0,
    lfvAnnualized: (overrides.lfv24h ?? 0) * 365,
    interpretation: overrides.interpretation ?? 'stable',
    netFlowUsd: overrides.netFlowUsd ?? 0,
    tvlStartUsd: overrides.tvlStartUsd ?? 1_000_000,
    tvlNowUsd: overrides.tvlNowUsd ?? 1_000_000,
    poolsMonitored: overrides.poolsMonitored ?? 1,
  };
}

const NOW = new Date('2026-04-03T12:00:00.000Z');
const TWENTY_FOUR_AGO = new Date(NOW.getTime() - 86_400_000);

function makePoolSnapshot(chain: string, tvlUsd: number, recordedAt: Date, poolId = 'pool-1') {
  return { poolId, chain, tvlUsd, recordedAt };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockRedisGet.mockResolvedValue(null);
  mockRedisSetex.mockResolvedValue('OK');
  mockPoolFindMany.mockResolvedValue([]);
  mockCalculateLFV.mockReturnValue(makeLFVResult({}));
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('GET /api/flight – happy path', () => {
  it('returns 200', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it('response has chains array and updatedAt', async () => {
    const response = await GET();
    const body = await response.json();
    expect(Array.isArray(body.chains)).toBe(true);
    expect(typeof body.updatedAt).toBe('string');
  });

  it('includes correct chain fields for each entry', async () => {
    mockPoolFindMany.mockResolvedValue([
      makePoolSnapshot('ethereum', 1_000_000, NOW, 'pool-1'),
      makePoolSnapshot('ethereum', 900_000, TWENTY_FOUR_AGO, 'pool-1'),
    ]);
    mockCalculateLFV.mockReturnValue(makeLFVResult({
      chain: 'ethereum',
      lfv24h: -0.05,
      interpretation: 'moderate_outflow',
      netFlowUsd: -100_000,
      tvlStartUsd: 900_000,
      tvlNowUsd: 1_000_000,
      poolsMonitored: 1,
    }));

    const response = await GET();
    const body = await response.json();

    expect(body.chains).toHaveLength(1);
    const chain = body.chains[0];
    expect(chain).toHaveProperty('chain', 'ethereum');
    expect(chain).toHaveProperty('lfv24h');
    expect(chain).toHaveProperty('lfvAnnualized');
    expect(chain).toHaveProperty('interpretation');
    expect(chain).toHaveProperty('netFlowUsd');
    expect(chain).toHaveProperty('tvlStartUsd');
    expect(chain).toHaveProperty('tvlNowUsd');
    expect(chain).toHaveProperty('poolsMonitored');
  });

  it('rounds lfv24h to 3 decimal places', async () => {
    mockPoolFindMany.mockResolvedValue([
      makePoolSnapshot('arbitrum', 1_000_000, NOW),
    ]);
    mockCalculateLFV.mockReturnValue(makeLFVResult({
      chain: 'arbitrum',
      lfv24h: -0.123456789,
    }));

    const response = await GET();
    const body = await response.json();

    const entry = body.chains[0];
    // Should be rounded to 3 decimals: -0.123
    expect(entry.lfv24h).toBe(-0.123);
  });

  it('rounds netFlowUsd to nearest integer', async () => {
    mockPoolFindMany.mockResolvedValue([
      makePoolSnapshot('arbitrum', 1_000_000, NOW),
    ]);
    mockCalculateLFV.mockReturnValue(makeLFVResult({
      chain: 'arbitrum',
      netFlowUsd: -12345.678,
    }));

    const response = await GET();
    const body = await response.json();

    expect(body.chains[0].netFlowUsd).toBe(-12346);
  });
});

// ---------------------------------------------------------------------------
// Alert flag for rapid_flight
// ---------------------------------------------------------------------------

describe('GET /api/flight – alert flag', () => {
  beforeEach(() => {
    mockPoolFindMany.mockResolvedValue([
      makePoolSnapshot('ethereum', 1_000_000, NOW),
    ]);
  });

  it('includes alert:true when interpretation is rapid_flight', async () => {
    mockCalculateLFV.mockReturnValue(makeLFVResult({
      chain: 'ethereum',
      lfv24h: -0.15,
      interpretation: 'rapid_flight',
    }));

    const response = await GET();
    const body = await response.json();

    expect(body.chains[0].alert).toBe(true);
  });

  it('does NOT include alert when interpretation is moderate_outflow', async () => {
    mockCalculateLFV.mockReturnValue(makeLFVResult({
      chain: 'ethereum',
      lfv24h: -0.05,
      interpretation: 'moderate_outflow',
    }));

    const response = await GET();
    const body = await response.json();

    expect(body.chains[0].alert).toBeUndefined();
  });

  it('does NOT include alert when interpretation is stable', async () => {
    mockCalculateLFV.mockReturnValue(makeLFVResult({
      chain: 'ethereum',
      lfv24h: 0,
      interpretation: 'stable',
    }));

    const response = await GET();
    const body = await response.json();

    expect(body.chains[0].alert).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Sort order — lfv24h ascending (most negative first)
// ---------------------------------------------------------------------------

describe('GET /api/flight – sort order', () => {
  it('sorts chains by lfv24h ascending (most negative first)', async () => {
    const pools = [
      makePoolSnapshot('arbitrum', 1_000_000, NOW, 'pool-a'),
      makePoolSnapshot('ethereum', 2_000_000, NOW, 'pool-b'),
      makePoolSnapshot('polygon',  500_000,   NOW, 'pool-c'),
    ];
    mockPoolFindMany.mockResolvedValue(pools);

    mockCalculateLFV
      .mockReturnValueOnce(makeLFVResult({ chain: 'arbitrum', lfv24h: 0.05 }))
      .mockReturnValueOnce(makeLFVResult({ chain: 'ethereum', lfv24h: -0.20 }))
      .mockReturnValueOnce(makeLFVResult({ chain: 'polygon',  lfv24h: -0.08 }));

    const response = await GET();
    const body = await response.json();

    const lfvValues = body.chains.map((c: { lfv24h: number }) => c.lfv24h);
    expect(lfvValues[0]).toBeLessThanOrEqual(lfvValues[1]);
    expect(lfvValues[1]).toBeLessThanOrEqual(lfvValues[2]);
  });
});

// ---------------------------------------------------------------------------
// Cache hit
// ---------------------------------------------------------------------------

describe('GET /api/flight – cache hit', () => {
  it('returns cached response and skips DB query', async () => {
    const cached = JSON.stringify({
      chains: [{ chain: 'ethereum', lfv24h: 0, interpretation: 'stable' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    mockRedisGet.mockResolvedValue(cached);

    const response = await GET();
    const body = await response.json();

    expect(body.chains[0].chain).toBe('ethereum');
    expect(mockPoolFindMany).not.toHaveBeenCalled();
    expect(mockRedisSetex).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cache write
// ---------------------------------------------------------------------------

describe('GET /api/flight – cache write', () => {
  it('writes to Redis with 60s TTL on cache miss', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mockRedisSetex).toHaveBeenCalledWith('api:flight', 60, expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// Redis error degradation
// ---------------------------------------------------------------------------

describe('GET /api/flight – Redis error degradation', () => {
  it('continues when redis.get throws', async () => {
    mockRedisGet.mockRejectedValue(new Error('Redis down'));
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it('still returns 200 when redis.setex throws', async () => {
    mockRedisSetex.mockRejectedValue(new Error('Write error'));
    const response = await GET();
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DB error → 500
// ---------------------------------------------------------------------------

describe('GET /api/flight – database error', () => {
  it('returns 500 when poolSnapshot.findMany throws', async () => {
    mockPoolFindMany.mockRejectedValue(new Error('DB offline'));

    const response = await GET();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Empty pool data
// ---------------------------------------------------------------------------

describe('GET /api/flight – empty data', () => {
  it('returns empty chains array when no snapshots exist', async () => {
    mockPoolFindMany.mockResolvedValue([]);

    const response = await GET();
    const body = await response.json();

    expect(body.chains).toHaveLength(0);
  });
});
