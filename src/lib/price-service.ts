/**
 * Price Service
 *
 * Provides USD prices for bridge-tracked tokens. Used by the transfer processor
 * to calculate `amountUsd` on ingestion.
 *
 * Strategy (docs/DATA-MODEL.md §4.2):
 *   - Stablecoins (USDC, USDT, DAI): hardcoded at $1.00
 *   - ETH/WETH: fetched from CoinGecko free API (no key required)
 *   - Prices cached for 5 minutes to stay within rate limits
 *
 * Error handling: any fetch failure returns 0. The processor will store
 * null for amountUsd when price is 0.
 */

import { logger } from './logger';

export interface PriceService {
  getPrice(symbol: string): Promise<number>;
  getPrices(symbols: string[]): Promise<Record<string, number>>;
}

const STABLECOINS = new Set(['USDC', 'USDT', 'DAI']);
const STABLECOIN_PRICE = 1.0;
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  ETH: 'ethereum',
  WETH: 'ethereum',
};

export class SimplePriceService implements PriceService {
  private readonly cache = new Map<string, { price: number; fetchedAt: number }>();

  async getPrice(symbol: string): Promise<number> {
    if (STABLECOINS.has(symbol)) {
      return STABLECOIN_PRICE;
    }

    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
      return cached.price;
    }

    const price = await this.fetchFromCoinGecko(symbol);
    this.cache.set(symbol, { price, fetchedAt: Date.now() });
    return price;
  }

  async getPrices(symbols: string[]): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    for (const symbol of symbols) {
      prices[symbol] = await this.getPrice(symbol);
    }
    return prices;
  }

  private async fetchFromCoinGecko(symbol: string): Promise<number> {
    const coinId = SYMBOL_TO_COINGECKO_ID[symbol];
    if (!coinId) return 0;

    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
      );
      const data = (await response.json()) as Record<string, { usd?: number }>;
      return data[coinId]?.usd ?? 0;
    } catch (error) {
      logger.error(`[PriceService] Failed to fetch price for ${symbol}`, { error: error instanceof Error ? error.message : String(error) });
      return 0;
    }
  }
}

export const priceService: PriceService = new SimplePriceService();
