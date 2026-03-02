/**
 * Tests for the RPC provider factory (src/lib/rpc.ts).
 *
 * ethers is fully mocked — no real network connections are made.
 * Each test resets modules to get a fresh provider cache, ensuring
 * caching behaviour is observable in isolation.
 */

// Must be set before any require() so requireEnv() succeeds when getProvider is called
process.env.ALCHEMY_API_KEY = 'test-alchemy-key';

const mockProviderConstructor = jest.fn().mockImplementation((url: string, chainId: number) => ({
  _url: url,
  _chainId: chainId,
  _isMock: true,
}));

jest.mock('ethers', () => ({
  JsonRpcProvider: mockProviderConstructor,
}));

// Helper: fresh require of rpc.ts with an empty provider cache
function loadRpc(): { getProvider: (chain: string) => unknown } {
  return require('../../../src/lib/rpc');
}

describe('getProvider', () => {
  beforeEach(() => {
    jest.resetModules(); // clears module cache → fresh providerCache Map on next require
    mockProviderConstructor.mockClear();
  });

  // ---------------------------------------------------------------------------
  // Happy path — URL & chain ID construction
  // ---------------------------------------------------------------------------

  it('constructs the correct Alchemy HTTPS URL for ethereum', () => {
    const { getProvider } = loadRpc();
    getProvider('ethereum');
    expect(mockProviderConstructor).toHaveBeenCalledWith(
      'https://eth-mainnet.g.alchemy.com/v2/test-alchemy-key',
      1,
    );
  });

  it('uses the correct network slug and chain ID for each supported chain', () => {
    const cases = [
      { chain: 'ethereum',  network: 'eth-mainnet',     chainId: 1       },
      { chain: 'arbitrum',  network: 'arb-mainnet',     chainId: 42161   },
      { chain: 'optimism',  network: 'opt-mainnet',     chainId: 10      },
      { chain: 'base',      network: 'base-mainnet',    chainId: 8453    },
      { chain: 'polygon',   network: 'polygon-mainnet', chainId: 137     },
      { chain: 'avalanche', network: 'avax-mainnet',    chainId: 43114   },
    ] as const;

    for (const { chain, network, chainId } of cases) {
      // Fresh module per chain to avoid cache hits
      jest.resetModules();
      mockProviderConstructor.mockClear();
      const { getProvider } = loadRpc();

      getProvider(chain);
      expect(mockProviderConstructor).toHaveBeenCalledWith(
        `https://${network}.g.alchemy.com/v2/test-alchemy-key`,
        chainId,
      );
    }
  });

  it('returns a JsonRpcProvider instance', () => {
    const { getProvider } = loadRpc();
    const provider = getProvider('arbitrum');
    expect(provider).toMatchObject({ _isMock: true });
  });

  // ---------------------------------------------------------------------------
  // Caching behaviour
  // ---------------------------------------------------------------------------

  it('returns the same provider instance on repeated calls for the same chain', () => {
    const { getProvider } = loadRpc();
    const p1 = getProvider('optimism');
    const p2 = getProvider('optimism');
    expect(p1).toBe(p2);
    expect(mockProviderConstructor).toHaveBeenCalledTimes(1);
  });

  it('creates a separate provider for each distinct chain', () => {
    const { getProvider } = loadRpc();
    const eth = getProvider('ethereum');
    const arb = getProvider('arbitrum');
    expect(eth).not.toBe(arb);
    expect(mockProviderConstructor).toHaveBeenCalledTimes(2);
  });

  it('does not call JsonRpcProvider constructor on a cache hit', () => {
    const { getProvider } = loadRpc();
    getProvider('base');               // first call — constructor runs
    getProvider('base');               // second call — should hit cache
    getProvider('base');               // third call — should hit cache
    expect(mockProviderConstructor).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('throws when ALCHEMY_API_KEY is not set', () => {
    const saved = process.env.ALCHEMY_API_KEY;
    delete process.env.ALCHEMY_API_KEY;

    try {
      jest.resetModules();
      const { getProvider } = loadRpc();
      expect(() => getProvider('ethereum')).toThrow('ALCHEMY_API_KEY');
    } finally {
      process.env.ALCHEMY_API_KEY = saved;
    }
  });

  it('includes the variable name in the error when ALCHEMY_API_KEY is missing', () => {
    const saved = process.env.ALCHEMY_API_KEY;
    delete process.env.ALCHEMY_API_KEY;

    try {
      jest.resetModules();
      const { getProvider } = loadRpc();
      expect(() => getProvider('polygon')).toThrow(
        'Missing required environment variable: ALCHEMY_API_KEY',
      );
    } finally {
      process.env.ALCHEMY_API_KEY = saved;
    }
  });

  it('includes the Alchemy API key in the provider URL', () => {
    process.env.ALCHEMY_API_KEY = 'my-special-key';
    jest.resetModules();
    mockProviderConstructor.mockClear();

    const { getProvider } = loadRpc();
    getProvider('ethereum');

    expect(mockProviderConstructor).toHaveBeenCalledWith(
      expect.stringContaining('my-special-key'),
      expect.any(Number),
    );

    process.env.ALCHEMY_API_KEY = 'test-alchemy-key';
  });
});
