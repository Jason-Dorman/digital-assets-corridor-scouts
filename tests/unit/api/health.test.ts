/**
 * Unit tests for GET /api/health
 *
 * Tests the route handler in isolation by mocking:
 *   - src/lib/redis          (cache read/write)
 *   - src/lib/corridor-metrics (DB query + aggregation)
 *   - src/lib/db             (anomaly count)
 *   - src/lib/logger         (suppress log noise)
 */

// ---------------------------------------------------------------------------
// Hoisted mock declarations
// ---------------------------------------------------------------------------

const mockRedisGet  = jest.fn();
const mockRedisSetex = jest.fn();
const mockFetchAllCorridorMetrics = jest.fn();
const mockAnomalyCount = jest.fn();

jest.mock('../../../src/lib/redis', () => ({
  redis: {
    get:   (...args: unknown[]) => mockRedisGet(...args),
    setex: (...args: unknown[]) => mockRedisSetex(...args),
  },
}));

jest.mock('../../../src/lib/corridor-metrics', () => ({
  fetchAllCorridorMetrics: (...args: unknown[]) => mockFetchAllCorridorMetrics(...args),
  CORRIDOR_METRICS_CACHE_KEY: 'api:corridor-metrics',
  CORRIDOR_METRICS_CACHE_TTL: 60,
}));

jest.mock('../../../src/lib/db', () => ({
  db: {
    anomaly: {
      count: (...args: unknown[]) => mockAnomalyCount(...args),
    },
  },
}));

jest.mock('../../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { GET } from '../../../src/app/api/health/route';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HEALTHY_METRICS = {
  corridors: [
    { status: 'healthy' },
    { status: 'healthy' },
    { status: 'degraded' },
    { status: 'down' },
  ],
  totalTransfers24h: 1000,
  overallSuccessRate24h: 98.7,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Default: cache miss, no Redis errors
  mockRedisGet.mockResolvedValue(null);
  mockRedisSetex.mockResolvedValue('OK');
  mockFetchAllCorridorMetrics.mockResolvedValue(HEALTHY_METRICS);
  mockAnomalyCount.mockResolvedValue(2);
});

// ---------------------------------------------------------------------------
// Happy path — cache miss
// ---------------------------------------------------------------------------

