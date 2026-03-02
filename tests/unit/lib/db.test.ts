/**
 * Tests for the Prisma client singleton (src/lib/db.ts).
 *
 * Each test uses jest.resetModules() + require() to force a fresh module
 * evaluation. This lets us observe how the singleton behaves on first load
 * vs. when globalThis already holds a cached instance.
 *
 * pg and @prisma/adapter-pg are mocked so no real database connection is made.
 */

// Required by db.ts → requireEnv('DATABASE_URL') at module evaluation time
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPool = { _isMockPool: true };
jest.mock('pg', () => ({ Pool: jest.fn().mockImplementation(() => mockPool) }));

const mockAdapter = { _isMockAdapter: true };
jest.mock('@prisma/adapter-pg', () => ({
  PrismaPg: jest.fn().mockImplementation(() => mockAdapter),
}));

const mockPrismaClient = jest.fn().mockImplementation(() => ({ _isMock: true }));
jest.mock('@prisma/client', () => ({ PrismaClient: mockPrismaClient }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('db (Prisma singleton)', () => {
  beforeEach(() => {
    jest.resetModules();
    delete (globalThis as Record<string, unknown>).prisma;
    mockPrismaClient.mockClear();
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it('exports a db object on first load', () => {
    const { db } = require('../../../src/lib/db');
    expect(db).toBeDefined();
  });

  it('instantiates PrismaClient exactly once on first load', () => {
    require('../../../src/lib/db');
    expect(mockPrismaClient).toHaveBeenCalledTimes(1);
  });

  it('passes a driver adapter to the PrismaClient constructor (Prisma 7 requirement)', () => {
    require('../../../src/lib/db');
    expect(mockPrismaClient).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: mockAdapter }),
    );
  });

  it('returns the same instance from repeated requires within the same module scope', () => {
    const { db: db1 } = require('../../../src/lib/db');
    const { db: db2 } = require('../../../src/lib/db');
    expect(db1).toBe(db2);
    expect(mockPrismaClient).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Singleton / globalThis pattern
  // ---------------------------------------------------------------------------

  it('stores the instance on globalThis in non-production environments', () => {
    require('../../../src/lib/db');
    expect((globalThis as Record<string, unknown>).prisma).toBeDefined();
  });

  it('reuses the cached globalThis instance across separate module evaluations', () => {
    // First load — creates the client and stores it on globalThis
    const { db: db1 } = require('../../../src/lib/db');

    // Simulate a hot-reload: clear the module cache but keep globalThis intact
    jest.resetModules();

    // Second load — globalThis.prisma is already populated, should reuse it
    const { db: db2 } = require('../../../src/lib/db');

    expect(db1).toBe(db2);
    expect(mockPrismaClient).toHaveBeenCalledTimes(1); // constructor only called once
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('creates a new client when globalThis.prisma has been cleared', () => {
    require('../../../src/lib/db');
    expect(mockPrismaClient).toHaveBeenCalledTimes(1);

    // Simulate a full cold-start (e.g. after process restart)
    jest.resetModules();
    delete (globalThis as Record<string, unknown>).prisma;
    mockPrismaClient.mockClear();

    require('../../../src/lib/db');
    expect(mockPrismaClient).toHaveBeenCalledTimes(1);
  });
});
