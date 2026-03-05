/**
 * Core TypeScript types for Corridor Scout.
 *
 * Enum-like union types are defined here per docs/DATA-MODEL.md §1.
 * BridgeName and ChainName are derived from constants so that
 * the single source of truth remains in src/lib/constants.ts.
 *
 * TransferEvent represents a serialised event published to Redis by
 * a scout. bigint fields are serialised as decimal strings for JSON
 * compatibility.
 */
export type { BridgeName, ChainName } from '../lib/constants';

// ---------------------------------------------------------------------------
// docs/DATA-MODEL.md §1.1
// ---------------------------------------------------------------------------
export type TransferStatus = 'pending' | 'completed' | 'stuck' | 'failed';

// ---------------------------------------------------------------------------
// docs/DATA-MODEL.md §1.2
// ---------------------------------------------------------------------------
export type HealthStatus = 'healthy' | 'degraded' | 'down';

// ---------------------------------------------------------------------------
// docs/DATA-MODEL.md §1.3
// ---------------------------------------------------------------------------
export type FragilityLevel = 'low' | 'medium' | 'high';

// ---------------------------------------------------------------------------
// docs/DATA-MODEL.md §1.4
// ---------------------------------------------------------------------------
export type ImpactLevel = 'negligible' | 'low' | 'moderate' | 'high' | 'severe';

// ---------------------------------------------------------------------------
// docs/DATA-MODEL.md §1.5
// ---------------------------------------------------------------------------
export type LFVInterpretation =
  | 'rapid_flight'
  | 'moderate_outflow'
  | 'stable'
  | 'moderate_inflow'
  | 'rapid_inflow';

// ---------------------------------------------------------------------------
// docs/DATA-MODEL.md §1.6
// ---------------------------------------------------------------------------
export type AnomalyType =
  | 'latency_spike'
  | 'failure_cluster'
  | 'liquidity_drop'
  | 'stuck_transfer';

// ---------------------------------------------------------------------------
// docs/DATA-MODEL.md §1.7
// ---------------------------------------------------------------------------
export type Severity = 'low' | 'medium' | 'high';

// ---------------------------------------------------------------------------
// docs/DATA-MODEL.md §3.2
// ---------------------------------------------------------------------------
export type TransferSizeBucket = 'small' | 'medium' | 'large' | 'whale';

// ---------------------------------------------------------------------------
// Transfer event emitted to Redis by scouts
// ---------------------------------------------------------------------------

/**
 * Payload published to `transfer:initiated` or `transfer:completed`.
 *
 * Each event represents exactly ONE on-chain transaction. No optional fields.
 * The processor combines two events (initiation + completion) into one
 * transfer database record.
 *
 * Serialised to Redis via superjson, which handles bigint and Date natively.
 */
export interface TransferEvent {
  type: 'initiation' | 'completion';
  transferId: string;
  bridge: import('../lib/constants').BridgeName;
  sourceChain: import('../lib/constants').ChainName;
  destChain: import('../lib/constants').ChainName;
  /** Raw on-chain token address (lowercase). Processor resolves to symbol. */
  tokenAddress: string;
  /** Raw on-chain amount as bigint. Processor normalises for storage. */
  amount: bigint;
  timestamp: Date;
  txHash: string;
  blockNumber: bigint;
}
