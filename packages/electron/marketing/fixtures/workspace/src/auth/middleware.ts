import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createLogger } from '../utils/logger';

const logger = createLogger('auth');

interface AuthStrategy {
  name: string;
  authenticate(req: Request): Promise<AuthResult>;
}

interface AuthResult {
  success: boolean;
  user?: { id: string; email: string; role: string };
  error?: string;
}

const jwtStrategy: AuthStrategy = {
  name: 'jwt',
  async authenticate(req) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return { success: false, error: 'No Bearer token' };
    }

    const token = header.slice(7);
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      return {
        success: true,
        user: { id: decoded.sub, email: decoded.email, role: decoded.role },
      };
    } catch {
      return { success: false, error: 'Invalid or expired JWT' };
    }
  },
};

const apiKeyStrategy: AuthStrategy = {
  name: 'api-key',
  async authenticate(req) {
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) {
      return { success: false, error: 'No API key provided' };
    }

    // Validate against database
    const user = await validateApiKey(apiKey);
    if (!user) {
      return { success: false, error: 'Invalid API key' };
    }

    return { success: true, user };
  },
};

const strategies: AuthStrategy[] = [jwtStrategy, apiKeyStrategy];

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  for (const strategy of strategies) {
    const result = await strategy.authenticate(req);
    if (result.success && result.user) {
      (req as any).user = result.user;
      logger.debug(`Authenticated via ${strategy.name}: ${result.user.email}`);
      return next();
    }
  }

  res.status(401).json({
    error: 'Unauthorized',
    message: 'Valid JWT token or API key required',
  });
}

async function validateApiKey(
  key: string
): Promise<{ id: string; email: string; role: string } | null> {
  // Look up API key in database
  const { db } = await import('../models/database');
  const row = await db.query('SELECT * FROM api_keys WHERE key = $1 AND revoked = false', [key]);
  if (!row.rows[0]) return null;

  return {
    id: row.rows[0].user_id,
    email: row.rows[0].email,
    role: row.rows[0].role,
  };
}
