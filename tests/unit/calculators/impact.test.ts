import { calculateImpact, IMPACT_DISCLAIMER } from '../../../src/calculators/impact';
import { IMPACT_THRESHOLDS, SLIPPAGE_FACTORS } from '../../../src/lib/constants';

// ---------------------------------------------------------------------------
// Spec examples — docs/DATA-MODEL.md §8.6
// ---------------------------------------------------------------------------

describe('calculateImpact – spec examples', () => {
  it('$50K / $10M / across → 0.5% share, 0.25 bps, negligible', () => {
    const result = calculateImpact({
      transferAmountUsd: 50_000,
      poolTvlUsd: 10_000_000,
      bridge: 'across',
    });
    expect(result.poolSharePct).toBe(0.5);
    expect(result.estimatedSlippageBps).toBe(0.25);
    expect(result.impactLevel).toBe('negligible');
    expect(result.warning).toBeNull();
  });

  it('$500K / $10M / across → 5% share, 2.5 bps, moderate', () => {
    const result = calculateImpact({
      transferAmountUsd: 500_000,
      poolTvlUsd: 10_000_000,
      bridge: 'across',
    });
    expect(result.poolSharePct).toBe(5);
    expect(result.estimatedSlippageBps).toBe(2.5);
    expect(result.impactLevel).toBe('moderate');
    expect(result.warning).toBe('Your transfer is 5.00% of pool liquidity');
  });

  it('$500K / $10M / stargate → 5% share, 5.0 bps, moderate', () => {
    const result = calculateImpact({
      transferAmountUsd: 500_000,
      poolTvlUsd: 10_000_000,
      bridge: 'stargate',
    });
    expect(result.poolSharePct).toBe(5);
    expect(result.estimatedSlippageBps).toBe(5);
    expect(result.impactLevel).toBe('moderate');
  });

  it('$3M / $10M / across → 30% share, 15.0 bps, severe', () => {
    const result = calculateImpact({
      transferAmountUsd: 3_000_000,
      poolTvlUsd: 10_000_000,
      bridge: 'across',
    });
    expect(result.poolSharePct).toBe(30);
    expect(result.estimatedSlippageBps).toBe(15);
    expect(result.impactLevel).toBe('severe');
  });

  it('$1M / $10M / cctp → 10% share, 0 bps, moderate (burn/mint: no slippage)', () => {
    const result = calculateImpact({
      transferAmountUsd: 1_000_000,
      poolTvlUsd: 10_000_000,
      bridge: 'cctp',
    });
    expect(result.poolSharePct).toBe(10);
    expect(result.estimatedSlippageBps).toBe(0);
    expect(result.impactLevel).toBe('moderate');
    expect(result.warning).toBe('Your transfer is 10.00% of pool liquidity');
  });
});

// ---------------------------------------------------------------------------
// API spec example — docs/API-SPEC.md §GET /api/impact/estimate
// ---------------------------------------------------------------------------

describe('calculateImpact – API spec example', () => {
  it('$5M / $85M / across → poolSharePct ~5.88%, slippageBps ~2.94, moderate', () => {
    // 5000000/85000000 × 100 = 5.882352941...  (full precision — callers round for display)
    // × 0.5 (across factor) = 2.941176470...
    const result = calculateImpact({
      transferAmountUsd: 5_000_000,
      poolTvlUsd: 85_000_000,
      bridge: 'across',
    });
    expect(result.poolSharePct).toBeCloseTo(5.8824, 4);
    expect(result.estimatedSlippageBps).toBeCloseTo(2.9412, 4);
    expect(result.impactLevel).toBe('moderate');
    // warning text is built with toFixed(2) on the raw value, so it reads "5.88"
    expect(result.warning).toBe('Your transfer is 5.88% of pool liquidity');
  });
});

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

describe('calculateImpact – return shape', () => {
  it('always returns all four fields', () => {
    const result = calculateImpact({
      transferAmountUsd: 100_000,
      poolTvlUsd: 5_000_000,
      bridge: 'across',
    });
    expect(result).toHaveProperty('poolSharePct');
    expect(result).toHaveProperty('estimatedSlippageBps');
    expect(result).toHaveProperty('impactLevel');
    expect(result).toHaveProperty('warning');
  });
});

// ---------------------------------------------------------------------------
// Impact level thresholds — boundary conditions
// ---------------------------------------------------------------------------

