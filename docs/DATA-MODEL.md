# Data Model & Calculations
## Corridor Scout - Formulas and Thresholds Reference

This document is the single source of truth for all calculations, formulas, thresholds, and enum values used in Corridor Scout.

---

## 1. Enums & Constants

### 1.1 Transfer Status

```typescript
type TransferStatus = 'pending' | 'completed' | 'stuck' | 'failed';
```

| Status | Description |
|--------|-------------|
| `pending` | Initiated, waiting for completion |
| `completed` | Successfully filled on destination |
| `stuck` | Exceeded bridge threshold, not yet failed |
| `failed` | Explicitly failed or timed out |

### 1.2 Health Status

```typescript
type HealthStatus = 'healthy' | 'degraded' | 'down';
```

### 1.3 Fragility Level

```typescript
type FragilityLevel = 'low' | 'medium' | 'high';
```

### 1.4 Impact Level

```typescript
type ImpactLevel = 'negligible' | 'low' | 'moderate' | 'high' | 'severe';
```

### 1.5 LFV Interpretation

```typescript
type LFVInterpretation = 'rapid_flight' | 'moderate_outflow' | 'stable' | 'moderate_inflow' | 'rapid_inflow';
```

### 1.6 Anomaly Type

```typescript
type AnomalyType = 'latency_spike' | 'failure_cluster' | 'liquidity_drop' | 'stuck_transfer';
```

### 1.7 Severity Level

```typescript
type Severity = 'low' | 'medium' | 'high';
```

---

## 2. Chain & Bridge Constants

### 2.1 Chain IDs

```typescript
const CHAIN_IDS = {
  ethereum: 1,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  polygon: 137,
  avalanche: 43114,
} as const;
```

### 2.2 Supported Bridges

```typescript
const BRIDGES = ['across', 'cctp', 'stargate'] as const;
```

### 2.3 Bridge → Chain Support

| Bridge | Chains |
|--------|--------|
| Across | Ethereum, Arbitrum, Optimism, Base, Polygon |
| CCTP | Ethereum, Arbitrum, Optimism, Base, Avalanche |
| Stargate | Ethereum, Arbitrum, Optimism, Avalanche, Polygon |

### 2.4 Supported Assets

```typescript
const SUPPORTED_ASSETS = ['USDC', 'USDT', 'ETH', 'WETH', 'DAI'] as const;
```

### 2.5 Stablecoins (for LFV calculation)

```typescript
const STABLECOINS = ['USDC', 'USDT', 'DAI'] as const;
```

---

## 3. Token Registry

The token registry maps on-chain token addresses to human-readable symbols and decimal precision. Scouts emit raw `tokenAddress`, the processor uses this registry to resolve `symbol`, `rawSymbol`, and `decimals`.

### 3.1 Token Info Interface

```typescript
interface TokenInfo {
  symbol: string;
  /** Exact on-chain ERC-20 symbol. Present only when it differs from `symbol`. */
  rawSymbol?: string;
  decimals: number;
}
```

**Canonical vs raw symbol:**

Some tokens have on-chain symbols that differ from the standard name (e.g. bridged Avalanche tokens use `.e` suffix, Polygon/Arbitrum USDT variants use `USDT0`/`USD₮0`). The registry captures both:

- `symbol` — canonical name used for aggregation queries (e.g. `'USDT'`)
- `rawSymbol` — exact on-chain contract symbol when it differs (e.g. `'USDT0'`). Absent when identical to `symbol`.

The transfers table stores both as `asset` (canonical) and `asset_raw` (null when same as canonical).

### 3.2 Registry Structure

```typescript
// Mapping: chainId → tokenAddress (lowercase) → TokenInfo
const TOKEN_REGISTRY: Record<number, Record<string, TokenInfo>> = {
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
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', rawSymbol: 'USDT0', decimals: 6 },
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI', decimals: 18 },
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', decimals: 18 },
  },
  // Avalanche (43114)
  43114: {
    '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': { symbol: 'USDC', decimals: 6 },
    '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': { symbol: 'USDT', rawSymbol: 'USDt', decimals: 6 },
    '0xd586e7f844cea2f87f50152665bcbc2c279d8d70': { symbol: 'DAI', rawSymbol: 'DAI.e', decimals: 18 },
    '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab': { symbol: 'WETH', rawSymbol: 'WETH.e', decimals: 18 },
  },
};
```

