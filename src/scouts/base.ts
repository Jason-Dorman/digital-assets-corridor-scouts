/**
 * Abstract base class for all bridge scouts.
 *
 * Each scout extends this class to listen to a specific bridge's contracts
 * and hand decoded TransferEvents directly to the provided onEvent handler
 * (the TransferProcessor). Scouts and the processor run in the same process —
 * there is no Redis queue between them. Redis pub/sub is used only by the
 * processor to broadcast enriched events to external WebSocket consumers.
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
 * Block timestamps are cached per scout instance (keyed by blockNumber) to
 * avoid redundant eth_getBlockByNumber RPC calls when multiple events land
 * in the same block. The cache is bounded to BLOCK_CACHE_SIZE entries.
 *
 * Subclasses should use eventListeners to register cleanup functions so that
 * stop() can remove all contract listeners without needing to track them
 * individually:
 *
 *   contract.on('EventName', listener);
 *   this.eventListeners.push(() => contract.off('EventName', listener));
 */
import type { JsonRpcProvider, Log } from 'ethers';

import { getProvider } from '../lib/rpc';
import { type ChainName } from '../lib/constants';
import type { TransferEvent } from '../types';

/** Maximum number of block timestamps to cache per scout instance. */
const BLOCK_CACHE_SIZE = 100;

export abstract class BaseScout {
  protected readonly rpcProviders: Map<ChainName, JsonRpcProvider>;
  protected readonly chains: ChainName[];
  protected isRunning: boolean;
  protected readonly eventListeners: Array<() => void>;

  /**
   * Handler invoked for each decoded TransferEvent.
   * Injected at construction time — typically TransferProcessor.processEvent.
   */
  private readonly onEvent: (event: TransferEvent) => Promise<void>;

  /**
   * Block timestamp cache: "{chainId}_{blockNumber}" → Date.
   *
   * The key includes chainId because multiple chains can share the same block
   * number (e.g. Ethereum block 21_000_000 and Base block 21_000_000 have
   * different timestamps). Using a compound key prevents one chain's cached
   * timestamp from poisoning a different chain's lookup.
   *
   * Shared across all chains in a single scout instance; bounded to
   * BLOCK_CACHE_SIZE entries (oldest evicted when full).
   */
  private readonly blockCache: Map<string, Date> = new Map();

  constructor(chains: ChainName[], onEvent: (event: TransferEvent) => Promise<void>) {
    this.chains = chains;
    this.onEvent = onEvent;
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
   * Hand a decoded TransferEvent to the processor.
   *
   * Calls the onEvent handler injected at construction (TransferProcessor).
   * The processor writes to the database and then publishes to Redis for
   * WebSocket broadcast — scouts do not touch Redis directly.
   */
  protected async emit(event: TransferEvent): Promise<void> {
    await this.onEvent(event);
  }

  /**
   * Fetch a block timestamp, using the instance cache to avoid redundant
   * eth_getBlockByNumber calls for events in the same block.
   *
   * The chainId parameter is required to prevent cache collisions: different
   * chains can have the same block number with different timestamps.
   *
   * Falls back to the current wall-clock time if the RPC call fails.
   */
  protected async getBlockTimestamp(
    provider: JsonRpcProvider,
    chainId: number,
    blockNumber: number,
  ): Promise<Date> {
    const cacheKey = `${chainId}_${blockNumber}`;
    const cached = this.blockCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const block = await provider.getBlock(blockNumber);
    let timestamp: Date;
    if (block !== null) {
      timestamp = new Date(block.timestamp * 1000);
    } else {
      console.warn('[BaseScout] Block not found — using wall-clock time as fallback; affected timestamps may be inaccurate', {
        chainId,
        blockNumber,
      });
      timestamp = new Date();
    }

    // Evict oldest entry when cache is full
    if (this.blockCache.size >= BLOCK_CACHE_SIZE) {
      const oldestKey = this.blockCache.keys().next().value;
      if (oldestKey !== undefined) this.blockCache.delete(oldestKey);
    }
    this.blockCache.set(cacheKey, timestamp);
    return timestamp;
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
}
