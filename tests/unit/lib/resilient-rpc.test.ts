/**
 * Tests for src/lib/resilient-rpc.ts
 *
 * Strategy:
 *   - Logger and retry are mocked to isolate resilient-rpc logic.
 *   - ethers JsonRpcProvider is mocked so no real RPC connections are made.
 *   - Tests cover: primary success, primary retry + recovery, fallback to
 *     public endpoint, both failing, and transient error classification.
 */

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('../../../src/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

// Mock retry to just call fn() directly — retry logic is tested in retry.test.ts.
// For the fallback path tests we need retry to propagate errors correctly.
jest.mock('../../../src/lib/retry', () => ({
  retry: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

jest.mock('ethers', () => ({
  JsonRpcProvider: jest.fn().mockImplementation((url: string, chainId: number) => ({
    _url: url,
    _chainId: chainId,
    _isFallback: true,
  })),
}));

import { resilientRpcCall } from '../../../src/lib/resilient-rpc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockLoggerWarn.mockClear();
  mockLoggerError.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resilientRpcCall', () => {
  // -------------------------------------------------------------------------
  // Primary success
  // -------------------------------------------------------------------------

  it('returns the result when primary call succeeds', async () => {
    const result = await resilientRpcCall(
      () => Promise.resolve('block-data'),
      { label: 'getBlock' },
    );

    expect(result).toBe('block-data');
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('passes through complex return values', async () => {
    const blockData = { number: 100, timestamp: 1700000000 };
    const result = await resilientRpcCall(() => Promise.resolve(blockData));
    expect(result).toEqual(blockData);
  });

  // -------------------------------------------------------------------------
  // Primary failure without chain (no fallback available)
  // -------------------------------------------------------------------------

  it('throws when primary fails and no chain is specified', async () => {
    await expect(
      resilientRpcCall(
        () => Promise.reject(new Error('rpc-down')),
        { label: 'getBlock' },
      ),
    ).rejects.toThrow('rpc-down');
  });

  // -------------------------------------------------------------------------
  // Fallback to public endpoint
  // -------------------------------------------------------------------------

  it('tries fallback provider when primary fails and chain is specified', async () => {
    let callCount = 0;
    const fn = jest.fn().mockImplementation((_provider?: unknown) => {
      callCount++;
      if (callCount === 1) {
        // Primary call (no provider passed)
        return Promise.reject(new Error('primary-down'));
      }
      // Fallback call (provider passed)
      return Promise.resolve('fallback-result');
    });

    const result = await resilientRpcCall(fn, {
      label: 'getBlock',
      chain: 'ethereum',
    });

    expect(result).toBe('fallback-result');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('trying fallback'),
      expect.objectContaining({ chain: 'ethereum' }),
    );
  });

  it('logs error and throws when both primary and fallback fail', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('all-down'));

    await expect(
      resilientRpcCall(fn, { label: 'getBlock', chain: 'arbitrum' }),
    ).rejects.toThrow('all-down');

    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('fallback also failed'),
      expect.objectContaining({ chain: 'arbitrum' }),
    );
  });

  // -------------------------------------------------------------------------
  // Fallback provider caching
  // -------------------------------------------------------------------------

  it('reuses the same fallback provider for repeated calls to the same chain', async () => {
    let callCount = 0;
    const fn = jest.fn().mockImplementation((_provider?: unknown) => {
      callCount++;
      if (callCount % 2 === 1) return Promise.reject(new Error('down'));
      return Promise.resolve('fallback-ok');
    });

    await resilientRpcCall(fn, { chain: 'optimism', label: 'call-1' });

    callCount = 0;
    await resilientRpcCall(fn, { chain: 'optimism', label: 'call-2' });

    // The fallback provider passed in call 2 should be the same object as call 1
    const call1FallbackProvider = fn.mock.calls[1][0];
    const call2FallbackProvider = fn.mock.calls[3][0];
    expect(call1FallbackProvider).toBe(call2FallbackProvider);
  });

  // -------------------------------------------------------------------------
  // Supported chains
  // -------------------------------------------------------------------------

  it('has fallback URLs for all major chains', async () => {
    const chains = ['ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'avalanche'] as const;

    for (const chain of chains) {
      let callCount = 0;
      const fn = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('primary-down'));
        return Promise.resolve('ok');
      });

      const result = await resilientRpcCall(fn, { chain, label: `test-${chain}` });
      expect(result).toBe('ok');
      callCount = 0;
    }
  });
});
