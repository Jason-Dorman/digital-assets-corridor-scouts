/**
 * Tests for src/scouts/across.ts
 *
 * Strategy:
 *   - parseDepositEvent / parseFillEvent are tested directly with real ABI-encoded
 *     logs produced by ethers Interface.encodeEventLog(). No mocks required for parsing.
 *   - start() / stop() lifecycle tests verify listener registration via a mocked
 *     ethers.Contract. Listener callbacks are then invoked directly to test the
 *     block-fetch → timestamp → emit pipeline.
 *   - lib/redis and lib/rpc are fully mocked — no real connections are made.
 */

// ---------------------------------------------------------------------------
// Mock declarations — named with 'mock' prefix so Jest hoists them alongside
// jest.mock() factory calls.
// ---------------------------------------------------------------------------

const mockPublish = jest.fn().mockResolvedValue(undefined);
const mockRedisInstance = { publish: jest.fn() };

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
import { AcrossScout } from '../../../src/scouts/across';
import { ACROSS_SPOKEPOOL_ADDRESSES, CHAIN_IDS, REDIS_CHANNELS } from '../../../src/lib/constants';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// Token addresses used when encoding test logs
const USDC_ETH  = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_ARB  = '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8';
const DEPOSITOR = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const RELAYER   = '0x3333333333333333333333333333333333333333';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

const DEPOSIT_ID    = 12345;
const INPUT_AMOUNT  = BigInt('10000000000'); // 10 000 USDC at 6 decimals
const OUTPUT_AMOUNT = BigInt('9995000000');  // ~10 000 USDC after fees

const TEST_TIMESTAMP = new Date('2026-01-01T00:00:00Z');
const BLOCK_TIMESTAMP_SECONDS = Math.floor(TEST_TIMESTAMP.getTime() / 1000);

// Mirror the exact ABI strings from across.ts so we can encode test logs with
// the same interface the scout uses to decode them.
const DEPOSIT_EVENT_ABI =
  'event V3FundsDeposited(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint32 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, address indexed depositor, address recipient, address exclusiveRelayer, bytes message)';

const FILL_EVENT_ABI =
  'event FilledV3Relay(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint32 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, address exclusiveRelayer, address indexed relayer, address depositor, address recipient, bytes message, (address updatedRecipient, bytes updatedMessage, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)';

const testIface = new Interface([DEPOSIT_EVENT_ABI, FILL_EVENT_ABI]);

// ---------------------------------------------------------------------------
// Log encoding helpers
// ---------------------------------------------------------------------------

interface DepositLogOpts {
  inputToken?: string;
  outputToken?: string;
  inputAmount?: bigint;
  outputAmount?: bigint;
  destinationChainId?: bigint;
  depositId?: number;
  txHash?: string;
  blockNumber?: number;
}

function encodeDepositLog(opts: DepositLogOpts = {}): Log {
  const {
    inputToken = USDC_ETH,
    outputToken = USDC_ARB,
    inputAmount = INPUT_AMOUNT,
    outputAmount = OUTPUT_AMOUNT,
    destinationChainId = BigInt(CHAIN_IDS.arbitrum),
    depositId = DEPOSIT_ID,
    txHash = '0xdeposit1111111111111111111111111111111111111111111111111111111111',
    blockNumber = 20_000_000,
  } = opts;

  const encoded = testIface.encodeEventLog('V3FundsDeposited', [
    inputToken,
    outputToken,
    inputAmount,
    outputAmount,
    destinationChainId,  // indexed
    depositId,           // indexed
    1_700_000_000,       // quoteTimestamp
    1_700_003_600,       // fillDeadline
    0,                   // exclusivityDeadline
    DEPOSITOR,           // indexed
    RECIPIENT,
    ZERO_ADDR,           // exclusiveRelayer
    '0x',                // message
  ]);

  return {
    blockNumber,
    blockHash: '0xblockhash',
    transactionHash: txHash,
    transactionIndex: 0,
    index: 0,
    removed: false,
    address: ACROSS_SPOKEPOOL_ADDRESSES.ethereum!,
    topics: encoded.topics as string[],
    data: encoded.data,
  } as unknown as Log;
}