### 3.3 Lookup Functions

```typescript
function getTokenInfo(chainId: number, tokenAddress: string): TokenInfo | null {
  const chainTokens = TOKEN_REGISTRY[chainId];
  if (!chainTokens) return null;
  return chainTokens[tokenAddress.toLowerCase()] ?? null;
}

// Returns canonical symbol (for aggregation). Falls back to address if unknown.
function getSymbol(chainId: number, tokenAddress: string): string {
  const info = getTokenInfo(chainId, tokenAddress);
  return info?.symbol ?? tokenAddress;
}

// Returns exact on-chain symbol. Falls back to canonical when rawSymbol absent,
// and to address when token is entirely unknown.
function getRawSymbol(chainId: number, tokenAddress: string): string {
  const info = getTokenInfo(chainId, tokenAddress);
  if (!info) return tokenAddress;
  return info.rawSymbol ?? info.symbol;
}

function getDecimals(chainId: number, tokenAddress: string): number {
  const info = getTokenInfo(chainId, tokenAddress);
  return info?.decimals ?? 18; // Default to 18 if unknown
}
```

### 3.4 Amount Normalization

```typescript
function normalizeAmount(rawAmount: bigint, decimals: number): number {
  return Number(rawAmount) / Math.pow(10, decimals);
}

// Usage in processor:
// const tokenInfo = getTokenInfo(chainId, event.tokenAddress);
// const normalizedAmount = normalizeAmount(event.amount, tokenInfo?.decimals ?? 18);
```

---

## 4. Price Service

The price service provides USD prices for tokens. Used by the processor to calculate `amountUsd`.

### 4.1 Interface

```typescript
interface PriceService {
  getPrice(symbol: string): Promise<number>;
  getPrices(symbols: string[]): Promise<Record<string, number>>;
}
```

### 4.2 Implementation Strategy

For Phase 0, use a simple approach:

1. **Stablecoins (USDC, USDT, DAI)**: Hardcode $1.00
2. **ETH/WETH**: Fetch from CoinGecko free API (no key required)
3. **Cache prices**: 5 minute TTL to avoid rate limits

```typescript
const STABLECOIN_PRICE = 1.0;
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class SimplePriceService implements PriceService {
  private cache: Map<string, { price: number; fetchedAt: number }> = new Map();

  async getPrice(symbol: string): Promise<number> {
    // Stablecoins are always $1
    if (['USDC', 'USDT', 'DAI'].includes(symbol)) {
      return STABLECOIN_PRICE;
    }

    // Check cache
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
      return cached.price;
    }

    // Fetch from CoinGecko
    const price = await this.fetchFromCoinGecko(symbol);
    this.cache.set(symbol, { price, fetchedAt: Date.now() });
    return price;
  }

  private async fetchFromCoinGecko(symbol: string): Promise<number> {
    const coinId = SYMBOL_TO_COINGECKO_ID[symbol];
    if (!coinId) return 0;

    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`
      );
      const data = await response.json();
      return data[coinId]?.usd ?? 0;
    } catch (error) {
      console.error(`Failed to fetch price for ${symbol}:`, error);
      return 0;
    }
  }

  async getPrices(symbols: string[]): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    for (const symbol of symbols) {
      prices[symbol] = await this.getPrice(symbol);
    }
    return prices;
  }
}

const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  ETH: 'ethereum',
  WETH: 'ethereum',
  // Add more as needed
};
```

### 4.3 Processor Enrichment Flow

```typescript
// In TransferProcessor.handleInitiation():

// 1. Resolve token
const chainId = CHAIN_IDS[event.sourceChain];
const tokenInfo = getTokenInfo(chainId, event.tokenAddress);
const symbol = tokenInfo?.symbol ?? event.tokenAddress;
// null when on-chain symbol matches canonical (null-means-same convention)
const assetRaw = tokenInfo?.rawSymbol ?? null;
const decimals = tokenInfo?.decimals ?? 18;

// 2. Normalize amount
const normalizedAmount = normalizeAmount(event.amount, decimals);

// 3. Get price (uses canonical symbol — stablecoins = $1, ETH/WETH = CoinGecko)
const price = await priceService.getPrice(symbol);

