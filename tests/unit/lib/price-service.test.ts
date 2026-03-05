/**
 * Tests for src/lib/price-service.ts
 *
 * fetch() is mocked globally so no real HTTP calls are made.
 */

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { SimplePriceService } from '../../../src/lib/price-service';

function makeFetchResponse(data: unknown): Promise<Response> {
  return Promise.resolve({
    json: () => Promise.resolve(data),
  } as unknown as Response);
}

// ---------------------------------------------------------------------------
// Stablecoins
// ---------------------------------------------------------------------------

describe('stablecoin prices', () => {
  let service: SimplePriceService;

  beforeEach(() => {
    service = new SimplePriceService();
    mockFetch.mockClear();
  });

  it('returns 1.0 for USDC without fetching', async () => {
    const price = await service.getPrice('USDC');
    expect(price).toBe(1.0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 1.0 for USDT without fetching', async () => {
    const price = await service.getPrice('USDT');
    expect(price).toBe(1.0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 1.0 for DAI without fetching', async () => {
    const price = await service.getPrice('DAI');
    expect(price).toBe(1.0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ETH / WETH via CoinGecko
// ---------------------------------------------------------------------------

describe('ETH/WETH price fetching', () => {
  let service: SimplePriceService;

  beforeEach(() => {
    service = new SimplePriceService();
    mockFetch.mockClear();
  });

  it('fetches ETH price from CoinGecko', async () => {
    mockFetch.mockReturnValueOnce(makeFetchResponse({ ethereum: { usd: 3000 } }));
    const price = await service.getPrice('ETH');
    expect(price).toBe(3000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('ids=ethereum'),
    );
  });

  it('treats WETH as the same CoinGecko ID as ETH', async () => {
    mockFetch.mockReturnValueOnce(makeFetchResponse({ ethereum: { usd: 3500 } }));
    const price = await service.getPrice('WETH');
    expect(price).toBe(3500);
  });

  it('returns 0 for an unknown symbol', async () => {
    const price = await service.getPrice('UNKNOWN_TOKEN');
    expect(price).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe('price caching', () => {
  let service: SimplePriceService;

  beforeEach(() => {
    service = new SimplePriceService();
    mockFetch.mockClear();
  });

  it('does not fetch again within the TTL', async () => {
    mockFetch.mockReturnValueOnce(makeFetchResponse({ ethereum: { usd: 2800 } }));

    const first = await service.getPrice('WETH');
    const second = await service.getPrice('WETH');

    expect(first).toBe(2800);
    expect(second).toBe(2800);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetches again after the TTL has expired', async () => {
    jest.useFakeTimers();

    mockFetch
      .mockReturnValueOnce(makeFetchResponse({ ethereum: { usd: 2800 } }))
      .mockReturnValueOnce(makeFetchResponse({ ethereum: { usd: 3100 } }));

    const first = await service.getPrice('WETH');
    expect(first).toBe(2800);

    // Advance past the 5-minute TTL
    jest.advanceTimersByTime(6 * 60 * 1000);

    const second = await service.getPrice('WETH');
    expect(second).toBe(3100);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  let service: SimplePriceService;

  beforeEach(() => {
    service = new SimplePriceService();
    mockFetch.mockClear();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 0 when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const price = await service.getPrice('WETH');
    expect(price).toBe(0);
  });

  it('returns 0 when CoinGecko response is missing the expected field', async () => {
    mockFetch.mockReturnValueOnce(makeFetchResponse({}));
    const price = await service.getPrice('WETH');
    expect(price).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getPrices (batch)
// ---------------------------------------------------------------------------

describe('getPrices', () => {
  let service: SimplePriceService;

  beforeEach(() => {
    service = new SimplePriceService();
    mockFetch.mockClear();
  });

  it('returns prices for multiple symbols', async () => {
    mockFetch.mockReturnValueOnce(makeFetchResponse({ ethereum: { usd: 3200 } }));

    const prices = await service.getPrices(['USDC', 'WETH', 'DAI']);
    expect(prices['USDC']).toBe(1.0);
    expect(prices['WETH']).toBe(3200);
    expect(prices['DAI']).toBe(1.0);
  });
});