interface FillLogOpts {
  inputToken?: string;
  outputToken?: string;
  inputAmount?: bigint;
  outputAmount?: bigint;
  repaymentChainId?: bigint;
  originChainId?: bigint;
  depositId?: number;
  txHash?: string;
  blockNumber?: number;
}

function encodeFillLog(opts: FillLogOpts = {}): Log {
  const {
    inputToken = USDC_ETH,
    outputToken = USDC_ARB,
    inputAmount = INPUT_AMOUNT,
    outputAmount = OUTPUT_AMOUNT,
    repaymentChainId = BigInt(CHAIN_IDS.arbitrum),
    originChainId = BigInt(CHAIN_IDS.ethereum),
    depositId = DEPOSIT_ID,
    txHash = '0xfill22222222222222222222222222222222222222222222222222222222222222',
    blockNumber = 20_100_000,
  } = opts;

  const relayExecutionInfo = [RECIPIENT, '0x', outputAmount, 0]; // tuple fields

  const encoded = testIface.encodeEventLog('FilledV3Relay', [
    inputToken,
    outputToken,
    inputAmount,
    outputAmount,
    repaymentChainId,
    originChainId,  // indexed
    depositId,      // indexed
    1_700_003_600,  // fillDeadline
    0,              // exclusivityDeadline
    ZERO_ADDR,      // exclusiveRelayer
    RELAYER,        // indexed
    DEPOSITOR,
    RECIPIENT,
    '0x',           // message
    relayExecutionInfo,
  ]);

  return {
    blockNumber,
    blockHash: '0xblockhash',
    transactionHash: txHash,
    transactionIndex: 0,
    index: 0,
    removed: false,
    address: ACROSS_SPOKEPOOL_ADDRESSES.arbitrum!,
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
  mockGetProvider.mockClear();
  mockContractOn.mockClear();
  mockContractOff.mockClear();
  mockGetBlock.mockClear();
});

// ---------------------------------------------------------------------------
// constructor
// ---------------------------------------------------------------------------

