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
 * Fields that are only known at initiation time (txHashSource, blockInitiated)
 * or at completion time (txHashDest, blockCompleted, completedAt) are optional
 * so the same type covers both event kinds.
 *
 * bigint values (amount, blockInitiated, blockCompleted) are serialised as
 * decimal strings for JSON compatibility.
 */
export interface TransferEvent {
  transferId: string;
  bridge: import('../lib/constants').BridgeName;
  sourceChain: import('../lib/constants').ChainName;
  destChain: import('../lib/constants').ChainName;
  asset: string;
  /** Raw on-chain amount as a decimal string (e.g. "10000000000" for 10k USDC). */
  amount: string;
  amountUsd?: number;
  initiatedAt?: string;  // ISO 8601
  completedAt?: string;  // ISO 8601
  status: TransferStatus;
  txHashSource?: string;
  txHashDest?: string;
  /** Source chain block number as a decimal string. */
  blockInitiated?: string;
  /** Destination chain block number as a decimal string. */
  blockCompleted?: string;
  gasPriceGwei?: number;
}