describe('GET /api/health – happy path (cache miss)', () => {
  it('returns 200', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it('response contains all required top-level fields', async () => {
    const response = await GET();
    const body = await response.json();

    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('corridorsMonitored');
    expect(body).toHaveProperty('corridorsHealthy');
    expect(body).toHaveProperty('corridorsDegraded');
    expect(body).toHaveProperty('corridorsDown');
    expect(body).toHaveProperty('transfers24h');
    expect(body).toHaveProperty('successRate24h');
    expect(body).toHaveProperty('activeAnomalies');
    expect(body).toHaveProperty('updatedAt');
  });

  it('corridors counts match fixture data', async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.corridorsMonitored).toBe(4);
    expect(body.corridorsHealthy).toBe(2);
    expect(body.corridorsDegraded).toBe(1);
    expect(body.corridorsDown).toBe(1);
  });

  it('transfers24h matches totalTransfers24h from metrics', async () => {
    const response = await GET();
    const body = await response.json();
    expect(body.transfers24h).toBe(1000);
  });

  it('successRate24h is passed through from metrics', async () => {
    const response = await GET();
    const body = await response.json();
    expect(body.successRate24h).toBe(98.7);
  });

  it('activeAnomalies matches anomaly count from DB', async () => {
    mockAnomalyCount.mockResolvedValue(5);
    const response = await GET();
    const body = await response.json();
    expect(body.activeAnomalies).toBe(5);
  });

  it('updatedAt is a valid ISO timestamp string', async () => {
    const before = Date.now();
    const response = await GET();
    const after = Date.now();
    const body = await response.json();
    const ts = new Date(body.updatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('writes fresh data to Redis cache', async () => {
    await GET();
    expect(mockRedisSetex).toHaveBeenCalledWith(
      'api:corridor-metrics',
      60,
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// System status derivation
// ---------------------------------------------------------------------------

describe('GET /api/health – system status', () => {
  it('returns operational when < 20% corridors are down', async () => {
    // 1 down out of 4 = 25%… wait, actually 1/4 = 0.25 which IS ≥ 0.20
    // Let's use 1 down of 10 = 10%
    mockFetchAllCorridorMetrics.mockResolvedValue({
      corridors: [
        ...Array(9).fill({ status: 'healthy' }),
        { status: 'down' },
      ],
      totalTransfers24h: 100,
      overallSuccessRate24h: 99,
    });
    const response = await GET();
    const body = await response.json();
    expect(body.status).toBe('operational');
  });

  it('returns degraded when ≥ 20% corridors are down', async () => {
    // 2 down out of 5 = 40%
    mockFetchAllCorridorMetrics.mockResolvedValue({
      corridors: [
        ...Array(3).fill({ status: 'healthy' }),
        { status: 'down' },
        { status: 'down' },
      ],
      totalTransfers24h: 50,
      overallSuccessRate24h: 95,
    });
    const response = await GET();
    const body = await response.json();
    expect(body.status).toBe('degraded');
  });

  it('returns degraded when ≥ 50% corridors are degraded', async () => {
    mockFetchAllCorridorMetrics.mockResolvedValue({
      corridors: [
        { status: 'degraded' },
        { status: 'degraded' },
        { status: 'healthy' },
        { status: 'healthy' },
      ],
      totalTransfers24h: 200,
      overallSuccessRate24h: 97,
    });
    const response = await GET();
    const body = await response.json();
    expect(body.status).toBe('degraded');
  });

  it('returns down when ≥ 50% corridors are down', async () => {
    mockFetchAllCorridorMetrics.mockResolvedValue({
      corridors: [
        { status: 'down' },
        { status: 'down' },
        { status: 'down' },
        { status: 'healthy' },
      ],
      totalTransfers24h: 10,
      overallSuccessRate24h: 50,
    });
    const response = await GET();
    const body = await response.json();
    expect(body.status).toBe('down');
  });

  it('returns operational when there are no corridors', async () => {
    mockFetchAllCorridorMetrics.mockResolvedValue({
      corridors: [],
      totalTransfers24h: 0,
      overallSuccessRate24h: 100,
    });
    const response = await GET();
    const body = await response.json();
    expect(body.status).toBe('operational');
  });
});

// ---------------------------------------------------------------------------
// Redis cache — cache hit
// ---------------------------------------------------------------------------

describe('GET /api/health – cache hit', () => {
  it('returns cached response without calling fetchAllCorridorMetrics', async () => {
    // The health route caches CorridorDataResult (raw corridor metrics), not the
    // computed health response. On a hit it skips fetchAllCorridorMetrics but
    // still computes health (including the anomaly count DB call).
    const cached = JSON.stringify({
      corridors: Array(10).fill({ status: 'healthy' }),
      totalTransfers24h: 500,
      overallSuccessRate24h: 100,
    });
    mockRedisGet.mockResolvedValue(cached);

    const response = await GET();
    const body = await response.json();

    expect(body.corridorsMonitored).toBe(10);
    expect(mockFetchAllCorridorMetrics).not.toHaveBeenCalled();
    // anomaly count is still called — it's part of computeHealth, not the cache
    expect(mockAnomalyCount).toHaveBeenCalled();
  });

  it('does not write to cache when cache hit', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify({ status: 'operational' }));
    await GET();
    expect(mockRedisSetex).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Redis cache — graceful degradation on errors
// ---------------------------------------------------------------------------

describe('GET /api/health – Redis error degradation', () => {
  it('continues without cache when redis.get throws', async () => {
    mockRedisGet.mockRejectedValue(new Error('Redis timeout'));

    const response = await GET();
    expect(response.status).toBe(200);
    expect(mockFetchAllCorridorMetrics).toHaveBeenCalled();
  });

  it('still returns 200 when redis.setex throws', async () => {
    mockRedisSetex.mockRejectedValue(new Error('Redis write error'));

    const response = await GET();
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DB error → 500
// ---------------------------------------------------------------------------

describe('GET /api/health – database error', () => {
  it('returns 500 when fetchAllCorridorMetrics throws', async () => {
    mockFetchAllCorridorMetrics.mockRejectedValue(new Error('DB connection lost'));

    const response = await GET();
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when anomaly count throws', async () => {
    mockAnomalyCount.mockRejectedValue(new Error('DB error'));

    const response = await GET();
    expect(response.status).toBe(500);
  });
});
