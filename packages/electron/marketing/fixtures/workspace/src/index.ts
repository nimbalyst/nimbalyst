import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createLogger } from './utils/logger';
import { authMiddleware } from './auth/middleware';
import { rateLimiter } from './utils/rateLimiter';
import { registerRoutes } from './api/routes';
import { connectDatabase } from './models/database';

const logger = createLogger('server');
const app = express();
const PORT = process.env.PORT || 3000;

// Global middleware
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(rateLimiter({ windowMs: 60_000, maxRequests: 100 }));

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Protected routes
app.use('/api', authMiddleware);
registerRoutes(app);

async function start() {
  await connectDatabase();
  logger.info('Database connected');

  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  logger.error('Failed to start server', err);
  process.exit(1);
});

export { app };
