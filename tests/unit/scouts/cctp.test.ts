/**
 * Tests for src/scouts/cctp.ts
 *
 * Strategy mirrors across.test.ts:
 *   - parseDepositEvent / parseFillEvent are tested directly with real ABI-encoded
 *     logs produced by ethers Interface.encodeEventLog(). No mocks required for parsing.
 *   - start() / stop() lifecycle tests verify listener registration via a mocked
 *     ethers.Contract. Listener callbacks are then invoked directly to test the
 *     block-fetch → timestamp → emit pipeline.
 *   - lib/redis and lib/rpc are fully mocked — no real connections are made.
 *
 * CCTP-specific notes:
 *   - Two contracts per chain (TokenMessenger + MessageTransmitter) → start()
 *     registers 2 listeners per chain (10 total across 5 chains) and pushes 2
 *     cleanup functions per chain (10 total in eventListeners).
 *   - MessageReceived (completion) does not carry burnToken or amount. parseFillEvent
 *     sets tokenAddress to COMPLETION_TOKEN_SENTINEL (zero address) and amount to 0n.
 */

// ---------------------------------------------------------------------------
// Mock declarations — named with 'mock' prefix so Jest hoists them alongside
// jest.mock() factory calls.
// ---------------------------------------------------------------------------

const mockPublish = jest.fn().mockResolvedValue(undefined);
const mockRedisInstance = { publish: jest.fn() };

/** Injected into CCTPScout in place of TransferProcessor.processEvent */
const mockOnEvent = jest.fn().mockResolvedValue(undefined);

const mockContractOn = jest.fn();
const mockContractOff = jest.fn();

const mockGetBlock = jest.fn();
const mockGetProvider = jest.fn().mockImplementation(() => ({
  getBlock: mockGetBlock,
}));

jest.mock('../../../src/lib/redis', () => ({
  redis: mockRedisInstance,
  publish: mockPublish,
  subscribe: jest.fn(),
}));

jest.mock('../../../src/lib/rpc', () => ({
  getProvider: mockGetProvider,
}));

// Mock resilient-rpc to execute fn() directly without retry delays.
jest.mock('../../../src/lib/resilient-rpc', () => ({
  resilientRpcCall: async <T>(fn: (p?: unknown) => Promise<T>): Promise<T> => fn(),
}));

// Spread the real ethers module and replace only Contract so that Interface
// (used both in the scout and in our test helpers) remains the real implementation.
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    Contract: jest.fn().mockImplementation(() => ({
      on: mockContractOn,
      off: mockContractOff,
    })),
  };
});

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { Interface, type Log } from 'ethers';
import { CCTPScout } from '../../../src/scouts/cctp';
import {
  CCTP_TOKEN_MESSENGER_ADDRESSES,
  CCTP_DOMAINS,
  CHAIN_IDS,
} from '../../../src/lib/constants';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const USDC_ETH   = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DEPOSITOR  = '0x1111111111111111111111111111111111111111';
const CALLER     = '0x4444444444444444444444444444444444444444';
const ZERO_ADDR  = '0x0000000000000000000000000000000000000000';
const ZERO_B32   = '0x' + '00'.repeat(32);

const NONCE       = BigInt(67890);
const BURN_AMOUNT = BigInt('10000000000'); // 10 000 USDC (6 decimals)

// CCTP domain numbers from constants
const DOMAIN_ETHEREUM  = CCTP_DOMAINS.ethereum!;   // 0
const DOMAIN_ARBITRUM  = CCTP_DOMAINS.arbitrum!;   // 3

const TEST_TIMESTAMP          = new Date('2026-01-01T00:00:00Z');
const BLOCK_TIMESTAMP_SECONDS = Math.floor(TEST_TIMESTAMP.getTime() / 1000);

// Mirror the exact ABI strings from cctp.ts so we can encode test logs with
// the same interface the scout uses to decode them.
const DEPOSIT_FOR_BURN_ABI =
  'event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)';

