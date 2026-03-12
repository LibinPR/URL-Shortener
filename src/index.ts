import { createApp } from './app';
import { connectDb, closeDb } from './db/postgres';
import { cache } from './db/redis';
import { config } from './config';
import { logger } from './utils/logger';

async function main() {
  //  Connect to infrastructure before accepting traffic 
  // If DB connection fails here, we crash with a clear message
  // Better than starting the server and having every request fail
  await connectDb();

  // Redis failure is non-fatal — app works without cache, just slower
  // connect() is called but errors won't crash startup
  await (cache as any).connect().catch((err: Error) => {
    logger.warn('Redis unavailable at startup, continuing without cache', {
      error: err.message,
    });
  });

  const app = createApp();

  const server = app.listen(config.server.port, () => {
    logger.info(`Server running`, {
      url: config.server.baseUrl,
      env: config.server.nodeEnv,
    });
  });

  //  Graceful shutdown 
  // When the process receives SIGTERM (e.g. docker stop, Ctrl+C),
  // we don't kill immediately. We:
  // 1. Stop accepting new connections
  // 2. Wait for in-flight requests to finish
  // 3. Close DB and Redis connections cleanly
  // 4. Exit
  //
  // Without this, a request in the middle of a DB transaction
  // could be cut off, leaving the DB in an inconsistent state
  async function shutdown(signal: string) {
    logger.info(`${signal} received, shutting down gracefully`);

    // server.close() stops accepting NEW connections
    // The callback fires when all existing connections are closed.
    server.close(async () => {
      logger.info('HTTP server closed');

      await closeDb();
      await (cache as any).disconnect().catch(() => {});

      logger.info('Shutdown complete');
      process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown hangs
    // This prevents the process from hanging forever if a connection
    // refuses to close (e.g. a long-polling client)
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
  }

  // SIGTERM — sent by Docker, Kubernetes, systemd when stopping a process
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // SIGINT — sent by Ctrl+C in the terminal
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Catch unhandled promise rejections — async functions that threw
  // without being caught. Log and exit — unknown state is dangerous
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
    process.exit(1);
  });
}

// Start the app
main().catch((err) => {
  logger.error('Failed to start server', { error: err.message });
  process.exit(1);
});