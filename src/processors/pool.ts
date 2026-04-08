/**
 * Pool Processor
 *
 * Queries on-chain pool contracts for TVL and available liquidity, then stores
 * point-in-time snapshots in the pool_snapshots table.
 *
 * Bridge strategies
 * ─────────────────
 * Across — Two snapshot types per token:
 *   (1) SpokePool rows   — ERC-20 balanceOf(spokePool) per chain.
 *                          Gives per-chain granularity needed for LFV.
 *                          utilization is stored as null (SpokePools do not
 *                          expose utilized vs. liquid split).
 *   (2) HubPool rows     — pooledTokens(token) on Ethereum HubPool.
 *                          Gives aggregate TVL + real utilization.
 *                          Stored with chain = 'ethereum_hub' to prevent
 *                          double-counting when LFV queries by chain.
 *
 * CCTP — Burn/mint model; no liquidity pools exist.
 *         Placeholder rows are written (tvl = 0, utilization = 0) so that
 *         downstream queries don't treat missing rows as missing data.
 *
 * Pool ID format
 * ──────────────
 *   SpokePool: across_{chain}_{asset_lowercase}    e.g. across_arbitrum_usdc
 *   HubPool:   across_hubpool_{asset_lowercase}    e.g. across_hubpool_usdc
 *   CCTP:      cctp_{chain}_{asset_lowercase}      e.g. cctp_base_usdc
 *
 * Utilization formula (docs/DATA-MODEL.md §5.2):
 *   utilization = (total - available) / total × 100
 *   where total     = liquidReserves + max(utilizedReserves, 0)
 *         available = liquidReserves
 */

import { Contract } from 'ethers';

import { logger } from '../lib/logger';
import { db } from '../lib/db';
import { getProvider } from '../lib/rpc';
import { publish } from '../lib/redis';
import { priceService } from '../lib/price-service';
import { TOKEN_REGISTRY, normalizeAmount } from '../lib/token-registry';
import {
  CHAIN_IDS,
  REDIS_CHANNELS,
  SUPPORTED_ASSETS,
  ACROSS_SPOKEPOOL_ADDRESSES,
  ACROSS_HUBPOOL_ADDRESS,
  BRIDGE_CHAINS,
  type BridgeName,
  type ChainName,
} from '../lib/constants';

// ---------------------------------------------------------------------------
// ABIs — minimal, only the methods we call
// ---------------------------------------------------------------------------

/** Standard ERC-20 balance query. */
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'] as const;

/**
 * Across HubPool — pooledTokens return struct (all named for clarity):
 *   isEnabled           bool
 *   lastLpFeeUpdate     uint32
 *   utilizedReserves    int256   ← can be negative during rebalancing
 *   liquidReserves      uint256
 *   undistributedLpFees uint256
 *
 * Source: Across V3 HubPool ABI
 */
const HUBPOOL_ABI = [
  'function pooledTokens(address) view returns (bool isEnabled, uint32 lastLpFeeUpdate, int256 utilizedReserves, uint256 liquidReserves, uint256 undistributedLpFees)',
] as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Sentinel chain key used for HubPool aggregate rows.
 *
 * Must not match any real ChainName so that LFV queries for chain='ethereum'
 * only pick up SpokePool rows (per-chain data), while callers that need
 * aggregate utilization can query chain='ethereum_hub' explicitly.
 */
const HUBPOOL_CHAIN_KEY = 'ethereum_hub';

// ---------------------------------------------------------------------------
// Internal data shape — not exported; only PoolProcessor uses it
// ---------------------------------------------------------------------------

interface PoolSnapshotInput {
  poolId: string;
  bridge: BridgeName;
  chain: string;
  asset: string;
  /** Human-readable float (raw bigint already normalised by token decimals). */
  tvl: number;
  availableLiquidity: number | null;
  utilization: number | null;
}

// ---------------------------------------------------------------------------
// PoolProcessor
// ---------------------------------------------------------------------------

