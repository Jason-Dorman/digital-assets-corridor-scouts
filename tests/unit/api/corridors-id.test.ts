/**
 * Unit tests for GET /api/corridors/[id]
 *
 * Tests the route handler in isolation by mocking:
 *   - src/lib/db                  (transfer + anomaly + pool queries)
 *   - src/calculators/health      (health status)
 *   - src/calculators/fragility   (fragility level)
 *   - src/lib/corridor-metrics    (calculatePercentile)
 *   - src/lib/constants           (ANOMALY_THRESHOLDS)
 *   - src/lib/logger              (suppress log noise)
 */

// ---------------------------------------------------------------------------
// Hoisted mock declarations
// ---------------------------------------------------------------------------

const mockTransferFindMany    = jest.fn();
const mockAnomalyFindMany     = jest.fn();
const mockPoolFindMany        = jest.fn();
const mockCalculateHealth     = jest.fn();
const mockCalculateFragility  = jest.fn();
const mockCalculatePercentile = jest.fn();

jest.mock('../../../src/lib/db', () => ({
  db: {
    transfer: {
      findMany: (...args: unknown[]) => mockTransferFindMany(...args),
    },
    anomaly: {
      findMany: (...args: unknown[]) => mockAnomalyFindMany(...args),
    },
    poolSnapshot: {
      findMany: (...args: unknown[]) => mockPoolFindMany(...args),
    },
  },
}));

jest.mock('../../../src/calculators/health', () => ({
  calculateHealthStatus: (...args: unknown[]) => mockCalculateHealth(...args),
}));

jest.mock('../../../src/calculators/fragility', () => ({
  calculateFragility: (...args: unknown[]) => mockCalculateFragility(...args),
}));

jest.mock('../../../src/lib/corridor-metrics', () => ({
  calculatePercentile: (...args: unknown[]) => mockCalculatePercentile(...args),
}));

