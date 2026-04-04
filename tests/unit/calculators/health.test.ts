import { calculateHealthStatus } from '../../../src/calculators/health';
import { HEALTH_THRESHOLDS } from '../../../src/lib/constants';
import { logger } from '../../../src/lib/logger';

// ---------------------------------------------------------------------------
// Spec examples from docs/DATA-MODEL.md §8
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – spec examples', () => {
  it('returns healthy for nominal corridor (99.5% success, 1.2x latency, 50 transfers)', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 120,
      historicalP90: 100,
      transferCount1h: 50,
    });
    expect(result.status).toBe('healthy');
    expect(result.reason).toBe('All systems normal');
  });

  it('returns degraded when success rate is 97% (below 99, above 95)', () => {
    const result = calculateHealthStatus({
      successRate1h: 97,
      currentP90: 120,
      historicalP90: 100,
      transferCount1h: 50,
    });
    expect(result.status).toBe('degraded');
    expect(result.reason).toMatch(/degraded success rate/i);
  });

  it('returns degraded when latency is 2.5x normal', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 250,
      historicalP90: 100,
      transferCount1h: 50,
    });
    expect(result.status).toBe('degraded');
    expect(result.reason).toMatch(/elevated latency/i);
  });

  it('returns down when success rate is 92% (below 95)', () => {
    const result = calculateHealthStatus({
      successRate1h: 92,
      currentP90: 120,
      historicalP90: 100,
      transferCount1h: 50,
    });
    expect(result.status).toBe('down');
    expect(result.reason).toMatch(/low success rate/i);
  });

  it('returns down when latency is 6x normal (above 5)', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 600,
      historicalP90: 100,
      transferCount1h: 50,
    });
    expect(result.status).toBe('down');
    expect(result.reason).toMatch(/high latency/i);
  });

  it('returns down when transferCount1h is 0', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 120,
      historicalP90: 100,
      transferCount1h: 0,
    });
    expect(result.status).toBe('down');
    expect(result.reason).toBe('No transfers in last hour');
  });
});

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – return shape', () => {
  it('echoes back successRate1h, transferCount1h, and exposes latencyMultiplier', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 150,
      historicalP90: 100,
      transferCount1h: 42,
    });
    expect(result.successRate1h).toBe(99.5);
    expect(result.transferCount1h).toBe(42);
    expect(result.latencyMultiplier).toBeCloseTo(1.5);
  });

  it('includes a non-empty reason string for every status', () => {
    const inputs = [
      { successRate1h: 99.5, currentP90: 100, historicalP90: 100, transferCount1h: 10 }, // healthy
      { successRate1h: 97,   currentP90: 100, historicalP90: 100, transferCount1h: 10 }, // degraded
      { successRate1h: 90,   currentP90: 100, historicalP90: 100, transferCount1h: 10 }, // down
    ];
    for (const input of inputs) {
      const result = calculateHealthStatus(input);
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Latency multiplier calculation
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – latencyMultiplier', () => {
  it('computes ratio correctly (300 / 100 = 3.0)', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 300,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.latencyMultiplier).toBeCloseTo(3.0);
  });

  it('is exactly 1 when currentP90 equals historicalP90', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 200,
      historicalP90: 200,
      transferCount1h: 10,
    });
    expect(result.latencyMultiplier).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DOWN threshold boundaries
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – DOWN boundaries', () => {
  // Success rate
  it('returns down when successRate1h is 94.9 (< 95)', () => {
    const result = calculateHealthStatus({
      successRate1h: 94.9,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.status).toBe('down');
  });

  it('returns NOT down when successRate1h is exactly 95 (not strictly < 95)', () => {
    const result = calculateHealthStatus({
      successRate1h: 95,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.status).not.toBe('down');
    expect(result.status).toBe('degraded'); // 95 < 99 → degraded
  });

  // Latency multiplier
  it('returns down when latencyMultiplier is 5.01 (> 5)', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 501,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.status).toBe('down');
  });

  it('returns NOT down when latencyMultiplier is exactly 5 (not strictly > 5)', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 500,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.status).not.toBe('down');
    expect(result.status).toBe('degraded'); // 5 > 2 → degraded
  });

  // Transfer count
  it('returns down when transferCount1h is 0 (strict === 0)', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 0,
    });
    expect(result.status).toBe('down');
  });

  it('does NOT return down when transferCount1h is 1', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 1,
    });
    expect(result.status).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// DEGRADED threshold boundaries
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – DEGRADED boundaries', () => {
  // Success rate
  it('returns degraded when successRate1h is 98.99 (< 99)', () => {
    const result = calculateHealthStatus({
      successRate1h: 98.99,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.status).toBe('degraded');
  });

  it('returns healthy when successRate1h is exactly 99 (not strictly < 99)', () => {
    const result = calculateHealthStatus({
      successRate1h: 99,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.status).toBe('healthy');
  });

  // Latency multiplier
  it('returns degraded when latencyMultiplier is 2.01 (> 2)', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 201,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.status).toBe('degraded');
  });

  it('returns healthy when latencyMultiplier is exactly 2 (not strictly > 2)', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 200,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.status).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// Evaluation order — DOWN takes priority over DEGRADED
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – evaluation order', () => {
  it('returns down (not degraded) when successRate is 90 — first DOWN condition wins', () => {
    const result = calculateHealthStatus({
      successRate1h: 90,
      currentP90: 250, // also degraded-latency-level
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.status).toBe('down');
    expect(result.reason).toMatch(/low success rate/i);
  });

  it('returns down (not degraded) when latencyMultiplier is 6 despite 98% success rate', () => {
    const result = calculateHealthStatus({
      successRate1h: 98, // degraded success rate alone
      currentP90: 600,   // also down-latency
      historicalP90: 100,
      transferCount1h: 10,
    });
    // successRate1h < 95 is FALSE (98 ≥ 95), but latencyMultiplier > 5 is TRUE
    expect(result.status).toBe('down');
    expect(result.reason).toMatch(/high latency/i);
  });

  it('returns down (not degraded) when transferCount is 0 despite 98% success rate', () => {
    const result = calculateHealthStatus({
      successRate1h: 98,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 0,
    });
    // successRate DOWN check: 98 < 95 → false
    // latency DOWN check: 1 > 5 → false
    // transferCount DOWN check: 0 === 0 → true (fires here, not degraded)
    expect(result.status).toBe('down');
    expect(result.reason).toBe('No transfers in last hour');
  });
});

