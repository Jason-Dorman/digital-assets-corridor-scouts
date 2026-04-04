/**
 * Unit tests for GET /api/impact/estimate
 *
 * Tests the route handler in isolation by mocking:
 *   - src/lib/db                (pool snapshot + transfer queries)
 *   - src/calculators/impact    (calculateImpact, IMPACT_DISCLAIMER)
 *   - src/calculators/fragility (calculateFragility)
 *   - src/calculators/health    (calculateHealthStatus)
 *   - src/lib/corridor-metrics  (calculatePercentile)
 *   - src/lib/constants         (ANOMALY_THRESHOLDS)
 *   - src/lib/logger            (suppress log noise)
 */

// ---------------------------------------------------------------------------
// Hoisted mock declarations
// ---------------------------------------------------------------------------

const mockPoolFindFirst    = jest.fn();
const mockTransferFindMany = jest.fn();
const mockCalculateImpact  = jest.fn();
const mockCalculateFragility = jest.fn();
const mockCalculateHealth  = jest.fn();
const mockCalculatePercentile = jest.fn();

jest.mock('../../../src/lib/db', () => ({
  db: {
    poolSnapshot: {
      findFirst: (...args: unknown[]) => mockPoolFindFirst(...args),
    },
    transfer: {
      findMany: (...args: unknown[]) => mockTransferFindMany(...args),
    },
  },
}));

jest.mock('../../../src/calculators/impact', () => ({
  calculateImpact: (...args: unknown[]) => mockCalculateImpact(...args),
  IMPACT_DISCLAIMER: 'Directional estimate only. Not an execution guarantee.',
}));

jest.mock('../../../src/calculators/fragility', () => ({
  calculateFragility: (...args: unknown[]) => mockCalculateFragility(...args),
}));

jest.mock('../../../src/calculators/health', () => ({
  calculateHealthStatus: (...args: unknown[]) => mockCalculateHealth(...args),
}));

jest.mock('../../../src/lib/corridor-metrics', () => ({
  calculatePercentile: (...args: unknown[]) => mockCalculatePercentile(...args),
}));

jest.mock('../../../src/lib/constants', () => ({
  ANOMALY_THRESHOLDS: { MAX_TRANSFER_QUERY_ROWS: 50_000 },
}));

jest.mock('../../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { NextRequest } from 'next/server';
import { GET } from '../../../src/app/api/impact/estimate/route';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POOL_SNAPSHOT = {
  tvlUsd: 10_000_000,
  utilization: 25,
  availableLiquidity: 8_000_000,
};

const IMPACT_RESULT = {
  poolSharePct: 1.00,
  estimatedSlippageBps: 0.50,
  impactLevel: 'low',
  warning: null,
};

const FRAGILITY_RESULT = {
  level: 'low' as const,
  reason: 'Pool is stable',
  utilization: 25,
  netFlow24hPct: 0,
};

const HEALTH_RESULT = {
  status: 'healthy' as const,
  reason: 'All systems normal',
  successRate1h: 99.5,
  transferCount1h: 10,
  latencyMultiplier: 1.0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'));
}

const BASE_URL = 'http://localhost/api/impact/estimate?bridge=across&source=ethereum&dest=arbitrum&amountUsd=100000';

function setupDefaultMocks() {
  mockPoolFindFirst.mockResolvedValue(POOL_SNAPSHOT);
  mockTransferFindMany.mockResolvedValue([]);
  mockCalculateImpact.mockReturnValue(IMPACT_RESULT);
  mockCalculateFragility.mockReturnValue(FRAGILITY_RESULT);
  mockCalculateHealth.mockReturnValue(HEALTH_RESULT);
  mockCalculatePercentile.mockReturnValue(120);
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('GET /api/impact/estimate – happy path', () => {
  it('returns 200', async () => {
    setupDefaultMocks();
    const response = await GET(makeRequest(BASE_URL));
    expect(response.status).toBe(200);
  });

  it('response contains all required top-level fields', async () => {
    setupDefaultMocks();
    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();

    expect(body).toHaveProperty('corridorId');
    expect(body).toHaveProperty('transferAmountUsd');
    expect(body).toHaveProperty('pool');
    expect(body).toHaveProperty('impact');
    expect(body).toHaveProperty('fragility');
    expect(body).toHaveProperty('corridorHealth');
    expect(body).toHaveProperty('disclaimer');
  });

  it('corridorId is formatted as {bridge}_{source}_{dest}', async () => {
    setupDefaultMocks();
    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();
    expect(body.corridorId).toBe('across_ethereum_arbitrum');
  });

  it('transferAmountUsd is rounded to integer', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/impact/estimate?bridge=across&source=ethereum&dest=arbitrum&amountUsd=100000.78'),
    );
    const body = await response.json();
    expect(Number.isInteger(body.transferAmountUsd)).toBe(true);
    expect(body.transferAmountUsd).toBe(100001);
  });

  it('impact object contains poolSharePct, estimatedSlippageBps, impactLevel', async () => {
    setupDefaultMocks();
    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();

    expect(body.impact).toHaveProperty('poolSharePct');
    expect(body.impact).toHaveProperty('estimatedSlippageBps');
    expect(body.impact).toHaveProperty('impactLevel');
  });

  it('fragility object contains current, reason, postTransfer', async () => {
    setupDefaultMocks();
    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();

    expect(body.fragility).toHaveProperty('current');
    expect(body.fragility).toHaveProperty('reason');
    expect(body.fragility).toHaveProperty('postTransfer');
  });

  it('corridorHealth contains status, p50DurationSeconds, p90DurationSeconds, successRate1h', async () => {
    setupDefaultMocks();
    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();

    expect(body.corridorHealth).toHaveProperty('status');
    expect(body.corridorHealth).toHaveProperty('p50DurationSeconds');
    expect(body.corridorHealth).toHaveProperty('p90DurationSeconds');
    expect(body.corridorHealth).toHaveProperty('successRate1h');
  });
});

