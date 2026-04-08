/**
 * Unit tests for GET /api/cron/orphan-retry
 *
 * Mocks the transfer-processor-singleton so that retryOrphans() is testable
 * without a real database, and verifies the cron auth / error handling.
 */

// ---------------------------------------------------------------------------
// Hoisted mock declarations
// ---------------------------------------------------------------------------

const mockRetryOrphans = jest.fn();
const mockOrphanQueueSize = jest.fn().mockReturnValue(0);

jest.mock('../../../../src/lib/transfer-processor-singleton', () => ({
  getTransferProcessor: () => ({
    retryOrphans: mockRetryOrphans,
    orphanQueue: { size: mockOrphanQueueSize },
  }),
}));

jest.mock('../../../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { GET } from '../../../../src/app/api/cron/orphan-retry/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(headers: Record<string, string> = {}): Request {
  const req = new Request('http://localhost:3000/api/cron/orphan-retry', {
    method: 'GET',
    headers,
  });
  return req;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/orphan-retry', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CRON_SECRET;
    mockRetryOrphans.mockResolvedValue({ matched: 0, pruned: 0 });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 200 with retry results on success', async () => {
    mockRetryOrphans.mockResolvedValue({ matched: 2, pruned: 1 });
    mockOrphanQueueSize.mockReturnValue(3);

    const response = await GET(makeRequest() as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      result: { matched: 2, pruned: 1, queueSize: 3 },
    });
  });

  it('returns 200 when queue is empty', async () => {
    const response = await GET(makeRequest() as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.matched).toBe(0);
    expect(body.result.pruned).toBe(0);
  });

  it('returns 401 when CRON_SECRET is set and auth header is missing', async () => {
    process.env.CRON_SECRET = 'test-secret';

    const response = await GET(makeRequest() as never);

    expect(response.status).toBe(401);
  });

  it('returns 401 when CRON_SECRET is set and auth header is wrong', async () => {
    process.env.CRON_SECRET = 'test-secret';

    const response = await GET(
      makeRequest({ authorization: 'Bearer wrong-secret' }) as never,
    );

    expect(response.status).toBe(401);
  });

  it('returns 200 when CRON_SECRET matches', async () => {
    process.env.CRON_SECRET = 'test-secret';

    const response = await GET(
      makeRequest({ authorization: 'Bearer test-secret' }) as never,
    );

    expect(response.status).toBe(200);
  });

  it('returns 500 when retryOrphans throws', async () => {
    mockRetryOrphans.mockRejectedValue(new Error('db connection lost'));

    const response = await GET(makeRequest() as never);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Internal server error');
  });
});