// ---------------------------------------------------------------------------
// Guard: NaN / Infinity inputs
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – NaN/Infinity guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns down (fail-safe) when successRate1h is NaN', () => {
    const result = calculateHealthStatus({
      successRate1h: NaN,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.status).toBe('down');
    expect(result.reason).toMatch(/data integrity/i);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns down (fail-safe) when currentP90 is Infinity', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: Infinity,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.status).toBe('down');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns down (fail-safe) when historicalP90 is NaN', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: NaN,
      transferCount1h: 10,
    });
    expect(result.status).toBe('down');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns down (fail-safe) when transferCount1h is Infinity', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: Infinity,
    });
    expect(result.status).toBe('down');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('logs a warn with [Health] prefix when NaN detected', () => {
    calculateHealthStatus({
      successRate1h: NaN,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Health]'),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Guard: zero / negative historicalP90 — no baseline
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – zero historicalP90 (no baseline)', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('defaults latencyMultiplier to 1 when historicalP90 is 0', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 10_000, // massive latency — would be DOWN if baseline existed
      historicalP90: 0,
      transferCount1h: 10,
    });
    // latencyMultiplier = 1, so no DOWN/DEGRADED via latency
    expect(result.latencyMultiplier).toBe(1);
    expect(result.status).toBe('healthy');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('logs a warning when historicalP90 is 0', () => {
    calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: 0,
      transferCount1h: 10,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Health]'),
      expect.anything(),
    );
  });

  it('defaults latencyMultiplier to 1 when historicalP90 is negative', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: -50,
      transferCount1h: 10,
    });
    expect(result.latencyMultiplier).toBe(1);
    expect(result.status).toBe('healthy');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guard: negative transferCount
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – negative transferCount guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns down (fail-safe) when transferCount1h is negative', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: -1,
    });
    expect(result.status).toBe('down');
    expect(result.reason).toMatch(/negative transfer count/i);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guard: negative currentP90 (clock skew)
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – negative currentP90 guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('clamps negative currentP90 to 0 and does not raise latency status', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: -500,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.latencyMultiplier).toBe(0);
    expect(result.status).toBe('healthy');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('logs a warn with [Health] prefix when currentP90 is negative', () => {
    calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: -1,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Health]'),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Guard: successRate1h out of range (clamping)
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – successRate1h clamping', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('clamps successRate > 100 to 100 and returns healthy for otherwise normal inputs', () => {
    const result = calculateHealthStatus({
      successRate1h: 105,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.successRate1h).toBe(100);
    expect(result.status).toBe('healthy');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('clamps successRate < 0 to 0 and returns down', () => {
    const result = calculateHealthStatus({
      successRate1h: -10,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.successRate1h).toBe(0);
    expect(result.status).toBe('down');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guard: non-integer transferCount (flooring)
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – non-integer transferCount guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('floors fractional transferCount and warns', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 5.7,
    });
    expect(result.transferCount1h).toBe(5);
    expect(result.status).toBe('healthy');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Health]'),
      expect.objectContaining({ transferCount1h: 5.7 }),
    );
  });

  it('floors 0.3 to 0 which triggers DOWN', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 0.3,
    });
    expect(result.transferCount1h).toBe(0);
    expect(result.status).toBe('down');
    expect(result.reason).toBe('No transfers in last hour');
  });
});

