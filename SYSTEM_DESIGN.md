# URL Shortener — System Design

## 1. Problem Statement

Design a service that:

- Accepts a long URL and returns a short code
- Redirects any short code to its original URL
- Tracks how many times each short URL was clicked
- Supports optional custom aliases and expiry dates

---

## 2. Functional Requirements

| Requirement  | Description                                  |
| ------------ | -------------------------------------------- |
| Shorten URL  | Given a long URL, return a unique short code |
| Redirect     | Given a short code, redirect to original URL |
| Custom Alias | Allow users to choose their own short code   |
| Expiry       | Allow URLs to expire after N days            |
| Analytics    | Track click count per short URL              |
| Deactivate   | Allow soft-deletion of a short URL           |

---

## 3. Non-Functional Requirements

| Requirement      | Target                                        |
| ---------------- | --------------------------------------------- |
| Redirect latency | < 10ms (cache hit), < 30ms (cache miss)       |
| Availability     | 99.9% uptime                                  |
| Read/Write ratio | ~100:1 (reads dominate heavily)               |
| Durability       | No URL data loss                              |
| Security         | No SQL injection, rate limiting, safe headers |

---

## 4. Capacity Estimation

### Assumptions

- 1 million new URLs shortened per day
- 100 million redirects per day (100:1 read/write ratio)
- Average URL length: 200 characters
- Short code length: 6 Base62 characters

### Storage

```
Per URL row:
  id            8 bytes
  short_code    12 bytes
  original_url  ~200 bytes
  metadata      ~50 bytes
  Total         ~270 bytes per row

1 million rows/day × 270 bytes = 270 MB/day
1 year = ~100 GB  →  manageable on a single PostgreSQL instance
```

### Throughput

```
Redirects: 100 million/day = ~1,160 requests/second (average)
Peak:      ~5,000 requests/second

Without cache: 5,000 DB queries/second → PostgreSQL struggles
With Redis:    ~95% cache hit rate → ~250 DB queries/second → trivial
```

This is why Redis is not optional at scale — it's the difference between needing 1 DB server vs 20.

---

## 5. High Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT                               │
│            (Browser / Mobile / API Consumer)                │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    EXPRESS SERVER                           │
│                                                             │
│  ┌──────────┐   ┌───────────┐   ┌──────────────────────┐  │
│  │  helmet  │   │   cors    │   │  express-rate-limit  │  │
│  └──────────┘   └───────────┘   └──────────────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                    ROUTER                           │   │
│  │  POST /api/urls          → UrlController.shorten   │   │
│  │  GET  /:shortCode        → UrlController.redirect  │   │
│  │  GET  /api/urls/:code/stats → UrlController.stats  │   │
│  │  DELETE /api/urls/:code  → UrlController.deactivate│   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  URL SERVICE                        │   │
│  │  - Business logic                                   │   │
│  │  - Cache orchestration                              │   │
│  │  - URL validation                                   │   │
│  │  - Deduplication                                    │   │
│  │  - Expiry checking                                  │   │
│  └──────────┬──────────────────────┬────────────────── ┘   │
│             │                      │                        │
│             ▼                      ▼                        │
│  ┌─────────────────┐    ┌─────────────────────┐           │
│  │  URL REPOSITORY │    │    REDIS CACHE       │           │
│  │  (SQL queries)  │    │  key: url:{code}     │           │
│  └────────┬────────┘    │  value: originalUrl  │           │
│           │             │  TTL: 24h            │           │
│           ▼             └─────────────────────┘           │
│  ┌─────────────────┐                                       │
│  │   POSTGRESQL    │                                       │
│  │   urls table    │                                       │
│  └─────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 6. Request Flow Diagrams

### 6a. Shorten URL (Write Path)

