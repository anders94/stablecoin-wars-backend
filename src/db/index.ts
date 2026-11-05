import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'stablecoin_wars',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Add statement timeout to prevent hanging queries (2 minutes default, much faster failure detection)
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '120000'),
  // Keep connections alive
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on('error', (err) => {
  // An idle client lost its connection (e.g. Postgres restarting). The pool drops that client
  // and opens new ones on demand, so log and carry on; callers that need to ride out the
  // outage use withDatabaseRetry.
  console.error('Database pool error (will attempt to recover):', err.message);
});

// Postgres codes for a server that is shutting down, restarting or unreachable
const CONNECTION_ERROR_CODES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (still starting up)
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);

/**
 * Whether an error means the database connection was lost or could not be made, as
 * opposed to a problem with the query itself.
 */
export function isConnectionError(error: unknown): boolean {
  const err = error as { code?: string; message?: string };
  if (err?.code && CONNECTION_ERROR_CODES.has(err.code)) {
    return true;
  }
  const message = err?.message || '';
  return message.includes('Connection terminated') ||
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('Client has encountered a connection error');
}

const DB_RETRY_DELAY_MS = 10 * 1000;
const DB_RETRY_MAX_WAIT_MS = 30 * 60 * 1000;

/**
 * Run fn, and if it fails because the database is unreachable, wait and run it again until
 * the database is back (up to 30 minutes). Any other error is thrown straight away. fn must
 * be safe to run again after a failure, e.g. a transaction that rolled back.
 */
export async function withDatabaseRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isConnectionError(error) || Date.now() - start + DB_RETRY_DELAY_MS > DB_RETRY_MAX_WAIT_MS) {
        throw error;
      }
      console.error(`Database unavailable during ${label} (${(error as Error).message}); retry ${attempt} in ${DB_RETRY_DELAY_MS / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, DB_RETRY_DELAY_MS));
    }
  }
}

export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

export async function execute(text: string, params?: unknown[]): Promise<number> {
  const result = await pool.query(text, params);
  return result.rowCount || 0;
}

export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection itself is gone; report the original error, not the failed rollback
      broken = true;
    }
    throw error;
  } finally {
    // Destroy a broken client instead of returning it to the pool
    client.release(broken);
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export { pool };
