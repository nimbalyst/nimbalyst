import { AsyncLocalStorage } from 'async_hooks';
import { Pool, type PoolClient } from 'pg';
import { logger } from '../utils/logger';
import { POSTGRES_SCHEMA_STATEMENTS } from './postgresSchema';

interface TxContext {
  client: PoolClient;
  finished: boolean;
}

type TransactionHandle = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
};

export class PostgresDatabase {
  private pool: Pool | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private readonly txStorage = new AsyncLocalStorage<TxContext>();

  constructor(private readonly connectionString = process.env.NIMBALYST_DATABASE_URL) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    if (!this.connectionString) {
      throw new Error('NIMBALYST_DATABASE_URL is required for the Postgres backend');
    }

    const max = Number.parseInt(process.env.NIMBALYST_POSTGRES_POOL_MAX ?? '10', 10);
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: Number.isFinite(max) && max > 0 ? max : 10,
      application_name: 'nimbalyst-electron',
    });

    try {
      await this.pool.query('SELECT 1');
      await this.createSchema();
      this.initialized = true;
      logger.main.info('[Postgres] Database initialized');
    } catch (error) {
      await this.pool.end().catch(() => {});
      this.pool = null;
      this.initPromise = null;
      throw error;
    }
  }

  private async createSchema(): Promise<void> {
    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of POSTGRES_SCHEMA_STATEMENTS) {
        await client.query(statement);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
    if (!this.initialized) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const normalized = sql.trim().replace(/;$/, '').toUpperCase();
    if (normalized === 'BEGIN' || normalized === 'START TRANSACTION') {
      return this.beginTransaction<T>(sql);
    }

    const ctx = this.txStorage.getStore();
    if (ctx && !ctx.finished) {
      return this.queryInTransaction<T>(ctx, sql, params, normalized);
    }

    const result = await this.requirePool().query(sql, params);
    return { rows: result.rows as T[] };
  }

  private async beginTransaction<T>(sql: string): Promise<{ rows: T[] }> {
    const client = await this.requirePool().connect();
    const ctx: TxContext = { client, finished: false };

    try {
      await client.query(sql);
      this.txStorage.enterWith(ctx);
      return { rows: [] };
    } catch (error) {
      ctx.finished = true;
      client.release();
      throw error;
    }
  }

  private async queryInTransaction<T>(
    ctx: TxContext,
    sql: string,
    params: any[] | undefined,
    normalized: string,
  ): Promise<{ rows: T[] }> {
    try {
      const result = await ctx.client.query(sql, params);
      if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        ctx.finished = true;
        ctx.client.release();
      }
      return { rows: result.rows as T[] };
    } catch (error) {
      if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
        ctx.finished = true;
        ctx.client.release();
      }
      throw error;
    }
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql);
  }

  async transaction<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T> {
    if (!this.initialized) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const client = await this.requirePool().connect();
    const ctx: TxContext = { client, finished: false };

    return this.txStorage.run(ctx, async () => {
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: this.query.bind(this),
          exec: this.exec.bind(this),
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        ctx.finished = true;
        client.release();
      }
    });
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this.initialized = false;
    this.initPromise = null;
    logger.main.info('[Postgres] Database pool closed');
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async getStats(): Promise<any> {
    const result = await this.query(`
      SELECT
        (SELECT COUNT(*) FROM ai_sessions) as ai_sessions_count,
        (SELECT COUNT(*) FROM document_history) as history_count,
        pg_database_size(current_database()) as database_size
    `);
    return { ...result.rows[0], backend: 'postgres', queryStats: {} };
  }

  getDB(): any {
    return {
      query: (sql: string, params?: any[]) => this.query(sql, params),
      exec: (sql: string) => this.exec(sql),
    };
  }

  setBackupService(): void {}

  async createBackup(): Promise<{ success: boolean; error?: string }> {
    return { success: true };
  }

  getBackupService(): null {
    return null;
  }

  async verifyBackup(): Promise<{ valid: boolean; error?: string }> {
    return { valid: false, error: 'Postgres backend does not use PGLite directory backups' };
  }

  async showRecoveryDialog(): Promise<void> {
    logger.main.info('[Postgres] PGLite recovery dialog is not available for Postgres backend');
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error('Postgres pool not initialized');
    }
    return this.pool;
  }
}