```
POST /api/urls  { url: "https://long-url.com" }
        │
        ▼
[Zod Validation] ─── invalid ──► 400 Bad Request
        │ valid
        ▼
[URL format check] ─── not http/https ──► 400 Bad Request
        │ valid
        ▼
[Custom alias?] ─── yes ──► [Check alias availability]
        │ no                       │ taken ──► 409 Conflict
        ▼                         │ free ──► continue
[Deduplication check]             │
[findByOriginalUrl]               │
        │                         │
        ├── exists ──► return existing shortUrl
        │
        ▼ not exists
[repo.create(dto)]
        │
        ▼
[BEGIN TRANSACTION]
        │
        ▼
[INSERT urls (...) RETURNING *]  ← PostgreSQL assigns id = 42
        │
        ▼
[shortCode = toBase62(42) = "00002q"]
        │
        ▼
[UPDATE urls SET short_code = "00002q" WHERE id = 42]
        │
        ▼
[COMMIT]
        │
        ▼
[Return UrlResponse]  ──► 201 Created
```

### 6b. Redirect (Read Path — Critical Path)

```
GET /:shortCode
        │
        ▼
[cache.get("url:abc123")]
        │
        ├── HIT ──► trackClick() [fire & forget, no await]
        │               │
        │               ▼
        │          302 Redirect to originalUrl   (~0.5ms total)
        │
        └── MISS
                │
                ▼
        [repo.findByShortCode("abc123")]   (~10-20ms)
                │
                ├── null ──────────────────────────► 404 Not Found
                │
                ├── isActive = false ──────────────► 404 Not Found
                │
                ├── expiresAt < NOW() ─────────────► 410 Gone
                │
                └── valid
                        │
                        ▼
                [Compute TTL]
                [cache.set("url:abc123", originalUrl, ttl)]
                        │
                        ▼
                [trackClick() — fire & forget]
                        │
                        ▼
                [302 Redirect to originalUrl]   (~15-25ms total)
```

---

## 7. Short Code Generation

### Strategy: Auto-Increment ID → Base62 Encode

```
Base62 alphabet: 0-9 a-z A-Z  (62 characters)

ID 1       →  "000001"
ID 62      →  "000010"
ID 3844    →  "000100"
ID 238328  →  "001000"

6 characters = 62^6 = 56,800,235,584 (~56 billion unique codes)
7 characters = 62^7 = 3,521,614,606,208 (~3.5 trillion)
```

### Why Not Other Strategies?

| Strategy                    | Problem                                                 |
| --------------------------- | ------------------------------------------------------- |
| Random string               | Collision probability grows with scale, need retry loop |
| Hash (MD5/SHA)              | Collisions on truncation, hard to guarantee uniqueness  |
| UUID                        | Too long (36 chars), not URL-friendly                   |
| **Auto-increment → Base62** | Collision-free by construction, short, deterministic    |

### Why Two Queries for Create?

The `id` is assigned by PostgreSQL's `BIGSERIAL` sequence — we don't know it before the INSERT. The short code is derived from the id. So:

1. INSERT with placeholder → PostgreSQL assigns id
2. Encode id to Base62 → get short code
3. UPDATE with real short code

Both queries happen inside a single transaction — atomic, consistent.

---

## 8. Caching Strategy

### Pattern: Cache-Aside (Lazy Loading)

The application manages the cache explicitly:

- On read: check cache first, populate on miss
- On write: do NOT pre-populate (lazy — only cache what gets read)
- On delete: invalidate the cache entry immediately

### Why Not Write-Through?

Write-through would cache every new URL at creation time. But many URLs are never clicked — we'd be wasting Redis memory on cold data. Cache-aside means only URLs that actually get clicked end up in cache.

### Cache Key Design

```
Key format:  url:{shortCode}
Examples:    url:abc123
             url:github

Value:       originalUrl (plain string — no serialization overhead)
TTL:         min(timeUntilExpiry, 86400 seconds)
```

Storing only the `originalUrl` string (not a JSON object) keeps values small and avoids serialization cost. The redirect path only needs the URL anyway.

### TTL Logic

```typescript
if (!expiresAt) return 86400; // no expiry → cache 24h

const secondsLeft = (expiresAt - now) / 1000;
if (secondsLeft <= 0) return 0; // already expired → don't cache
return Math.min(secondsLeft, 86400); // cache until expiry or 24h, whichever is sooner
```

This prevents the cache from serving a URL after its expiry date.

### Graceful Degradation

If Redis goes down:

- `cache.get()` returns `null` → treated as cache miss → falls back to PostgreSQL
- `cache.set()` fails silently → next request also misses → falls back again
- App continues working, just slower

