/**
 * Redis client singletons and pub/sub helpers.
 *
 * Two clients are required:
 *   - `redis`           — general-purpose client (GET, SET, publish, etc.)
 *   - `redisSubscriber` — dedicated subscriber client
 *
 * Redis protocol forbids issuing any command other than SUBSCRIBE/UNSUBSCRIBE
 * on a connection that has entered pub/sub mode, so the two clients must be
 * separate connections.
 *
 * The globalThis pattern prevents connection pool exhaustion during Next.js
 * hot-reload in development (same reason as db.ts).
 */
import Redis from 'ioredis';
import superjson from 'superjson';

import { requireEnv } from './env';
import type { RedisChannel } from './constants';

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
  redisSubscriber: Redis | undefined;
};

function createClient(): Redis {
  return new Redis(requireEnv('REDIS_URL'));
}

export const redis = globalForRedis.redis ?? createClient();
export const redisSubscriber = globalForRedis.redisSubscriber ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
  globalForRedis.redisSubscriber = redisSubscriber;
}

// ---------------------------------------------------------------------------
// Pub/sub helpers
// ---------------------------------------------------------------------------

/**
 * Publish a message to a Redis channel.
 *
 * Uses superjson for serialisation so bigint and Date values are preserved
 * correctly across the wire.
 */
export async function publish(channel: RedisChannel, message: unknown): Promise<void> {
  await redis.publish(channel, superjson.stringify(message));
}

/**
 * Per-channel message handlers. A single top-level 'message' listener on
 * redisSubscriber dispatches to the correct handler, preventing listener
 * accumulation when subscribe() is called multiple times for the same channel
 * (e.g. during Next.js hot-reload in development).
 */
const channelHandlers = new Map<string, (raw: string) => void>();

// Register the single top-level dispatcher exactly once at module load.
redisSubscriber.on('message', (receivedChannel: string, raw: string) => {
  channelHandlers.get(receivedChannel)?.(raw);
});

/**
 * Subscribe to a Redis channel and invoke `handler` for each message.
 *
 * Safe to call multiple times for the same channel — subsequent calls replace
 * the handler (last-write-wins) without accumulating duplicate listeners.
 *
 * Uses superjson for deserialisation so bigint and Date values are restored
 * to their original types before being passed to the handler.
 */
export async function subscribe<T = unknown>(
  channel: RedisChannel,
  handler: (message: T) => void,
): Promise<void> {
  if (!channelHandlers.has(channel)) {
    await redisSubscriber.subscribe(channel);
  }
  channelHandlers.set(channel, (raw: string) => handler(superjson.parse<T>(raw)));
}
