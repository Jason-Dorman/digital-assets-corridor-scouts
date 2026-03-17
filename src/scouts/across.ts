/**
 * Across V3 bridge scout.
 *
 * Listens for V3FundsDeposited (initiations) and FilledV3Relay (completions)
 * on the Across SpokePool contract across Ethereum, Arbitrum, Optimism, and Base.
 *
 * Design decisions:
 *   - tokenAddress: raw inputToken address (lowercase). Symbol resolution is the
 *     transfer processor's responsibility (docs/DATA-MODEL.md §13.1).
 *   - amount: bigint directly from event args. Processor normalises for storage.
 *   - timestamp: derived from block.timestamp in the async listener and passed
 *     into parseDepositEvent / parseFillEvent, keeping the parsers synchronous.
 *   - Unknown chains in event args: logged and skipped rather than errored.
 */

import { Contract, Interface, type Log } from 'ethers';

import { BaseScout } from './base';
import {
  ACROSS_SPOKEPOOL_ADDRESSES,
  CHAIN_IDS,
  type ChainName,
} from '../lib/constants';
import type { TransferEvent } from '../types';

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/**
 * Chains where SpokePool addresses are verified and active.
 *
 * Polygon is excluded: the SpokePool address in constants.ts is marked TODO/unverified.
 * Add 'polygon' back once the address is confirmed against https://docs.across.to/reference/contract-addresses
 */
const ACROSS_SCOUT_CHAINS: ChainName[] = ['ethereum', 'arbitrum', 'optimism', 'base'];

/**
 * Reverse lookup: numeric chain ID → ChainName.
 *
 * Covers all entries in CHAIN_IDS so we can identify any destination or origin
 * chain that appears in Across event args (not just the 4 we actively scout).
 */
const CHAIN_ID_TO_NAME = new Map<number, ChainName>(
  (Object.entries(CHAIN_IDS) as [ChainName, number][]).map(([name, id]) => [id, name]),
);

/**
 * Minimal ABI — only the two SpokePool events we listen for.
 *
 * V3RelayExecutionEventInfo tuple (FilledV3Relay):
 *   (address updatedRecipient, bytes updatedMessage, uint256 updatedOutputAmount, uint8 fillType)
 *
 * Source: UPDATED-SPEC.md "Start with Across (Week 1-2)".
 */
const SPOKE_POOL_ABI = [
  'event V3FundsDeposited(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint32 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, address indexed depositor, address recipient, address exclusiveRelayer, bytes message)',
  'event FilledV3Relay(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint32 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, address exclusiveRelayer, address indexed relayer, address depositor, address recipient, bytes message, (address updatedRecipient, bytes updatedMessage, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)',
] as const;

/** Shared Interface instance — stateless, safe to reuse across all chains. */
const SPOKE_POOL_IFACE = new Interface(SPOKE_POOL_ABI);

// ---------------------------------------------------------------------------
// AcrossScout
// ---------------------------------------------------------------------------

export class AcrossScout extends BaseScout {
  constructor(onEvent: (event: import('../types').TransferEvent) => Promise<void>) {
    super(ACROSS_SCOUT_CHAINS, onEvent);
  }

  // ---------------------------------------------------------------------------
  // BaseScout — contract address
  // ---------------------------------------------------------------------------

