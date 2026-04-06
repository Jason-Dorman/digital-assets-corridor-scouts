/**
 * Unit tests for GET /api/anomalies
 *
 * Tests the route handler in isolation by mocking:
 *   - src/lib/db      (anomaly queries)
 *   - src/lib/logger  (suppress log noise)
 */

// ---------------------------------------------------------------------------
// Hoisted mock declarations
// ---------------------------------------------------------------------------

const mockAnomalyFindMany = jest.fn();
const mockAnomalyCount    = jest.fn();

jest.mock('../../../src/lib/db', () => ({
  db: {
    anomaly: {
      findMany: (...args: unknown[]) => mockAnomalyFindMany(...args),
      count:    (...args: unknown[]) => mockAnomalyCount(...args),
    },
  },
}));

jest.mock('../../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { NextRequest } from 'next/server';
import { GET } from '../../../src/app/api/anomalies/route';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAnomaly(overrides: {
  id?: bigint;
  anomalyType?: string;
  corridorId?: string;
  bridge?: string;
  sourceChain?: string | null;
  destChain?: string | null;
  severity?: string;
  resolvedAt?: Date | null;
  details?: Record<string, unknown> | null;
}) {
  return {
    id: overrides.id ?? BigInt(1),
    anomalyType: overrides.anomalyType ?? 'latency_spike',
    corridorId: overrides.corridorId ?? 'across_ethereum_arbitrum',
    bridge: overrides.bridge ?? 'across',
    sourceChain: overrides.sourceChain ?? 'ethereum',
    destChain: overrides.destChain ?? 'arbitrum',
    severity: overrides.severity ?? 'high',
    detectedAt: new Date('2026-04-03T10:00:00Z'),
    resolvedAt: overrides.resolvedAt ?? null,
    details: overrides.details ?? { multiplier: 6.9 },
  };
}

const ANOMALY_FIXTURES = [
  makeAnomaly({ id: BigInt(1), anomalyType: 'latency_spike',    severity: 'high',   bridge: 'across' }),
  makeAnomaly({ id: BigInt(2), anomalyType: 'failure_cluster',  severity: 'medium', bridge: 'cctp', sourceChain: 'polygon', destChain: 'ethereum', details: { failureRate: 30 } }),
  makeAnomaly({ id: BigInt(3), anomalyType: 'stuck_transfer',   severity: 'low',    bridge: 'across', details: { pendingMinutes: 45, amountUsd: 50000 } }),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAnomalyFindMany.mockResolvedValue(ANOMALY_FIXTURES);
  mockAnomalyCount.mockResolvedValue(ANOMALY_FIXTURES.length);
});

// ---------------------------------------------------------------------------
// Happy path — defaults
// ---------------------------------------------------------------------------