describe('calculateImpact – negligible / low boundary', () => {
  it('returns negligible when poolSharePct is just below 1%', () => {
    // $99.99 of $10,000 → 0.9999%
    const result = calculateImpact({ transferAmountUsd: 99.99, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.impactLevel).toBe('negligible');
    expect(result.warning).toBeNull();
  });

  it('returns low when poolSharePct is exactly 1%', () => {
    const result = calculateImpact({ transferAmountUsd: 100, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.impactLevel).toBe('low');
    expect(result.warning).toBeNull();
  });
});

describe('calculateImpact – low / moderate boundary', () => {
  it('returns low when poolSharePct is just below 5%', () => {
    // $499.99 of $10,000 → 4.9999%
    const result = calculateImpact({ transferAmountUsd: 499.99, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.impactLevel).toBe('low');
    expect(result.warning).toBeNull();
  });

  it('returns moderate when poolSharePct is exactly 5%', () => {
    const result = calculateImpact({ transferAmountUsd: 500, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.impactLevel).toBe('moderate');
    expect(result.warning).not.toBeNull();
  });
});

describe('calculateImpact – moderate / high boundary', () => {
  it('returns moderate when poolSharePct is just below 15%', () => {
    // $1,499.99 of $10,000 → 14.9999%
    const result = calculateImpact({ transferAmountUsd: 1_499.99, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.impactLevel).toBe('moderate');
  });

  it('returns high when poolSharePct is exactly 15%', () => {
    const result = calculateImpact({ transferAmountUsd: 1_500, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.impactLevel).toBe('high');
    expect(result.warning).toContain('Consider splitting');
  });
});

describe('calculateImpact – high / severe boundary', () => {
  it('returns high when poolSharePct is just below 30%', () => {
    // $2,999.99 of $10,000 → 29.9999%
    const result = calculateImpact({ transferAmountUsd: 2_999.99, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.impactLevel).toBe('high');
  });

  it('returns severe when poolSharePct is exactly 30%', () => {
    const result = calculateImpact({ transferAmountUsd: 3_000, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.impactLevel).toBe('severe');
    expect(result.warning).toContain('Split recommended');
  });
});

// ---------------------------------------------------------------------------
// Warning strings — format and content
// ---------------------------------------------------------------------------

describe('calculateImpact – warning strings', () => {
  it('moderate warning uses toFixed(2) precision', () => {
    // 5.882352...% → "5.88%"
    const result = calculateImpact({
      transferAmountUsd: 5_000_000,
      poolTvlUsd: 85_000_000,
      bridge: 'across',
    });
    expect(result.warning).toBe('Your transfer is 5.88% of pool liquidity');
  });

  it('high warning uses toFixed(2) precision and correct template', () => {
    // $1,750 of $10,000 = 17.5%
    const result = calculateImpact({ transferAmountUsd: 1_750, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.warning).toBe('Large transfer: 17.50% of pool. Consider splitting.');
  });

  it('severe warning uses toFixed(2) precision and correct template', () => {
    // $4,000 of $10,000 = 40%
    const result = calculateImpact({ transferAmountUsd: 4_000, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.warning).toBe('Transfer exceeds safe threshold (40.00% of pool). Split recommended.');
  });

  it('negligible and low levels produce null warning', () => {
    const negligible = calculateImpact({ transferAmountUsd: 50, poolTvlUsd: 10_000, bridge: 'across' });
    const low = calculateImpact({ transferAmountUsd: 200, poolTvlUsd: 10_000, bridge: 'across' });
    expect(negligible.warning).toBeNull();
    expect(low.warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slippage formula: poolSharePct × slippageFactor (no × 10)
// ---------------------------------------------------------------------------

describe('calculateImpact – slippage formula per bridge', () => {
  it('across (0.5): 10% pool share → 5.0 bps', () => {
    const result = calculateImpact({ transferAmountUsd: 1_000, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.poolSharePct).toBe(10);
    expect(result.estimatedSlippageBps).toBe(5);
  });

  it('stargate (1.0): 10% pool share → 10.0 bps', () => {
    const result = calculateImpact({ transferAmountUsd: 1_000, poolTvlUsd: 10_000, bridge: 'stargate' });
    expect(result.poolSharePct).toBe(10);
    expect(result.estimatedSlippageBps).toBe(10);
  });

  it('cctp (0.0): any pool share → 0 bps', () => {
    const result = calculateImpact({ transferAmountUsd: 1_000, poolTvlUsd: 10_000, bridge: 'cctp' });
    expect(result.poolSharePct).toBe(10);
    expect(result.estimatedSlippageBps).toBe(0);
  });

  it('unknown bridge falls back to factor 1.0: 10% pool share → 10.0 bps', () => {
    // Simulates a runtime cast bypassing the type (e.g. new bridge added before constants updated)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = calculateImpact({ transferAmountUsd: 1_000, poolTvlUsd: 10_000, bridge: 'unknown-bridge' as any });
    expect(result.estimatedSlippageBps).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Full precision — docs/DATA-MODEL.md §14 (rounding applied by callers)
// ---------------------------------------------------------------------------

describe('calculateImpact – full precision output', () => {
  it('poolSharePct is full precision (callers apply display rounding)', () => {
    // 5000000 / 85000000 * 100 = 5.882352941... — NOT rounded here
    const result = calculateImpact({
      transferAmountUsd: 5_000_000,
      poolTvlUsd: 85_000_000,
      bridge: 'cctp',
    });
    expect(result.poolSharePct).toBeCloseTo(5.8824, 4);
    expect(Number.isFinite(result.poolSharePct)).toBe(true);
  });

  it('estimatedSlippageBps is full precision (callers apply display rounding)', () => {
    // poolSharePct = 5.882352... × 0.5 (across) = 2.941176... — NOT rounded here
    const result = calculateImpact({
      transferAmountUsd: 5_000_000,
      poolTvlUsd: 85_000_000,
      bridge: 'across',
    });
    expect(result.estimatedSlippageBps).toBeCloseTo(2.9412, 4);
    expect(Number.isFinite(result.estimatedSlippageBps)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard: NaN / Infinity inputs
// ---------------------------------------------------------------------------

describe('calculateImpact – NaN/Infinity guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns severe (fail-safe) when transferAmountUsd is NaN', () => {
    const result = calculateImpact({ transferAmountUsd: NaN, poolTvlUsd: 10_000_000, bridge: 'across' });
    expect(result.impactLevel).toBe('severe');
    expect(result.poolSharePct).toBe(100);
    expect(result.estimatedSlippageBps).toBe(50); // 100 × across factor (0.5)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Impact]'),
      expect.anything(),
    );
  });

  it('returns severe (fail-safe) when poolTvlUsd is Infinity', () => {
    const result = calculateImpact({ transferAmountUsd: 1_000, poolTvlUsd: Infinity, bridge: 'across' });
    expect(result.impactLevel).toBe('severe');
    expect(result.estimatedSlippageBps).toBe(50); // 100 × across factor (0.5)
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns severe (fail-safe) when transferAmountUsd is Infinity', () => {
    const result = calculateImpact({ transferAmountUsd: Infinity, poolTvlUsd: 10_000_000, bridge: 'across' });
    expect(result.impactLevel).toBe('severe');
    expect(result.estimatedSlippageBps).toBe(50); // 100 × across factor (0.5)
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns severe (fail-safe) when poolTvlUsd is NaN', () => {
    const result = calculateImpact({ transferAmountUsd: 1_000, poolTvlUsd: NaN, bridge: 'across' });
    expect(result.impactLevel).toBe('severe');
    expect(result.estimatedSlippageBps).toBe(50); // 100 × across factor (0.5)
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('cctp NaN fail-safe returns 0 bps (burn/mint: no slippage)', () => {
    const result = calculateImpact({ transferAmountUsd: NaN, poolTvlUsd: 10_000_000, bridge: 'cctp' });
    expect(result.impactLevel).toBe('severe');
    expect(result.estimatedSlippageBps).toBe(0); // 100 × cctp factor (0.0)
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guard: zero / negative poolTvlUsd
// ---------------------------------------------------------------------------

describe('calculateImpact – zero/negative poolTvlUsd guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns severe with poolSharePct=100 when poolTvlUsd is 0', () => {
    const result = calculateImpact({ transferAmountUsd: 500_000, poolTvlUsd: 0, bridge: 'across' });
    expect(result.poolSharePct).toBe(100);
    expect(result.estimatedSlippageBps).toBe(50); // 100 × across factor (0.5)
    expect(result.impactLevel).toBe('severe');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Impact]'),
      expect.anything(),
    );
  });

  it('returns severe with poolSharePct=100 when poolTvlUsd is negative', () => {
    const result = calculateImpact({ transferAmountUsd: 500_000, poolTvlUsd: -1_000_000, bridge: 'across' });
    expect(result.poolSharePct).toBe(100);
    expect(result.estimatedSlippageBps).toBe(50); // 100 × across factor (0.5)
    expect(result.impactLevel).toBe('severe');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guard: zero / negative transferAmountUsd
// ---------------------------------------------------------------------------

describe('calculateImpact – zero/negative transferAmountUsd guard', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns negligible with 0 bps when transferAmountUsd is 0', () => {
    const result = calculateImpact({ transferAmountUsd: 0, poolTvlUsd: 10_000_000, bridge: 'across' });
    expect(result.poolSharePct).toBe(0);
    expect(result.estimatedSlippageBps).toBe(0);
    expect(result.impactLevel).toBe('negligible');
    expect(result.warning).toBeNull();
  });

  it('returns negligible (fail-safe) and logs warn when transferAmountUsd is negative', () => {
    const result = calculateImpact({ transferAmountUsd: -500_000, poolTvlUsd: 10_000_000, bridge: 'across' });
    expect(result.impactLevel).toBe('negligible');
    expect(result.poolSharePct).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Impact]'),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// Transfer exceeds pool TVL (> 100% pool share)
// ---------------------------------------------------------------------------

describe('calculateImpact – transfer exceeds pool TVL', () => {
  it('returns severe and computes slippage beyond 100% when transfer is 2× pool TVL', () => {
    // $20,000 / $10,000 = 200% pool share; slippage = 200 × 0.5 = 100 bps
    const result = calculateImpact({ transferAmountUsd: 20_000, poolTvlUsd: 10_000, bridge: 'across' });
    expect(result.poolSharePct).toBe(200);
    expect(result.estimatedSlippageBps).toBe(100);
    expect(result.impactLevel).toBe('severe');
    expect(result.warning).toContain('Split recommended');
  });

  it('stargate at 150% pool share → 150 bps', () => {
    // $15,000 / $10,000 = 150%; slippage = 150 × 1.0 = 150 bps
    const result = calculateImpact({ transferAmountUsd: 15_000, poolTvlUsd: 10_000, bridge: 'stargate' });
    expect(result.poolSharePct).toBe(150);
    expect(result.estimatedSlippageBps).toBe(150);
    expect(result.impactLevel).toBe('severe');
  });
});

// ---------------------------------------------------------------------------
// IMPACT_DISCLAIMER export
// ---------------------------------------------------------------------------

describe('IMPACT_DISCLAIMER', () => {
  it('exports the required disclaimer string', () => {
    expect(IMPACT_DISCLAIMER).toBe('Directional estimate only. Not an execution guarantee.');
  });
});

// ---------------------------------------------------------------------------
// Constants alignment — IMPACT_THRESHOLDS
// ---------------------------------------------------------------------------

describe('calculateImpact – thresholds match IMPACT_THRESHOLDS constants', () => {
  it('NEGLIGIBLE threshold is 1', () => {
    expect(IMPACT_THRESHOLDS.NEGLIGIBLE).toBe(1);
  });

  it('LOW threshold is 5', () => {
    expect(IMPACT_THRESHOLDS.LOW).toBe(5);
  });

  it('MODERATE threshold is 15', () => {
    expect(IMPACT_THRESHOLDS.MODERATE).toBe(15);
  });

  it('HIGH threshold is 30', () => {
    expect(IMPACT_THRESHOLDS.HIGH).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Constants alignment — SLIPPAGE_FACTORS
// ---------------------------------------------------------------------------

describe('calculateImpact – SLIPPAGE_FACTORS constants', () => {
  it('across factor is 0.5', () => {
    expect(SLIPPAGE_FACTORS.across).toBe(0.5);
  });

  it('cctp factor is 0.0', () => {
    expect(SLIPPAGE_FACTORS.cctp).toBe(0);
  });

  it('stargate factor is 1.0', () => {
    expect(SLIPPAGE_FACTORS.stargate).toBe(1.0);
  });
});
