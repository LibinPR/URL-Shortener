# URL Shortener — Architecture

## 1. Layered Architecture

The application follows a strict layered architecture. Each layer has one responsibility and communicates only with the layer directly below it.

```
┌─────────────────────────────────────────┐
│           HTTP (Express)                │  ← receives raw HTTP
├─────────────────────────────────────────┤
│           Middleware                    │  ← security, logging, rate limit
├─────────────────────────────────────────┤
│           Controller                   │  ← parse request, format response
├─────────────────────────────────────────┤
│           Service                      │  ← business logic, cache logic
├─────────────────────────────────────────┤
│           Repository                   │  ← SQL queries only
├─────────────────────────────────────────┤
│      PostgreSQL        Redis            │  ← infrastructure
└─────────────────────────────────────────┘
```

### The Rule

Each layer only imports from the layer below. A controller never imports the repository. A repository never imports the service. Violations of this rule create circular dependencies and make testing impossible.

---

## 2. Folder Structure

```
url-shortener/
├── src/
│   ├── config/
│   │   └── index.ts          # All env vars in one place, parsed and typed
│   │
│   ├── types/
│   │   └── index.ts          # Interfaces, DTOs, custom error classes
│   │
│   ├── db/
│   │   ├── postgres.ts       # Connection pool + withTransaction helper
│   │   ├── redis.ts          # Redis client implementing ICache
│   │   └── migrate.ts        # Schema creation script (run once)
│   │
│   ├── utils/
│   │   ├── base62.ts         # ID → short code encoder
│   │   ├── logger.ts         # Winston structured logger
│   │   └── validation.ts     # Zod request schemas
│   │
│   ├── repositories/
│   │   └── url.repository.ts # All PostgreSQL queries. Nothing else.
│   │
│   ├── services/
│   │   └── url.service.ts    # Business logic + cache orchestration
│   │
│   ├── controllers/
│   │   └── url.controller.ts # HTTP parsing and response formatting
│   │
│   ├── middleware/
│   │   ├── error.ts          # Global error → JSON response handler
│   │   └── requestLogger.ts  # Logs every request with status + duration
│   │
│   ├── routes/
│   │   └── index.ts          # Route definitions — wires URLs to handlers
│   │
│   ├── app.ts                # Express setup + dependency wiring
│   └── index.ts              # Entry point — starts server, graceful shutdown
│
├── .env.example              # Template — commit this, never commit .env
├── .gitignore
├── docker-compose.yml        # PostgreSQL + Redis for local development
├── package.json
├── tsconfig.json
├── SYSTEM_DESIGN.md
├── ARCHITECTURE.md
└── README.md
```

---

## 3. SOLID Principles Applied

### S — Single Responsibility

Every file does exactly one thing:

| File | Its one job |
|---|---|
| `url.repository.ts` | Execute SQL queries against PostgreSQL |
| `url.service.ts` | Apply business rules and orchestrate cache |
| `url.controller.ts` | Parse HTTP requests and format HTTP responses |
| `error.ts` | Convert any error into a clean JSON response |
| `base62.ts` | Encode numbers to Base62 strings |
| `validation.ts` | Define the shape of valid request bodies |

If you need to change how SQL queries are written → touch only the repository. If you need to change the response format → touch only the controller. Changes are isolated.

### O — Open/Closed

The `ICache` interface allows new cache implementations without modifying existing code:

```typescript
// Today: Redis
const service = new UrlService(repo, new RedisCache());

// Tomorrow: Memcached (just implement ICache)
const service = new UrlService(repo, new MemcachedCache());

// In tests: in-memory
const service = new UrlService(repo, new MemoryCache());
```

`UrlService` never changes. It's open for extension, closed for modification.

### L — Liskov Substitution

Any class implementing `ICache` can replace any other without breaking `UrlService`. Any class implementing `IUrlRepository` can replace `UrlRepository`. The service works correctly with any conforming implementation.