// ---------------------------------------------------------------------------
// Disclaimer — always present
// ---------------------------------------------------------------------------

describe('GET /api/impact/estimate – disclaimer', () => {
  it('always includes the required disclaimer string', async () => {
    setupDefaultMocks();
    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();

    expect(body.disclaimer).toBe('Directional estimate only. Not an execution guarantee.');
  });

  it('disclaimer is present even when pool TVL is zero', async () => {
    setupDefaultMocks();
    mockPoolFindFirst.mockResolvedValue(null);

    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();

    expect(body.disclaimer).toBe('Directional estimate only. Not an execution guarantee.');
  });
});

// ---------------------------------------------------------------------------
// Recommendation logic
// ---------------------------------------------------------------------------

describe('GET /api/impact/estimate – recommendation', () => {
  it('returns recommendation for severe impact', async () => {
    setupDefaultMocks();
    mockCalculateImpact.mockReturnValue({ ...IMPACT_RESULT, impactLevel: 'severe', warning: 'Very large trade' });

    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();

    expect(body.recommendation).toContain('Split');
  });

  it('returns recommendation for high impact + high fragility', async () => {
    setupDefaultMocks();
    mockCalculateImpact.mockReturnValue({ ...IMPACT_RESULT, impactLevel: 'high' });
    mockCalculateFragility
      .mockReturnValueOnce({ ...FRAGILITY_RESULT, level: 'high', reason: 'High util' })
      .mockReturnValue({ ...FRAGILITY_RESULT, level: 'high' });

    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();

    expect(body.recommendation).not.toBeNull();
  });

  it('returns null recommendation for low impact + low fragility', async () => {
    setupDefaultMocks();
    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();

    expect(body.recommendation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pool data from DB
// ---------------------------------------------------------------------------

describe('GET /api/impact/estimate – pool data', () => {
  it('pool.tvlUsd is a rounded integer', async () => {
    setupDefaultMocks();
    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();
    expect(Number.isInteger(body.pool.tvlUsd)).toBe(true);
  });

  it('pool.availableLiquidity is a rounded integer', async () => {
    setupDefaultMocks();
    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();
    expect(Number.isInteger(body.pool.availableLiquidity)).toBe(true);
  });

  it('uses zero pool values when no snapshot found', async () => {
    setupDefaultMocks();
    mockPoolFindFirst.mockResolvedValue(null);

    const response = await GET(makeRequest(BASE_URL));
    const body = await response.json();
    expect(body.pool.tvlUsd).toBe(0);
    expect(body.pool.availableLiquidity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Validation errors — 400
// ---------------------------------------------------------------------------

describe('GET /api/impact/estimate – validation errors', () => {
  it('returns 400 when bridge is missing', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/impact/estimate?source=ethereum&dest=arbitrum&amountUsd=1000'),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when source is missing', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/impact/estimate?bridge=across&dest=arbitrum&amountUsd=1000'),
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 when dest is missing', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/impact/estimate?bridge=across&source=ethereum&amountUsd=1000'),
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 when amountUsd is missing', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/impact/estimate?bridge=across&source=ethereum&dest=arbitrum'),
    );
    expect(response.status).toBe(400);
  });

  it('returns 400 for invalid bridge value', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/impact/estimate?bridge=unknown&source=ethereum&dest=arbitrum&amountUsd=1000'),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.details.field).toBe('bridge');
  });

  it('returns 400 for non-numeric amountUsd', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/impact/estimate?bridge=across&source=ethereum&dest=arbitrum&amountUsd=abc'),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.details.field).toBe('amountUsd');
  });

  it('returns 400 for negative amountUsd', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/impact/estimate?bridge=across&source=ethereum&dest=arbitrum&amountUsd=-100'),
    );
    expect(response.status).toBe(400);
  });

  it('accepts zero amountUsd (edge case — no-op transfer)', async () => {
    setupDefaultMocks();
    const response = await GET(
      makeRequest('http://localhost/api/impact/estimate?bridge=across&source=ethereum&dest=arbitrum&amountUsd=0'),
    );
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DB error → 500
// ---------------------------------------------------------------------------

describe('GET /api/impact/estimate – database error', () => {
  it('returns 500 when pool snapshot query throws', async () => {
    mockPoolFindFirst.mockRejectedValue(new Error('DB timeout'));
    mockTransferFindMany.mockResolvedValue([]);

    const response = await GET(makeRequest(BASE_URL));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
