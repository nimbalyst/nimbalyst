import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message);
    this.name = 'ValidationError';
  }
}

/**
 * Middleware factory for request body validation using Zod schemas.
 */
export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      throw new ValidationError(`Validation failed: ${errors.join(', ')}`);
    }
    req.body = result.data;
    next();
  };
}

/**
 * Format a date for API responses.
 */
export function formatDate(date: Date): string {
  return date.toISOString();
}

/**
 * Generate a random ID with a given prefix.
 */
export function generateId(prefix = ''): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const id = Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Retry an async operation with exponential backoff.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<T> {
  const { attempts = 3, delayMs = 1000 } = options;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, i)));
    }
  }

  throw new Error('Unreachable');
}
