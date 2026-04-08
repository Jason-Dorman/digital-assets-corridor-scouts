/**
 * TransferProcessor singleton.
 *
 * The globalThis pattern ensures the same TransferProcessor instance (and its
 * in-memory orphan queue) survives Next.js hot-reload in development.
 *
 * Without this, the cron endpoint for orphan retries would create a fresh
 * processor with an empty queue, making retries impossible.
 */

import { TransferProcessor } from '../processors/transfer';

const globalForProcessor = globalThis as unknown as {
  transferProcessor: TransferProcessor | undefined;
};

export function getTransferProcessor(): TransferProcessor {
  if (!globalForProcessor.transferProcessor) {
    globalForProcessor.transferProcessor = new TransferProcessor();
  }
  return globalForProcessor.transferProcessor;
}
