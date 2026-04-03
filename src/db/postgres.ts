import { Pool , PoolClient } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * A connection pool is a set of pre-opened database connections
 * that are reused across requests.
 *
 * Without a pool:
 *   Each request → open TCP connection → authenticate → query → close connection
 *   Opening a connection takes ~50-100ms. Unacceptable per-request overhead.
 *
 * With a pool (min: 2, max: 10):
 *   App starts → opens 2 connections immediately and keeps them open
 *   Request arrives → borrows a connection from pool → query (~1ms) → returns it
 *   If all 10 connections are busy → new requests wait in queue
 *   If load drops → excess connections close, min 2 remain
 */

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  min: config.db.poolMin,               // always keep 2 connections open
  max: config.db.poolMax,               // never exceed 10 connections
  idleTimeoutMillis: 30_000,            // close a connection idle for 30s
  connectionTimeoutMillis: 5_000,       // throw if can't get connection in 5s
  statement_timeout: 10_000,            // kill any query running longer than 10s
  ssl: config.db.ssl ? { rejectUnauthorized: false } : false,

});

// Log pool-level errors — these aren't tied to a specific request
pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { error: err.message });
});

/**
 * Call this at startup to verify the DB is reachable before accepting traffic
 * Fails fast: if the DB is misconfigured, crash immediately with a clear message
 * rather than serving requests that will all fail
 */
export async function connectDb(): Promise<void> {
  // connect() borrows a client from the pool
  const client = await pool.connect();
  try {
    await client.query('SELECT 1'); // cheapest possible query — just tests connectivity
    logger.info('PostgreSQL connected', {
      host: config.db.host,
      database: config.db.database,
    });
  } finally {
    // ALWAYS release the client back to the pool — in both success and error paths.
    // If you forget this, the connection is never returned and the pool
    // eventually exhausts all connections. App hangs. Very hard to debug.
    client.release();
  }
}

/**
 * Wraps multiple queries in a transaction.
 *
 * A transaction is an all-or-nothing operation:
 * - If all queries succeed → COMMIT (changes are permanent)
 * - If any query throws → ROLLBACK (all changes are undone, DB unchanged)
 *
 * We use this when creating a URL:
 * 1. INSERT row (gets auto-generated id)
 * 2. UPDATE row with Base62-encoded short_code derived from that id
 * Both must succeed or neither should. A transaction guarantees this.
 *
 * Usage:
 *   const result = await withTransaction(async (client) => {
 *     const { rows } = await client.query('INSERT ... RETURNING *');
 *     await client.query('UPDATE ...');
 *     return rows[0];
 *   });
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');      // start the transaction
    const result = await fn(client);  // run all your queries
    await client.query('COMMIT');     // make changes permanent
    return result;
  } catch (err) {
    await client.query('ROLLBACK');   // undo everything on error
    throw err;                        // re-throw so caller handles it
  } finally {
    client.release();                 // always return connection to pool
  }
}

export async function closeDb(): Promise<void> {
  await pool.end(); // gracefully close all pool connections
  logger.info('PostgreSQL pool closed');
}