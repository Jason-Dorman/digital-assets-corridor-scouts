/**
 * Unit tests for GET /api/corridors
 *
 * Tests the route handler in isolation by mocking:
 *   - src/lib/corridor-metrics (DB query + aggregation)
 *   - src/lib/logger           (suppress log noise)
 */

// ---------------------------------------------------------------------------
// Hoisted mock declarations
// ---------------------------------------------------------------------------

const mockRedisGet   = jest.fn();
const mockRedisSetex = jest.fn();
const mockFetchAllCorridorMetrics = jest.fn();

jest.mock('../../../src/lib/redis', () => ({
  redis: {
    get:   (...args: unknown[]) => mockRedisGet(...args),
    setex: (...args: unknown[]) => mockRedisSetex(...args),
  },
}));

jest.mock('../../../src/lib/corridor-metrics', () => ({
  fetchAllCorridorMetrics: (...args: unknown[]) => mockFetchAllCorridorMetrics(...args),
}));

jest.mock('../../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { NextRequest } from 'next/server';
import { GET } from '../../../src/app/api/corridors/route';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCorridor(overrides: {
  corridorId?: string;
  bridge?: string;
  sourceChain?: string;
  destChain?: string;
  status?: string;
  p50?: number;
  p90?: number;
  transfers?: number;
  fragility?: string;
}) {
  const bridge = overrides.bridge ?? 'across';
  const src = overrides.sourceChain ?? 'ethereum';
  const dst = overrides.destChain ?? 'arbitrum';
  return {
    corridorId: overrides.corridorId ?? `${bridge}_${src}_${dst}`,
    bridge,
    sourceChain: src,
    destChain: dst,
    status: overrides.status ?? 'healthy',
    metrics: {
      transferCount1h: 5,
      transferCount24h: overrides.transfers ?? 100,
      successRate1h: 99.5,
      successRate24h: 99.5,
      p50DurationSeconds: overrides.p50 ?? 120,
      p90DurationSeconds: overrides.p90 ?? 180,
      volumeUsd24h: 500_000,
    },
    pool: {
      tvlUsd: 10_000_000,
      utilization: 25,
      fragility: overrides.fragility ?? 'low',
      fragilityReason: 'Pool is stable',
    },
    lastTransferAt: new Date('2026-04-03T11:00:00Z'),
  };
}

const FIXTURES = [
  makeCorridor({ bridge: 'across', sourceChain: 'ethereum', destChain: 'arbitrum', status: 'healthy', p50: 120, transfers: 200 }),
  makeCorridor({ bridge: 'across', sourceChain: 'arbitrum', destChain: 'ethereum', status: 'degraded', p50: 240, transfers: 50 }),
  makeCorridor({ bridge: 'cctp',   sourceChain: 'ethereum', destChain: 'polygon',  status: 'down',    p50: 60,  transfers: 10, fragility: 'high' }),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'));
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: cache miss so tests exercise the full computation path
  mockRedisGet.mockResolvedValue(null);
  mockRedisSetex.mockResolvedValue('OK');
  mockFetchAllCorridorMetrics.mockResolvedValue({ corridors: FIXTURES });
});

// ---------------------------------------------------------------------------
// Happy path — no filters
// ---------------------------------------------------------------------------

