import { calculateLFV, interpretLFV } from '../../../src/calculators/lfv';
import { LFV_THRESHOLDS } from '../../../src/lib/constants';

// ---------------------------------------------------------------------------
// Spec examples — docs/DATA-MODEL.md §9 (§7.7)
//
// Note: The Optimism row was corrected from 'moderate_inflow' to 'rapid_inflow'.
// +10% exactly equals the RAPID_INFLOW threshold (0.10), which is NOT strictly
// less than 0.10, so it flips into rapid_inflow. See §7.5 for the code definition.
// ---------------------------------------------------------------------------

describe('calculateLFV – spec examples (DATA-MODEL.md §9, §7.7)', () => {
  it('Ethereum: $100M → $102M over 24h → +2% → stable', () => {
    const result = calculateLFV({
      chain: 'ethereum',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 102_000_000,
      timeWindowHours: 24,
      poolsMonitored: 5,
    });
    expect(result.lfv24h).toBeCloseTo(0.02);
    expect(result.interpretation).toBe('stable');
    expect(result.netFlowUsd).toBe(2_000_000);
    expect(result.tvlStartUsd).toBe(100_000_000);
    expect(result.tvlNowUsd).toBe(102_000_000);
  });

  it('Base: $50M → $42M over 24h → -16% → rapid_flight', () => {
    const result = calculateLFV({
      chain: 'base',
      tvlStartUsd: 50_000_000,
      tvlNowUsd: 42_000_000,
      timeWindowHours: 24,
      poolsMonitored: 3,
    });
    expect(result.lfv24h).toBeCloseTo(-0.16);
    expect(result.interpretation).toBe('rapid_flight');
    expect(result.netFlowUsd).toBe(-8_000_000);
  });

  it('Arbitrum: $80M → $76M over 24h → -5% → moderate_outflow', () => {
    const result = calculateLFV({
      chain: 'arbitrum',
      tvlStartUsd: 80_000_000,
      tvlNowUsd: 76_000_000,
      timeWindowHours: 24,
      poolsMonitored: 4,
    });
    expect(result.lfv24h).toBeCloseTo(-0.05);
    expect(result.interpretation).toBe('moderate_outflow');
    expect(result.netFlowUsd).toBe(-4_000_000);
  });

  it('Optimism: $60M → $66M over 24h → +10% → rapid_inflow (corrected from spec table)', () => {
    // +10% is exactly at the RAPID_INFLOW threshold (0.10).
    // The code uses strict less-than: lfv24h < 0.10 → moderate_inflow.
    // 0.10 is NOT < 0.10, so it falls through to rapid_inflow.
    const result = calculateLFV({
      chain: 'optimism',
      tvlStartUsd: 60_000_000,
      tvlNowUsd: 66_000_000,
      timeWindowHours: 24,
      poolsMonitored: 4,
    });
    expect(result.lfv24h).toBeCloseTo(0.10);
    expect(result.interpretation).toBe('rapid_inflow');
    expect(result.netFlowUsd).toBe(6_000_000);
  });
});

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

