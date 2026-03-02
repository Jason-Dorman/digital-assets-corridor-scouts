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

  const checks = [checkEnv, checkDatabase, checkRedis, checkRpc];
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
