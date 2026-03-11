import pg from 'pg';
const { Pool } = pg;
import type { PoolClient } from 'pg';

let pool: InstanceType<typeof Pool> | null = null;

export interface DbConfig {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean };
}

export function initPool(config: DbConfig): void {
  if (pool) return;
  pool = new Pool({
    connectionString: config.connectionString,
    ssl: config.ssl ?? { rejectUnauthorized: false },
  });
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  if (!pool) throw new Error('Database pool not initialized');
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

export async function queryRaw(sql: string, params?: unknown[]) {
  if (!pool) throw new Error('Database pool not initialized');
  return pool.query(sql, params);
}

export async function transaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  if (!pool) throw new Error('Database pool not initialized');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getClient(): Promise<PoolClient> {
  if (!pool) throw new Error('Database pool not initialized');
  return pool.connect();
}

export function getPool(): InstanceType<typeof Pool> | null {
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