// 4. Calculate USD value
const amountUsd = price > 0 ? normalizedAmount * price : null;

// 5. Get size bucket
const transferSizeBucket = amountUsd != null && amountUsd > 0 ? getSizeBucket(amountUsd) : null;

// 6. Store in database
await db.transfers.insert({
  // ... other fields
  asset: symbol,      // canonical — use for aggregation queries
  assetRaw,           // exact on-chain symbol — null when same as asset
  amount: event.amount.toString(),
  amountUsd,
  transferSizeBucket,
});
```

---

## 5. Transfer Size Buckets

### 3.1 Definition

```typescript
function getSizeBucket(amountUsd: number): string {
  if (amountUsd < 10_000) return 'small';
  if (amountUsd < 100_000) return 'medium';
  if (amountUsd < 1_000_000) return 'large';
  return 'whale';
}
```

### 3.2 Thresholds Table

| Bucket | USD Range |
|--------|-----------|
| `small` | $0 - $9,999 |
| `medium` | $10,000 - $99,999 |
| `large` | $100,000 - $999,999 |
| `whale` | $1,000,000+ |

---

## 6. Stuck Transfer Detection

### 4.1 Thresholds by Bridge

```typescript
const STUCK_THRESHOLDS_SECONDS: Record<string, number> = {
  across: 30 * 60,      // 30 minutes = 1800 seconds
  cctp: 45 * 60,        // 45 minutes = 2700 seconds
  stargate: 30 * 60,    // 30 minutes = 1800 seconds
  wormhole: 60 * 60,    // 60 minutes = 3600 seconds
  layerzero: 30 * 60,   // 30 minutes = 1800 seconds
};
```

### 4.2 Detection Logic

```typescript
function isStuck(transfer: Transfer, now: Date): boolean {
  if (transfer.status !== 'pending') return false;
  
  const threshold = STUCK_THRESHOLDS_SECONDS[transfer.bridge];
  const elapsed = (now.getTime() - transfer.initiatedAt.getTime()) / 1000;
  
  return elapsed > threshold;
}
```

---

## 7. Fragility Calculation

### 5.1 Inputs

| Input | Type | Description |
|-------|------|-------------|
| `utilization` | number (0-100) | Pool utilization percentage |
| `tvlUsd` | number | Total value locked in USD |
| `netFlow24h` | number | Net flow in last 24h (positive = inflow) |

### 5.2 Formula

```typescript
interface FragilityResult {
  level: 'low' | 'medium' | 'high';
  utilization: number;
  netFlow24hPct: number;
  reason: string;
}

