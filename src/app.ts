import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createRouter } from './routes';
import { UrlController } from './controllers/url.controller';
import { UrlService } from './services/url.service';
import { UrlRepository } from './repositories/url.repository';
import { cache } from './db/redis';
import { requestLogger } from './middleware/requestLogger';
import { errorHandler } from './middleware/error';
import { config } from './config';

export function createApp() {
  const app = express();

  // Security 
  // helmet sets ~15 security-related HTTP headers automatically.
  // Examples: X-Frame-Options (prevent clickjacking),
  //           X-Content-Type-Options (prevent MIME sniffing),
  //           Strict-Transport-Security (force HTTPS)
  app.use(helmet());

  // cors allows browsers to make requests from other origins.
  // In dev we allow all origins. In production, lock to your domain.
  app.use(cors({
    origin: config.server.isDev ? '*' : config.server.baseUrl,
    methods: ['GET', 'POST', 'DELETE'],
  }));

  //  Body parsing 
  // Without this, req.body is undefined for POST requests.
  // limit: '10kb' prevents someone sending a 100MB JSON body to crash the server.
  app.use(express.json({ limit: '10kb' }));

   // ── Request logging ───────────────────────────────────────────────
  // Applied globally — logs every request regardless of route.
  app.use(requestLogger);


    // Health check 
  // Simple endpoint for load balancers and monitoring to verify the
  //   // No DB check here — that would make health checks slow and fragile
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
    });
  });

  // Rate limiting
  // Limits each IP to 60 requests per minute on API routes.
  // Prevents abuse — someone writing a script to create millions of short URLs.
  const apiLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,   // 1 minute window
    max: config.rateLimit.max,             // 60 requests per window
    standardHeaders: true,   // Return RateLimit headers in responses
    legacyHeaders: false,     // Disable old X-RateLimit headers
    message: {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, please try again later',
      },
    },
  });

  // Apply rate limiter only to API routes — not to redirects.
  // Redirects must be fast and unlimited — they're the core product.
  // A legitimate user clicking a short link shouldn't be rate limited.
  app.use('/api', apiLimiter);



  // ── Dependency wiring ─────────────────────────────────────────────
  // This is the only place in the app that creates concrete instances.
  // Every layer receives its dependencies — nothing creates its own.
  //
  // Reading bottom-up: cache and repo are the leaves (no dependencies).
  // service depends on repo + cache. controller depends on service.
  // router depends on controller.
  const repo = new UrlRepository();
  const service = new UrlService(repo, cache);
  const controller = new UrlController(service);
  const router = createRouter(controller);

  app.use(router);



  // ── Error handler ─────────────────────────────────────────────────
  // MUST be last. Express identifies error middleware by 4-param signature.
  // Any error passed to next(err) anywhere in the app lands here.
  app.use(errorHandler);

  return app;
}