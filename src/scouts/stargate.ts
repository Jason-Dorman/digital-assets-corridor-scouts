/**
 * Stargate V1 bridge scout.
 *
 * Listens for Swap events on Stargate Pool contracts (USDC Pool / USDT Pool)
 * across Ethereum, Arbitrum, Optimism, Avalanche, and Polygon.
 *
 * Phase 0 simplified model:
 *   - Swap events are tracked as initiations only (type: 'initiation').
 *   - parseFillEvent is a no-op stub — Stargate completion detection is deferred.
 *     Transfers will be marked 'stuck' after STUCK_THRESHOLDS_SECONDS.stargate
 *     (30 min) by the stuck-detector job and reconciled by a future job in Phase 1+.
 *
 * Design decisions:
 *   - getContractAddress returns the Router address to satisfy the BaseScout
 *     abstract contract (Liskov Substitution). Actual event listening happens on
 *     the individual Pool contracts inside start(). See comment on getContractAddress.
 *   - Multiple Pool contracts per chain: start() iterates WATCHED_POOL_IDS and
 *     registers a Swap listener on each Pool contract address independently.
 *   - tokenAddress: derived from dstPoolId + source chain. Since Stargate Pool 1 = USDC
 *     and Pool 2 = USDT across all chains, dstPoolId identifies the token type;
 *     we resolve the token address on the source chain (where the event fired).
 *   - chainId in Swap events: Stargate's internal chain ID (NOT EVM). Translated to
 *     ChainName via STARGATE_CHAIN_IDS for the destChain field.
 *   - transferId: `{sourceEVMChainId}_{txHash}` per docs/DATA-MODEL.md §13.1.
 *   - amount: amountSD (shared decimals) passed as-is. Processor normalises for storage.
 */

import { Contract, Interface, type Log } from 'ethers';

import { logger } from '../lib/logger';
import { BaseScout } from './base';
import {
  CHAIN_IDS,
  STARGATE_CHAIN_IDS,
  STARGATE_POOL_ADDRESSES,
  STARGATE_POOL_TOKEN_ADDRESSES,
  STARGATE_ROUTER_ADDRESSES,
  type ChainName,
} from '../lib/constants';
import type { TransferEvent } from '../types';

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/** Chains where Stargate V1 Pool contracts are deployed (DATA-MODEL.md §2.3). */
const STARGATE_SCOUT_CHAINS: ChainName[] = [
  'ethereum',
  'arbitrum',
  'optimism',
  'avalanche',
  'polygon',
];

/** Pool IDs to monitor. Pool 1 = USDC, Pool 2 = USDT. */
const WATCHED_POOL_IDS = [1, 2] as const;

/**
 * Reverse lookup: EVM chain ID → ChainName.
 * Used to resolve source chain from the numeric chainId passed by the listener.
 */
const EVM_CHAIN_ID_TO_NAME = new Map<number, ChainName>(
  (Object.entries(CHAIN_IDS) as [ChainName, number][]).map(([name, id]) => [id, name]),
);

/**
 * Minimal Pool ABI — only the Swap event (UPDATED-SPEC.md "Add Stargate (Week 3)").
 *
 * Field notes:
 *   chainId     — Stargate's internal destination chain ID (NOT the EVM chain ID).
 *                 Translate to ChainName via STARGATE_CHAIN_IDS.
 *   dstPoolId   — Destination pool ID. 1 = USDC, 2 = USDT. Same ID = same token type
 *                 as the source pool, so dstPoolId also identifies the source token.
 *   from        — Sender address.
 *   amountSD    — Transfer amount in shared decimals (6 dp for stablecoins). Passed
 *                 as-is to TransferEvent.amount; processor normalises for storage.
 *   eqReward    — Equilibrium reward paid to the sender.
 *   eqFee       — Equilibrium fee deducted from the swap.
 *   protocolFee — Protocol fee.
 *   lpFee       — Liquidity provider fee.
 */
const POOL_ABI = [
  'event Swap(uint16 chainId, uint256 dstPoolId, address from, uint256 amountSD, uint256 eqReward, uint256 eqFee, uint256 protocolFee, uint256 lpFee)',
] as const;

/** Shared Interface instance — stateless, safe to reuse across all chains and pools. */
const POOL_IFACE = new Interface(POOL_ABI);

// ---------------------------------------------------------------------------
// StargateScout
// ---------------------------------------------------------------------------

export class StargateScout extends BaseScout {
  constructor(onEvent: (event: TransferEvent) => Promise<void>) {
    super(STARGATE_SCOUT_CHAINS, onEvent);
    // Log once at construction — not per event — to avoid log spam.
    logger.warn(
      '[StargateScout] parseFillEvent is a no-op in Phase 0. ' +
        'Stargate transfers will be marked stuck after the 30-min threshold ' +
        'and reconciled by a future job.',
    );
  }

  // ---------------------------------------------------------------------------
  // BaseScout — contract address
  // ---------------------------------------------------------------------------

