import Redis from 'ioredis';
import { ICache } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * RedisCache implements ICache.
 *
 * Design principle: Redis is a cache, not source of truth.
 * - If Redis is down: the app works, just slower (every request hits PostgreSQL)
 * - If PostgreSQL is down: the app is broken (no data source)
 *
 * This means ALL Redis errors are caught and swallowed.
 * A failed cache read → returns null (treated as cache miss → falls back to DB).
 * A failed cache write → silently skipped (next request will miss and re-populate).
 *
 * This design is called "graceful degradation" — Redis failure degrades
 * performance but never breaks functionality.
 */
class RedisCache implements ICache {
  private client: Redis;

  constructor() {
    this.client = new Redis({
      host: config.redis.host,
      port: config.redis.port,

      // lazyConnect: don't attempt connection in the constructor.
      // We call connect() explicitly at startup so we can await it
      // and log success/failure properly.
      lazyConnect: true,

      // If Redis is down, fail immediately instead of queuing up commands.
      // We don't want requests to hang waiting for Redis to come back.
      enableOfflineQueue: false,

      // Only retry once per command. If Redis is unavailable,
      // we want to fall back to the DB immediately, not wait for retries.
      maxRetriesPerRequest: 1,

      // Retry connection itself (reconnection strategy):
      // If the connection drops, retry with exponential backoff up to 30s.
      // This is for the persistent connection, not individual commands.
      retryStrategy(times) {
        const delay = Math.min(times * 500, 30_000); // 500ms, 1s, 1.5s, ... max 30s
        logger.warn(`Redis reconnecting, attempt ${times}`, { delay });
        return delay; // return delay in ms, or null to stop retrying
      },
    });

    // Log errors but don't throw — see design principle above
    this.client.on('error', (err) => {
      logger.warn('Redis error — operating in degraded mode', {
        error: err.message,
      });
    });

    this.client.on('connect', () => {
      logger.info('Redis connected');
    });

    this.client.on('reconnecting', () => {
      logger.warn('Redis reconnecting...');
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  /**
   * Get a value by key.
   * Returns null on cache miss OR on error (both mean "go to DB").
   */
  async get(key: string): Promise<string | null> {
    try {
      const value = await this.client.get(key);
      return value; // null if key doesn't exist in Redis
    } catch (err) {
      logger.warn('Redis GET failed, treating as cache miss', { key });
      return null; // fall back to DB — don't throw
    }
  }

  /**
   * Store a key-value pair with an expiry.
   *
   * We use SETEX (SET + EXpiry) instead of SET + EXPIRE separately.
   * Why? Atomicity. If the process crashes between SET and EXPIRE,
   * the key would exist forever with no expiry. SETEX is one atomic command.
   *
   * ttlSeconds defaults to config value (24 hours) if not specified.
   */
  async set(key: string, value: string, ttlSeconds = config.redis.ttlSeconds): Promise<void> {
    try {
      // SETEX key seconds value
      await this.client.setex(key, ttlSeconds, value);
    } catch (err) {
      // Failed to cache — not fatal, just means next request will also be a miss
      logger.warn('Redis SET failed', { key });
    }
  }

  /**
   * Delete a key.
   * Called when a URL is deactivated — we must evict the cached value
   * so the next request gets the updated state from the DB.
   */
  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      logger.warn('Redis DEL failed', { key });
    }
  }

  async disconnect(): Promise<void> {
    await this.client.quit(); // sends QUIT command — graceful shutdown
    logger.info('Redis disconnected');
  }
}

// Export a single shared instance — one Redis connection for the whole app
export const cache = new RedisCache();