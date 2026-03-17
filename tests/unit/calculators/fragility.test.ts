import { calculateFragility } from '../../../src/calculators/fragility';
import { FRAGILITY_THRESHOLDS } from '../../../src/lib/constants';

// ---------------------------------------------------------------------------
// Spec examples from docs/DATA-MODEL.md §5.4
// ---------------------------------------------------------------------------

describe('calculateFragility – spec examples', () => {
  it('returns HIGH for 65% utilization with positive flow', () => {
    const result = calculateFragility({ utilization: 65, tvlUsd: 1_000_000, netFlow24h: 50_000 });
    expect(result.level).toBe('high');
    expect(result.reason).toBe('High utilization (65%)');
  });

  it('returns HIGH for large outflow (-25%) with low utilization', () => {
    const result = calculateFragility({ utilization: 25, tvlUsd: 1_000_000, netFlow24h: -250_000 });
    expect(result.level).toBe('high');
    expect(result.reason).toBe('Large outflow (-25.0% in 24h)');
  });

  it('returns MEDIUM for 45% utilization with modest inflow', () => {
    const result = calculateFragility({ utilization: 45, tvlUsd: 1_000_000, netFlow24h: 20_000 });
    expect(result.level).toBe('medium');
    expect(result.reason).toBe('Moderate utilization (45%)');
  });

  it('returns MEDIUM for moderate outflow (-15%) with low utilization', () => {
    const result = calculateFragility({ utilization: 20, tvlUsd: 1_000_000, netFlow24h: -150_000 });
    expect(result.level).toBe('medium');
    expect(result.reason).toBe('Moderate outflow (-15.0% in 24h)');
  });

  it('returns LOW for stable pool', () => {
    const result = calculateFragility({ utilization: 25, tvlUsd: 1_000_000, netFlow24h: 30_000 });
    expect(result.level).toBe('low');
    expect(result.reason).toBe('Pool is stable');
  });
});

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

describe('calculateFragility – return shape', () => {
  it('echoes back utilization and computed netFlow24hPct', () => {
    const result = calculateFragility({ utilization: 25, tvlUsd: 1_000_000, netFlow24h: 30_000 });
    expect(result.utilization).toBe(25);
    expect(result.netFlow24hPct).toBeCloseTo(3);
  });
});

// ---------------------------------------------------------------------------
// HIGH threshold boundaries
// ---------------------------------------------------------------------------

