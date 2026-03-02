/**
 * Ethers v6 JSON-RPC provider factory.
 *
 * Returns a cached JsonRpcProvider for each chain backed by Alchemy HTTP
 * endpoints. Providers are created on first access and reused for the
 * lifetime of the process, which keeps connection overhead minimal.
 */
import { JsonRpcProvider } from 'ethers';

import { requireEnv } from './env';
import { CHAIN_IDS, type ChainName } from './constants';

/** Alchemy network slug for each supported chain. */
const ALCHEMY_NETWORK: Record<ChainName, string> = {
  ethereum: 'eth-mainnet',
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  base: 'base-mainnet',
  polygon: 'polygon-mainnet',
  avalanche: 'avax-mainnet',
};

const providerCache = new Map<ChainName, JsonRpcProvider>();

/**
 * Return the shared JsonRpcProvider for `chain`.
 *
 * Reads ALCHEMY_API_KEY from the environment on first call — throws
 * immediately if the key is missing rather than silently returning a broken
 * provider.
 */
export function getProvider(chain: ChainName): JsonRpcProvider {
  const cached = providerCache.get(chain);
  if (cached !== undefined) return cached;

  const apiKey = requireEnv('ALCHEMY_API_KEY');
  const network = ALCHEMY_NETWORK[chain];
  const url = `https://${network}.g.alchemy.com/v2/${apiKey}`;
  const provider = new JsonRpcProvider(url, CHAIN_IDS[chain]);

  providerCache.set(chain, provider);
  return provider;
}
