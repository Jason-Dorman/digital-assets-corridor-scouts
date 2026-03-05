/**
 * Tests for the Redis client singleton and pub/sub helpers (src/lib/redis.ts).
 *
 * ioredis is fully mocked — no real Redis connection is made.
 * REDIS_URL is set before any module is required so requireEnv() succeeds.
 */

// Must be set before redis.ts is evaluated (it calls requireEnv at module load)
process.env.REDIS_URL = 'redis://localhost:6379';

// Shared mock functions so we can inspect calls across both client instances
const mockPublish = jest.fn().mockResolvedValue(1);
const mockIoRedisSubscribe = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    publish: mockPublish,
    subscribe: mockIoRedisSubscribe,
    on: mockOn,
  }));
});

import superjson from 'superjson';
import { redis, redisSubscriber, publish, subscribe } from '../../../src/lib/redis';
import { REDIS_CHANNELS } from '../../../src/lib/constants';

// ---------------------------------------------------------------------------
// Singleton exports
// ---------------------------------------------------------------------------

describe('redis singletons', () => {
  it('exports a redis client', () => {
    expect(redis).toBeDefined();
  });

  it('exports a separate redisSubscriber client', () => {
    expect(redisSubscriber).toBeDefined();
  });

  it('redis and redisSubscriber are separate instances', () => {
    // Two clients are required: one general-purpose, one locked in sub mode
    expect(redis).not.toBe(redisSubscriber);
  });
});

// ---------------------------------------------------------------------------
// publish()
// ---------------------------------------------------------------------------

describe('publish', () => {
  beforeEach(() => {
    mockPublish.mockClear();
  });

  it('serialises an object payload with superjson and calls redis.publish', async () => {
    const payload = { transferId: 'abc123', bridge: 'across' };
    await publish(REDIS_CHANNELS.TRANSFER_INITIATED, payload);
    expect(mockPublish).toHaveBeenCalledWith(
      'transfer:initiated',
      superjson.stringify(payload),
    );
  });

  it('serialises a numeric payload with superjson', async () => {
    await publish(REDIS_CHANNELS.POOL_SNAPSHOT, 42);
    expect(mockPublish).toHaveBeenCalledWith('pool:snapshot', superjson.stringify(42));
  });

  it('serialises a null payload with superjson', async () => {
    await publish(REDIS_CHANNELS.TRANSFER_COMPLETED, null);
    expect(mockPublish).toHaveBeenCalledWith('transfer:completed', superjson.stringify(null));
  });

  it('publishes to the exact channel string provided', async () => {
    await publish(REDIS_CHANNELS.TRANSFER_COMPLETED, {});
    expect(mockPublish).toHaveBeenCalledWith('transfer:completed', expect.any(String));
  });

  it('serialises bigint values correctly (preserves type through superjson)', async () => {
    const payload = { amount: 10000000000n, blockNumber: 20000000n };
    await publish(REDIS_CHANNELS.TRANSFER_INITIATED, payload);
    const raw = mockPublish.mock.calls[0][1] as string;
    // Round-trip: the serialised string must restore to the original bigint values
    const restored = superjson.parse<typeof payload>(raw);
    expect(restored.amount).toBe(10000000000n);
    expect(restored.blockNumber).toBe(20000000n);
  });

  it('serialises Date values correctly (preserves type through superjson)', async () => {
    const ts = new Date('2026-01-01T00:00:00Z');
    const payload = { timestamp: ts };
    await publish(REDIS_CHANNELS.TRANSFER_INITIATED, payload);
    const raw = mockPublish.mock.calls[0][1] as string;
    const restored = superjson.parse<typeof payload>(raw);
    expect(restored.timestamp).toEqual(ts);
    expect(restored.timestamp).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// subscribe()
// ---------------------------------------------------------------------------

describe('subscribe', () => {
  beforeEach(() => {
    mockIoRedisSubscribe.mockClear();
    mockOn.mockClear();
  });

  /** Helper to grab the inner 'message' handler registered via redisSubscriber.on */
  function getMessageHandler(): (channel: string, raw: string) => void {
    const call = mockOn.mock.calls.find(([event]) => event === 'message');
    if (!call) throw new Error('No message handler registered via .on()');
    return call[1];
  }

  it('subscribes to the given Redis channel', async () => {
    await subscribe(REDIS_CHANNELS.TRANSFER_INITIATED, jest.fn());
    expect(mockIoRedisSubscribe).toHaveBeenCalledWith('transfer:initiated');
  });

  it('registers a message event listener', async () => {
    await subscribe(REDIS_CHANNELS.TRANSFER_INITIATED, jest.fn());
    expect(mockOn).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('calls the handler with the superjson-parsed message on the correct channel', async () => {
    const handler = jest.fn();
    await subscribe(REDIS_CHANNELS.TRANSFER_INITIATED, handler);

    const messageHandler = getMessageHandler();
    const payload = { transferId: 'xyz', type: 'initiation' };
    messageHandler('transfer:initiated', superjson.stringify(payload));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('does NOT call the handler when the message arrives on a different channel', async () => {
    const handler = jest.fn();
    await subscribe(REDIS_CHANNELS.TRANSFER_INITIATED, handler);

    const messageHandler = getMessageHandler();
    messageHandler('transfer:completed', superjson.stringify({ transferId: 'xyz' }));

    expect(handler).not.toHaveBeenCalled();
  });

  it('parses nested structures correctly', async () => {
    const handler = jest.fn();
    await subscribe(REDIS_CHANNELS.POOL_SNAPSHOT, handler);

    const messageHandler = getMessageHandler();
    const payload = { poolId: 'across_eth_usdc', tvl: 1_000_000, assets: ['USDC'] };
    messageHandler('pool:snapshot', superjson.stringify(payload));

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('restores bigint and Date values in the handler', async () => {
    const handler = jest.fn();
    await subscribe(REDIS_CHANNELS.TRANSFER_INITIATED, handler);

    const messageHandler = getMessageHandler();
    const payload = { amount: 10000000000n, timestamp: new Date('2026-01-01T00:00:00Z') };
    messageHandler('transfer:initiated', superjson.stringify(payload));

    const received = handler.mock.calls[0][0];
    expect(received.amount).toBe(10000000000n);
    expect(received.timestamp).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(received.timestamp).toBeInstanceOf(Date);
  });
});
