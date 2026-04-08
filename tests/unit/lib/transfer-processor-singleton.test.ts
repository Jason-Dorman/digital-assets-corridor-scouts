/**
 * Tests for src/lib/transfer-processor-singleton.ts
 *
 * Verifies that getTransferProcessor returns the same instance across calls.
 */

jest.mock('../../../src/lib/db', () => ({
  db: { transfer: { upsert: jest.fn(), update: jest.fn(), findUnique: jest.fn() } },
}));

jest.mock('../../../src/lib/redis', () => ({
  publish: jest.fn(),
}));

jest.mock('../../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../../src/lib/price-service', () => ({
  priceService: { getPrice: jest.fn().mockResolvedValue(1) },
}));

import { getTransferProcessor } from '../../../src/lib/transfer-processor-singleton';

describe('getTransferProcessor', () => {
  it('returns the same instance on repeated calls', () => {
    const a = getTransferProcessor();
    const b = getTransferProcessor();
    expect(a).toBe(b);
  });

  it('returns an object with orphanQueue and retryOrphans', () => {
    const processor = getTransferProcessor();
    expect(processor.orphanQueue).toBeDefined();
    expect(typeof processor.retryOrphans).toBe('function');
  });
});