### I — Interface Segregation

`ICache` only declares what the service needs: `get`, `set`, `del`. The Redis client has many other methods (`lpush`, `zadd`, `subscribe`...) but they're not exposed through the interface. The service can only do what the interface allows.

### D — Dependency Inversion

High-level modules depend on abstractions, not concretions:

```
UrlService depends on → IUrlRepository (interface)
UrlService depends on → ICache (interface)

NOT:
UrlService depends on → UrlRepository (concrete class)
UrlService depends on → RedisCache (concrete class)
```

Concrete instances are created once in `app.ts` and injected downward. No layer creates its own dependencies.

---

## 4. Dependency Injection Flow

Everything is wired in `app.ts`. Reading bottom-up:

```typescript
// Infrastructure (no dependencies)
const repo = new UrlRepository();         // depends on: pool (global)
const cacheInstance = cache;              // depends on: config (global)

// Business logic (depends on interfaces)
const service = new UrlService(repo, cacheInstance);

// HTTP handling (depends on service)
const controller = new UrlController(service);

// Routing (depends on controller)
const router = createRouter(controller);

app.use(router);
```

This is called **manual dependency injection** — no framework, no magic, full control and visibility.

---

## 5. Error Handling Architecture

Errors flow upward through layers and are handled at the top:

```
Repository throws:   new Error("connection refused")
                          ↓
Service catches it:  (doesn't — re-throws automatically)
                          ↓
Controller catches:  next(err)  ← passes to Express error middleware
                          ↓
Error middleware:    instanceof AppError? → structured JSON response
                    unknown error?       → 500 + log full stack trace
```

### Custom Error Hierarchy

```
Error (built-in)
  └── AppError (base — carries statusCode + code)
        ├── NotFoundError    (404, NOT_FOUND)
        ├── ConflictError    (409, CONFLICT)
        ├── ValidationError  (400, VALIDATION_ERROR)
        └── GoneError        (410, URL_EXPIRED)
```

Controllers never decide status codes. They throw typed errors. The error middleware maps error types to responses. Status code logic lives in one place.

---

## 6. Middleware Pipeline

Every request passes through this pipeline in order:

```
Incoming Request
      │
      ▼
┌─────────────┐
│   helmet    │  Sets 15+ security HTTP headers
└──────┬──────┘
       ▼
┌─────────────┐
│    cors     │  Adds Access-Control headers for browser clients
└──────┬──────┘
       ▼
┌─────────────┐
│ express     │  Parses JSON body into req.body
│   .json()   │  Rejects bodies > 10kb
└──────┬──────┘
       ▼
┌─────────────┐
│  request    │  Records start time, logs method+path+status+duration on finish
│   Logger    │
└──────┬──────┘
       ▼
┌─────────────┐
│   health    │  GET /health → returns 200 immediately
│   check     │  (registered before router to avoid /:shortCode catching it)
└──────┬──────┘
       ▼
┌─────────────┐
│ rate limit  │  Applied to /api/* only — 60 req/min per IP
└──────┬──────┘
       ▼
┌─────────────┐
│   router    │  Matches route, calls controller handler
└──────┬──────┘
       ▼
┌─────────────┐
│   error     │  Catches any next(err) from handlers
│   handler   │  Returns structured JSON error response
└─────────────┘
```

**Order is not optional.** The health check must be before the router. The error handler must be last. Rate limiting must be before route handlers. This sequence is deliberate.

---

## 7. Data Flow: Complete Request Lifecycle

### POST /api/urls (Shorten)