const MESSAGE_RECEIVED_ABI =
  'event MessageReceived(address indexed caller, uint32 sourceDomain, uint64 indexed nonce, bytes32 sender, bytes messageBody)';

const testIface = new Interface([DEPOSIT_FOR_BURN_ABI, MESSAGE_RECEIVED_ABI]);

// ---------------------------------------------------------------------------
// Log encoding helpers
// ---------------------------------------------------------------------------

interface DepositLogOpts {
  nonce?: bigint;
  burnToken?: string;
  amount?: bigint;
  destinationDomain?: number;
  txHash?: string;
  blockNumber?: number;
}

function encodeDepositLog(opts: DepositLogOpts = {}): Log {
  const {
    nonce = NONCE,
    burnToken = USDC_ETH,
    amount = BURN_AMOUNT,
    destinationDomain = DOMAIN_ARBITRUM,
    txHash = '0xdeposit1111111111111111111111111111111111111111111111111111111111',
    blockNumber = 20_000_000,
  } = opts;

  const encoded = testIface.encodeEventLog('DepositForBurn', [
    nonce,             // indexed uint64
    burnToken,         // indexed address
    amount,            // uint256
    DEPOSITOR,         // indexed address
    ZERO_B32,          // mintRecipient (bytes32)
    destinationDomain, // uint32
    ZERO_B32,          // destinationTokenMessenger (bytes32)
    ZERO_B32,          // destinationCaller (bytes32)
  ]);

  return {
    blockNumber,
    blockHash: '0xblockhash',
    transactionHash: txHash,
    transactionIndex: 0,
    index: 0,
    removed: false,
    address: CCTP_TOKEN_MESSENGER_ADDRESSES.ethereum!,
    topics: encoded.topics as string[],
    data: encoded.data,
  } as unknown as Log;
}

interface MessageReceivedLogOpts {
  sourceDomain?: number;
  nonce?: bigint;
  txHash?: string;
  blockNumber?: number;
}

function encodeMessageReceivedLog(opts: MessageReceivedLogOpts = {}): Log {
  const {
    sourceDomain = DOMAIN_ETHEREUM,
    nonce = NONCE,
    txHash = '0xreceive2222222222222222222222222222222222222222222222222222222222',
    blockNumber = 20_100_000,
  } = opts;

  const encoded = testIface.encodeEventLog('MessageReceived', [
    CALLER,       // indexed address
    sourceDomain, // uint32
    nonce,        // indexed uint64
    ZERO_B32,     // sender (bytes32)
    '0x',         // messageBody (bytes)
  ]);

  return {
    blockNumber,
    blockHash: '0xblockhash',
    transactionHash: txHash,
    transactionIndex: 0,
    index: 0,
    removed: false,
    address: ZERO_ADDR, // MessageTransmitter address (not checked in parser)
    topics: encoded.topics as string[],
    data: encoded.data,
  } as unknown as Log;
}

/** Invoke a listener captured from mockContractOn with a given log payload. */
async function invokeListener(eventName: string, log: Log): Promise<void> {
  const call = mockContractOn.mock.calls.find(c => c[0] === eventName);
  if (call === undefined) throw new Error(`No listener registered for ${eventName}`);
  const listener = call[1] as (...args: unknown[]) => Promise<void>;
  await listener({ log });
}

// ---------------------------------------------------------------------------
// Shared reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockPublish.mockClear();
  mockOnEvent.mockClear();
  mockGetProvider.mockClear();
  mockContractOn.mockClear();
  mockContractOff.mockClear();
  mockGetBlock.mockClear();
});

// ---------------------------------------------------------------------------
// constructor
// ---------------------------------------------------------------------------

