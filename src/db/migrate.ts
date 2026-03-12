import { pool, connectDb } from './postgres';
import { logger } from '../utils/logger';

/**
 * Creates the database schema.
 *
 * Run once with: npm run migrate
 * Safe to re-run: IF NOT EXISTS on table and indexes means it won't
 * fail or duplicate anything if you run it again.
 */
const createUrlsTable = `
  CREATE TABLE IF NOT EXISTS urls (

    -- BIGSERIAL: auto-incrementing 64-bit integer
    -- Automatically creates a sequence and sets DEFAULT nextval(sequence)
    -- Range: 1 to 9,223,372,036,854,775,807 (9.2 quintillion)
    id           BIGSERIAL     PRIMARY KEY,

    -- The generated short code (e.g. "a1b2c3")
    -- VARCHAR(12) gives us room for codes up to 12 chars
    -- NOT NULL: every URL must have a code
    short_code   VARCHAR(12)   NOT NULL,

    -- The original long URL the user wants to shorten
    -- TEXT: no length limit (URLs can be very long with query params)
    original_url TEXT          NOT NULL,

    -- User-provided alias (e.g. "my-blog-post" instead of "a1b2c3")
    -- NULL means the user didn't provide one
    custom_alias VARCHAR(50)   DEFAULT NULL,

    -- TIMESTAMPTZ: timestamp WITH time zone
    -- Always stores in UTC. Critical for correctness across timezones.
    -- DEFAULT NOW(): database sets this automatically on insert
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    -- When this URL expires. NULL = never expires.
    expires_at   TIMESTAMPTZ   DEFAULT NULL,

    -- Soft delete flag. We never hard-DELETE rows.
    -- Soft delete preserves analytics history and allows recovery.
    is_active    BOOLEAN       NOT NULL DEFAULT TRUE,

    -- Click counter. Incremented atomically on each redirect.
    click_count  BIGINT        NOT NULL DEFAULT 0,

    -- CONSTRAINTS --

    -- Unique short codes: no two URLs can have the same short_code.
    -- This is enforced at DB level — even if application code has a bug,
    -- the DB will reject duplicates.
    CONSTRAINT urls_short_code_unique   UNIQUE (short_code),

    -- Custom aliases must also be globally unique.
    -- Note: NULL values are NOT considered equal in SQL — two NULL custom_alias
    -- values won't conflict. Only non-null aliases must be unique.
    CONSTRAINT urls_custom_alias_unique UNIQUE (custom_alias),

    -- Business rule: click count can never go negative
    CONSTRAINT click_count_non_negative CHECK (click_count >= 0)
  );
`;

// ── INDEXES ──────────────────────────────────────────────────────────────────
// Indexes speed up SELECT queries at the cost of slightly slower INSERTs
// (because the index must be updated too).
// Every column you regularly filter/sort on should have an index.

const createIndexes = `
  -- Primary lookup: "give me the URL for short code X"
  -- This is the hottest query in the entire system (every redirect).
  -- Partial index: WHERE is_active = TRUE means the index only contains
  -- active URLs. Smaller index = faster lookups.
  -- Deactivated URLs are never in the redirect flow, so excluding them is safe.
  CREATE INDEX IF NOT EXISTS idx_urls_short_code
    ON urls (short_code)
    WHERE is_active = TRUE;

  -- Deduplication: "has this long URL already been shortened?"
  -- We check this on every create request.
  -- Same partial index strategy: only active URLs matter for deduplication.
  CREATE INDEX IF NOT EXISTS idx_urls_original_url
    ON urls (original_url)
    WHERE is_active = TRUE;

  -- Expiry cleanup: a background job can efficiently find expired URLs
  -- with: WHERE expires_at < NOW() AND is_active = TRUE
  -- Without this index, that query scans the entire table.
  CREATE INDEX IF NOT EXISTS idx_urls_expires_at
    ON urls (expires_at)
    WHERE expires_at IS NOT NULL;
`;

async function migrate(): Promise<void> {
  await connectDb();

  logger.info('Running migrations...');

  await pool.query(createUrlsTable);
  logger.info('Table created: urls');

  await pool.query(createIndexes);
  logger.info('Indexes created');

  logger.info('Migration complete ✓');

  await pool.end();
}

migrate().catch((err) => {
  logger.error('Migration failed', { error: err.message });
  process.exit(1);
});