// ---------------------------------------------------------------------------
// Boundary: currentP90 === 0 with valid baseline
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – currentP90 zero with valid baseline', () => {
  it('returns latencyMultiplier 0 and healthy (0 is not > 2 or > 5)', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 0,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.latencyMultiplier).toBe(0);
    expect(result.status).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// Context propagation to logger
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – context propagation', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('includes context fields in warn log payload', () => {
    calculateHealthStatus({
      successRate1h: NaN,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 10,
      context: { bridge: 'across', corridor: 'across_ethereum_arbitrum' },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        bridge: 'across',
        corridor: 'across_ethereum_arbitrum',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Data error guards return null latencyMultiplier
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – null latencyMultiplier on data errors', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns null latencyMultiplier when NaN detected', () => {
    const result = calculateHealthStatus({
      successRate1h: NaN,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.latencyMultiplier).toBeNull();
  });

  it('returns null latencyMultiplier when transferCount is negative', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: 100,
      transferCount1h: -1,
    });
    expect(result.latencyMultiplier).toBeNull();
  });

  it('returns numeric latencyMultiplier (not null) on normal classification paths', () => {
    const result = calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 150,
      historicalP90: 100,
      transferCount1h: 10,
    });
    expect(result.latencyMultiplier).not.toBeNull();
    expect(typeof result.latencyMultiplier).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Guard: negative historicalP90 (clock skew — distinct from zero baseline)
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – negative historicalP90 clamp', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('logs clock-skew message (not "no baseline" message) for negative historicalP90', () => {
    calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: -50,
      transferCount1h: 10,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('clock skew in baseline'),
      expect.anything(),
    );
  });

  it('does not double-warn (only one warn for the clamp, not a second for zero)', () => {
    calculateHealthStatus({
      successRate1h: 99.5,
      currentP90: 100,
      historicalP90: -50,
      transferCount1h: 10,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Constants alignment — thresholds are locked to spec values
// ---------------------------------------------------------------------------

describe('calculateHealthStatus – thresholds match HEALTH_THRESHOLDS constants', () => {
  it('SUCCESS_RATE_HEALTHY threshold is 99', () => {
    expect(HEALTH_THRESHOLDS.SUCCESS_RATE_HEALTHY).toBe(99);
  });

  it('SUCCESS_RATE_DOWN threshold is 95', () => {
    expect(HEALTH_THRESHOLDS.SUCCESS_RATE_DOWN).toBe(95);
  });

  it('LATENCY_DEGRADED_MULTIPLIER threshold is 2', () => {
    expect(HEALTH_THRESHOLDS.LATENCY_DEGRADED_MULTIPLIER).toBe(2);
  });

  it('LATENCY_DOWN_MULTIPLIER threshold is 5', () => {
    expect(HEALTH_THRESHOLDS.LATENCY_DOWN_MULTIPLIER).toBe(5);
  });
});