describe('constructor', () => {
  it('scouts exactly the 5 CCTP chains (ethereum, arbitrum, optimism, base, avalanche)', () => {
    const scout = new CCTPScout(mockOnEvent);
    expect((scout as any).chains).toEqual([
      'ethereum', 'arbitrum', 'optimism', 'base', 'avalanche',
    ]);
  });

  it('isRunning starts as false', () => {
    const scout = new CCTPScout(mockOnEvent);
    expect((scout as any).isRunning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getContractAddress
// ---------------------------------------------------------------------------

describe('getContractAddress', () => {
  const scout = new CCTPScout(mockOnEvent);

  it('returns the correct TokenMessenger address for ethereum', () => {
    expect(scout.getContractAddress('ethereum')).toBe(CCTP_TOKEN_MESSENGER_ADDRESSES.ethereum);
  });

  it('returns the correct TokenMessenger address for arbitrum', () => {
    expect(scout.getContractAddress('arbitrum')).toBe(CCTP_TOKEN_MESSENGER_ADDRESSES.arbitrum);
  });

  it('returns the correct TokenMessenger address for optimism', () => {
    expect(scout.getContractAddress('optimism')).toBe(CCTP_TOKEN_MESSENGER_ADDRESSES.optimism);
  });

  it('returns the correct TokenMessenger address for base', () => {
    expect(scout.getContractAddress('base')).toBe(CCTP_TOKEN_MESSENGER_ADDRESSES.base);
  });

  it('returns the correct TokenMessenger address for avalanche', () => {
    expect(scout.getContractAddress('avalanche')).toBe(CCTP_TOKEN_MESSENGER_ADDRESSES.avalanche);
  });

  it('throws for polygon (not a CCTP chain)', () => {
    expect(() => scout.getContractAddress('polygon')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseDepositEvent
// ---------------------------------------------------------------------------

describe('parseDepositEvent', () => {
  const scout = new CCTPScout(mockOnEvent);

  describe('happy path — ETH → ARB deposit', () => {
    const log = encodeDepositLog();
    const result = scout.parseDepositEvent(log, CHAIN_IDS.ethereum, TEST_TIMESTAMP);

    it('returns a non-null TransferEvent', () => {
      expect(result).not.toBeNull();
    });

    it('type is "initiation"', () => {
      expect(result!.type).toBe('initiation');
    });

    it('bridge is "cctp"', () => {
      expect(result!.bridge).toBe('cctp');
    });

    it('sourceChain matches the chainId parameter', () => {
      expect(result!.sourceChain).toBe('ethereum');
    });

    it('destChain resolves from destinationDomain in the event (3 → arbitrum)', () => {
      expect(result!.destChain).toBe('arbitrum');
    });

    it('transferId follows DATA-MODEL.md §13.1 format: {sourceDomain}_{nonce}', () => {
      expect(result!.transferId).toBe(`${DOMAIN_ETHEREUM}_${NONCE.toString()}`);
    });

    it('tokenAddress is the raw burnToken address in lowercase', () => {
      expect(result!.tokenAddress).toBe(USDC_ETH.toLowerCase());
    });

    it('amount is the raw on-chain amount as a bigint', () => {
      expect(result!.amount).toBe(BURN_AMOUNT);
    });

    it('timestamp is the Date passed in from block.timestamp', () => {
      expect(result!.timestamp).toEqual(TEST_TIMESTAMP);
    });

    it('txHash is taken from the log', () => {
      expect(result!.txHash).toBe(log.transactionHash);
    });

    it('blockNumber is the log blockNumber as a bigint', () => {
      expect(result!.blockNumber).toBe(BigInt(log.blockNumber));
    });
  });

  describe('happy path — different source chain', () => {
    it('sourceChain reflects the chainId param (optimism)', () => {
      const log = encodeDepositLog({ destinationDomain: CCTP_DOMAINS.base! });
      const result = scout.parseDepositEvent(log, CHAIN_IDS.optimism, TEST_TIMESTAMP);
      expect(result!.sourceChain).toBe('optimism');
    });

    it('destChain resolves from destinationDomain in the event (base)', () => {
      const log = encodeDepositLog({ destinationDomain: CCTP_DOMAINS.base! });
      const result = scout.parseDepositEvent(log, CHAIN_IDS.ethereum, TEST_TIMESTAMP);
      expect(result!.destChain).toBe('base');
    });

    it('produces a unique transferId for a different nonce', () => {
      const log = encodeDepositLog({ nonce: BigInt(99999) });
      const result = scout.parseDepositEvent(log, CHAIN_IDS.ethereum, TEST_TIMESTAMP);
      expect(result!.transferId).toBe(`${DOMAIN_ETHEREUM}_99999`);
    });

    it('transferId uses sourceDomain (0), not EVM chainId (1)', () => {
      // Ethereum EVM chainId = 1, CCTP sourceDomain = 0 — these are different numbers
      const log = encodeDepositLog({ nonce: NONCE });
      const result = scout.parseDepositEvent(log, CHAIN_IDS.ethereum, TEST_TIMESTAMP);
      // transferId starts with CCTP domain (0), not EVM chainId (1)
      expect(result!.transferId).toBe(`0_${NONCE.toString()}`);
      expect(result!.transferId.startsWith('1_')).toBe(false);
    });
  });

  describe('null cases', () => {
    it('returns null when destinationDomain is not a recognised CCTP domain', () => {
      const log = encodeDepositLog({ destinationDomain: 99 });
      expect(scout.parseDepositEvent(log, CHAIN_IDS.ethereum, TEST_TIMESTAMP)).toBeNull();
    });

    it('returns null when passed a MessageReceived log (wrong event name)', () => {
      const fillLog = encodeMessageReceivedLog();
      expect(scout.parseDepositEvent(fillLog, CHAIN_IDS.arbitrum, TEST_TIMESTAMP)).toBeNull();
    });

    it('returns null for a completely malformed log (empty topics and data)', () => {
      const badLog = {
        blockNumber: 1,
        blockHash: '0x',
        transactionHash: '0x',
        transactionIndex: 0,
        index: 0,
        removed: false,
        address: ZERO_ADDR,
        topics: [],
        data: '0x',
      } as unknown as Log;
      expect(scout.parseDepositEvent(badLog, CHAIN_IDS.ethereum, TEST_TIMESTAMP)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// parseFillEvent
// ---------------------------------------------------------------------------

describe('parseFillEvent', () => {
  const scout = new CCTPScout(mockOnEvent);

  describe('happy path — fill observed on ARB, originated from ETH', () => {
    // chainId = 42161 (Arbitrum, where we're listening for MessageReceived)
    // sourceDomain = 0 (Ethereum, where DepositForBurn was emitted)
    const log = encodeMessageReceivedLog();
    const result = scout.parseFillEvent(log, CHAIN_IDS.arbitrum, TEST_TIMESTAMP);

    it('returns a non-null TransferEvent', () => {
      expect(result).not.toBeNull();
    });

    it('type is "completion"', () => {
      expect(result!.type).toBe('completion');
    });

    it('bridge is "cctp"', () => {
      expect(result!.bridge).toBe('cctp');
    });

    it('sourceChain resolves from sourceDomain in the event (0 → ethereum)', () => {
      expect(result!.sourceChain).toBe('ethereum');
    });

    it('destChain comes from the chainId param (the listening chain)', () => {
      expect(result!.destChain).toBe('arbitrum');
    });

    it('transferId uses sourceDomain from the event — NOT the listening chainId', () => {
      // Listening on Arbitrum (chainId=42161, domain=3) but sourceDomain=0 (Ethereum),
      // so transferId must start with 0 (not 3 or 42161) to match the deposit's ID.
      expect(result!.transferId).toBe(`${DOMAIN_ETHEREUM}_${NONCE.toString()}`);
      expect(result!.transferId.startsWith('3_')).toBe(false);
    });

    it('timestamp is the Date passed in from block.timestamp', () => {
      expect(result!.timestamp).toEqual(TEST_TIMESTAMP);
    });

    it('txHash is taken from the log', () => {
      expect(result!.txHash).toBe(log.transactionHash);
    });

    it('blockNumber is the log blockNumber as a bigint', () => {
      expect(result!.blockNumber).toBe(BigInt(log.blockNumber));
    });
  });

  describe('sentinel values — MessageReceived does not carry burnToken or amount', () => {
    const log = encodeMessageReceivedLog();
    const result = new CCTPScout(mockOnEvent).parseFillEvent(log, CHAIN_IDS.arbitrum, TEST_TIMESTAMP);

    it('tokenAddress is the zero address sentinel (docs/DATA-MODEL.md §13.1)', () => {
      expect(result!.tokenAddress).toBe(ZERO_ADDR);
    });

    it('amount is 0n sentinel — processor uses initiation record for real amount', () => {
      expect(result!.amount).toBe(0n);
    });
  });

  describe('null cases', () => {
    it('returns null when sourceDomain is not a recognised CCTP domain', () => {
      const log = encodeMessageReceivedLog({ sourceDomain: 99 });
      expect(new CCTPScout(mockOnEvent).parseFillEvent(log, CHAIN_IDS.arbitrum, TEST_TIMESTAMP)).toBeNull();
    });

    it('returns null when passed a DepositForBurn log (wrong event name)', () => {
      const depositLog = encodeDepositLog();
      expect(new CCTPScout(mockOnEvent).parseFillEvent(depositLog, CHAIN_IDS.ethereum, TEST_TIMESTAMP)).toBeNull();
    });

    it('returns null for a completely malformed log', () => {
      const badLog = {
        blockNumber: 1,
        blockHash: '0x',
        transactionHash: '0x',
        transactionIndex: 0,
        index: 0,
        removed: false,
        address: ZERO_ADDR,
        topics: [],
        data: '0x',
      } as unknown as Log;
      expect(new CCTPScout(mockOnEvent).parseFillEvent(badLog, CHAIN_IDS.arbitrum, TEST_TIMESTAMP)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Transfer ID consistency
// ---------------------------------------------------------------------------

describe('transferId consistency', () => {
  const scout = new CCTPScout(mockOnEvent);

  it('DepositForBurn on Ethereum and MessageReceived on Arbitrum produce the same transferId', () => {
    const depositLog = encodeDepositLog({
      nonce: NONCE,
      destinationDomain: DOMAIN_ARBITRUM,
    });
    const deposit = scout.parseDepositEvent(depositLog, CHAIN_IDS.ethereum, TEST_TIMESTAMP);

    const fillLog = encodeMessageReceivedLog({
      sourceDomain: DOMAIN_ETHEREUM,
      nonce: NONCE,
    });
    const fill = scout.parseFillEvent(fillLog, CHAIN_IDS.arbitrum, TEST_TIMESTAMP);

    expect(deposit!.transferId).toBe(fill!.transferId);
  });

  it('transferId is "0_67890" for sourceDomain=0 (ethereum), nonce=67890', () => {
    const depositLog = encodeDepositLog({ nonce: NONCE });
    const fillLog = encodeMessageReceivedLog({ sourceDomain: DOMAIN_ETHEREUM, nonce: NONCE });

    const deposit = scout.parseDepositEvent(depositLog, CHAIN_IDS.ethereum, TEST_TIMESTAMP);
    const fill = scout.parseFillEvent(fillLog, CHAIN_IDS.arbitrum, TEST_TIMESTAMP);

    expect(deposit!.transferId).toBe('0_67890');
    expect(fill!.transferId).toBe('0_67890');
  });

  it('different nonces produce different transferIds', () => {
    const log1 = encodeDepositLog({ nonce: BigInt(100) });
    const log2 = encodeDepositLog({ nonce: BigInt(200) });
    expect(
      scout.parseDepositEvent(log1, CHAIN_IDS.ethereum, TEST_TIMESTAMP)!.transferId,
    ).not.toBe(
      scout.parseDepositEvent(log2, CHAIN_IDS.ethereum, TEST_TIMESTAMP)!.transferId,
    );
  });

  it('deposits from different source domains produce different transferIds for the same nonce', () => {
    const ethLog = encodeDepositLog({ nonce: NONCE });
    const ethResult = scout.parseDepositEvent(ethLog, CHAIN_IDS.ethereum, TEST_TIMESTAMP);

    // Avalanche has domain 1, so sourceDomain=1 for the same nonce should differ
    const avaxFillLog = encodeMessageReceivedLog({ sourceDomain: CCTP_DOMAINS.avalanche!, nonce: NONCE });
    const avaxResult = scout.parseFillEvent(avaxFillLog, CHAIN_IDS.ethereum, TEST_TIMESTAMP);

    expect(ethResult!.transferId).not.toBe(avaxResult!.transferId);
  });
});

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

describe('start', () => {
  let scout: CCTPScout;

  beforeEach(async () => {
    scout = new CCTPScout(mockOnEvent);
    await scout.start();
  });

  it('sets isRunning to true', () => {
    expect((scout as any).isRunning).toBe(true);
  });

  it('registers a DepositForBurn listener for each of the 5 chains', () => {
    const depositCalls = mockContractOn.mock.calls.filter(c => c[0] === 'DepositForBurn');
    expect(depositCalls).toHaveLength(5);
  });

  it('registers a MessageReceived listener for each of the 5 chains', () => {
    const receiveCalls = mockContractOn.mock.calls.filter(c => c[0] === 'MessageReceived');
    expect(receiveCalls).toHaveLength(5);
  });

  it('registers exactly 10 cleanup functions in eventListeners (2 per chain × 5 chains)', () => {
    expect((scout as any).eventListeners).toHaveLength(10);
  });

  it('all registered listeners are functions', () => {
    for (const [, listener] of mockContractOn.mock.calls) {
      expect(typeof listener).toBe('function');
    }
  });

  it('is idempotent — calling start() twice does not add duplicate listeners', async () => {
    await scout.start(); // second call
    const depositCalls = mockContractOn.mock.calls.filter(c => c[0] === 'DepositForBurn');
    expect(depositCalls).toHaveLength(5); // still 5, not 10
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('stop', () => {
  let scout: CCTPScout;

  beforeEach(async () => {
    scout = new CCTPScout(mockOnEvent);
    await scout.start();
    await scout.stop();
  });

  it('sets isRunning to false', () => {
    expect((scout as any).isRunning).toBe(false);
  });

  it('calls contract.off for DepositForBurn for each chain (5 times)', () => {
    const offDeposit = mockContractOff.mock.calls.filter(c => c[0] === 'DepositForBurn');
    expect(offDeposit).toHaveLength(5);
  });

  it('calls contract.off for MessageReceived for each chain (5 times)', () => {
    const offReceive = mockContractOff.mock.calls.filter(c => c[0] === 'MessageReceived');
    expect(offReceive).toHaveLength(5);
  });

  it('clears the eventListeners array', () => {
    expect((scout as any).eventListeners).toHaveLength(0);
  });

  it('passes the same listener reference to off() that was passed to on()', () => {
    for (const [eventName, onListener] of mockContractOn.mock.calls) {
      const matchingOff = mockContractOff.mock.calls.find(
        ([offEventName, offListener]) =>
          offEventName === eventName && offListener === onListener,
      );
      expect(matchingOff).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Deposit listener behavior
// ---------------------------------------------------------------------------

describe('deposit listener', () => {
  let scout: CCTPScout;

  beforeEach(async () => {
    scout = new CCTPScout(mockOnEvent);
    await scout.start();
  });

  it('calls onEvent with an initiation event when a valid DepositForBurn is observed', async () => {
    mockGetBlock.mockResolvedValue({ timestamp: BLOCK_TIMESTAMP_SECONDS });
    const log = encodeDepositLog();

    await invokeListener('DepositForBurn', log);

    expect(mockOnEvent).toHaveBeenCalledTimes(1);
    expect(mockOnEvent).toHaveBeenCalledWith(
      expect.objectContaining({ bridge: 'cctp', type: 'initiation' }),
    );
  });

  it('sets timestamp from block.timestamp as a Date', async () => {
    mockGetBlock.mockResolvedValue({ timestamp: BLOCK_TIMESTAMP_SECONDS });
    const log = encodeDepositLog();

    await invokeListener('DepositForBurn', log);

    const emittedEvent = mockOnEvent.mock.calls[0][0];
    expect(emittedEvent.timestamp).toEqual(new Date(BLOCK_TIMESTAMP_SECONDS * 1000));
  });

  it('falls back to approximate current time when getBlock returns null', async () => {
    mockGetBlock.mockResolvedValue(null);
    const before = new Date();
    const log = encodeDepositLog();

    await invokeListener('DepositForBurn', log);

    const after = new Date();
    const emittedTimestamp: Date = mockOnEvent.mock.calls[0][0].timestamp;
    expect(emittedTimestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(emittedTimestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('falls back to wall-clock time and still emits when getBlock throws (graceful degradation)', async () => {
    mockGetBlock.mockRejectedValue(new Error('RPC timeout'));
    const log = encodeDepositLog();
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const before = new Date();
    await invokeListener('DepositForBurn', log);
    const after = new Date();

    // Event is still emitted with wall-clock fallback — never lose a transfer
    expect(mockOnEvent).toHaveBeenCalledTimes(1);
    const emittedTimestamp: Date = mockOnEvent.mock.calls[0][0].timestamp;
    expect(emittedTimestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(emittedTimestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Fill listener behavior
// ---------------------------------------------------------------------------

describe('fill listener', () => {
  let scout: CCTPScout;

  beforeEach(async () => {
    scout = new CCTPScout(mockOnEvent);
    await scout.start();
  });

  it('calls onEvent with a completion event when a valid MessageReceived is observed', async () => {
    mockGetBlock.mockResolvedValue({ timestamp: BLOCK_TIMESTAMP_SECONDS });
    const log = encodeMessageReceivedLog();

    await invokeListener('MessageReceived', log);

    expect(mockOnEvent).toHaveBeenCalledTimes(1);
    expect(mockOnEvent).toHaveBeenCalledWith(
      expect.objectContaining({ bridge: 'cctp', type: 'completion' }),
    );
  });

  it('completion event carries sentinel tokenAddress and amount', async () => {
    mockGetBlock.mockResolvedValue({ timestamp: BLOCK_TIMESTAMP_SECONDS });
    const log = encodeMessageReceivedLog();

    await invokeListener('MessageReceived', log);

    const emittedEvent = mockOnEvent.mock.calls[0][0];
    expect(emittedEvent.tokenAddress).toBe(ZERO_ADDR);
    expect(emittedEvent.amount).toBe(0n);
  });

  it('sets timestamp from block.timestamp as a Date', async () => {
    mockGetBlock.mockResolvedValue({ timestamp: BLOCK_TIMESTAMP_SECONDS });
    const log = encodeMessageReceivedLog();

    await invokeListener('MessageReceived', log);

    const emittedEvent = mockOnEvent.mock.calls[0][0];
    expect(emittedEvent.timestamp).toEqual(new Date(BLOCK_TIMESTAMP_SECONDS * 1000));
  });

  it('falls back to approximate current time when getBlock returns null', async () => {
    mockGetBlock.mockResolvedValue(null);
    const before = new Date();
    const log = encodeMessageReceivedLog();

    await invokeListener('MessageReceived', log);

    const after = new Date();
    const emittedTimestamp: Date = mockOnEvent.mock.calls[0][0].timestamp;
    expect(emittedTimestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(emittedTimestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('falls back to wall-clock time and still emits when getBlock throws (graceful degradation)', async () => {
    mockGetBlock.mockRejectedValue(new Error('RPC timeout'));
    const log = encodeMessageReceivedLog();
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const before = new Date();
    await invokeListener('MessageReceived', log);
    const after = new Date();

    // Event is still emitted with wall-clock fallback — never lose a transfer
    expect(mockOnEvent).toHaveBeenCalledTimes(1);
    const emittedTimestamp: Date = mockOnEvent.mock.calls[0][0].timestamp;
    expect(emittedTimestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(emittedTimestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    consoleSpy.mockRestore();
  });
});