describe('calculateLFV – return shape', () => {
  it('always returns all eight required fields', () => {
    const result = calculateLFV({
      chain: 'ethereum',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 103_000_000,
      timeWindowHours: 24,
      poolsMonitored: 4,
    });
    expect(result).toHaveProperty('chain');
    expect(result).toHaveProperty('lfv24h');
    expect(result).toHaveProperty('lfvAnnualized');
    expect(result).toHaveProperty('interpretation');
    expect(result).toHaveProperty('netFlowUsd');
    expect(result).toHaveProperty('tvlStartUsd');
    expect(result).toHaveProperty('tvlNowUsd');
    expect(result).toHaveProperty('poolsMonitored');
  });

  it('echoes chain and poolsMonitored from input', () => {
    const result = calculateLFV({
      chain: 'polygon',
      tvlStartUsd: 10_000_000,
      tvlNowUsd: 10_500_000,
      timeWindowHours: 24,
      poolsMonitored: 7,
    });
    expect(result.chain).toBe('polygon');
    expect(result.poolsMonitored).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Formula correctness
// ---------------------------------------------------------------------------

describe('calculateLFV – formula correctness', () => {
  it('lfvAnnualized = lfv24h × 365', () => {
    const result = calculateLFV({
      chain: 'ethereum',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 102_000_000,
      timeWindowHours: 24,
      poolsMonitored: 5,
    });
    // lfv24h = 0.02; lfvAnnualized = 0.02 × 365 = 7.3
    expect(result.lfvAnnualized).toBeCloseTo(result.lfv24h * 365);
  });

  it('netFlowUsd = tvlNowUsd − tvlStartUsd (negative for outflow)', () => {
    const result = calculateLFV({
      chain: 'base',
      tvlStartUsd: 50_000_000,
      tvlNowUsd: 42_000_000,
      timeWindowHours: 24,
      poolsMonitored: 3,
    });
    expect(result.netFlowUsd).toBe(42_000_000 - 50_000_000);
  });

  it('tvlStartUsd and tvlNowUsd are echoed exactly', () => {
    const result = calculateLFV({
      chain: 'arbitrum',
      tvlStartUsd: 80_000_000,
      tvlNowUsd: 76_000_000,
      timeWindowHours: 24,
      poolsMonitored: 4,
    });
    expect(result.tvlStartUsd).toBe(80_000_000);
    expect(result.tvlNowUsd).toBe(76_000_000);
  });
});

// ---------------------------------------------------------------------------
// Time-window normalization
// ---------------------------------------------------------------------------

describe('calculateLFV – time-window normalization', () => {
  it('12h window with 6% raw drop normalizes to -12% lfv24h → rapid_flight', () => {
    // tvlStart=100M, tvlNow=94M → netFlow=-6M → lfv=-0.06 → lfv24h=-0.06×(24/12)=-0.12
    const result = calculateLFV({
      chain: 'base',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 94_000_000,
      timeWindowHours: 12,
      poolsMonitored: 3,
    });
    expect(result.lfv24h).toBeCloseTo(-0.12);
    expect(result.interpretation).toBe('rapid_flight');
  });

  it('48h window with 4% raw drop normalizes to -2% lfv24h → stable', () => {
    // tvlStart=100M, tvlNow=96M → lfv=-0.04 → lfv24h=-0.04×(24/48)=-0.02
    const result = calculateLFV({
      chain: 'ethereum',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 96_000_000,
      timeWindowHours: 48,
      poolsMonitored: 5,
    });
    expect(result.lfv24h).toBeCloseTo(-0.02);
    expect(result.interpretation).toBe('stable');
  });

  it('1h window with 0.5% raw drop normalizes to -12% lfv24h → rapid_flight', () => {
    // tvlStart=100M, tvlNow=99.5M → lfv=-0.005 → lfv24h=-0.005×24=-0.12
    const result = calculateLFV({
      chain: 'base',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 99_500_000,
      timeWindowHours: 1,
      poolsMonitored: 2,
    });
    expect(result.lfv24h).toBeCloseTo(-0.12);
    expect(result.interpretation).toBe('rapid_flight');
  });
});

// ---------------------------------------------------------------------------
// interpretLFV – boundary conditions (strict less-than)
// ---------------------------------------------------------------------------

describe('interpretLFV – rapid_flight / moderate_outflow boundary (−10%)', () => {
  it('returns rapid_flight when lfv24h is just below −10%', () => {
    expect(interpretLFV(-0.1001)).toBe('rapid_flight');
  });

  it('returns moderate_outflow when lfv24h is exactly −10%', () => {
    // −0.10 is NOT < −0.10, so it does NOT return rapid_flight
    expect(interpretLFV(-0.10)).toBe('moderate_outflow');
  });

  it('returns moderate_outflow just above −10%', () => {
    expect(interpretLFV(-0.0999)).toBe('moderate_outflow');
  });
});

describe('interpretLFV – moderate_outflow / stable boundary (−3%)', () => {
  it('returns moderate_outflow when lfv24h is just below −3%', () => {
    expect(interpretLFV(-0.0301)).toBe('moderate_outflow');
  });

  it('returns stable when lfv24h is exactly −3%', () => {
    // −0.03 is NOT < −0.03, so it falls through to stable
    expect(interpretLFV(-0.03)).toBe('stable');
  });

  it('returns stable just above −3%', () => {
    expect(interpretLFV(-0.0299)).toBe('stable');
  });
});

describe('interpretLFV – stable / moderate_inflow boundary (+3%)', () => {
  it('returns stable when lfv24h is just below +3%', () => {
    expect(interpretLFV(0.0299)).toBe('stable');
  });

  it('returns moderate_inflow when lfv24h is exactly +3%', () => {
    // +0.03 is NOT < +0.03 (MODERATE_INFLOW), falls through to moderate_inflow check
    expect(interpretLFV(0.03)).toBe('moderate_inflow');
  });

  it('returns moderate_inflow just above +3%', () => {
    expect(interpretLFV(0.0301)).toBe('moderate_inflow');
  });
});

describe('interpretLFV – moderate_inflow / rapid_inflow boundary (+10%)', () => {
  it('returns moderate_inflow when lfv24h is just below +10%', () => {
    expect(interpretLFV(0.0999)).toBe('moderate_inflow');
  });

  it('returns rapid_inflow when lfv24h is exactly +10%', () => {
    // +0.10 is NOT < +0.10 (RAPID_INFLOW), so it falls through to rapid_inflow.
    // This is the corrected behavior — the spec example table erroneously showed
    // moderate_inflow for +10%.
    expect(interpretLFV(0.10)).toBe('rapid_inflow');
  });

  it('returns rapid_inflow just above +10%', () => {
    expect(interpretLFV(0.1001)).toBe('rapid_inflow');
  });
});

// ---------------------------------------------------------------------------
// calculateLFV – threshold boundaries via round-trip inputs
// ---------------------------------------------------------------------------

describe('calculateLFV – threshold round-trips', () => {
  it('exactly −10% lfv24h → moderate_outflow', () => {
    // tvlStart=100M, tvlNow=90M → lfv=-0.10 → lfv24h=-0.10 (24h window)
    const result = calculateLFV({
      chain: 'base',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 90_000_000,
      timeWindowHours: 24,
      poolsMonitored: 3,
    });
    expect(result.lfv24h).toBeCloseTo(-0.10);
    expect(result.interpretation).toBe('moderate_outflow');
  });

  it('exactly +10% lfv24h → rapid_inflow', () => {
    const result = calculateLFV({
      chain: 'optimism',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 110_000_000,
      timeWindowHours: 24,
      poolsMonitored: 4,
    });
    expect(result.lfv24h).toBeCloseTo(0.10);
    expect(result.interpretation).toBe('rapid_inflow');
  });

  it('exactly −3% lfv24h → stable', () => {
    const result = calculateLFV({
      chain: 'arbitrum',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 97_000_000,
      timeWindowHours: 24,
      poolsMonitored: 2,
    });
    expect(result.lfv24h).toBeCloseTo(-0.03);
    expect(result.interpretation).toBe('stable');
  });

  it('exactly +3% lfv24h → moderate_inflow', () => {
    const result = calculateLFV({
      chain: 'ethereum',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 103_000_000,
      timeWindowHours: 24,
      poolsMonitored: 5,
    });
    expect(result.lfv24h).toBeCloseTo(0.03);
    expect(result.interpretation).toBe('moderate_inflow');
  });
});

// ---------------------------------------------------------------------------
// Guard: NaN / Infinity inputs
// ---------------------------------------------------------------------------

describe('calculateLFV – NaN/Infinity guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns stable zero when tvlStartUsd is NaN', () => {
    const result = calculateLFV({
      chain: 'base',
      tvlStartUsd: NaN,
      tvlNowUsd: 42_000_000,
      timeWindowHours: 24,
      poolsMonitored: 3,
    });
    expect(result.lfv24h).toBe(0);
    expect(result.lfvAnnualized).toBe(0);
    expect(result.interpretation).toBe('stable');
    expect(result.netFlowUsd).toBe(0);
    expect(result.tvlStartUsd).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[LFV]'),
      expect.anything(),
    );
  });

  it('returns stable zero when tvlNowUsd is Infinity', () => {
    const result = calculateLFV({
      chain: 'ethereum',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: Infinity,
      timeWindowHours: 24,
      poolsMonitored: 5,
    });
    expect(result.lfv24h).toBe(0);
    expect(result.interpretation).toBe('stable');
    // tvlNowUsd was Infinity — clamped to 0 in buildStableZero
    expect(result.tvlNowUsd).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns stable zero when timeWindowHours is NaN', () => {
    const result = calculateLFV({
      chain: 'arbitrum',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 96_000_000,
      timeWindowHours: NaN,
      poolsMonitored: 4,
    });
    expect(result.lfv24h).toBe(0);
    expect(result.interpretation).toBe('stable');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns stable zero when poolsMonitored is Infinity', () => {
    const result = calculateLFV({
      chain: 'ethereum',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 102_000_000,
      timeWindowHours: 24,
      poolsMonitored: Infinity,
    });
    expect(result.lfv24h).toBe(0);
    expect(result.interpretation).toBe('stable');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guard: zero / negative timeWindowHours
// ---------------------------------------------------------------------------

describe('calculateLFV – invalid timeWindowHours guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns stable zero when timeWindowHours is 0', () => {
    const result = calculateLFV({
      chain: 'base',
      tvlStartUsd: 50_000_000,
      tvlNowUsd: 42_000_000,
      timeWindowHours: 0,
      poolsMonitored: 3,
    });
    expect(result.lfv24h).toBe(0);
    expect(result.interpretation).toBe('stable');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[LFV]'),
      expect.anything(),
    );
  });

  it('returns stable zero when timeWindowHours is negative', () => {
    const result = calculateLFV({
      chain: 'base',
      tvlStartUsd: 50_000_000,
      tvlNowUsd: 42_000_000,
      timeWindowHours: -6,
      poolsMonitored: 3,
    });
    expect(result.lfv24h).toBe(0);
    expect(result.interpretation).toBe('stable');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guard: zero / negative tvlStartUsd (spec §9, §7.3)
// ---------------------------------------------------------------------------

describe('calculateLFV – zero/negative tvlStartUsd guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns stable zero when tvlStartUsd is 0 (spec §9 base case)', () => {
    const result = calculateLFV({
      chain: 'base',
      tvlStartUsd: 0,
      tvlNowUsd: 5_000_000,
      timeWindowHours: 24,
      poolsMonitored: 2,
    });
    expect(result.lfv24h).toBe(0);
    expect(result.lfvAnnualized).toBe(0);
    expect(result.interpretation).toBe('stable');
    expect(result.netFlowUsd).toBe(0);
    expect(result.tvlStartUsd).toBe(0);
    // tvlNowUsd passes through so caller can see current state
    expect(result.tvlNowUsd).toBe(5_000_000);
    // No warn for the spec-defined zero case
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns stable zero AND warns when tvlStartUsd is negative', () => {
    const result = calculateLFV({
      chain: 'ethereum',
      tvlStartUsd: -10_000_000,
      tvlNowUsd: 90_000_000,
      timeWindowHours: 24,
      poolsMonitored: 5,
    });
    expect(result.lfv24h).toBe(0);
    expect(result.interpretation).toBe('stable');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[LFV]'),
      expect.anything(),
    );
  });

  it('passes tvlNowUsd through when tvlStartUsd is 0', () => {
    const result = calculateLFV({
      chain: 'arbitrum',
      tvlStartUsd: 0,
      tvlNowUsd: 25_000_000,
      timeWindowHours: 24,
      poolsMonitored: 3,
    });
    expect(result.tvlNowUsd).toBe(25_000_000);
  });
});

// ---------------------------------------------------------------------------
// buildStableZero – NaN tvlNowUsd is clamped to 0
// ---------------------------------------------------------------------------

describe('calculateLFV – NaN tvlNowUsd clamped in stable zero result', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('clamps NaN tvlNowUsd to 0 in the result when NaN guard fires', () => {
    const result = calculateLFV({
      chain: 'base',
      tvlStartUsd: NaN,
      tvlNowUsd: NaN,
      timeWindowHours: 24,
      poolsMonitored: 3,
    });
    expect(result.tvlNowUsd).toBe(0);
    expect(result.poolsMonitored).toBe(3); // number is finite
  });
});

// ---------------------------------------------------------------------------
// Stable range: zero net flow
// ---------------------------------------------------------------------------

describe('calculateLFV – zero net flow', () => {
  it('returns stable with lfv24h=0 when tvlNow equals tvlStart', () => {
    const result = calculateLFV({
      chain: 'ethereum',
      tvlStartUsd: 100_000_000,
      tvlNowUsd: 100_000_000,
      timeWindowHours: 24,
      poolsMonitored: 5,
    });
    expect(result.lfv24h).toBe(0);
    expect(result.lfvAnnualized).toBe(0);
    expect(result.netFlowUsd).toBe(0);
    expect(result.interpretation).toBe('stable');
  });
});

// ---------------------------------------------------------------------------
// Constants alignment
// ---------------------------------------------------------------------------

describe('LFV_THRESHOLDS – constants values match spec §9 (§7.5)', () => {
  it('RAPID_FLIGHT is -0.10', () => {
    expect(LFV_THRESHOLDS.RAPID_FLIGHT).toBe(-0.10);
  });

  it('MODERATE_OUTFLOW is -0.03', () => {
    expect(LFV_THRESHOLDS.MODERATE_OUTFLOW).toBe(-0.03);
  });

  it('MODERATE_INFLOW is +0.03', () => {
    expect(LFV_THRESHOLDS.MODERATE_INFLOW).toBe(0.03);
  });

  it('RAPID_INFLOW is +0.10', () => {
    expect(LFV_THRESHOLDS.RAPID_INFLOW).toBe(0.10);
  });
});
