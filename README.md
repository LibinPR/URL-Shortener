# URL Shortener

A production-grade URL shortener built with Node.js, Express, TypeScript, PostgreSQL, and Redis.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 |
| Framework | Express 4 |
| Language | TypeScript (strict mode) |
| Database | PostgreSQL 16 |
| Cache | Redis 7 |
| Validation | Zod |
| Logging | Winston |
| Infrastructure | Docker + Docker Compose |

---

## Features

- Shorten any `http`/`https` URL to a 6-character Base62 code
- Custom aliases (e.g. `/github` instead of `/a1b2c3`)
- Optional expiry — URLs can expire after N days
- Click tracking on every redirect
- URL deduplication — shortening the same URL twice returns the same code
- Soft delete — deactivate URLs without losing analytics
- Redis cache with graceful degradation (app works if Redis is down)
- Rate limiting on API routes (60 req/min per IP)
- Structured JSON logging

---

## Prerequisites

- [Node.js 20+](https://nodejs.org)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Git](https://git-scm.com)

---

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/yourusername/url-shortener.git
cd url-shortener
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set your values. The defaults work with the Docker Compose setup out of the box.

### 4. Start infrastructure (PostgreSQL + Redis)

```bash
docker-compose up -d
```

Verify both containers are running:
```bash
docker ps
```

### 5. Run database migration

```bash
npm run migrate
```

This creates the `urls` table and indexes. Safe to run multiple times.

### 6. Start the development server

```bash
npm run dev
```

Server starts at `http://localhost:3000`

---

## API Reference

### Shorten a URL

```http
POST /api/urls
Content-Type: application/json

{
  "url": "https://example.com/very/long/path",
  "customAlias": "my-link",
  "expiresInDays": 30
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | Must be a valid http/https URL |
| `customAlias` | string |  4-30 alphanumeric chars, hyphens, underscores |
| `expiresInDays` | number |  Integer between 1 and 3650 |

**Response 201:**
```json
{
  "success": true,
  "data": {
    "shortCode": "000001",
    "shortUrl": "http://localhost:3000/000001",
    "originalUrl": "https://example.com/very/long/path",
    "expiresAt": "2024-02-01T00:00:00.000Z",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### Redirect

```http
GET /:shortCode
```

Returns `302 Found` with `Location` header set to the original URL.

Returns `404` if not found or deactivated.
Returns `410 Gone` if the URL has expired.

---

### Get Stats

```http
GET /api/urls/:shortCode/stats
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "shortCode": "000001",
    "originalUrl": "https://example.com/very/long/path",
    "clickCount": 42,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "expiresAt": null,
    "isActive": true
  }
}
```

---

### Deactivate a URL

```http
DELETE /api/urls/:shortCode
```

**Response 200:**
```json
{
  "success": true,
  "message": "Short URL '000001' has been deactivated"
}
```

---

### Health Check

```http
GET /health
```

**Response 200:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime": 120
}
```

---

## Error Responses

All errors follow this structure:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  }
}
```

| HTTP Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Invalid request body |
| 404 | `NOT_FOUND` | Short URL doesn't exist |
| 409 | `CONFLICT` | Custom alias already taken |
| 410 | `URL_EXPIRED` | URL existed but has expired |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unexpected server error |

---

## Project Structure

```
src/
├── config/index.ts              # Centralized environment config
├── types/index.ts               # Interfaces, DTOs, custom errors
├── db/
│   ├── postgres.ts              # Connection pool + transaction helper
│   ├── redis.ts                 # Redis cache client
│   └── migrate.ts               # Schema migration
├── utils/
│   ├── base62.ts                # ID → short code encoder
│   ├── logger.ts                # Winston logger
│   └── validation.ts            # Zod request schemas
├── repositories/
│   └── url.repository.ts        # All PostgreSQL queries
├── services/
│   └── url.service.ts           # Business logic + cache
├── controllers/
│   └── url.controller.ts        # HTTP request/response handling
├── middleware/
│   ├── error.ts                 # Global error handler
│   └── requestLogger.ts         # Request logging
├── routes/index.ts              # Route definitions
├── app.ts                       # Express app + dependency wiring
└── index.ts                     # Server entry point
```

---

## Scripts

```bash
npm run dev        # Start dev server with hot reload
npm run build      # Compile TypeScript to dist/
npm run start      # Run compiled production build
npm run migrate    # Create database schema
```

---

## Docker Commands

```bash
# Start containers
docker-compose up -d

# Stop containers
docker-compose down

# View logs
docker logs urlshortener_db
docker logs urlshortener_redis

# Inspect Redis cache
docker exec -it urlshortener_redis redis-cli
KEYS *
GET url:abc123
TTL url:abc123

# Inspect PostgreSQL
docker exec -it urlshortener_db psql -U postgres -d urlshortener
\d urls
SELECT * FROM urls;
```

---

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full layered architecture, SOLID principles, dependency injection pattern, and complete request lifecycle.

See [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md) for system design, capacity estimation, caching strategy, short code generation, and tradeoffs.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Environment |
| `BASE_URL` | `http://localhost:3000` | Base URL for generating short links |
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `urlshortener` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | — | Database password |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_TTL_SECONDS` | `86400` | Cache TTL (24 hours) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (1 minute) |
| `RATE_LIMIT_MAX` | `60` | Max requests per window per IP |

---

## License

MIT
