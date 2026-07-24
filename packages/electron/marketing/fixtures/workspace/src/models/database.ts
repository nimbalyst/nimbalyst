import { Pool, PoolConfig } from 'pg';
import { createLogger } from '../utils/logger';

const logger = createLogger('database');

const poolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

export const db = new Pool(poolConfig);

db.on('error', (err) => {
  logger.error('Unexpected database error', err);
});

export async function connectDatabase(): Promise<void> {
  const client = await db.connect();
  try {
    const result = await client.query('SELECT version()');
    logger.info(`Connected to ${result.rows[0].version.split(' ').slice(0, 2).join(' ')}`);
  } finally {
    client.release();
  }
}

export async function disconnectDatabase(): Promise<void> {
  await db.end();
  logger.info('Database pool closed');
}
