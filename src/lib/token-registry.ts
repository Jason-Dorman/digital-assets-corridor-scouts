/**
 * Token Registry
 *
 * Maps on-chain token addresses to human-readable symbols and decimal precision.
 * Scouts emit raw `tokenAddress`; the processor uses this registry to resolve
 * `symbol`, `rawSymbol`, and `decimals` for enrichment.
 *
 * Fields:
 *   symbol    — canonical name used for aggregation queries (e.g. 'USDT')
 *   rawSymbol — exact on-chain contract symbol when it differs from canonical
 *               (e.g. 'DAI.e' for Avalanche Bridge DAI). Absent when identical.
 *   decimals  — ERC-20 decimal precision
 *
 * Registry data sourced from docs/DATA-MODEL.md §3.2.
 * All addresses are stored lowercase for case-insensitive lookups.
 */

export interface TokenInfo {
  symbol: string;
  /** On-chain contract symbol. Present only when it differs from `symbol`. */
  rawSymbol?: string;
  decimals: number;
}

// Mapping: chainId → tokenAddress (lowercase) → TokenInfo
// Source: docs/DATA-MODEL.md §3.2
export const TOKEN_REGISTRY: Record<number, Record<string, TokenInfo>> = {
  // Ethereum (1)
  1: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  },
  // Arbitrum (42161)
  42161: {
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 },
    // Bridged Tether on Arbitrum — on-chain symbol is 'USD₮0'
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', rawSymbol: 'USD₮0', decimals: 6 },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18 },
  },
  // Optimism (10)
  10: {
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6 },
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6 },
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  },
  // Base (8453)
  8453: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
    '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  },
  // Polygon (137)
  137: {
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': { symbol: 'USDC', decimals: 6 },
    // Bridged Tether on Polygon — on-chain symbol is 'USDT0'
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', rawSymbol: 'USDT0', decimals: 6 },
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI', decimals: 18 },
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', decimals: 18 },
  },
  // Avalanche (43114)
  43114: {
    '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': { symbol: 'USDC', decimals: 6 },
    // Native Tether on Avalanche — on-chain symbol is 'USDt'
    '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': { symbol: 'USDT', rawSymbol: 'USDt', decimals: 6 },
    // DAI bridged via Avalanche Bridge — on-chain symbol is 'DAI.e'
    '0xd586e7f844cea2f87f50152665bcbc2c279d8d70': { symbol: 'DAI', rawSymbol: 'DAI.e', decimals: 18 },
    // WETH bridged via Avalanche Bridge — on-chain symbol is 'WETH.e'
    '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab': { symbol: 'WETH', rawSymbol: 'WETH.e', decimals: 18 },
  },
};

/**
 * Returns TokenInfo for a given chain and token address, or null if unknown.
 * Address lookup is case-insensitive.
 */
export function getTokenInfo(chainId: number, tokenAddress: string): TokenInfo | null {
  const chainTokens = TOKEN_REGISTRY[chainId];
  if (!chainTokens) return null;
  return chainTokens[tokenAddress.toLowerCase()] ?? null;
}

/**
 * Returns the canonical token symbol, falling back to the raw address if unknown.
 */
export function getSymbol(chainId: number, tokenAddress: string): string {
  const info = getTokenInfo(chainId, tokenAddress);
  return info?.symbol ?? tokenAddress;
}

/**
 * Returns the exact on-chain token symbol.
 * Falls back to canonical symbol when no rawSymbol is defined, and to the
 * raw address when the token is unknown entirely.
 */
export function getRawSymbol(chainId: number, tokenAddress: string): string {
  const info = getTokenInfo(chainId, tokenAddress);
  if (!info) return tokenAddress;
  return info.rawSymbol ?? info.symbol;
}

/**
 * Returns the token decimal precision, falling back to 18 if unknown.
 */
export function getDecimals(chainId: number, tokenAddress: string): number {
  const info = getTokenInfo(chainId, tokenAddress);
  return info?.decimals ?? 18;
}

/**
 * Converts a raw on-chain bigint amount to a human-readable float.
 *
 * Splits into integer and fractional parts using BigInt arithmetic before
 * converting to Number. Converting the full rawAmount to Number first would
 * lose precision for amounts > Number.MAX_SAFE_INTEGER (~9×10^15), which can
 * occur with whale ETH transfers (18 decimals, raw value up to ~10^26).
 *
 * Precision note: for 18-decimal tokens the divisor is 10^18 > MAX_SAFE_INTEGER,
 * so Number(remainder) and Number(divisor) are themselves imprecise — the
 * fractional part carries ~1–2 ULP of rounding error. This is negligible for
 * USD calculations (error < 1e-12 dollars) but should not be used where
 * sub-wei precision is required.
 *
 * Example: normalizeAmount(1_000_000n, 6) → 1.0  (USDC)
 *          normalizeAmount(1_000_000_000_000_000_000n, 18) → 1.0  (WETH)
 */
export function normalizeAmount(rawAmount: bigint, decimals: number): number {
  const divisor = 10n ** BigInt(decimals);
  const whole = rawAmount / divisor;       // integer part — fits in Number (safe up to ~9×10^15 whole tokens)
  const remainder = rawAmount % divisor;   // fractional part — < divisor; conversion to Number has negligible rounding error for decimals ≤ 18
  return Number(whole) + Number(remainder) / Number(divisor);
}