  getContractAddress(chain: ChainName): string {
    const address = ACROSS_SPOKEPOOL_ADDRESSES[chain];
    if (address === undefined) {
      throw new Error(`No SpokePool address configured for chain: ${chain}`);
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

      let address: string;
      try {
        address = this.getContractAddress(chain);
      } catch (error) {
        console.error('[AcrossScout] No contract address — skipping chain', { chain, error });
        continue;
      }

      const contract = new Contract(address, SPOKE_POOL_ABI, provider);
      const chainId = CHAIN_IDS[chain];

      // Each listener receives decoded event args + ContractEventPayload as the
      // final argument. We access payload.log for the raw Log data needed by
      // our parse methods, and fetch the block timestamp asynchronously here
      // before calling the synchronous parser.

      const depositListener = async (...args: unknown[]): Promise<void> => {
        const payload = args[args.length - 1] as { log: Log };
        const log = payload.log;
        try {
          const timestamp = await this.getBlockTimestamp(provider, chainId, log.blockNumber);
          const event = this.parseDepositEvent(log, chainId, timestamp);
          if (event !== null) {
            await this.emit(event);
          }
        } catch (error) {
          console.error('[AcrossScout] Failed to process V3FundsDeposited', {
            chain,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            error,
          });
        }
      };

      const fillListener = async (...args: unknown[]): Promise<void> => {
        const payload = args[args.length - 1] as { log: Log };
        const log = payload.log;
        try {
          const timestamp = await this.getBlockTimestamp(provider, chainId, log.blockNumber);
          const event = this.parseFillEvent(log, chainId, timestamp);
          if (event !== null) {
            await this.emit(event);
          }
        } catch (error) {
          console.error('[AcrossScout] Failed to process FilledV3Relay', {
            chain,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            error,
          });
        }
      };

      contract.on('V3FundsDeposited', depositListener);
      contract.on('FilledV3Relay', fillListener);

      // Register cleanup so stop() can remove listeners without tracking
      // contract references individually (see BaseScout docs).
      this.eventListeners.push(() => {
        contract.off('V3FundsDeposited', depositListener);
        contract.off('FilledV3Relay', fillListener);
      });
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
   * Decode a V3FundsDeposited log into an initiation TransferEvent.
   *
   * chainId    — numeric ID of the chain where this event was observed (source chain).
   * timestamp  — block.timestamp for this log, fetched by the async listener.
   * Returns null if decoding fails or the destination chain is not in CHAIN_IDS.
   */
  parseDepositEvent(log: Log, chainId: number, timestamp: Date): TransferEvent | null {
    try {
      const decoded = SPOKE_POOL_IFACE.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });

      if (decoded === null || decoded.name !== 'V3FundsDeposited') return null;

      const {
        inputToken,
        inputAmount,
        destinationChainId,
        depositId,
      } = decoded.args as unknown as {
        inputToken: string;
        inputAmount: bigint;
        destinationChainId: bigint;
        depositId: bigint;
      };

      // chainId is from our own chain list so this should never be undefined,
      // but guard defensively.
      const sourceChain = CHAIN_ID_TO_NAME.get(chainId);
      if (sourceChain === undefined) return null;

      const destChain = CHAIN_ID_TO_NAME.get(Number(destinationChainId));
      if (destChain === undefined) {
        console.warn('[AcrossScout] Skipping deposit — unrecognised destination chain', {
          destinationChainId: destinationChainId.toString(),
          depositId: depositId.toString(),
        });
        return null;
      }

      return {
        type: 'initiation',
        // DATA-MODEL.md §13.1: Across transfer ID = {originChainId}_{depositId}
        // For deposits, the listening chain IS the origin chain.
        transferId: this.generateTransferId(chainId, Number(depositId)),
        bridge: 'across',
        sourceChain,
        destChain,
        // Raw address — symbol resolution is the processor's responsibility.
        tokenAddress: inputToken.toLowerCase(),
        amount: inputAmount,
        timestamp,
        txHash: log.transactionHash,
        blockNumber: BigInt(log.blockNumber),
      };
    } catch (error) {
      console.error('[AcrossScout] Failed to decode V3FundsDeposited log', {
        blockNumber: log.blockNumber,
        error,
      });
      return null;
    }
  }

  /**
   * Decode a FilledV3Relay log into a completion TransferEvent.
   *
   * chainId    — numeric ID of the chain where this event was observed (dest chain).
   * timestamp  — block.timestamp for this log, fetched by the async listener.
   * Returns null if decoding fails or the origin chain is not in CHAIN_IDS.
   */
  parseFillEvent(log: Log, chainId: number, timestamp: Date): TransferEvent | null {
    try {
      const decoded = SPOKE_POOL_IFACE.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });

      if (decoded === null || decoded.name !== 'FilledV3Relay') return null;

      const {
        inputToken,
        inputAmount,
        originChainId,
        depositId,
      } = decoded.args as unknown as {
        inputToken: string;
        inputAmount: bigint;
        originChainId: bigint;
        depositId: bigint;
      };

      const sourceChain = CHAIN_ID_TO_NAME.get(Number(originChainId));
      if (sourceChain === undefined) {
        console.warn('[AcrossScout] Skipping fill — unrecognised origin chain', {
          originChainId: originChainId.toString(),
          depositId: depositId.toString(),
        });
        return null;
      }

      // chainId is from our own chain list so this should never be undefined.
      const destChain = CHAIN_ID_TO_NAME.get(chainId);
      if (destChain === undefined) return null;

      return {
        type: 'completion',
        // DATA-MODEL.md §13.1: Across transfer ID = {originChainId}_{depositId}
        // originChainId comes from the event args — the chain where the deposit
        // was made, not the chain we are currently listening on.
        transferId: this.generateTransferId(Number(originChainId), Number(depositId)),
        bridge: 'across',
        sourceChain,
        destChain,
        // Raw address — symbol resolution is the processor's responsibility.
        tokenAddress: inputToken.toLowerCase(),
        amount: inputAmount,
        timestamp,
        txHash: log.transactionHash,
        blockNumber: BigInt(log.blockNumber),
      };
    } catch (error) {
      console.error('[AcrossScout] Failed to decode FilledV3Relay log', {
        blockNumber: log.blockNumber,
        error,
      });
      return null;
    }
  }
}