describe('constructor', () => {
  it('scouts exactly the 4 chains that have SpokePool addresses (ethereum, arbitrum, optimism, base)', () => {
    const scout = new AcrossScout();
    expect((scout as any).chains).toEqual(['ethereum', 'arbitrum', 'optimism', 'base']);
  });

  it('isRunning starts as false', () => {
    const scout = new AcrossScout();
    expect((scout as any).isRunning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getContractAddress
// ---------------------------------------------------------------------------

describe('getContractAddress', () => {
  const scout = new AcrossScout();

  it('returns the correct SpokePool address for ethereum', () => {
    expect(scout.getContractAddress('ethereum')).toBe(ACROSS_SPOKEPOOL_ADDRESSES.ethereum);
  });

  it('returns the correct SpokePool address for arbitrum', () => {
    expect(scout.getContractAddress('arbitrum')).toBe(ACROSS_SPOKEPOOL_ADDRESSES.arbitrum);
  });

  it('returns the correct SpokePool address for optimism', () => {
    expect(scout.getContractAddress('optimism')).toBe(ACROSS_SPOKEPOOL_ADDRESSES.optimism);
  });

  it('returns the correct SpokePool address for base', () => {
    expect(scout.getContractAddress('base')).toBe(ACROSS_SPOKEPOOL_ADDRESSES.base);
  });

  it('throws for polygon (no address defined in spec)', () => {
    expect(() => scout.getContractAddress('polygon')).toThrow();
  });

  it('throws for avalanche (no address defined in spec)', () => {
    expect(() => scout.getContractAddress('avalanche')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseDepositEvent
// ---------------------------------------------------------------------------

describe('parseDepositEvent', () => {
  const scout = new AcrossScout();

  describe('happy path — ETH → ARB deposit', () => {
    const log = encodeDepositLog();
    const result = scout.parseDepositEvent(log, CHAIN_IDS.ethereum, TEST_TIMESTAMP);

    it('returns a non-null TransferEvent', () => {
      expect(result).not.toBeNull();
    });

    it('type is "initiation"', () => {
      expect(result!.type).toBe('initiation');
    });

    it('bridge is "across"', () => {
      expect(result!.bridge).toBe('across');
    });

    it('sourceChain matches the chainId parameter', () => {
      expect(result!.sourceChain).toBe('ethereum');
    });

    it('destChain matches destinationChainId from the event', () => {
      expect(result!.destChain).toBe('arbitrum');
    });

    it('transferId follows DATA-MODEL.md §13.1 format: {originChainId}_{depositId}', () => {
      expect(result!.transferId).toBe(`${CHAIN_IDS.ethereum}_${DEPOSIT_ID}`);
    });

    it('tokenAddress is the raw inputToken address in lowercase', () => {
      expect(result!.tokenAddress).toBe(USDC_ETH.toLowerCase());
    });

    it('amount is the raw on-chain inputAmount as a bigint', () => {
      expect(result!.amount).toBe(INPUT_AMOUNT);
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

  describe('happy path — different chains', () => {
    it('sourceChain reflects the chainId param (optimism)', () => {
      const log = encodeDepositLog({ destinationChainId: BigInt(CHAIN_IDS.base) });
      const result = scout.parseDepositEvent(log, CHAIN_IDS.optimism, TEST_TIMESTAMP);
      expect(result!.sourceChain).toBe('optimism');
    });

    it('destChain reflects destinationChainId in the event (base)', () => {
      const log = encodeDepositLog({ destinationChainId: BigInt(CHAIN_IDS.base) });
      const result = scout.parseDepositEvent(log, CHAIN_IDS.ethereum, TEST_TIMESTAMP);
      expect(result!.destChain).toBe('base');
    });

    it('produces a unique transferId for a different depositId', () => {
      const log = encodeDepositLog({ depositId: 99999 });
      const result = scout.parseDepositEvent(log, CHAIN_IDS.ethereum, TEST_TIMESTAMP);
      expect(result!.transferId).toBe(`${CHAIN_IDS.ethereum}_99999`);
    });
  });

  describe('null cases', () => {
    it('returns null when destinationChainId is not a recognised chain', () => {
      const log = encodeDepositLog({ destinationChainId: BigInt(99999) });
      expect(scout.parseDepositEvent(log, CHAIN_IDS.ethereum, TEST_TIMESTAMP)).toBeNull();
    });

    it('returns null when passed a FilledV3Relay log (wrong event name)', () => {
      const fillLog = encodeFillLog();
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
  const scout = new AcrossScout();

  describe('happy path — fill observed on ARB, originated from ETH', () => {
    // chainId = 42161 (Arbitrum, where we're listening)
    // originChainId = 1 (Ethereum, where the deposit happened)
    const log = encodeFillLog();
    const result = scout.parseFillEvent(log, CHAIN_IDS.arbitrum, TEST_TIMESTAMP);

    it('returns a non-null TransferEvent', () => {
      expect(result).not.toBeNull();
    });

    it('type is "completion"', () => {
      expect(result!.type).toBe('completion');
    });

    it('bridge is "across"', () => {
      expect(result!.bridge).toBe('across');
    });

    it('sourceChain comes from originChainId in the event args (not from chainId param)', () => {
      expect(result!.sourceChain).toBe('ethereum');
    });

    it('destChain comes from the chainId param (the listening chain)', () => {
      expect(result!.destChain).toBe('arbitrum');
    });

    it('transferId uses originChainId from the event — NOT the listening chainId', () => {
      // The fill is observed on Arbitrum (chainId=42161) but originChainId=1 (Ethereum),
      // so the transferId must start with 1, not 42161, to match the deposit's ID.
      expect(result!.transferId).toBe(`${CHAIN_IDS.ethereum}_${DEPOSIT_ID}`);
    });

    it('tokenAddress is the raw inputToken address in lowercase', () => {
      expect(result!.tokenAddress).toBe(USDC_ETH.toLowerCase());
    });

    it('amount is the raw on-chain inputAmount as a bigint', () => {
      expect(result!.amount).toBe(INPUT_AMOUNT);
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

  describe('null cases', () => {
    it('returns null when originChainId is not a recognised chain', () => {
      const log = encodeFillLog({ originChainId: BigInt(99999) });
      expect(scout.parseFillEvent(log, CHAIN_IDS.arbitrum, TEST_TIMESTAMP)).toBeNull();
    });

    it('returns null when passed a V3FundsDeposited log (wrong event name)', () => {
      const depositLog = encodeDepositLog();
      expect(scout.parseFillEvent(depositLog, CHAIN_IDS.ethereum, TEST_TIMESTAMP)).toBeNull();
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
      expect(scout.parseFillEvent(badLog, CHAIN_IDS.arbitrum, TEST_TIMESTAMP)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Transfer ID consistency
// ---------------------------------------------------------------------------

describe('transferId consistency', () => {
  const scout = new AcrossScout();

  it('deposit on Ethereum and fill on Arbitrum produce the same transferId', () => {
    const depositLog = encodeDepositLog({
      destinationChainId: BigInt(CHAIN_IDS.arbitrum),
      depositId: DEPOSIT_ID,
    });
    const deposit = scout.parseDepositEvent(depositLog, CHAIN_IDS.ethereum, TEST_TIMESTAMP);

    const fillLog = encodeFillLog({
      originChainId: BigInt(CHAIN_IDS.ethereum),
      depositId: DEPOSIT_ID,
    });
    const fill = scout.parseFillEvent(fillLog, CHAIN_IDS.arbitrum, TEST_TIMESTAMP);

    expect(deposit!.transferId).toBe(fill!.transferId);
  });

  it('transferId is "1_12345" for originChainId=1, depositId=12345', () => {
    const depositLog = encodeDepositLog({ depositId: DEPOSIT_ID });
    const fillLog = encodeFillLog({
      originChainId: BigInt(CHAIN_IDS.ethereum),
      depositId: DEPOSIT_ID,
    });

    const deposit = scout.parseDepositEvent(depositLog, CHAIN_IDS.ethereum, TEST_TIMESTAMP);
    const fill = scout.parseFillEvent(fillLog, CHAIN_IDS.arbitrum, TEST_TIMESTAMP);

    expect(deposit!.transferId).toBe('1_12345');
    expect(fill!.transferId).toBe('1_12345');
  });

  it('different depositIds produce different transferIds', () => {
    const scout2 = new AcrossScout();
    const log1 = encodeDepositLog({ depositId: 100 });
    const log2 = encodeDepositLog({ depositId: 200 });
    expect(
      scout2.parseDepositEvent(log1, CHAIN_IDS.ethereum, TEST_TIMESTAMP)!.transferId,
    ).not.toBe(
      scout2.parseDepositEvent(log2, CHAIN_IDS.ethereum, TEST_TIMESTAMP)!.transferId,
    );
  });
});

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

describe('start', () => {
  let scout: AcrossScout;

  beforeEach(async () => {
    scout = new AcrossScout();
    await scout.start();
  });

  it('sets isRunning to true', () => {
    expect((scout as any).isRunning).toBe(true);
  });

  it('registers a V3FundsDeposited listener for each of the 4 chains', () => {
    const depositCalls = mockContractOn.mock.calls.filter(c => c[0] === 'V3FundsDeposited');
    expect(depositCalls).toHaveLength(4);
  });

  it('registers a FilledV3Relay listener for each of the 4 chains', () => {
    const fillCalls = mockContractOn.mock.calls.filter(c => c[0] === 'FilledV3Relay');
    expect(fillCalls).toHaveLength(4);
  });

  it('registers exactly 4 cleanup functions in eventListeners (one per chain)', () => {
    expect((scout as any).eventListeners).toHaveLength(4);
  });

  it('all registered listeners are functions', () => {
    for (const [, listener] of mockContractOn.mock.calls) {
      expect(typeof listener).toBe('function');
    }
  });

  it('is idempotent — calling start() twice does not add duplicate listeners', async () => {
    await scout.start(); // second call
    const depositCalls = mockContractOn.mock.calls.filter(c => c[0] === 'V3FundsDeposited');
    expect(depositCalls).toHaveLength(4); // still 4, not 8
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe('stop', () => {
  let scout: AcrossScout;

  beforeEach(async () => {
    scout = new AcrossScout();
    await scout.start();
    await scout.stop();
  });

  it('sets isRunning to false', () => {
    expect((scout as any).isRunning).toBe(false);
  });

  it('calls contract.off for V3FundsDeposited for each chain', () => {
    const offDeposit = mockContractOff.mock.calls.filter(c => c[0] === 'V3FundsDeposited');
    expect(offDeposit).toHaveLength(4);
  });

  it('calls contract.off for FilledV3Relay for each chain', () => {
    const offFill = mockContractOff.mock.calls.filter(c => c[0] === 'FilledV3Relay');
    expect(offFill).toHaveLength(4);
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
  let scout: AcrossScout;

  beforeEach(async () => {
    scout = new AcrossScout();
    await scout.start();
  });

  it('emits to transfer:initiated channel when a valid deposit is observed', async () => {
    mockGetBlock.mockResolvedValue({ timestamp: BLOCK_TIMESTAMP_SECONDS });
    const log = encodeDepositLog();

    await invokeListener('V3FundsDeposited', log);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      REDIS_CHANNELS.TRANSFER_INITIATED,
      expect.objectContaining({ bridge: 'across', type: 'initiation' }),
    );
  });

  it('sets timestamp from block.timestamp as a Date', async () => {
    mockGetBlock.mockResolvedValue({ timestamp: BLOCK_TIMESTAMP_SECONDS });
    const log = encodeDepositLog();

    await invokeListener('V3FundsDeposited', log);

    const emittedEvent = mockPublish.mock.calls[0][1];
    expect(emittedEvent.timestamp).toEqual(new Date(BLOCK_TIMESTAMP_SECONDS * 1000));
  });

  it('falls back to approximate current time when getBlock returns null', async () => {
    mockGetBlock.mockResolvedValue(null);
    const before = new Date();
    const log = encodeDepositLog();

    await invokeListener('V3FundsDeposited', log);

    const after = new Date();
    const emittedTimestamp: Date = mockPublish.mock.calls[0][1].timestamp;
    expect(emittedTimestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(emittedTimestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('does NOT emit when getBlock throws (logs error, swallows exception)', async () => {
    mockGetBlock.mockRejectedValue(new Error('RPC timeout'));
    const log = encodeDepositLog();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await invokeListener('V3FundsDeposited', log);

    expect(mockPublish).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Fill listener behavior
// ---------------------------------------------------------------------------

describe('fill listener', () => {
  let scout: AcrossScout;

  beforeEach(async () => {
    scout = new AcrossScout();
    await scout.start();
  });

  it('emits to transfer:completed channel when a valid fill is observed', async () => {
    mockGetBlock.mockResolvedValue({ timestamp: BLOCK_TIMESTAMP_SECONDS });
    const log = encodeFillLog();

    await invokeListener('FilledV3Relay', log);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      REDIS_CHANNELS.TRANSFER_COMPLETED,
      expect.objectContaining({ bridge: 'across', type: 'completion' }),
    );
  });

  it('sets timestamp from block.timestamp as a Date', async () => {
    mockGetBlock.mockResolvedValue({ timestamp: BLOCK_TIMESTAMP_SECONDS });
    const log = encodeFillLog();

    await invokeListener('FilledV3Relay', log);

    const emittedEvent = mockPublish.mock.calls[0][1];
    expect(emittedEvent.timestamp).toEqual(new Date(BLOCK_TIMESTAMP_SECONDS * 1000));
  });

  it('falls back to approximate current time when getBlock returns null', async () => {
    mockGetBlock.mockResolvedValue(null);
    const before = new Date();
    const log = encodeFillLog();

    await invokeListener('FilledV3Relay', log);

    const after = new Date();
    const emittedTimestamp: Date = mockPublish.mock.calls[0][1].timestamp;
    expect(emittedTimestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(emittedTimestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('does NOT emit when getBlock throws', async () => {
    mockGetBlock.mockRejectedValue(new Error('RPC timeout'));
    const log = encodeFillLog();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await invokeListener('FilledV3Relay', log);

    expect(mockPublish).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