function calculateFragility(input: FragilityInput): FragilityResult {
  // Guard 1: NaN or Infinity in any field → fail-safe HIGH.
  if (!Number.isFinite(input.utilization) || !Number.isFinite(input.tvlUsd) || !Number.isFinite(input.netFlow24h)) {
    // warn + return high
    return { level: 'high', utilization: 0, netFlow24hPct: 0, reason: 'Data integrity error – unable to calculate' };
  }

  // Guard 2: Zero or negative TVL → fail-safe HIGH.
  // A pool with no liquidity is maximally fragile regardless of utilization.
  // NOTE: The original formula (netFlow24hPct = tvlUsd > 0 ? ... : 0) would return
  // LOW for a zero-TVL / zero-utilization pool. We intentionally deviate — fail-safe
  // is safer than masking a drain/corruption signal.
  if (input.tvlUsd <= 0) {
    // warn + return high
    return { level: 'high', utilization: input.utilization, netFlow24hPct: 0, reason: 'Zero TVL detected' };
  }

  // Guard 3: Clamp utilization to 0–100. Values outside range indicate upstream
  // corruption; log a warning so affected records can be traced.
  let utilization = Math.max(0, Math.min(100, input.utilization)); // warn if clamped

  const netFlow24hPct = (input.netFlow24h / input.tvlUsd) * 100;

  // Step 1: Evaluate both HIGH conditions independently.
  // When both fire simultaneously, the reason string must surface both — a consumer
  // reading only `reason` should see the full picture.
  const highUtil    = utilization > 60;
  const highOutflow = netFlow24hPct < -20;

  if (highUtil || highOutflow) {
    const reasons: string[] = [];
    if (highUtil)    reasons.push(`High utilization (${utilization.toFixed(0)}%)`);
    if (highOutflow) reasons.push(`Large outflow (${netFlow24hPct.toFixed(1)}% in 24h)`);
    return { level: 'high', utilization, netFlow24hPct, reason: reasons.join('; ') };
  }

  // Step 2: Check MEDIUM conditions (same dual-visibility pattern).
  const medUtil    = utilization > 30;
  const medOutflow = netFlow24hPct < -10;

  if (medUtil || medOutflow) {
    const reasons: string[] = [];
    if (medUtil)    reasons.push(`Moderate utilization (${utilization.toFixed(0)}%)`);
    if (medOutflow) reasons.push(`Moderate outflow (${netFlow24hPct.toFixed(1)}% in 24h)`);
    return { level: 'medium', utilization, netFlow24hPct, reason: reasons.join('; ') };
  }

  // Step 3: Default to LOW.
  return { level: 'low', utilization, netFlow24hPct, reason: 'Pool is stable' };
}
```

### 5.3 Thresholds Table

| Level | Utilization | OR | Net Flow 24h |
|-------|-------------|-----|--------------|
| `high` | > 60% | OR | < -20% |
| `medium` | > 30% | OR | < -10% |
| `low` | ≤ 30% | AND | ≥ -10% |

**Input guards (applied before threshold evaluation):**

| Condition | Behaviour |
|-----------|-----------|
| NaN or Infinity in any input field | Return `high` — `reason: 'Data integrity error – unable to calculate'` |
| `tvlUsd ≤ 0` | Return `high` — `reason: 'Zero TVL detected'` (deviation from original formula; see note in §5.2) |
| `utilization` outside 0–100 | Clamp to valid range, log warning, continue evaluation |

### 5.4 Dual-Trigger Reason Strings

When more than one condition at the same level fires simultaneously, all triggered conditions are combined in the `reason` field, separated by `'; '`. This ensures a caller reading only `reason` sees the full picture.

| Conditions firing | `reason` |
|-------------------|----------|
| High utilization only | `"High utilization (65%)"` |
| High outflow only | `"Large outflow (-25.0% in 24h)"` |
| Both HIGH conditions | `"High utilization (65%); Large outflow (-25.0% in 24h)"` |
| Moderate utilization only | `"Moderate utilization (45%)"` |
| Moderate outflow only | `"Moderate outflow (-15.0% in 24h)"` |
| Both MEDIUM conditions | `"Moderate utilization (45%); Moderate outflow (-15.0% in 24h)"` |

### 5.5 Example Calculations

| Utilization | Net Flow | Result | Reason |
|-------------|----------|--------|--------|
| 65% | +5% | HIGH | High utilization (65%) |
| 25% | -25% | HIGH | Large outflow (-25.0% in 24h) |
| 70% | -30% | HIGH | High utilization (70%); Large outflow (-30.0% in 24h) |
| 45% | +2% | MEDIUM | Moderate utilization (45%) |
| 20% | -15% | MEDIUM | Moderate outflow (-15.0% in 24h) |
| 45% | -15% | MEDIUM | Moderate utilization (45%); Moderate outflow (-15.0% in 24h) |
| 25% | +3% | LOW | Pool is stable |
| 0% | 0% (TVL=0) | HIGH | Zero TVL detected |

---

## 8. Impact Calculation

### 6.1 Slippage Factors by Bridge

```typescript
const SLIPPAGE_FACTORS: Record<string, number> = {
  across: 0.5,      // Intent-based, relayers absorb slippage
  stargate: 1.0,    // Pool-based AMM
  cctp: 0.0,        // Burn/mint, no slippage
  wormhole: 0.1,    // Message-based
  layerzero: 0.1,   // Message-based
};
```

### 6.2 Inputs

| Input | Type | Description |
|-------|------|-------------|
| `transferAmountUsd` | number | Transfer amount in USD |
| `poolTvlUsd` | number | Pool TVL in USD |
| `bridge` | string | Bridge identifier |

### 6.3 Formula

```typescript
interface ImpactResult {
  poolSharePct: number;
  estimatedSlippageBps: number;
  impactLevel: 'negligible' | 'low' | 'moderate' | 'high' | 'severe';
  warning: string | null;
}

