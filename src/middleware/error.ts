import { Request, Response, NextFunction } from 'express';
import { AppError } from '../types';
import { logger } from '../utils/logger';

// It must be registered LAST in app.ts — after all routes.
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction   // must be declared even if unused — Express requires 4 params
): void {

  //  Known application errors 
  // These are errors we deliberately threw with a specific status code
  // NotFoundError, ConflictError, ValidationError, GoneError all extend AppError
  if (err instanceof AppError) {
    // No need to log these at error level — they're expected, not bugs
    // 404 & 409 is not a bug
    logger.warn('Application error', {
      code: err.code,
      message: err.message,
      path: req.path,
    });

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  //  PostgreSQL unique constraint violation 
  // Happens if two requests try to create the same short code simultaneously.
  // pg error code '23505' = unique_violation.
  // We handle it here as a safety net even though the service checks first,
  // because there's a small race condition window between the check and insert.
  if ((err as any).code === '23505') {
    res.status(409).json({
      success: false,
      error: {
        code: 'CONFLICT',
        message: 'A URL with this alias already exists',
      },
    });
    return;
  }

  //  Unknown errors 
  // These are genuine bugs — unexpected throws, DB connection failures, etc.
  // Log the full error including stack trace for debugging.
  // Never send stack traces to the client — information leakage.
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      // Vague message intentionally — don't leak internal details - Production conventions
      message: 'An unexpected error occurred',
    },
  });
}