describe('GET /api/corridors – no filters', () => {
  it('returns 200', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors'));
    expect(response.status).toBe(200);
  });

  it('response has corridors array, total, limit, offset', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors'));
    const body = await response.json();
    expect(Array.isArray(body.corridors)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.limit).toBe('number');
    expect(typeof body.offset).toBe('number');
  });

  it('returns all corridors when no filter is applied', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors'));
    const body = await response.json();
    expect(body.corridors).toHaveLength(3);
    expect(body.total).toBe(3);
  });

  it('lastTransferAt is an ISO string (not a Date object)', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors'));
    const body = await response.json();
    for (const c of body.corridors) {
      expect(typeof c.lastTransferAt).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('GET /api/corridors – filtering', () => {
  it('filters by bridge', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?bridge=across'));
    const body = await response.json();
    expect(body.corridors).toHaveLength(2);
    body.corridors.forEach((c: { bridge: string }) => expect(c.bridge).toBe('across'));
  });

  it('filters by source chain', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?source=arbitrum'));
    const body = await response.json();
    expect(body.corridors).toHaveLength(1);
    expect(body.corridors[0].sourceChain).toBe('arbitrum');
  });

  it('filters by dest chain', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?dest=polygon'));
    const body = await response.json();
    expect(body.corridors).toHaveLength(1);
    expect(body.corridors[0].destChain).toBe('polygon');
  });

  it('filters by status', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?status=healthy'));
    const body = await response.json();
    expect(body.corridors).toHaveLength(1);
    expect(body.corridors[0].status).toBe('healthy');
  });

  it('can combine bridge and status filters', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?bridge=across&status=degraded'));
    const body = await response.json();
    expect(body.corridors).toHaveLength(1);
    expect(body.corridors[0].bridge).toBe('across');
    expect(body.corridors[0].status).toBe('degraded');
  });

  it('returns empty array when filter matches nothing', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?status=down&bridge=cctp&dest=ethereum'));
    const body = await response.json();
    expect(body.corridors).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('GET /api/corridors – sorting', () => {
  it('sorts by p50 ascending (default)', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?sort=p50&order=asc'));
    const body = await response.json();
    const p50s = body.corridors.map((c: { metrics: { p50DurationSeconds: number } }) => c.metrics.p50DurationSeconds);
    for (let i = 1; i < p50s.length; i++) {
      expect(p50s[i]).toBeGreaterThanOrEqual(p50s[i - 1]);
    }
  });

  it('sorts by p50 descending', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?sort=p50&order=desc'));
    const body = await response.json();
    const p50s = body.corridors.map((c: { metrics: { p50DurationSeconds: number } }) => c.metrics.p50DurationSeconds);
    for (let i = 1; i < p50s.length; i++) {
      expect(p50s[i]).toBeLessThanOrEqual(p50s[i - 1]);
    }
  });

  it('sorts by transfers ascending', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?sort=transfers&order=asc'));
    const body = await response.json();
    const counts = body.corridors.map((c: { metrics: { transferCount24h: number } }) => c.metrics.transferCount24h);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    }
  });

  it('sorts by fragility ascending (low < medium < high)', async () => {
    mockFetchAllCorridorMetrics.mockResolvedValue({
      corridors: [
        makeCorridor({ fragility: 'high' }),
        makeCorridor({ bridge: 'cctp', sourceChain: 'polygon', destChain: 'ethereum', fragility: 'low' }),
        makeCorridor({ bridge: 'across', sourceChain: 'arbitrum', destChain: 'polygon', fragility: 'medium' }),
      ],
    });

    const response = await GET(makeRequest('http://localhost/api/corridors?sort=fragility&order=asc'));
    const body = await response.json();
    const fragilities = body.corridors.map((c: { pool: { fragility: string } }) => c.pool.fragility);
    expect(fragilities).toEqual(['low', 'medium', 'high']);
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('GET /api/corridors – pagination', () => {
  it('applies limit', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?limit=2'));
    const body = await response.json();
    expect(body.corridors).toHaveLength(2);
    expect(body.total).toBe(3); // total is pre-pagination count
    expect(body.limit).toBe(2);
  });

  it('applies offset', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?offset=2'));
    const body = await response.json();
    expect(body.corridors).toHaveLength(1);
    expect(body.offset).toBe(2);
  });

  it('clamps limit to max 500', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?limit=9999'));
    const body = await response.json();
    expect(body.limit).toBe(500);
  });

  it('uses default limit of 100 when not specified', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors'));
    const body = await response.json();
    expect(body.limit).toBe(100);
  });

  it('uses default offset of 0 when not specified', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors'));
    const body = await response.json();
    expect(body.offset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Validation errors — 400
// ---------------------------------------------------------------------------

describe('GET /api/corridors – validation errors', () => {
  it('returns 400 for invalid bridge value', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?bridge=unknown'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('bridge');
  });

  it('returns 400 for invalid status value', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?status=ok'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('status');
  });

  it('returns 400 for invalid sort field', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?sort=volume'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('sort');
  });

  it('returns 400 for invalid order value', async () => {
    const response = await GET(makeRequest('http://localhost/api/corridors?order=random'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('order');
  });
});

// ---------------------------------------------------------------------------
// DB error → 500
// ---------------------------------------------------------------------------

describe('GET /api/corridors – database error', () => {
  it('returns 500 when fetchAllCorridorMetrics throws', async () => {
    mockFetchAllCorridorMetrics.mockRejectedValue(new Error('DB error'));
    const response = await GET(makeRequest('http://localhost/api/corridors'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Redis cache
// ---------------------------------------------------------------------------

describe('GET /api/corridors – cache hit', () => {
  it('returns cached corridors without calling fetchAllCorridorMetrics', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify(FIXTURES));

    const response = await GET(makeRequest('http://localhost/api/corridors'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.corridors).toHaveLength(3);
    expect(mockFetchAllCorridorMetrics).not.toHaveBeenCalled();
  });

  it('does not write cache on a cache hit', async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify(FIXTURES));
    await GET(makeRequest('http://localhost/api/corridors'));
    expect(mockRedisSetex).not.toHaveBeenCalled();
  });
});

describe('GET /api/corridors – cache miss', () => {
  it('writes to Redis with 60s TTL on cache miss', async () => {
    await GET(makeRequest('http://localhost/api/corridors'));
    expect(mockRedisSetex).toHaveBeenCalledWith('api:corridors', 60, expect.any(String));
  });
});

describe('GET /api/corridors – Redis error degradation', () => {
  it('continues without cache when redis.get throws', async () => {
    mockRedisGet.mockRejectedValue(new Error('Redis down'));
    const response = await GET(makeRequest('http://localhost/api/corridors'));
    expect(response.status).toBe(200);
    expect(mockFetchAllCorridorMetrics).toHaveBeenCalled();
  });

  it('still returns 200 when redis.setex throws', async () => {
    mockRedisSetex.mockRejectedValue(new Error('Write error'));
    const response = await GET(makeRequest('http://localhost/api/corridors'));
    expect(response.status).toBe(200);
  });
});
