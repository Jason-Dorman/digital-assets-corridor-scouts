/**
 * Circle CCTP V1 bridge scout.
 *
 * Listens for DepositForBurn (initiations) on the TokenMessenger contract and
 * MessageReceived (completions) on the MessageTransmitter contract across
 * Ethereum, Arbitrum, Optimism, Base, and Avalanche.
 *
 * Design decisions:
 *   - Two contracts per chain: TokenMessenger (source) and MessageTransmitter
 *     (destination). getContractAddress() returns the TokenMessenger address;
 *     MessageTransmitter addresses are resolved via the private
 *     getMessageTransmitterAddress() method. This keeps the BaseScout interface
 *     satisfied while containing CCTP-specific complexity within this class.
 *   - tokenAddress: raw burnToken address (lowercase). Symbol resolution
 *     (always USDC for CCTP) is the transfer processor's responsibility
 *     (docs/DATA-MODEL.md §13.1).
 *   - amount: bigint directly from DepositForBurn args. Processor normalises.
 *   - timestamp: derived from block.timestamp in the async listener and passed
 *     into parseDepositEvent / parseFillEvent, keeping the parsers synchronous.
 *   - Transfer ID format: {sourceDomain}_{nonce} (docs/DATA-MODEL.md §13.1).
 *   - MessageReceived does not carry burnToken or amount. tokenAddress is set
 *     to the zero address and amount to 0n as explicit sentinels — the
 *     processor resolves real values from the stored initiation record on match
 *     (docs/DATA-MODEL.md §13.1 CCTP completion note).
 *   - Unknown domains in event args: logged and skipped rather than errored.
 */

import { Contract, Interface, type Log } from 'ethers';

import { logger } from '../lib/logger';
import { BaseScout } from './base';
import {
  CCTP_TOKEN_MESSENGER_ADDRESSES,
  CCTP_MESSAGE_TRANSMITTER_ADDRESSES,
  CCTP_DOMAINS,
  CHAIN_IDS,
  type ChainName,
} from '../lib/constants';
import type { TransferEvent } from '../types';

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/** Chains where CCTP V1 contracts are deployed (UPDATED-SPEC.md, Week 3). */
const CCTP_SCOUT_CHAINS: ChainName[] = ['ethereum', 'arbitrum', 'optimism', 'base', 'avalanche'];

/**
 * Reverse lookup: numeric EVM chain ID → ChainName.
 * Used to resolve source/dest chain names from the chainId passed to parsers.
 */
const CHAIN_ID_TO_NAME = new Map<number, ChainName>(
  (Object.entries(CHAIN_IDS) as [ChainName, number][]).map(([name, id]) => [id, name]),
);

/**
 * Reverse lookup: CCTP domain number → ChainName.
 * Used to resolve chain names from domain numbers in CCTP event args.
 */
const CCTP_DOMAIN_TO_CHAIN = new Map<number, ChainName>(
  (Object.entries(CCTP_DOMAINS) as [ChainName, number][]).map(([name, domain]) => [domain, name]),
);

/**
 * Sentinel value for tokenAddress on CCTP completion events.
 * MessageReceived does not carry the burn token address — the processor
 * resolves the token from the matched initiation record.
 * See docs/DATA-MODEL.md §13.1 for rationale.
 */
const COMPLETION_TOKEN_SENTINEL = '0x0000000000000000000000000000000000000000';

/**
 * Minimal ABIs — one event per contract.
 * Source: UPDATED-SPEC.md "Add CCTP (Week 3)".
 */
const TOKEN_MESSENGER_ABI = [
  'event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)',
] as const;

const MESSAGE_TRANSMITTER_ABI = [
  'event MessageReceived(address indexed caller, uint32 sourceDomain, uint64 indexed nonce, bytes32 sender, bytes messageBody)',
] as const;

/** Shared Interface instances — stateless, safe to reuse across all chains. */
const TOKEN_MESSENGER_IFACE = new Interface(TOKEN_MESSENGER_ABI);
const MESSAGE_TRANSMITTER_IFACE = new Interface(MESSAGE_TRANSMITTER_ABI);

