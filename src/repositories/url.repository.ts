import { pool, withTransaction } from '../db/postgres';
import { IUrlRepository, Url, CreateUrlDto } from '../types';
import { toBase62 } from '../utils/base62';
import { logger } from '../utils/logger';

function rowToUrl(row: Record<string, any>): Url {
  return {
    id: Number(row.id),
    shortCode: row.short_code,
    originalUrl: row.original_url,
    customAlias: row.custom_alias,       // null if not set
    createdAt: new Date(row.created_at),
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    isActive: row.is_active,
    clickCount: Number(row.click_count), // pg returns bigint as string — convert
  };
}

export class UrlRepository implements IUrlRepository {
    async findByShortCode(shortCode: string): Promise<Url | null> {
    // $1 is a parameterized query placeholder
    // NEVER do: `WHERE short_code = '${shortCode}'` — that's SQL injection
    // gets no results instead of dumping your entire database
    const result = await pool.query(
      `SELECT * FROM urls WHERE short_code = $1 LIMIT 1`,
      [shortCode]
    );

    if (result.rows.length === 0) {
      return null; // caller handles the "not found" case
    }

    return rowToUrl(result.rows[0]);
  }

  async findByOriginalUrl(originalUrl: string): Promise<Url | null> {
    const result = await pool.query(
      `SELECT * FROM urls
       WHERE original_url = $1
       AND is_active = TRUE
       LIMIT 1`,
      [originalUrl]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToUrl(result.rows[0]);
  }

  async create(dto: CreateUrlDto): Promise<Url> {
    // withTransaction gives us a client and handles BEGIN/COMMIT/ROLLBACK
    return withTransaction(async (client) => {

      // Step 1: INSERT the row.
      // short_code gets a temporary placeholder - then updated
      // RETURNING * gives us back the full inserted row including
      // the auto-generated id.
      const insertResult = await client.query(
        `INSERT INTO urls (short_code, original_url, custom_alias, expires_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [
          'placeholder',           // temporary, will be replaced immediately
          dto.originalUrl,
          dto.customAlias ?? null, // ?? null: undefined becomes null for SQL
          dto.expiresAt ?? null,
        ]
      );

      const row = insertResult.rows[0];
      const id: number = Number(row.id);

      // Step 2: Generate the real short code.
      // If user provided a custom alias, use that.
      // Otherwise encode the auto-generated id to Base62.
      const shortCode = dto.customAlias ?? toBase62(id);

      // Step 3: UPDATE the row with the real short code.
      // RETURNING * gives us the final state of the row.
      const updateResult = await client.query(
        `UPDATE urls
         SET short_code = $1
         WHERE id = $2
         RETURNING *`,
        [shortCode, id]
      );

      logger.debug('URL created', { id, shortCode });

      return rowToUrl(updateResult.rows[0]);
    });
  }

  async incrementClicks(shortCode: string): Promise<void> {
    try {
      // click_count + 1 is atomic in PostgreSQL
      // Even if 1000 requests hit this simultaneously, each increment
      // is applied correctly. No race conditions
      // This is different from: read count → add 1 → write back
      // (which WOULD have race conditions)
      await pool.query(
        `UPDATE urls
         SET click_count = click_count + 1
         WHERE short_code = $1`,
        [shortCode]
      );
    } catch (err) {
      // This method is called fire-and-forget from the service
      // A failed click count must never cause a redirect to fail
      logger.error('Failed to increment click count', {
        shortCode,
        error: (err as Error).message,
      });
    }
  }

  async deactivate(shortCode: string): Promise<boolean> {
    const result = await pool.query(
      `UPDATE urls
       SET is_active = FALSE
       WHERE short_code = $1
       AND is_active = TRUE
       RETURNING id`,
      [shortCode]
    );

    // rowCount tells us how many rows were affected
    // 0 means either the code doesn't exist or was already deactivated
    // We return a boolean so the service can decide whether to throw NotFoundError
    return (result.rowCount ?? 0) > 0;
  }

  async getStats(shortCode: string): Promise<Url | null> {
    // No is_active filter here — we want stats even for deactivated URLs
    // Someone might deactivate a URL but still want to see how many clicks it got
    const result = await pool.query(
      `SELECT * FROM urls WHERE short_code = $1 LIMIT 1`,
      [shortCode]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return rowToUrl(result.rows[0]);
  }
}