describe('calculateFragility – HIGH boundaries', () => {
  it('returns HIGH when utilization is exactly one above the threshold', () => {
    const result = calculateFragility({ utilization: 61, tvlUsd: 1_000_000, netFlow24h: 0 });
    expect(result.level).toBe('high');
  });

  it('returns MEDIUM when utilization is exactly at the HIGH threshold (not strictly above)', () => {
    const result = calculateFragility({ utilization: 60, tvlUsd: 1_000_000, netFlow24h: 0 });
    expect(result.level).toBe('medium');
  });

  it('returns HIGH when netFlow24hPct is just below the HIGH outflow threshold', () => {
    // -21% outflow
    const result = calculateFragility({ utilization: 10, tvlUsd: 1_000_000, netFlow24h: -210_000 });
    expect(result.level).toBe('high');
  });

  it('returns MEDIUM when netFlow24hPct is exactly at the HIGH outflow threshold', () => {
    // -20% outflow — not strictly below, so should be MEDIUM
    const result = calculateFragility({ utilization: 10, tvlUsd: 1_000_000, netFlow24h: -200_000 });
    expect(result.level).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// MEDIUM threshold boundaries
// ---------------------------------------------------------------------------

describe('calculateFragility – MEDIUM boundaries', () => {
  it('returns MEDIUM when utilization is exactly one above the MEDIUM threshold', () => {
    const result = calculateFragility({ utilization: 31, tvlUsd: 1_000_000, netFlow24h: 0 });
    expect(result.level).toBe('medium');
  });

  it('returns LOW when utilization is exactly at the MEDIUM threshold (not strictly above)', () => {
    const result = calculateFragility({ utilization: 30, tvlUsd: 1_000_000, netFlow24h: 0 });
    expect(result.level).toBe('low');
  });

  it('returns MEDIUM when netFlow24hPct is just below the MEDIUM outflow threshold', () => {
    // -11% outflow
    const result = calculateFragility({ utilization: 10, tvlUsd: 1_000_000, netFlow24h: -110_000 });
    expect(result.level).toBe('medium');
  });

  it('returns LOW when netFlow24hPct is exactly at the MEDIUM outflow threshold', () => {
    // -10% outflow — not strictly below, so should be LOW
    const result = calculateFragility({ utilization: 10, tvlUsd: 1_000_000, netFlow24h: -100_000 });
    expect(result.level).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// HIGH takes precedence over MEDIUM
// ---------------------------------------------------------------------------

describe('calculateFragility – dual-trigger reason strings', () => {
  it('surfaces both HIGH conditions when both fire simultaneously', () => {
    // utilization > 60 AND netFlow24hPct < -20
    const result = calculateFragility({ utilization: 70, tvlUsd: 1_000_000, netFlow24h: -300_000 });
    expect(result.level).toBe('high');
    expect(result.reason).toMatch(/utilization/i);
    expect(result.reason).toMatch(/outflow/i);
    expect(result.reason).toContain('; ');
  });

  it('surfaces only utilization when outflow does not breach HIGH threshold', () => {
    const result = calculateFragility({ utilization: 70, tvlUsd: 1_000_000, netFlow24h: -100_000 });
    expect(result.level).toBe('high');
    expect(result.reason).toBe('High utilization (70%)');
  });

  it('surfaces only outflow when utilization does not breach HIGH threshold', () => {
    const result = calculateFragility({ utilization: 10, tvlUsd: 1_000_000, netFlow24h: -300_000 });
    expect(result.level).toBe('high');
    expect(result.reason).toBe('Large outflow (-30.0% in 24h)');
  });

  it('surfaces both MEDIUM conditions when both fire simultaneously', () => {
    // utilization > 30 AND netFlow24hPct < -10
    const result = calculateFragility({ utilization: 45, tvlUsd: 1_000_000, netFlow24h: -150_000 });
    expect(result.level).toBe('medium');
    expect(result.reason).toMatch(/utilization/i);
    expect(result.reason).toMatch(/outflow/i);
    expect(result.reason).toContain('; ');
  });
});

// ---------------------------------------------------------------------------
// Guard: NaN / Infinity inputs
// ---------------------------------------------------------------------------

describe('calculateFragility – NaN/Infinity guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns HIGH (fail-safe) when utilization is NaN', () => {
    const result = calculateFragility({ utilization: NaN, tvlUsd: 1_000_000, netFlow24h: 0 });
    expect(result.level).toBe('high');
    expect(result.reason).toMatch(/data integrity/i);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns HIGH (fail-safe) when tvlUsd is Infinity', () => {
    const result = calculateFragility({ utilization: 50, tvlUsd: Infinity, netFlow24h: 0 });
    expect(result.level).toBe('high');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns HIGH (fail-safe) when netFlow24h is NaN', () => {
    const result = calculateFragility({ utilization: 50, tvlUsd: 1_000_000, netFlow24h: NaN });
    expect(result.level).toBe('high');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guard: zero TVL
// ---------------------------------------------------------------------------

describe('calculateFragility – zero TVL guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns HIGH (fail-safe) when tvlUsd is 0', () => {
    const result = calculateFragility({ utilization: 10, tvlUsd: 0, netFlow24h: -50_000 });
    expect(result.level).toBe('high');
    expect(result.reason).toBe('Zero TVL detected');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns HIGH (fail-safe) when tvlUsd is negative', () => {
    const result = calculateFragility({ utilization: 25, tvlUsd: -500_000, netFlow24h: -100_000 });
    expect(result.level).toBe('high');
    expect(result.reason).toContain('Zero TVL');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('logs a warning when tvlUsd is 0', () => {
    calculateFragility({ utilization: 0, tvlUsd: 0, netFlow24h: 0 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Fragility]'),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Guard: utilization out of range (clamping)
// ---------------------------------------------------------------------------

describe('calculateFragility – utilization clamping', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('clamps negative utilization to 0 and returns LOW for otherwise stable inputs', () => {
    const result = calculateFragility({ utilization: -10, tvlUsd: 1_000_000, netFlow24h: 0 });
    expect(result.utilization).toBe(0);
    expect(result.level).toBe('low');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('clamps utilization > 100 to 100 and returns HIGH', () => {
    const result = calculateFragility({ utilization: 150, tvlUsd: 1_000_000, netFlow24h: 0 });
    expect(result.utilization).toBe(100);
    expect(result.level).toBe('high');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Constants alignment
// ---------------------------------------------------------------------------

describe('calculateFragility – thresholds match FRAGILITY_THRESHOLDS constants', () => {
  it('HIGH_UTILIZATION threshold is 60', () => {
    expect(FRAGILITY_THRESHOLDS.HIGH_UTILIZATION).toBe(60);
  });

  it('HIGH_OUTFLOW threshold is -20', () => {
    expect(FRAGILITY_THRESHOLDS.HIGH_OUTFLOW).toBe(-20);
  });

  it('MEDIUM_UTILIZATION threshold is 30', () => {
    expect(FRAGILITY_THRESHOLDS.MEDIUM_UTILIZATION).toBe(30);
  });

  it('MEDIUM_OUTFLOW threshold is -10', () => {
    expect(FRAGILITY_THRESHOLDS.MEDIUM_OUTFLOW).toBe(-10);
  });
});
