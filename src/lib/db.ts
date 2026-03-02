/**
 * Prisma client singleton.
 *
 * Prisma 7 requires a driver adapter — the datasource URL can no longer be
 * placed in schema.prisma or passed directly to the PrismaClient constructor.
 * We use @prisma/adapter-pg backed by a pg Pool.
 *
 * The globalThis pattern prevents connection pool exhaustion during Next.js
 * hot-reload in development (new module instance on every file change).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { requireEnv } from './env';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  const pool = new Pool({ connectionString: requireEnv('DATABASE_URL') });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db;
}