  /**
   * Returns the Stargate Router address for BaseScout interface compliance.
   *
   * StargateScout does NOT listen on the Router. Actual event listeners are
   * registered on individual Pool contracts in start(). The Router address is
   * returned here to satisfy the abstract contract (see docs/ENGINEERING-PRINCIPLES.md
   * Liskov Substitution). This avoids changing BaseScout for a single bridge's
   * multi-pool architecture.
   */
  getContractAddress(chain: ChainName): string {
    const address = STARGATE_ROUTER_ADDRESSES[chain];
    if (address === undefined) {
      throw new Error(`No Stargate Router address configured for chain: ${chain}`);
    }
    return address;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    for (const chain of this.chains) {
      const provider = this.rpcProviders.get(chain);
      if (provider === undefined) continue;

      const chainId = CHAIN_IDS[chain];
      const chainPools = STARGATE_POOL_ADDRESSES[chain];
      if (chainPools === undefined) continue;

      for (const poolId of WATCHED_POOL_IDS) {
        const poolAddress = chainPools[poolId];
        if (poolAddress === undefined) continue;

        const contract = new Contract(poolAddress, POOL_ABI, provider);

        const swapListener = async (...args: unknown[]): Promise<void> => {
          const payload = args[args.length - 1] as { log: Log };
          const log = payload.log;
          try {
            const block = await provider.getBlock(log.blockNumber);
            const timestamp = block !== null
              ? new Date(block.timestamp * 1000)
              : new Date();

            const event = this.parseDepositEvent(log, chainId, timestamp);
            if (event !== null) {
              await this.emit(event);
            }
          } catch (error) {
            logger.error('[StargateScout] Failed to process Swap event', {
              chain,
              poolId,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        };

        contract.on('Swap', swapListener);
        // Register cleanup so stop() can remove listeners without tracking
        // contract references individually (see BaseScout docs).
        this.eventListeners.push(() => contract.off('Swap', swapListener));
      }
    }
  }

  async stop(): Promise<void> {
    for (const cleanup of this.eventListeners) {
      cleanup();
    }
    this.eventListeners.length = 0;
    this.isRunning = false;
  }

  // ---------------------------------------------------------------------------
  // Event parsers
  // ---------------------------------------------------------------------------

  /**
   * Decode a Stargate Pool Swap log into an initiation TransferEvent.
   *
   * chainId    — EVM chain ID of the source chain (the chain this event was observed on).
   * timestamp  — block.timestamp for this log, fetched by the async listener.
   *
   * Returns null if:
   *   - The log cannot be decoded.
   *   - The Swap event's chainId (Stargate internal) is not in STARGATE_CHAIN_IDS.
   *   - The token address cannot be resolved from dstPoolId on the source chain.
   */
  parseDepositEvent(log: Log, chainId: number, timestamp: Date): TransferEvent | null {
    try {
      const decoded = POOL_IFACE.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });

      if (decoded === null || decoded.name !== 'Swap') return null;

      const {
        chainId: stargateDestChainId,
        dstPoolId,
        amountSD,
      } = decoded.args as unknown as {
        chainId: bigint;      // Stargate internal destination chain ID — NOT EVM
        dstPoolId: bigint;
        from: string;
        amountSD: bigint;
        eqReward: bigint;
        eqFee: bigint;
        protocolFee: bigint;
        lpFee: bigint;
      };

      // chainId (parameter) is from our own CHAIN_IDS map, so this should
      // never be undefined — guard defensively.
      const sourceChain = EVM_CHAIN_ID_TO_NAME.get(chainId);
      if (sourceChain === undefined) return null;

      // Swap event's chainId field is Stargate's internal ID, not EVM.
      const destChain = STARGATE_CHAIN_IDS[Number(stargateDestChainId)];
      if (destChain === undefined) {
        logger.warn('[StargateScout] Skipping swap — unrecognised Stargate destination chain', {
          stargateChainId: stargateDestChainId.toString(),
          txHash: log.transactionHash,
        });
        return null;
      }

      // dstPoolId identifies the token type (1=USDC, 2=USDT). Since pool IDs
      // hold the same token type across all chains, we use it to resolve the
      // token's address on the SOURCE chain — the token the user deposited.
      const tokenAddress = STARGATE_POOL_TOKEN_ADDRESSES[sourceChain]?.[Number(dstPoolId)];
      if (tokenAddress === undefined) {
        logger.warn('[StargateScout] Skipping swap — unknown pool ID on source chain', {
          sourceChain,
          dstPoolId: dstPoolId.toString(),
          txHash: log.transactionHash,
        });
        return null;
      }

      return {
        type: 'initiation',
        // DATA-MODEL.md §13.1: Stargate transfer ID = {sourceEVMChainId}_{txHash}
        transferId: this.generateTransferId(chainId, log.transactionHash),
        bridge: 'stargate',
        sourceChain,
        destChain,
        // Raw address (lowercase) — symbol resolution is the processor's responsibility.
        tokenAddress,
        // amountSD = amount in shared decimals (6 dp for stablecoins).
        // Processor normalises to human-readable amount for storage.
        amount: amountSD,
        timestamp,
        txHash: log.transactionHash,
        blockNumber: BigInt(log.blockNumber),
      };
    } catch (error) {
      logger.error('[StargateScout] Failed to decode Swap log', {
        blockNumber: log.blockNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Stargate completion detection is not implemented in Phase 0.
   *
   * Stargate V1 does not emit a single on-chain completion event that can be
   * trivially matched back to a Swap initiation by transfer ID. Transfers remain
   * 'pending' until the stuck-detector job marks them 'stuck' after 30 minutes
   * (STUCK_THRESHOLDS_SECONDS.stargate). A future reconciliation job will resolve
   * them in Phase 1+.
   */
  parseFillEvent(_log: Log, _chainId: number, _timestamp: Date): TransferEvent | null {
    return null;
  }
}