export class PoolProcessor {
  /**
   * Fetch all pool snapshots and persist them.
   *
   * Each bridge fetch runs concurrently. A failure in one bridge does not
   * abort the others — errors are logged and those rows are skipped.
   */
  async run(): Promise<void> {
    const now = new Date();

    const results = await Promise.allSettled([
      this.fetchAcrossSpokePools(),
      this.fetchAcrossHubPool(),
      Promise.resolve(this.fetchCctpPlaceholders()),
    ]);

    const snapshots: PoolSnapshotInput[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        snapshots.push(...result.value);
      } else {
        logger.error('[PoolProcessor] Bridge fetch failed', { reason: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      }
    }

    await this.enrichAndStore(snapshots, now);
  }

  // ---------------------------------------------------------------------------
  // Across — per-chain SpokePool balances
  // ---------------------------------------------------------------------------

  /**
   * Query ERC-20 balanceOf(spokePool) for every token defined in TOKEN_REGISTRY
   * on each chain where an Across SpokePool exists.
   *
   * These rows give LFV the per-chain granularity it needs. Utilization is null
   * because SpokePools do not expose utilized vs. liquid split on-chain.
   */
  private async fetchAcrossSpokePools(): Promise<PoolSnapshotInput[]> {
    const results: PoolSnapshotInput[] = [];

    for (const [chain, spokePoolAddress] of Object.entries(ACROSS_SPOKEPOOL_ADDRESSES) as [ChainName, string][]) {
      const chainId = CHAIN_IDS[chain];
      const chainTokens = TOKEN_REGISTRY[chainId];
      if (!chainTokens) continue;

      const provider = getProvider(chain);

      for (const [tokenAddress, tokenInfo] of Object.entries(chainTokens)) {
        if (!(SUPPORTED_ASSETS as readonly string[]).includes(tokenInfo.symbol)) continue;

        try {
          const token = new Contract(tokenAddress, ERC20_ABI, provider);
          const rawBalance = await token.balanceOf(spokePoolAddress) as bigint;
          const tvl = normalizeAmount(rawBalance, tokenInfo.decimals);

          results.push({
            poolId: `across_${chain}_${tokenInfo.symbol.toLowerCase()}`,
            bridge: 'across',
            chain,
            asset: tokenInfo.symbol,
            tvl,
            // Full balance is available — no utilization split at the SpokePool level
            availableLiquidity: tvl,
            utilization: null,
          });
        } catch (error) {
          logger.error(`[PoolProcessor] Across SpokePool balanceOf failed: chain=${chain} token=${tokenAddress}`, { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Across — HubPool aggregate (Ethereum)
  // ---------------------------------------------------------------------------

  /**
   * Query pooledTokens(tokenAddress) on the Across HubPool for each token
   * defined on Ethereum in TOKEN_REGISTRY.
   *
   * The HubPool is where LP funds live; it exposes both liquid and utilized
   * reserves, making it the only place we can compute real utilization for Across.
   *
   * Stored with chain = HUBPOOL_CHAIN_KEY ('ethereum_hub') to prevent LFV from
   * double-counting these rows alongside the per-chain SpokePool rows.
   *
   * utilizedReserves is int256 and can go negative during settlement rebalancing
   * (more capital returned to pool than originally accounted for). When negative,
   * we clamp to 0 so that tvl = liquidReserves and utilization = 0.
   */
  private async fetchAcrossHubPool(): Promise<PoolSnapshotInput[]> {
    const results: PoolSnapshotInput[] = [];
    const provider = getProvider('ethereum');
    const hubPool = new Contract(ACROSS_HUBPOOL_ADDRESS, HUBPOOL_ABI, provider);

    const ethereumTokens = TOKEN_REGISTRY[CHAIN_IDS.ethereum];
    if (!ethereumTokens) return results;

    for (const [tokenAddress, tokenInfo] of Object.entries(ethereumTokens)) {
      if (!(SUPPORTED_ASSETS as readonly string[]).includes(tokenInfo.symbol)) continue;

      try {
        // ethers v6 returns a Result object with named fields for named ABI returns
        const raw = await hubPool.pooledTokens(tokenAddress) as unknown as {
          utilizedReserves: bigint;
          liquidReserves: bigint;
        };

        // Clamp negative utilizedReserves — pool is over-collateralised, utilization = 0
        const utilized = raw.utilizedReserves < 0n ? 0n : raw.utilizedReserves;
        const liquid = raw.liquidReserves;
        const total = utilized + liquid;

        // Skip uninitialised / empty pools — a zero-TVL HubPool row carries no
        // signal and would distort aggregate utilization queries.
        if (total === 0n) continue;

        const tvl = normalizeAmount(total, tokenInfo.decimals);
        const available = normalizeAmount(liquid, tokenInfo.decimals);
        const utilization = Number(utilized * 10_000n / total) / 100;

        results.push({
          poolId: `across_hubpool_${tokenInfo.symbol.toLowerCase()}`,
          bridge: 'across',
          chain: HUBPOOL_CHAIN_KEY,
          asset: tokenInfo.symbol,
          tvl,
          availableLiquidity: available,
          utilization,
        });
      } catch (error) {
        logger.error(`[PoolProcessor] Across HubPool pooledTokens failed: token=${tokenAddress}`, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // CCTP — burn/mint, no pools
  // ---------------------------------------------------------------------------

  /**
   * CCTP uses a burn-and-mint model — there are no liquidity pools, so TVL and
   * utilization are meaningless. We write placeholder rows (tvl = 0, utilization = 0)
   * so that downstream queries return a row rather than treating the absence of data
   * as a signal that the bridge is not monitored.
   *
   * CCTP only supports USDC.
   */
  private fetchCctpPlaceholders(): PoolSnapshotInput[] {
    return BRIDGE_CHAINS.cctp.map((chain) => ({
      poolId: `cctp_${chain}_usdc`,
      bridge: 'cctp',
      chain,
      asset: 'USDC',
      tvl: 0,
      availableLiquidity: 0,
      utilization: 0,
    }));
  }

  // ---------------------------------------------------------------------------
  // Enrich with USD price and persist
  // ---------------------------------------------------------------------------

  /**
   * Fetch USD prices for all unique assets in a single batch, then write one
   * pool_snapshots row per input.
   *
   * Individual rows are stored sequentially so that a single DB error does not
   * abort the entire batch — the error is logged and that row is skipped.
   */
  private async enrichAndStore(snapshots: PoolSnapshotInput[], recordedAt: Date): Promise<void> {
    if (snapshots.length === 0) return;

    // One price call per unique symbol — priceService caches results for 5 min
    const uniqueAssets = [...new Set(snapshots.map((s) => s.asset))];
    let prices: Record<string, number> = {};
    try {
      prices = await priceService.getPrices(uniqueAssets);
    } catch (error) {
      logger.warn('[PoolProcessor] Price fetch failed — storing snapshots without USD values', { error: error instanceof Error ? error.message : String(error) });
    }

    let stored = 0;
    for (const snapshot of snapshots) {
      const price = prices[snapshot.asset] ?? 0;
      const tvlUsd = price > 0 ? snapshot.tvl * price : null;

      try {
        await db.poolSnapshot.create({
          data: {
            poolId: snapshot.poolId,
            bridge: snapshot.bridge,
            chain: snapshot.chain,
            asset: snapshot.asset,
            tvl: snapshot.tvl,
            tvlUsd,
            availableLiquidity: snapshot.availableLiquidity,
            utilization: snapshot.utilization,
            recordedAt,
          },
        });
        stored++;
      } catch (error) {
        logger.error(`[PoolProcessor] Failed to store snapshot: poolId=${snapshot.poolId}`, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    logger.info(`[PoolProcessor] Stored ${stored}/${snapshots.length} pool snapshots at ${recordedAt.toISOString()}`);

    try {
      await publish(REDIS_CHANNELS.POOL_SNAPSHOT, { recordedAt, stored, total: snapshots.length });
    } catch (error) {
      logger.warn('[PoolProcessor] Failed to broadcast pool:snapshot — snapshots are persisted', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
