/**
 * Abstract base class for all bridge scouts.
 *
 * Each scout extends this class to listen to a specific bridge's contracts
 * and emit TransferEvent payloads to Redis for downstream processing.
 *
 * Subclasses must implement:
 *   - start() / stop()                          — lifecycle management
 *   - getContractAddress(chain)                 — contract address for a given chain
 *   - parseDepositEvent(log, chainId, timestamp) — convert a deposit log to a TransferEvent
 *   - parseFillEvent(log, chainId, timestamp)    — convert a fill/completion log to a TransferEvent
 *
 * The timestamp parameter is provided by the async listener after fetching
 * block.timestamp, keeping the parsers themselves synchronous and focused
 * purely on log decoding.
 *
 * Subclasses should use eventListeners to register cleanup functions so that
 * stop() can remove all contract listeners without needing to track them
 * individually:
 *
 *   contract.on('EventName', listener);
 *   this.eventListeners.push(() => contract.off('EventName', listener));
 */
import type { JsonRpcProvider, Log } from 'ethers';
import type Redis from 'ioredis';

import { redis, publish } from '../lib/redis';
import { getProvider } from '../lib/rpc';
import {
  REDIS_CHANNELS,
  SIZE_BUCKET_THRESHOLDS,
  type ChainName,
} from '../lib/constants';
import type { TransferEvent, TransferSizeBucket } from '../types';

export abstract class BaseScout {
  protected readonly rpcProviders: Map<ChainName, JsonRpcProvider>;
  protected readonly redis: Redis;
  protected readonly chains: ChainName[];
  protected isRunning: boolean;
  protected readonly eventListeners: Array<() => void>;

  constructor(chains: ChainName[]) {
    this.chains = chains;
    this.redis = redis;
    this.isRunning = false;
    this.eventListeners = [];
    this.rpcProviders = new Map(
      chains.map(chain => [chain, getProvider(chain)]),
    );
  }

  // ---------------------------------------------------------------------------
  // Abstract — implemented per bridge
  // ---------------------------------------------------------------------------

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  /** Return the contract address to watch on the given chain. */
  abstract getContractAddress(chain: ChainName): string;

  /**
   * Parse a deposit/initiation log into a TransferEvent.
   * Returns null if the log cannot be decoded (e.g. unrelated event on the same contract).
   * The timestamp is fetched from block.timestamp by the async listener and passed in.
   */
  abstract parseDepositEvent(log: Log, chainId: number, timestamp: Date): TransferEvent | null;

  /**
   * Parse a fill/completion log into a TransferEvent.
   * Returns null if the log cannot be decoded.
   * The timestamp is fetched from block.timestamp by the async listener and passed in.
   */
  abstract parseFillEvent(log: Log, chainId: number, timestamp: Date): TransferEvent | null;

  // ---------------------------------------------------------------------------
  // Protected helpers — shared across all scouts
  // ---------------------------------------------------------------------------

  /**
   * Publish a TransferEvent to the appropriate Redis channel.
   *
   * Routing:
   *   type 'initiation' → transfer:initiated
   *   type 'completion' → transfer:completed
   */
  protected async emit(event: TransferEvent): Promise<void> {
    if (event.type === 'initiation') {
      await publish(REDIS_CHANNELS.TRANSFER_INITIATED, event);
    } else if (event.type === 'completion') {
      await publish(REDIS_CHANNELS.TRANSFER_COMPLETED, event);
    }
  }

  /**
   * Build a transfer ID from a chain identifier and a bridge-specific key.
   *
   * Formats by bridge (docs/DATA-MODEL.md §13.1):
   *   Across   → generateTransferId(originChainId, depositId)   → "1_12345"
   *   CCTP     → generateTransferId(sourceDomain, nonce)         → "0_67890"
   *   Stargate → generateTransferId(chainId, txHash)             → "1_0xabc…"
   */
  protected generateTransferId(
    chainId: number | string,
    identifier: number | string,
  ): string {
    return `${chainId}_${identifier}`;
  }

  /**
   * Classify a USD transfer amount into a size bucket.
   *
   * Thresholds (docs/DATA-MODEL.md §3.2):
   *   small  : < $10,000
   *   medium : $10,000 – $99,999
   *   large  : $100,000 – $999,999
   *   whale  : ≥ $1,000,000
   */
  protected getSizeBucket(amountUsd: number): TransferSizeBucket {
    if (amountUsd < SIZE_BUCKET_THRESHOLDS.small) return 'small';
    if (amountUsd < SIZE_BUCKET_THRESHOLDS.medium) return 'medium';
    if (amountUsd < SIZE_BUCKET_THRESHOLDS.large) return 'large';
    return 'whale';
  }
}
