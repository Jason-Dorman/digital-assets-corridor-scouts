/**
 * Smoke test — validates that each core library module can reach its
 * real infrastructure dependency.
 *
 * Run with:  npm run smoke-test
 *
 * Requires Docker (postgres + redis) and a valid .env.local.
 * Each check is run sequentially so failures are easy to isolate.
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env.local BEFORE any module that calls requireEnv() is imported.
// Dynamic imports below ensure the env is populated first.
config({ path: resolve(process.cwd(), '.env.local') });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkEnv(): Promise<CheckResult> {
  const { requireEnv } = await import('../src/lib/env');
  const required = ['DATABASE_URL', 'REDIS_URL', 'ALCHEMY_API_KEY'];
  const missing: string[] = [];

  for (const key of required) {
    try {
      requireEnv(key);
    } catch {
      missing.push(key);
    }
  }

  return missing.length === 0
    ? { name: 'env vars', ok: true, detail: `${required.join(', ')} all present` }
    : { name: 'env vars', ok: false, detail: `Missing: ${missing.join(', ')}` };
}

async function checkDatabase(): Promise<CheckResult> {
  const { db } = await import('../src/lib/db');
  try {
    // $queryRaw<T> returns an array; SELECT 1 returns [{ '?column?': 1n }] in Postgres
    await db.$queryRaw`SELECT 1`;
    return { name: 'database (postgres)', ok: true, detail: 'SELECT 1 succeeded' };
  } catch (error) {
    return { name: 'database (postgres)', ok: false, detail: String(error) };
  }
}

async function checkRedis(): Promise<CheckResult> {
  const { redis } = await import('../src/lib/redis');
  try {
    const pong = await redis.ping();
    return { name: 'redis', ok: pong === 'PONG', detail: `PING → ${pong}` };
  } catch (error) {
    return { name: 'redis', ok: false, detail: String(error) };
  }
}

async function checkRpc(): Promise<CheckResult> {
  const { getProvider } = await import('../src/lib/rpc');
  try {
    const provider = getProvider('ethereum');
    const blockNumber = await provider.getBlockNumber();
    return {
      name: 'rpc (ethereum/alchemy)',
      ok: blockNumber > 0,
      detail: `latest block: #${blockNumber.toLocaleString()}`,
    };
  } catch (error) {
    return { name: 'rpc (ethereum/alchemy)', ok: false, detail: String(error) };
  }
}

async function checkTokenRegistry(): Promise<CheckResult> {
  const { Contract } = await import('ethers');
  const { getProvider } = await import('../src/lib/rpc');
  const { TOKEN_REGISTRY } = await import('../src/lib/token-registry');
  const { CHAIN_IDS } = await import('../src/lib/constants');

  // Reverse map: chainId → ChainName, built from CHAIN_IDS
  const chainIdToName = new Map(
    Object.entries(CHAIN_IDS).map(([name, id]) => [id as number, name as keyof typeof CHAIN_IDS]),
  );

  // Minimal ERC-20 ABI — only the two fields we want to verify
  const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
  ];

  const mismatches: string[] = [];
  let checked = 0;

  // Check every entry in the registry in parallel per chain
  const checks = Object.entries(TOKEN_REGISTRY).flatMap(([chainIdStr, tokens]) => {
    const chainId = Number(chainIdStr);
    const chainName = chainIdToName.get(chainId);
    if (!chainName) return [];

    return Object.entries(tokens).map(async ([address, expected]) => {
      try {
        const provider = getProvider(chainName);
        const contract = new Contract(address, ERC20_ABI, provider);
        const [onChainSymbol, onChainDecimals] = await Promise.all([
          contract.symbol() as Promise<string>,
          contract.decimals() as Promise<bigint>,
        ]);

        checked++;

        // Compare against rawSymbol when defined, otherwise canonical symbol
        const expectedOnChain = expected.rawSymbol ?? expected.symbol;
        if (onChainSymbol !== expectedOnChain) {
          mismatches.push(
            `chain ${chainId} ${address}: symbol expected ${expectedOnChain}, got ${onChainSymbol}`,
          );
        }
        if (Number(onChainDecimals) !== expected.decimals) {
          mismatches.push(
            `chain ${chainId} ${address}: decimals expected ${expected.decimals}, got ${onChainDecimals}`,
          );
        }
      } catch (error) {
        mismatches.push(`chain ${chainId} ${address}: RPC error — ${String(error)}`);
      }
    });
  });

  await Promise.all(checks);

  if (mismatches.length > 0) {
    return {
      name: 'token registry',
      ok: false,
      detail: `${mismatches.length} mismatch(es):\n    ${mismatches.join('\n    ')}`,
    };
  }

  return {
    name: 'token registry',
    ok: true,
    detail: `${checked} addresses verified on-chain`,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  try {
    const { db } = await import('../src/lib/db');
    await db.$disconnect();
  } catch { /* already disconnected or never connected */ }

  try {
    const { redis, redisSubscriber } = await import('../src/lib/redis');
    redis.disconnect();
    redisSubscriber.disconnect();
  } catch { /* already disconnected or never connected */ }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const DIM   = '\x1b[2m';
const RESET = '\x1b[0m';

async function main(): Promise<void> {
  console.log(`\n${DIM}Corridor Scout — Smoke Test${RESET}\n`);

  const checks = [checkEnv, checkDatabase, checkRedis, checkRpc, checkTokenRegistry];
  const results: CheckResult[] = [];

  for (const check of checks) {
    process.stdout.write(`  checking ${check.name.replace('check', '').trim()}...`);
    const result = await check();
    results.push(result);

    const icon  = result.ok ? '✓' : '✗';
    const color = result.ok ? GREEN : RED;
    // overwrite the "checking..." line
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    console.log(`  ${color}${icon}${RESET}  ${result.name.padEnd(26)} ${DIM}${result.detail}${RESET}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');

  if (failed.length === 0) {
    console.log(`${GREEN}  All checks passed.${RESET}\n`);
  } else {
    console.log(`${RED}  ${failed.length} check(s) failed: ${failed.map((r) => r.name).join(', ')}${RESET}\n`);
  }

  await cleanup();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nUnexpected smoke-test error:', err);
  process.exit(1);
});