function calculateImpact(
  transferAmountUsd: number,
  poolTvlUsd: number,
  bridge: string
): ImpactResult {
  // Step 1: Calculate pool share
  const poolSharePct = poolTvlUsd > 0
    ? (transferAmountUsd / poolTvlUsd) * 100
    : 100;

  // Step 2: Calculate estimated slippage
  const slippageFactor = SLIPPAGE_FACTORS[bridge] ?? 1.0;
  const estimatedSlippageBps = poolSharePct * slippageFactor;

  // Step 3: Determine impact level and warning
  let impactLevel: ImpactResult['impactLevel'];
  let warning: string | null = null;

  if (poolSharePct < 1) {
    impactLevel = 'negligible';
  } else if (poolSharePct < 5) {
    impactLevel = 'low';
  } else if (poolSharePct < 15) {
    impactLevel = 'moderate';
    warning = `Your transfer is ${poolSharePct.toFixed(2)}% of pool liquidity`;
  } else if (poolSharePct < 30) {
    impactLevel = 'high';
    warning = `Large transfer: ${poolSharePct.toFixed(2)}% of pool. Consider splitting.`;
  } else {
    impactLevel = 'severe';
    warning = `Transfer exceeds safe threshold (${poolSharePct.toFixed(2)}% of pool). Split recommended.`;
  }

  return {
    poolSharePct: Math.round(poolSharePct * 100) / 100,
    estimatedSlippageBps: Math.round(estimatedSlippageBps * 10) / 10,
    impactLevel,
    warning,
  };
}
```

### 6.4 Impact Level Thresholds

| Level | Pool Share % | Warning |
|-------|-------------|---------|
| `negligible` | < 1% | None |
| `low` | 1% - 4.99% | None |
| `moderate` | 5% - 14.99% | "Your transfer is X% of pool liquidity" |
| `high` | 15% - 29.99% | "Large transfer: X% of pool. Consider splitting." |
| `severe` | ≥ 30% | "Transfer exceeds safe threshold. Split recommended." |

### 6.5 Slippage Formula

```
estimatedSlippageBps = poolSharePct × slippageFactor
```

### 6.6 Example Calculations

| Amount | Pool TVL | Bridge | Pool Share | Slippage | Level |
|--------|----------|--------|------------|----------|-------|
| $50K | $10M | across | 0.5% | 0.25 bps | negligible |
| $500K | $10M | across | 5% | 2.5 bps | moderate |
| $500K | $10M | stargate | 5% | 5.0 bps | moderate |
| $3M | $10M | across | 30% | 15.0 bps | severe |
| $1M | $10M | cctp | 10% | 0 bps | moderate |

**⚠️ DISCLAIMER (must always be shown):**
> "Directional estimate only. Not an execution guarantee."

---

## 9. Liquidity Flight Velocity (LFV)

### 7.1 Definition

LFV measures the rate of net stablecoin liquidity change across monitored bridge pools per chain.

### 7.2 Inputs

| Input | Type | Description |
|-------|------|-------------|
| `chain` | string | Chain to calculate LFV for |
| `timeWindowHours` | number | Time window (default: 24) |

### 7.3 Formula

```typescript
interface LFVResult {
  chain: string;
  lfv24h: number;           // Decimal rate (-0.10 = -10%)
  lfvAnnualized: number;    // Projected annual rate
  interpretation: LFVInterpretation;
  netFlowUsd: number;
  tvlStartUsd: number;
  tvlNowUsd: number;
  poolsMonitored: number;
}

async function calculateLFV(
  chain: string,
  timeWindowHours: number = 24
): Promise<LFVResult> {
  // Step 1: Get stablecoin pools for chain
  const pools = await getStablecoinPools(chain); // USDC, USDT, DAI
  
  // Step 2: Get TVL at start and end of window
  const tvlStart = await getTvlAtTime(pools, hoursAgo(timeWindowHours));
  const tvlNow = await getCurrentTvl(pools);
  
  // Step 3: Calculate net flow
  const netFlow = tvlNow - tvlStart;
  
  // Step 4: Calculate LFV
  if (tvlStart === 0) {
    return { chain, lfv24h: 0, lfvAnnualized: 0, interpretation: 'stable', ... };
  }
  
  const lfv = netFlow / tvlStart;
  const lfv24h = lfv * (24 / timeWindowHours);  // Normalize to 24h
  const lfvAnnualized = lfv24h * 365;
  
  // Step 5: Interpret
  const interpretation = interpretLFV(lfv24h);
  
  return {
    chain,
    lfv24h,
    lfvAnnualized,
    interpretation,
    netFlowUsd: netFlow,
    tvlStartUsd: tvlStart,
    tvlNowUsd: tvlNow,
    poolsMonitored: pools.length,
  };
}
```

### 7.4 Core Formulas

```
netFlow = tvlNow - tvlStart

