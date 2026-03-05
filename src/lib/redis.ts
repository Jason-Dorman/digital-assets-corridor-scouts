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
 * Subscribe to a Redis channel and invoke `handler` for each message.
 *
 * Uses superjson for deserialisation so bigint and Date values are restored
 * to their original types before being passed to the handler.
 */
export async function subscribe<T = unknown>(
  channel: RedisChannel,
  handler: (message: T) => void,
): Promise<void> {
  await redisSubscriber.subscribe(channel);
  redisSubscriber.on('message', (receivedChannel: string, raw: string) => {
    if (receivedChannel !== channel) return;
    handler(superjson.parse<T>(raw));
  });
}