```
1. Request arrives at Express
2. helmet adds security headers to response
3. cors adds CORS headers
4. express.json() parses body: { url, customAlias?, expiresInDays? }
5. requestLogger records start time
6. apiLimiter checks IP request count
7. Router matches POST /api/urls → controller.shorten
8. Controller: ShortenSchema.safeParse(req.body)
   └── invalid → 400 with Zod error details
9. Controller: converts expiresInDays → expiresAt Date
10. Controller: calls service.shorten(dto)
11. Service: validates URL protocol
12. Service: if customAlias → checks availability in DB
13. Service: if no customAlias → deduplication check in DB
14. Service: calls repo.create(dto)
15. Repository: BEGIN TRANSACTION
16. Repository: INSERT urls (...) RETURNING * → gets id
17. Repository: shortCode = toBase62(id)
18. Repository: UPDATE urls SET short_code = shortCode WHERE id = id
19. Repository: COMMIT
20. Service: builds UrlResponse with full shortUrl
21. Controller: res.status(201).json({ success: true, data: result })
22. requestLogger: logs "POST /api/urls 201 45ms"
```

### GET /:shortCode (Redirect)

```
1. Request arrives: GET /abc123
2. Middleware pipeline (helmet, cors, requestLogger)
3. Router matches /:shortCode → controller.redirect
4. Controller: shortCode = req.params['shortCode']
5. Controller: calls service.resolve("abc123")
6. Service: cache.get("url:abc123")
   ├── HIT:
   │   service: void repo.incrementClicks("abc123") [no await]
   │   service: returns "https://original.com"
   │   controller: res.redirect(302, "https://original.com")
   │   [background: DB click_count += 1]
   │
   └── MISS:
       service: repo.findByShortCode("abc123")
       ├── null → throw NotFoundError → 404
       ├── isActive=false → throw NotFoundError → 404
       ├── expired → throw GoneError → 410
       └── valid:
           service: computeTtl(expiresAt)
           service: cache.set("url:abc123", originalUrl, ttl)
           service: void repo.incrementClicks("abc123") [no await]
           service: returns "https://original.com"
           controller: res.redirect(302, "https://original.com")
```

---

## 8. Environment Configuration

All configuration is centralized in `src/config/index.ts`.

No file other than `config/index.ts` reads from `process.env` directly. This means:
- One place to see all configuration
- One place to add validation
- Easy to mock in tests

```
.env file
    │
    ▼
dotenv.config()   (called once in config/index.ts)
    │
    ▼
config object   (imported by any file that needs settings)
    │
    ├── config.server.port
    ├── config.db.host
    ├── config.redis.ttlSeconds
    └── config.rateLimit.max
```

---

## 9. Graceful Shutdown

When the process receives SIGTERM (Docker stop, server restart) or SIGINT (Ctrl+C):

```
1. Stop accepting new HTTP connections
2. Wait for in-flight requests to complete (max 10 seconds)
3. Close PostgreSQL pool (flushes pending queries)
4. Close Redis connection (sends QUIT command)
5. process.exit(0)
```

Without graceful shutdown, a request mid-transaction could be killed, leaving the database in an inconsistent state. The 10-second timeout prevents hanging forever if a client holds a connection open.

---

## 10. Technology Choices

| Technology | Why Chosen | Alternative |
|---|---|---|
| **Node.js + Express** | Non-blocking I/O suits high-concurrency redirect workload | Fastify (faster), NestJS (more structured) |
| **TypeScript** | Compile-time safety, better IDE support, interfaces for DI | Plain JavaScript |
| **PostgreSQL** | ACID transactions, reliable, excellent index support | MySQL (similar), MongoDB (no ACID) |
| **Redis** | In-memory, ~0.1ms reads, native TTL support, industry standard for caching | Memcached (simpler but fewer features) |
| **ioredis** | Full-featured Redis client, TypeScript support, retry strategies | node-redis (official but less featured) |
| **Zod** | Runtime validation with TypeScript type inference | Joi (no TS inference), manual validation |
| **Winston** | Structured logging, multiple transports, log levels | Pino (faster), console.log (not production ready) |
| **Raw SQL (pg)** | Full control, understand every query, no magic | Prisma (type-safe but magic), TypeORM |
| **Docker Compose** | Consistent local environment, no local installs needed | Local installs (version conflicts) |