describe('GET /api/anomalies – happy path', () => {
  it('returns 200', async () => {
    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    expect(response.status).toBe(200);
  });

  it('response has anomalies array and total', async () => {
    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();
    expect(Array.isArray(body.anomalies)).toBe(true);
    expect(typeof body.total).toBe('number');
  });

  it('total matches DB count', async () => {
    mockAnomalyCount.mockResolvedValue(42);
    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();
    expect(body.total).toBe(42);
  });

  it('each anomaly has required fields', async () => {
    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();

    for (const a of body.anomalies) {
      expect(a).toHaveProperty('id');
      expect(a).toHaveProperty('anomalyType');
      expect(a).toHaveProperty('corridorId');
      expect(a).toHaveProperty('bridge');
      expect(a).toHaveProperty('severity');
      expect(a).toHaveProperty('detectedAt');
      expect(a).toHaveProperty('resolvedAt');
      expect(a).toHaveProperty('description');
    }
  });

  it('id is serialized as a string (not BigInt)', async () => {
    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();
    for (const a of body.anomalies) {
      expect(typeof a.id).toBe('string');
    }
  });

  it('detectedAt is an ISO timestamp string', async () => {
    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();
    for (const a of body.anomalies) {
      expect(typeof a.detectedAt).toBe('string');
      expect(() => new Date(a.detectedAt)).not.toThrow();
    }
  });

  it('resolvedAt is null for active anomalies', async () => {
    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();
    for (const a of body.anomalies) {
      expect(a.resolvedAt).toBeNull();
    }
  });

  it('default query filters for active=true (resolvedAt: null)', async () => {
    await GET(makeRequest('http://localhost/api/anomalies'));
    const whereArg = mockAnomalyFindMany.mock.calls[0][0].where;
    // Default behaviour: active=true → resolvedAt: null in where clause
    expect(whereArg).toHaveProperty('resolvedAt', null);
  });

  it('default limit is 50', async () => {
    await GET(makeRequest('http://localhost/api/anomalies'));
    const takeArg = mockAnomalyFindMany.mock.calls[0][0].take;
    expect(takeArg).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// active=false — include resolved anomalies
// ---------------------------------------------------------------------------

describe('GET /api/anomalies – active=false', () => {
  it('does NOT add resolvedAt filter when active=false', async () => {
    mockAnomalyFindMany.mockResolvedValue([
      makeAnomaly({ resolvedAt: new Date('2026-04-03T09:00:00Z') }),
    ]);
    mockAnomalyCount.mockResolvedValue(1);

    await GET(makeRequest('http://localhost/api/anomalies?active=false'));

    const whereArg = mockAnomalyFindMany.mock.calls[0][0].where;
    expect(whereArg).not.toHaveProperty('resolvedAt');
  });

  it('serializes resolvedAt as ISO string when present', async () => {
    mockAnomalyFindMany.mockResolvedValue([
      makeAnomaly({ resolvedAt: new Date('2026-04-03T09:00:00Z') }),
    ]);
    mockAnomalyCount.mockResolvedValue(1);

    const response = await GET(makeRequest('http://localhost/api/anomalies?active=false'));
    const body = await response.json();

    expect(typeof body.anomalies[0].resolvedAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('GET /api/anomalies – filters', () => {
  it('passes severity filter to DB query', async () => {
    await GET(makeRequest('http://localhost/api/anomalies?severity=high'));
    const whereArg = mockAnomalyFindMany.mock.calls[0][0].where;
    expect(whereArg.severity).toBe('high');
  });

  it('passes type filter to DB query', async () => {
    await GET(makeRequest('http://localhost/api/anomalies?type=latency_spike'));
    const whereArg = mockAnomalyFindMany.mock.calls[0][0].where;
    expect(whereArg.anomalyType).toBe('latency_spike');
  });

  it('passes bridge filter to DB query', async () => {
    await GET(makeRequest('http://localhost/api/anomalies?bridge=cctp'));
    const whereArg = mockAnomalyFindMany.mock.calls[0][0].where;
    expect(whereArg.bridge).toBe('cctp');
  });

  it('passes corridorId filter to DB query', async () => {
    await GET(makeRequest('http://localhost/api/anomalies?corridorId=across_ethereum_arbitrum'));
    const whereArg = mockAnomalyFindMany.mock.calls[0][0].where;
    expect(whereArg.corridorId).toBe('across_ethereum_arbitrum');
  });

  it('applies custom limit', async () => {
    await GET(makeRequest('http://localhost/api/anomalies?limit=10'));
    const takeArg = mockAnomalyFindMany.mock.calls[0][0].take;
    expect(takeArg).toBe(10);
  });

  it('clamps limit to max 500', async () => {
    await GET(makeRequest('http://localhost/api/anomalies?limit=9999'));
    const takeArg = mockAnomalyFindMany.mock.calls[0][0].take;
    expect(takeArg).toBe(500);
  });

  it('orders results by detectedAt DESC', async () => {
    await GET(makeRequest('http://localhost/api/anomalies'));
    const orderArg = mockAnomalyFindMany.mock.calls[0][0].orderBy;
    expect(orderArg).toEqual({ detectedAt: 'desc' });
  });
});

// ---------------------------------------------------------------------------
// Validation errors — 400
// ---------------------------------------------------------------------------

describe('GET /api/anomalies – validation errors', () => {
  it('returns 400 for invalid severity value', async () => {
    const response = await GET(makeRequest('http://localhost/api/anomalies?severity=critical'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('severity');
  });

  it('returns 400 for invalid type value', async () => {
    const response = await GET(makeRequest('http://localhost/api/anomalies?type=unknown_type'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('type');
  });

  it('returns 400 for invalid bridge value', async () => {
    const response = await GET(makeRequest('http://localhost/api/anomalies?bridge=invalid'));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('bridge');
  });

  it('accepts all valid type values', async () => {
    const validTypes = ['latency_spike', 'failure_cluster', 'liquidity_drop', 'stuck_transfer'];
    for (const type of validTypes) {
      const response = await GET(makeRequest(`http://localhost/api/anomalies?type=${type}`));
      expect(response.status).toBe(200);
    }
  });

  it('accepts all valid severity values', async () => {
    for (const severity of ['low', 'medium', 'high']) {
      const response = await GET(makeRequest(`http://localhost/api/anomalies?severity=${severity}`));
      expect(response.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Description generation
// ---------------------------------------------------------------------------

describe('GET /api/anomalies – description generation', () => {
  it('latency_spike with multiplier: "Latency Nx normal on ..."', async () => {
    mockAnomalyFindMany.mockResolvedValue([
      makeAnomaly({ anomalyType: 'latency_spike', details: { multiplier: 6.9 } }),
    ]);
    mockAnomalyCount.mockResolvedValue(1);

    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();

    expect(body.anomalies[0].description).toMatch(/Latency 6\.9x normal on Across Ethereum→Arbitrum/);
  });

  it('latency_spike without multiplier: falls back to generic description', async () => {
    mockAnomalyFindMany.mockResolvedValue([
      makeAnomaly({ anomalyType: 'latency_spike', details: {} }),
    ]);
    mockAnomalyCount.mockResolvedValue(1);

    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();

    expect(body.anomalies[0].description).toMatch(/Latency spike detected on/);
  });

  it('failure_cluster with failureRate: "NN% failure rate on ..."', async () => {
    mockAnomalyFindMany.mockResolvedValue([
      makeAnomaly({ anomalyType: 'failure_cluster', details: { failureRate: 30 } }),
    ]);
    mockAnomalyCount.mockResolvedValue(1);

    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();

    expect(body.anomalies[0].description).toMatch(/30% failure rate on/);
  });

  it('liquidity_drop with dropPct: "Liquidity dropped NN% on ..."', async () => {
    mockAnomalyFindMany.mockResolvedValue([
      makeAnomaly({ anomalyType: 'liquidity_drop', details: { dropPct: 25 } }),
    ]);
    mockAnomalyCount.mockResolvedValue(1);

    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();

    expect(body.anomalies[0].description).toMatch(/Liquidity dropped 25% on/);
  });

  it('stuck_transfer with pendingMinutes and amountUsd: includes both in description', async () => {
    mockAnomalyFindMany.mockResolvedValue([
      makeAnomaly({ anomalyType: 'stuck_transfer', details: { pendingMinutes: 45, amountUsd: 50000 } }),
    ]);
    mockAnomalyCount.mockResolvedValue(1);

    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();

    expect(body.anomalies[0].description).toMatch(/Transfer stuck 45m on/);
    expect(body.anomalies[0].description).toMatch(/\$50,000/);
  });

  it('corridor label capitalises bridge and chain names', async () => {
    mockAnomalyFindMany.mockResolvedValue([
      makeAnomaly({ bridge: 'stargate', sourceChain: 'ethereum', destChain: 'avalanche', anomalyType: 'latency_spike', details: { multiplier: 3 } }),
    ]);
    mockAnomalyCount.mockResolvedValue(1);

    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();

    expect(body.anomalies[0].description).toContain('Stargate Ethereum→Avalanche');
  });

  it('corridor label works when sourceChain is null', async () => {
    mockAnomalyFindMany.mockResolvedValue([
      makeAnomaly({ bridge: 'across', sourceChain: null, destChain: 'arbitrum', anomalyType: 'liquidity_drop', details: { dropPct: 10 } }),
    ]);
    mockAnomalyCount.mockResolvedValue(1);

    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();

    // Should not throw; label uses dest only
    expect(typeof body.anomalies[0].description).toBe('string');
    expect(body.anomalies[0].description.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Empty results
// ---------------------------------------------------------------------------

describe('GET /api/anomalies – empty results', () => {
  it('returns empty anomalies array and total 0 when no anomalies exist', async () => {
    mockAnomalyFindMany.mockResolvedValue([]);
    mockAnomalyCount.mockResolvedValue(0);

    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    const body = await response.json();

    expect(body.anomalies).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DB error → 500
// ---------------------------------------------------------------------------

describe('GET /api/anomalies – database error', () => {
  it('returns 500 when anomaly.findMany throws', async () => {
    mockAnomalyFindMany.mockRejectedValue(new Error('DB offline'));
    mockAnomalyCount.mockResolvedValue(0);

    const response = await GET(makeRequest('http://localhost/api/anomalies'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
