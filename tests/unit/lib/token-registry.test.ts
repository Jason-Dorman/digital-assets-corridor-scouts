/**
 * Tests for src/lib/token-registry.ts
 *
 * Verifies address-to-token resolution, fallback behaviour, rawSymbol handling,
 * and amount normalisation across all supported chains.
 */

import {
  getTokenInfo,
  getSymbol,
  getRawSymbol,
  getDecimals,
  normalizeAmount,
} from '../../../src/lib/token-registry';

// ---------------------------------------------------------------------------
// getTokenInfo
// ---------------------------------------------------------------------------

describe('getTokenInfo', () => {
  it('returns correct info for a known Ethereum USDC address', () => {
    const info = getTokenInfo(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(info).toEqual({ symbol: 'USDC', decimals: 6 });
  });

  it('returns correct info for a known Arbitrum WETH address', () => {
    const info = getTokenInfo(42161, '0x82af49447d8a07e3bd95bd0d56f35241523fbab1');
    expect(info).toEqual({ symbol: 'WETH', decimals: 18 });
  });

  it('includes rawSymbol for tokens with a differing on-chain symbol', () => {
    // Avalanche Bridge DAI — on-chain symbol is 'DAI.e'
    const info = getTokenInfo(43114, '0xd586e7f844cea2f87f50152665bcbc2c279d8d70');
    expect(info).toEqual({ symbol: 'DAI', rawSymbol: 'DAI.e', decimals: 18 });
  });

  it('includes rawSymbol for Polygon USDT (on-chain: USDT0)', () => {
    const info = getTokenInfo(137, '0xc2132d05d31c914a87c6611c10748aeb04b58e8f');
    expect(info).toEqual({ symbol: 'USDT', rawSymbol: 'USDT0', decimals: 6 });
  });

  it('omits rawSymbol when on-chain symbol matches canonical', () => {
    const info = getTokenInfo(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(info?.rawSymbol).toBeUndefined();
  });

  it('is case-insensitive for token addresses', () => {
    const lower = getTokenInfo(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    const upper = getTokenInfo(1, '0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48');
    expect(lower).toEqual(upper);
  });

  it('returns null for an unknown token address on a known chain', () => {
    const info = getTokenInfo(1, '0x0000000000000000000000000000000000000000');
    expect(info).toBeNull();
  });

  it('returns null for an unknown chain', () => {
    const info = getTokenInfo(99999, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(info).toBeNull();
  });

  it('returns correct info for Base USDC', () => {
    const info = getTokenInfo(8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(info).toEqual({ symbol: 'USDC', decimals: 6 });
  });
});

// ---------------------------------------------------------------------------
// getSymbol (canonical)
// ---------------------------------------------------------------------------

describe('getSymbol', () => {
  it('returns the canonical symbol for a known token', () => {
    expect(getSymbol(1, '0xdac17f958d2ee523a2206206994597c13d831ec7')).toBe('USDT');
  });

  it('returns canonical symbol even when rawSymbol differs', () => {
    // Avalanche WETH.e — getSymbol should return 'WETH', not 'WETH.e'
    expect(getSymbol(43114, '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab')).toBe('WETH');
  });

  it('returns the raw address as fallback for an unknown token', () => {
    const addr = '0x0000000000000000000000000000000000000001';
    expect(getSymbol(1, addr)).toBe(addr);
  });

  it('returns the raw address as fallback for an unknown chain', () => {
    const addr = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    expect(getSymbol(99999, addr)).toBe(addr);
  });
});

// ---------------------------------------------------------------------------
// getRawSymbol (exact on-chain)
// ---------------------------------------------------------------------------

describe('getRawSymbol', () => {
  it('returns rawSymbol when the on-chain symbol differs from canonical', () => {
    // Avalanche Bridge DAI
    expect(getRawSymbol(43114, '0xd586e7f844cea2f87f50152665bcbc2c279d8d70')).toBe('DAI.e');
  });

  it('returns rawSymbol for Avalanche WETH.e', () => {
    expect(getRawSymbol(43114, '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab')).toBe('WETH.e');
  });

  it('returns rawSymbol for Polygon USDT0', () => {
    expect(getRawSymbol(137, '0xc2132d05d31c914a87c6611c10748aeb04b58e8f')).toBe('USDT0');
  });

  it('returns canonical symbol when rawSymbol is absent (on-chain matches canonical)', () => {
    // Ethereum USDC — no rawSymbol, falls back to 'USDC'
    expect(getRawSymbol(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe('USDC');
  });

  it('returns the raw address as fallback for an unknown token', () => {
    const addr = '0x0000000000000000000000000000000000000001';
    expect(getRawSymbol(1, addr)).toBe(addr);
  });
});

// ---------------------------------------------------------------------------
// getDecimals
// ---------------------------------------------------------------------------

describe('getDecimals', () => {
  it('returns 6 for USDC on Ethereum', () => {
    expect(getDecimals(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(6);
  });

  it('returns 18 for WETH on Arbitrum', () => {
    expect(getDecimals(42161, '0x82af49447d8a07e3bd95bd0d56f35241523fbab1')).toBe(18);
  });

  it('returns 18 as fallback for an unknown token', () => {
    expect(getDecimals(1, '0x0000000000000000000000000000000000000000')).toBe(18);
  });

  it('returns 18 as fallback for an unknown chain', () => {
    expect(getDecimals(99999, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')).toBe(18);
  });
});

// ---------------------------------------------------------------------------
// normalizeAmount
// ---------------------------------------------------------------------------

describe('normalizeAmount', () => {
  it('normalises a USDC amount (6 decimals)', () => {
    expect(normalizeAmount(1_000_000n, 6)).toBe(1.0);
  });

  it('normalises a WETH amount (18 decimals)', () => {
    expect(normalizeAmount(1_000_000_000_000_000_000n, 18)).toBe(1.0);
  });

  it('normalises a fractional USDC amount', () => {
    expect(normalizeAmount(500_000n, 6)).toBe(0.5);
  });

  it('normalises a large USDC amount ($50,000)', () => {
    expect(normalizeAmount(50_000_000_000n, 6)).toBe(50_000);
  });

  it('returns 0 for a zero amount', () => {
    expect(normalizeAmount(0n, 18)).toBe(0);
  });
});
