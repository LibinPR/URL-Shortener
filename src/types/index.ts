// ─────────────────────────────────────────────
// DOMAIN TYPES
// Pure data shapes — no methods, no dependencies
// ─────────────────────────────────────────────

/**
 * Represents a URL row exactly as it exists in the database.
 * snake_case DB columns are mapped to camelCase here.
 */
export interface Url {
  id: number;
  shortCode: string;
  originalUrl: string;
  customAlias: string | null;  // null means no custom alias set
  createdAt: Date;
  expiresAt: Date | null;      // null means never expires
  isActive: boolean;
  clickCount: number;
}

/**
 * Data Transfer Object — what the caller passes to create a URL.
 * Only the fields the caller can control. id, createdAt, clickCount
 * are set by the system, not the user.
 */
export interface CreateUrlDto {
  originalUrl: string;
  customAlias?: string;  // optional — user may not provide one
  expiresAt?: Date;      // optional — may not set an expiry
}

/**
 * What we return to the API client.
 * Includes shortUrl (constructed, not stored) but not internal fields
 * like id, isActive, clickCount (those are internal concerns).
 */
export interface UrlResponse {
  shortCode: string;
  shortUrl: string;    // full URL e.g. http://localhost:3000/abc123
  originalUrl: string;
  expiresAt: Date | null;
  createdAt: Date;
}

/**
 * Analytics response — includes click count.
 * Separate from UrlResponse because most callers don't need stats.
 */
export interface UrlStats {
  shortCode: string;
  originalUrl: string;
  clickCount: number;
  createdAt: Date;
  expiresAt: Date | null;
  isActive: boolean;
}

// ─────────────────────────────────────────────
// REPOSITORY INTERFACE
// The contract for database access.
// UrlService depends on this interface — not the concrete class.
// This means you can swap PostgreSQL for MySQL by writing a new class
// that implements this interface, without touching UrlService at all.
// ─────────────────────────────────────────────

export interface IUrlRepository {
  findByShortCode(shortCode: string): Promise<Url | null>;
  findByOriginalUrl(originalUrl: string): Promise<Url | null>;
  create(dto: CreateUrlDto): Promise<Url>;
  incrementClicks(shortCode: string): Promise<void>;
  deactivate(shortCode: string): Promise<boolean>;
  getStats(shortCode: string): Promise<Url | null>;
}

// ─────────────────────────────────────────────
// CACHE INTERFACE
// The contract for caching.
// In tests, you inject MemoryCache instead of RedisCache.
// UrlService never knows which one it's using.
// ─────────────────────────────────────────────

export interface ICache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

// ─────────────────────────────────────────────
// CUSTOM ERRORS
// Typed errors that carry HTTP status codes.
// The error handler middleware reads these to form the response.
// ─────────────────────────────────────────────

/**
 * Base class for all application errors.
 * Extends Error so it works with try/catch and instanceof.
 * 
 * Why Object.setPrototypeOf?
 * TypeScript compiles class inheritance to ES5 prototype chains.
 * When extending built-in classes like Error, the prototype chain
 * can break in certain environments. This line fixes it.
 */
export class AppError extends Error {
  constructor(
    public readonly message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

// 404 — resource not found
export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
    Object.setPrototypeOf(this, NotFoundError.prototype);
  }
}

// 409 — conflict (e.g. alias already taken)
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
    Object.setPrototypeOf(this, ConflictError.prototype);
  }
}

// 400 — bad input from client
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

// 410 — resource existed but is now gone (expired URL)
// 410 is semantically better than 404 for expired URLs
// It tells the client "this existed but doesn't anymore"
export class GoneError extends AppError {
  constructor() {
    super('This short URL has expired', 410, 'URL_EXPIRED');
    Object.setPrototypeOf(this, GoneError.prototype);
  }
}