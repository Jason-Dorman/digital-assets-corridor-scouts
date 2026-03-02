/**
 * Validated environment variable access.
 *
 * Centralises env validation so every lib file gets a clear, actionable
 * error at access time rather than a silent undefined that surfaces as a
 * cryptic failure later. Follows the engineering principle of making
 * dependencies explicit and failing fast.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Ensure it is set in .env.local (Next.js) or exported before running scripts.`,
    );
  }
  return value;
}
