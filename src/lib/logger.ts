/**
 * Minimal structured logger.
 *
 * - Production: emits newline-delimited JSON to stderr, suitable for log
 *   aggregators (Datadog, Logtail, etc.).
 * - Development: emits human-readable text to stderr.
 *
 * Not a replacement for a full observability stack — swap this module out for
 * pino/winston when the project graduates to a dedicated logging infrastructure.
 * All internal callers import `logger` from here, so the swap is a one-file change.
 */

const isDev = process.env.NODE_ENV !== 'production';

type LogMeta = Record<string, unknown>;

function emit(level: 'info' | 'warn' | 'error', message: string, meta?: LogMeta): void {
  const output = isDev
    ? `[${level.toUpperCase()}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}`
    : JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...meta });

  // Route to the appropriate console method so log-level filtering on the
  // consuming side (e.g. Docker log drivers) works as expected.
  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.info(output);
  }
}

export const logger = {
  info(message: string, meta?: LogMeta): void {
    emit('info', message, meta);
  },
  warn(message: string, meta?: LogMeta): void {
    emit('warn', message, meta);
  },
  error(message: string, meta?: LogMeta): void {
    emit('error', message, meta);
  },
};