jest.mock('../../../src/lib/constants', () => ({
  ANOMALY_THRESHOLDS: { MAX_TRANSFER_QUERY_ROWS: 50_000, MAX_POOL_SNAPSHOT_QUERY_ROWS: 10_000 },
  VALID_BRIDGES: new Set(['across', 'cctp', 'stargate']),
  VALID_CHAIN_NAMES: new Set(['ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'avalanche']),
  STABLECOINS: ['USDC', 'USDT', 'DAI'],
}));

jest.mock('../../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { NextRequest } from 'next/server';
import { GET } from '../../../src/app/api/corridors/[id]/route';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-03T12:00:00.000Z');
const ONE_HOUR_AGO       = new Date(NOW.getTime() - 3_600_000);
const TWENTY_FOUR_AGO    = new Date(NOW.getTime() - 86_400_000);

function makeTransfer(overrides: {
  status?: string;
  initiatedAt?: Date;
  durationSeconds?: number;
  amountUsd?: number;
}) {
  return {
    transferId: 'tx-' + Math.random().toString(36).slice(2, 9),
    amount: BigInt(1_000_000),
    amountUsd: overrides.amountUsd ?? 1000,
    asset: 'USDC',
    status: overrides.status ?? 'completed',
    initiatedAt: overrides.initiatedAt ?? new Date(NOW.getTime() - 1800_000),
    completedAt: overrides.status === 'completed' ? new Date(NOW.getTime() - 1680_000) : null,
    durationSeconds: overrides.durationSeconds ?? 120,
    txHashSource: '0xabc',
    txHashDest: '0xdef',
  };
}

const HEALTH_RESULT = {
  status: 'healthy' as const,
  reason: 'All systems normal',
  successRate1h: 99.5,
  transferCount1h: 5,
  latencyMultiplier: 1.2,
};

const FRAGILITY_RESULT = {
  level: 'low' as const,
  reason: 'Pool is stable',
  utilization: 25,
  netFlow24hPct: 0,
};

const POOL_SNAPSHOT = {
  tvlUsd: 10_000_000,
  utilization: 25,
  availableLiquidity: 8_000_000,
  recordedAt: NOW,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'));
}

function makeCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function setupDefaultMocks(transfers: ReturnType<typeof makeTransfer>[] = [makeTransfer({})]) {
  mockTransferFindMany.mockResolvedValue(transfers);
  mockAnomalyFindMany.mockResolvedValue([]);
  // findMany returns array; include chain so dest-chain filter in route matches
  mockPoolFindMany.mockResolvedValue([{ ...POOL_SNAPSHOT, poolId: 'pool-1', chain: 'arbitrum' }]);
  mockCalculateHealth.mockReturnValue(HEALTH_RESULT);
  mockCalculateFragility.mockReturnValue(FRAGILITY_RESULT);
  mockCalculatePercentile.mockReturnValue(120);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('GET /api/corridors/[id] – happy path', () => {
  it('returns 200 for a valid corridor ID with data', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    expect(response.status).toBe(200);
  });

  it('response contains corridor, recentTransfers, hourlyStats, dailyStats, anomalies', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    const body = await response.json();

    expect(body).toHaveProperty('corridor');
    expect(body).toHaveProperty('recentTransfers');
    expect(body).toHaveProperty('hourlyStats');
    expect(body).toHaveProperty('dailyStats');
    expect(body).toHaveProperty('anomalies');
  });

  it('corridor has correct corridorId, bridge, sourceChain, destChain', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    const body = await response.json();
    const { corridor } = body;

    expect(corridor.corridorId).toBe('across_ethereum_arbitrum');
    expect(corridor.bridge).toBe('across');
    expect(corridor.sourceChain).toBe('ethereum');
    expect(corridor.destChain).toBe('arbitrum');
  });

  it('corridor status comes from calculateHealthStatus result', async () => {
    setupDefaultMocks();
    mockCalculateHealth.mockReturnValue({ ...HEALTH_RESULT, status: 'degraded' });

    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    const body = await response.json();
    expect(body.corridor.status).toBe('degraded');
  });

  it('corridor pool fragility comes from calculateFragility result', async () => {
    setupDefaultMocks();
    mockCalculateFragility.mockReturnValue({ ...FRAGILITY_RESULT, level: 'high', reason: 'High utilization' });

    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    const body = await response.json();
    expect(body.corridor.pool.fragility).toBe('high');
    expect(body.corridor.pool.fragilityReason).toBe('High utilization');
  });

  it('recentTransfers is capped at 20 entries', async () => {
    const manyTransfers = Array.from({ length: 30 }, () =>
      makeTransfer({ initiatedAt: new Date(NOW.getTime() - 600_000) }),
    );
    setupDefaultMocks(manyTransfers);

    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    const body = await response.json();
    expect(body.recentTransfers.length).toBeLessThanOrEqual(20);
  });

  it('recentTransfers have ISO string timestamps, not Date objects', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    const body = await response.json();
    for (const t of body.recentTransfers) {
      expect(typeof t.initiatedAt).toBe('string');
    }
  });

  it('hourlyStats array has up to 24 entries', async () => {
    const transfers = [makeTransfer({ initiatedAt: new Date(NOW.getTime() - 1_000_000) })];
    setupDefaultMocks(transfers);

    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    const body = await response.json();
    expect(body.hourlyStats.length).toBeLessThanOrEqual(24);
  });

  it('dailyStats entries have date, transferCount, successRate, avgDurationSeconds, volumeUsd, status', async () => {
    const transfers = [makeTransfer({ initiatedAt: new Date(NOW.getTime() - 3_600_000) })];
    setupDefaultMocks(transfers);

    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    const body = await response.json();

    for (const day of body.dailyStats) {
      expect(day).toHaveProperty('date');
      expect(day).toHaveProperty('transferCount');
      expect(day).toHaveProperty('successRate');
      expect(day).toHaveProperty('avgDurationSeconds');
      expect(day).toHaveProperty('volumeUsd');
      expect(day).toHaveProperty('status');
    }
  });

  it('anomalies are serialized with ISO timestamps', async () => {
    setupDefaultMocks();
    mockAnomalyFindMany.mockResolvedValue([{
      id: BigInt(1),
      anomalyType: 'latency_spike',
      corridorId: 'across_ethereum_arbitrum',
      bridge: 'across',
      sourceChain: 'ethereum',
      destChain: 'arbitrum',
      severity: 'high',
      detectedAt: new Date('2026-04-03T10:00:00Z'),
      resolvedAt: null,
      details: { multiplier: 6.9 },
    }]);

    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    const body = await response.json();

    expect(body.anomalies).toHaveLength(1);
    expect(typeof body.anomalies[0].detectedAt).toBe('string');
    expect(body.anomalies[0].resolvedAt).toBeNull();
  });

  it('pool tvlUsd is rounded to 2 decimal places and utilization is a rounded integer', async () => {
    setupDefaultMocks();
    mockPoolFindMany.mockResolvedValue([{
      poolId: 'pool-1', chain: 'arbitrum',
      tvlUsd: 10_000_000.567,
      utilization: 25.9,
      availableLiquidity: 8_000_000,
      recordedAt: NOW,
    }]);

    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    const body = await response.json();
    // tvlUsd uses round2 (2dp precision); utilization uses Math.round (integer)
    expect(body.corridor.pool.tvlUsd).toBe(10_000_000.57);
    expect(Number.isInteger(body.corridor.pool.utilization)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invalid corridor ID format — 400
// ---------------------------------------------------------------------------

describe('GET /api/corridors/[id] – invalid ID format', () => {
  it('returns 400 for an ID with fewer than 3 parts', async () => {
    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum'),
      makeCtx('across_ethereum'),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('id');
  });

  it('returns 400 for an ID with more than 3 parts', async () => {
    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum_extra'),
      makeCtx('across_ethereum_arbitrum_extra'),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Not found — 404
// ---------------------------------------------------------------------------

describe('GET /api/corridors/[id] – not found', () => {
  it('returns 404 when no transfers AND no pool snapshots exist for the corridor', async () => {
    // Both empty = corridor is not being monitored — returning zeros would be
    // misleading financial data (e.g. 100% success rate from 0 transfers).
    mockTransferFindMany.mockResolvedValue([]);
    mockAnomalyFindMany.mockResolvedValue([]);
    mockPoolFindMany.mockResolvedValue([]);

    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// No pool snapshot
// ---------------------------------------------------------------------------

describe('GET /api/corridors/[id] – missing pool data', () => {
  it('returns 200 and zero pool values when no snapshot exists', async () => {
    mockTransferFindMany.mockResolvedValue([makeTransfer({})]);
    mockAnomalyFindMany.mockResolvedValue([]);
    mockPoolFindMany.mockResolvedValue([]); // has transfers but no pool data
    mockCalculateHealth.mockReturnValue(HEALTH_RESULT);
    mockCalculateFragility.mockReturnValue(FRAGILITY_RESULT);
    mockCalculatePercentile.mockReturnValue(0);

    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.corridor.pool.tvlUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DB error → 500
// ---------------------------------------------------------------------------

describe('GET /api/corridors/[id] – database error', () => {
  it('returns 500 when transfer query throws', async () => {
    mockTransferFindMany.mockRejectedValue(new Error('DB offline'));
    mockAnomalyFindMany.mockResolvedValue([]);
    mockPoolFindMany.mockResolvedValue([]);

    const response = await GET(
      makeRequest('http://localhost/api/corridors/across_ethereum_arbitrum'),
      makeCtx('across_ethereum_arbitrum'),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