// ---------------------------------------------------------------------------
// CCTPScout
// ---------------------------------------------------------------------------

export class CCTPScout extends BaseScout {
  constructor(onEvent: (event: TransferEvent) => Promise<void>) {
    super(CCTP_SCOUT_CHAINS, onEvent);
  }

  // ---------------------------------------------------------------------------
  // BaseScout — contract addresses
  // ---------------------------------------------------------------------------

  /**
   * Returns the TokenMessenger address for the given chain (initiation contract).
   * Satisfies the BaseScout interface; called in start() for DepositForBurn listeners.
   */
  getContractAddress(chain: ChainName): string {
    const address = CCTP_TOKEN_MESSENGER_ADDRESSES[chain];
    if (address === undefined) {
      throw new Error(`No CCTP TokenMessenger address configured for chain: ${chain}`);
    }
    return address;
  }

  /**
   * Returns the MessageTransmitter address for the given chain (completion contract).
   * CCTP requires two contracts per chain — this is the second address, used for
   * MessageReceived listeners. Not part of the BaseScout interface.
   */
  private getMessageTransmitterAddress(chain: ChainName): string {
    const address = CCTP_MESSAGE_TRANSMITTER_ADDRESSES[chain];
    if (address === undefined) {
      throw new Error(`No CCTP MessageTransmitter address configured for chain: ${chain}`);
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

      // --- TokenMessenger: DepositForBurn (initiations) ---

      let tokenMessengerAddress: string;
      try {
        tokenMessengerAddress = this.getContractAddress(chain);
      } catch (error) {
        logger.error('[CCTPScout] No TokenMessenger address — skipping chain', { chain, error: error instanceof Error ? error.message : String(error) });
        continue;
      }

      const tokenMessenger = new Contract(tokenMessengerAddress, TOKEN_MESSENGER_ABI, provider);

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
          logger.error('[CCTPScout] Failed to process DepositForBurn', {
            chain,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      tokenMessenger.on('DepositForBurn', depositListener);
      this.eventListeners.push(() => tokenMessenger.off('DepositForBurn', depositListener));

      // --- MessageTransmitter: MessageReceived (completions) ---

      let messageTransmitterAddress: string;
      try {
        messageTransmitterAddress = this.getMessageTransmitterAddress(chain);
      } catch (error) {
        logger.error('[CCTPScout] No MessageTransmitter address — completions will not be tracked', { chain, error: error instanceof Error ? error.message : String(error) });
        // Deposit listener for this chain is already registered.
        // Skip only the completion side; continue to next chain.
        continue;
      }

      const messageTransmitter = new Contract(
        messageTransmitterAddress,
        MESSAGE_TRANSMITTER_ABI,
        provider,
      );

      const receiveListener = async (...args: unknown[]): Promise<void> => {
        const payload = args[args.length - 1] as { log: Log };
        const log = payload.log;
        try {
          const timestamp = await this.getBlockTimestamp(provider, chainId, log.blockNumber);
          const event = this.parseFillEvent(log, chainId, timestamp);
          if (event !== null) {
            await this.emit(event);
          }
        } catch (error) {
          logger.error('[CCTPScout] Failed to process MessageReceived', {
            chain,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      messageTransmitter.on('MessageReceived', receiveListener);
      this.eventListeners.push(() => messageTransmitter.off('MessageReceived', receiveListener));
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
   * Decode a DepositForBurn log into an initiation TransferEvent.
   *
   * chainId    — numeric EVM chain ID where this event was observed (source chain).
   * timestamp  — block.timestamp for this log, fetched by the async listener.
   * Returns null if decoding fails or the destination domain is unknown.
   */
  parseDepositEvent(log: Log, chainId: number, timestamp: Date): TransferEvent | null {
    try {
      const decoded = TOKEN_MESSENGER_IFACE.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });

      if (decoded === null || decoded.name !== 'DepositForBurn') return null;

      const {
        nonce,
        burnToken,
        amount,
        destinationDomain,
      } = decoded.args as unknown as {
        nonce: bigint;
        burnToken: string;
        amount: bigint;
        // ethers v6 decodes uint32 as bigint at runtime — use Number() for map lookups.
        destinationDomain: bigint;
      };

      const sourceChain = CHAIN_ID_TO_NAME.get(chainId);
      if (sourceChain === undefined) return null;

      const sourceDomain = CCTP_DOMAINS[sourceChain];
      if (sourceDomain === undefined) return null;

      const destChain = CCTP_DOMAIN_TO_CHAIN.get(Number(destinationDomain));
      if (destChain === undefined) {
        logger.warn('[CCTPScout] Skipping deposit — unrecognised destination domain', {
          destinationDomain: destinationDomain.toString(),
          nonce: nonce.toString(),
        });
        return null;
      }

      return {
        type: 'initiation',
        // docs/DATA-MODEL.md §13.1: CCTP transfer ID = {sourceDomain}_{nonce}
        transferId: this.generateTransferId(sourceDomain, nonce.toString()),
        bridge: 'cctp',
        sourceChain,
        destChain,
        // Raw address — symbol resolution (USDC) is the processor's responsibility.
        tokenAddress: burnToken.toLowerCase(),
        amount,
        timestamp,
        txHash: log.transactionHash,
        blockNumber: BigInt(log.blockNumber),
      };
    } catch (error) {
      logger.error('[CCTPScout] Failed to decode DepositForBurn log', {
        blockNumber: log.blockNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Decode a MessageReceived log into a completion TransferEvent.
   *
   * chainId    — numeric EVM chain ID where this event was observed (dest chain).
   * timestamp  — block.timestamp for this log, fetched by the async listener.
   * Returns null if decoding fails or the source domain is unknown.
   *
   * Note: MessageReceived does not carry burnToken or amount. tokenAddress is
   * set to COMPLETION_TOKEN_SENTINEL (zero address) and amount to 0n.
   * The processor resolves real values from the matched initiation record.
   */
  parseFillEvent(log: Log, chainId: number, timestamp: Date): TransferEvent | null {
    try {
      const decoded = MESSAGE_TRANSMITTER_IFACE.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });

      if (decoded === null || decoded.name !== 'MessageReceived') return null;

      const {
        sourceDomain,
        nonce,
      } = decoded.args as unknown as {
        // ethers v6 decodes uint32 as bigint at runtime — use Number() for map lookups.
        sourceDomain: bigint;
        nonce: bigint;
      };

      const sourceChain = CCTP_DOMAIN_TO_CHAIN.get(Number(sourceDomain));
      if (sourceChain === undefined) {
        logger.warn('[CCTPScout] Skipping fill — unrecognised source domain', {
          sourceDomain: sourceDomain.toString(),
          nonce: nonce.toString(),
        });
        return null;
      }

      // chainId is from our own chain list so this should never be undefined,
      // but guard defensively.
      const destChain = CHAIN_ID_TO_NAME.get(chainId);
      if (destChain === undefined) return null;

      return {
        type: 'completion',
        // docs/DATA-MODEL.md §13.1: CCTP transfer ID = {sourceDomain}_{nonce}
        // sourceDomain comes from the event args — identifies the chain where
        // the DepositForBurn was initiated, matching the initiation's transferId.
        transferId: this.generateTransferId(Number(sourceDomain), nonce.toString()),
        bridge: 'cctp',
        sourceChain,
        destChain,
        // MessageReceived does not carry the burn token address or amount.
        // Processor resolves real values from the matched initiation record.
        tokenAddress: COMPLETION_TOKEN_SENTINEL,
        amount: 0n,
        timestamp,
        txHash: log.transactionHash,
        blockNumber: BigInt(log.blockNumber),
      };
    } catch (error) {
      logger.error('[CCTPScout] Failed to decode MessageReceived log', {
        blockNumber: log.blockNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