lfv = netFlow / tvlStart

lfv24h = lfv × (24 / timeWindowHours)

lfvAnnualized = lfv24h × 365
```

### 7.5 Interpretation Thresholds

```typescript
function interpretLFV(lfv24h: number): LFVInterpretation {
  if (lfv24h < -0.10) return 'rapid_flight';      // < -10%
  if (lfv24h < -0.03) return 'moderate_outflow';  // -10% to -3%
  if (lfv24h < 0.03) return 'stable';             // -3% to +3%
  if (lfv24h < 0.10) return 'moderate_inflow';    // +3% to +10%
  return 'rapid_inflow';                           // > +10%
}
```

### 7.6 Thresholds Table

| Interpretation | LFV 24h Range | Alert |
|----------------|---------------|-------|
| `rapid_flight` | < -10% | 🔴 Yes |
| `moderate_outflow` | -10% to -3% | No |
| `stable` | -3% to +3% | No |
| `moderate_inflow` | +3% to +10% | No |
| `rapid_inflow` | > +10% | No |

### 7.7 Example Calculations

| Chain | TVL Start | TVL Now | Net Flow | LFV 24h | Interpretation |
|-------|-----------|---------|----------|---------|----------------|
| Ethereum | $100M | $102M | +$2M | +2% | stable |
| Base | $50M | $42M | -$8M | -16% | rapid_flight 🔴 |
| Arbitrum | $80M | $76M | -$4M | -5% | moderate_outflow |
| Optimism | $60M | $66M | +$6M | +10% | rapid_inflow |

---

## 10. Corridor Health Status

### 8.1 Inputs

| Input | Type | Description |
|-------|------|-------------|
| `successRate1h` | number (0-100) | Success rate in last hour |
| `currentP90` | number | Current p90 latency (seconds) |
| `historicalP90` | number | 7-day historical p90 (seconds) |
| `transferCount1h` | number | Transfers in last hour |

### 8.2 Formula

```typescript
function calculateHealthStatus(
  successRate1h: number,
  currentP90: number,
  historicalP90: number,
  transferCount1h: number
): HealthStatus {
  const latencyMultiplier = historicalP90 > 0 ? currentP90 / historicalP90 : 1;

  // DOWN conditions (check first)
  if (successRate1h < 95) return 'down';
  if (latencyMultiplier > 5) return 'down';
  if (transferCount1h === 0) return 'down';

  // DEGRADED conditions
  if (successRate1h < 99) return 'degraded';
  if (latencyMultiplier > 2) return 'degraded';

  // HEALTHY (default)
  return 'healthy';
}
```

### 8.3 Thresholds Table

| Status | Success Rate | OR | Latency | OR | Volume |
|--------|-------------|-----|---------|-----|--------|
| `down` | < 95% | OR | > 5x normal | OR | 0 transfers/hr |
| `degraded` | 95-98.99% | OR | 2-5x normal | | |
| `healthy` | ≥ 99% | AND | ≤ 2x normal | AND | > 0 transfers |

### 8.4 Latency Multiplier

```
latencyMultiplier = currentP90 / historicalP90
```

---

## 11. Anomaly Detection

### 9.1 Latency Spike Detection

```typescript
const LATENCY_SPIKE_MULTIPLIER = 3; // 3x normal = spike

function detectLatencySpike(
  currentP90: number,
  historicalP90: number
): boolean {
  return currentP90 > historicalP90 * LATENCY_SPIKE_MULTIPLIER;
}
```

**Threshold:** Current p90 > 3× historical p90

### 9.2 Failure Cluster Detection

```typescript
const FAILURE_RATE_THRESHOLD = 10; // 10% failure rate

