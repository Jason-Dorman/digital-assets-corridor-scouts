/**
 * Tests for the Prisma client singleton (src/lib/db.ts).
 *
 * db.ts exports a Proxy that lazily creates the PrismaClient on first
 * property access — not at require() time. This allows `next build` to
 * import route modules without DATABASE_URL being present.
 *
 * Each test uses jest.resetModules() + require() to force a fresh module
 * evaluation, and accesses a property on `db` to trigger initialization.
 *
 * pg and @prisma/adapter-pg are mocked so no real database connection is made.
 */

// Required by db.ts → requireEnv('DATABASE_URL') at first property access
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

const mockClientInstance = { _isMock: true, $connect: jest.fn() };
const mockPrismaClient = jest.fn().mockImplementation(() => mockClientInstance);
jest.mock('@prisma/client', () => ({ PrismaClient: mockPrismaClient }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Require a fresh db module and trigger lazy initialization by accessing
 * a property on the exported Proxy.
 */
function loadAndInit(): { db: Record<string, unknown> } {
  const mod = require('../../../src/lib/db');
  // Access any property to trigger the Proxy's get trap → getDb() → createClient()
  void mod.db.$connect;
  return mod;
}

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
  // Lazy Proxy behaviour
  // ---------------------------------------------------------------------------

  it('exports a db object on first load', () => {
    const { db } = require('../../../src/lib/db');
    expect(db).toBeDefined();
  });

  it('does NOT instantiate PrismaClient at require() time (lazy proxy)', () => {
    require('../../../src/lib/db');
    expect(mockPrismaClient).toHaveBeenCalledTimes(0);
  });

  it('instantiates PrismaClient on first property access', () => {
    loadAndInit();
    expect(mockPrismaClient).toHaveBeenCalledTimes(1);
  });

  it('passes a driver adapter to the PrismaClient constructor (Prisma 7 requirement)', () => {
    loadAndInit();
    expect(mockPrismaClient).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: mockAdapter }),
    );
  });

  it('returns the same property value from repeated accesses (single client)', () => {
    const { db } = loadAndInit();
    const a = db.$connect;
    const b = db.$connect;
    expect(a).toBe(b);
    expect(mockPrismaClient).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Singleton / globalThis pattern
  // ---------------------------------------------------------------------------

  it('stores the instance on globalThis after first access', () => {
    loadAndInit();
    expect((globalThis as Record<string, unknown>).prisma).toBeDefined();
  });

  it('reuses the cached globalThis instance across separate module evaluations', () => {
    // First load — creates the client and stores it on globalThis
    loadAndInit();
    expect(mockPrismaClient).toHaveBeenCalledTimes(1);

    // Simulate a hot-reload: clear the module cache but keep globalThis intact
    jest.resetModules();
    mockPrismaClient.mockClear();

    // Second load — globalThis.prisma is already populated, should reuse it
    loadAndInit();
    expect(mockPrismaClient).toHaveBeenCalledTimes(0); // no new constructor call
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('creates a new client when globalThis.prisma has been cleared', () => {
    loadAndInit();
    expect(mockPrismaClient).toHaveBeenCalledTimes(1);

    // Simulate a full cold-start (e.g. after process restart)
    jest.resetModules();
    delete (globalThis as Record<string, unknown>).prisma;
    mockPrismaClient.mockClear();

    loadAndInit();
    expect(mockPrismaClient).toHaveBeenCalledTimes(1);
  });
});
