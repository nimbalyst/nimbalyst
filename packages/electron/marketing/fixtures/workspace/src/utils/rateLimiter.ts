import { Request, Response, NextFunction } from 'express';

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

interface ClientRecord {
  count: number;
  resetAt: number;
}

const clients = new Map<string, ClientRecord>();

export function rateLimiter(config: RateLimitConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    let record = clients.get(clientIp);

    if (!record || now > record.resetAt) {
      record = { count: 0, resetAt: now + config.windowMs };
      clients.set(clientIp, record);
    }

    record.count++;

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', config.maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, config.maxRequests - record.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetAt / 1000));

    if (record.count > config.maxRequests) {
      res.status(429).json({
        error: 'TooManyRequests',
        message: 'Rate limit exceeded. Try again later.',
        retryAfter: Math.ceil((record.resetAt - now) / 1000),
      });
      return;
    }

    next();
  };
}