function detectFailureCluster(
  failedCount: number,
  totalCount: number
): boolean {
  if (totalCount === 0) return false;
  const failureRate = (failedCount / totalCount) * 100;
  return failureRate > FAILURE_RATE_THRESHOLD;
}
```

**Threshold:** Failure rate > 10% in last hour

### 9.3 Liquidity Drop Detection

```typescript
const LIQUIDITY_DROP_THRESHOLD = 15; // 15% drop

function detectLiquidityDrop(
  tvlNow: number,
  tvl24hAgo: number
): boolean {
  if (tvl24hAgo === 0) return false;
  const dropPct = ((tvl24hAgo - tvlNow) / tvl24hAgo) * 100;
  return dropPct > LIQUIDITY_DROP_THRESHOLD;
}
```

**Threshold:** TVL drop > 15% in 24 hours

### 9.4 Anomaly Severity Assignment

| Anomaly Type | Low | Medium | High |
|--------------|-----|--------|------|
| Latency Spike | 3-5x | 5-10x | > 10x |
| Failure Cluster | 10-20% | 20-40% | > 40% |
| Liquidity Drop | 15-25% | 25-40% | > 40% |
| Stuck Transfer | < $100K | $100K-$1M | > $1M |

---

## 12. Percentile Calculations

### 10.1 p50 (Median) and p90

```typescript
function calculatePercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  
  const sorted = [...values].sort((a, b) => a - b);
  const index = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  
  if (lower === upper) return sorted[lower];
  
  // Linear interpolation
  const fraction = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

// Usage
const p50 = calculatePercentile(durations, 50);
const p90 = calculatePercentile(durations, 90);
```

### 10.2 Success Rate

```typescript
function calculateSuccessRate(
  completed: number,
  failed: number,
  stuck: number
): number {
  const total = completed + failed + stuck;
  if (total === 0) return 100;
  return (completed / total) * 100;
}
```

---

## 13. Time Windows

### 11.1 Standard Windows

| Window | Seconds | Usage |
|--------|---------|-------|
| 1 hour | 3600 | Health metrics, anomaly detection |
| 24 hours | 86400 | LFV, daily stats |
| 7 days | 604800 | Historical baseline |

### 11.2 Cron Schedules

| Job | Interval | Purpose |
|-----|----------|---------|
| Stuck Detector | Every 1 minute | Mark stuck transfers |
| Pool Snapshots | Every 5 minutes | Capture TVL |
| Anomaly Detector | Every 15 minutes | Scan for anomalies |

---

## 14. API Response Rounding

### 12.1 Precision Rules

| Field | Precision | Example |
|-------|-----------|---------|
| `poolSharePct` | 2 decimals | 5.88 |
| `estimatedSlippageBps` | 1 decimal | 2.9 |
| `successRate` | 2 decimals | 99.73 |
| `lfv24h` | 3 decimals | -0.082 |
| `utilization` | 0 decimals | 23 |
| `durationSeconds` | 0 decimals | 210 |
| `amountUsd` | 2 decimals | 5000000.00 |

### 12.2 Nullable Success Rate

`successRate1h`, `successRate24h`, and the system-level `successRate24h` return `null`
when no transfers have resolved (completed, failed, or stuck) in the window. This avoids
reporting a phantom 100% success rate when only pending transfers exist. Consumers must
handle `null` as "no data" rather than assuming a numeric value.

---

## 15. Transfer ID Formats

### 13.1 By Bridge

| Bridge | Format | Example |
|--------|--------|---------|
| Across | `{originChainId}_{depositId}` | `1_12345` |
| CCTP | `{sourceDomain}_{nonce}` | `0_67890` |
| Stargate | `{chainId}_{txHash}` | `1_0xabc...` |

#### CCTP completion events

`MessageReceived` on the MessageTransmitter does not carry `burnToken` or `amount`. Completion `TransferEvent` payloads set these fields to explicit sentinel values rather than making them optional (which would complicate every consumer):

| Field | Sentinel | Rationale |
|-------|----------|-----------|
| `tokenAddress` | `0x0000000000000000000000000000000000000000` | Zero address — unambiguous EVM convention for "not present" |
| `amount` | `0n` | Processor already has the real amount from the stored initiation record |

The transfer processor identifies these sentinel values on match and uses the initiation record's values for storage.

---

### 13.2 Corridor ID Format

```
{bridge}_{sourceChain}_{destChain}
```

Example: `across_ethereum_arbitrum`