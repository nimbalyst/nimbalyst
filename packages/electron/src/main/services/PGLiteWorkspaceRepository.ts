/**
 * PGLite implementation of WorkspaceRepository interface
 */

import type { WorkspaceRepository, Workspace } from '../types/workspace';

type PGliteLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
};

const now = () => Date.now();

export function createPGLiteWorkspaceRepository(db: PGliteLike): WorkspaceRepository {
  return {
    async list(): Promise<Workspace[]> {
      const { rows } = await db.query<Workspace>(
        'SELECT id, name, created_at as "createdAt", updated_at as "updatedAt" FROM workspaces ORDER BY updated_at DESC'
      );
      return rows;
    },

    async create(name: string): Promise<Workspace> {
      const id = `ws_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
      const ts = now();
      await db.query(
        'INSERT INTO workspaces(id, name, created_at, updated_at) VALUES($1, $2, $3, $4)',
        [id, name, ts, ts]
      );
      return { id, name, createdAt: ts, updatedAt: ts };
    },

    async rename(id: string, name: string): Promise<void> {
      await db.query('UPDATE workspaces SET name=$2, updated_at=$3 WHERE id=$1', [id, name, now()]);
    },
  };
}