Redis failure never crashes the app. PostgreSQL is always the source of truth.

---

## 9. Database Schema

```sql
CREATE TABLE urls (
  id           BIGSERIAL    PRIMARY KEY,
  short_code   VARCHAR(12)  NOT NULL,
  original_url TEXT         NOT NULL,
  custom_alias VARCHAR(50)  DEFAULT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ  DEFAULT NULL,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  click_count  BIGINT       NOT NULL DEFAULT 0,

  CONSTRAINT urls_short_code_unique    UNIQUE (short_code),
  CONSTRAINT urls_custom_alias_unique  UNIQUE (custom_alias),
  CONSTRAINT click_count_non_negative  CHECK (click_count >= 0)
);
```

### Design Decisions

| Decision                       | Reasoning                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `BIGSERIAL` not `SERIAL`       | 64-bit vs 32-bit. SERIAL maxes out at 2.1 billion. BIGSERIAL handles 9.2 quintillion.                               |
| `TEXT` for original_url        | No length limit. URLs with query params can be very long. VARCHAR(2048) would also work.                            |
| `TIMESTAMPTZ` not `TIMESTAMP`  | Stores timezone offset. Safe across server timezone changes. Always UTC internally.                                 |
| `is_active` soft delete        | Preserves analytics history. Allows recovery. Hard DELETE is irreversible.                                          |
| `click_count` in same table    | Simple for MVP. At scale, move to a separate events table or use Redis counters.                                    |
| `custom_alias` nullable UNIQUE | NULL values are not considered equal in SQL — two NULL values don't conflict. Only non-null aliases must be unique. |

### Indexes

```sql
-- Hottest query: redirect lookup by short_code
-- Partial: only active URLs (deactivated URLs never redirect)
CREATE INDEX idx_urls_short_code
  ON urls (short_code) WHERE is_active = TRUE;

-- Deduplication: check if originalUrl was already shortened
CREATE INDEX idx_urls_original_url
  ON urls (original_url) WHERE is_active = TRUE;

-- Expiry cleanup jobs: find expired active URLs efficiently
CREATE INDEX idx_urls_expires_at
  ON urls (expires_at) WHERE expires_at IS NOT NULL;
```

---

## 10. ACID Properties in This System

**Atomicity** — The two-query URL creation (INSERT + UPDATE) happens inside a transaction. Either both succeed or neither does. No partial state is possible.

**Consistency** — UNIQUE constraints on `short_code` and `custom_alias` ensure no duplicates can exist, even under concurrent load. CHECK constraint ensures click_count never goes negative.

**Isolation** — PostgreSQL's default isolation level (Read Committed) prevents dirty reads. Two requests creating the same custom alias simultaneously: one succeeds, one gets a constraint violation → 409 Conflict.

**Durability** — PostgreSQL writes to WAL (Write-Ahead Log) before confirming a transaction. Even if the server crashes mid-write, data is recoverable.

---

## 11. Security

| Threat             | Mitigation                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------- |
| SQL Injection      | Parameterized queries (`$1`, `$2`) — values never concatenated into SQL strings           |
| XSS                | helmet sets `X-Content-Type-Options` and `X-XSS-Protection` headers                       |
| Clickjacking       | helmet sets `X-Frame-Options: DENY`                                                       |
| Abuse / spam       | express-rate-limit: 60 requests/minute per IP on API routes                               |
| Large payloads     | `express.json({ limit: '10kb' })` rejects oversized bodies                                |
| Protocol injection | Service validates URL must be `http:` or `https:` — blocks `javascript://`, `ftp://` etc. |

---

## 12. Tradeoffs and Future Improvements

| Current (MVP)                   | At Scale                                                |
| ------------------------------- | ------------------------------------------------------- |
| Single server                   | Horizontal scaling behind a load balancer               |
| Click count via SQL UPDATE      | Redis INCR counter, batch flush to PostgreSQL           |
| In-process dependency injection | Proper IoC container                                    |
| No authentication               | API keys per user, URL ownership                        |
| No geographic analytics         | Separate click_events table with IP, country, timestamp |
| Single Redis instance           | Redis Cluster or Redis Sentinel for HA                  |
| Manual expiry checking          | Background job (cron) to clean up expired rows          |
