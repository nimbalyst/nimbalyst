/**
 * PGLite implementation of DocumentsRepository interface from runtime package
 */

import type { DocumentsRepository, DocumentRecord } from '@nimbalyst/runtime';

type PGliteLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
};

const now = () => Date.now();

export function createPGLiteDocumentsRepository(db: PGliteLike): DocumentsRepository {
  return {
    async list(workspaceId: string): Promise<DocumentRecord[]> {
      const { rows } = await db.query<DocumentRecord>(
        'SELECT id, workspace_id as "workspaceId", title, content, created_at as "createdAt", updated_at as "updatedAt" FROM documents WHERE workspace_id=$1 ORDER BY updated_at DESC',
        [workspaceId]
      );
      return rows;
    },

    async get(id: string): Promise<DocumentRecord | null> {
      const { rows } = await db.query<DocumentRecord>(
        'SELECT id, workspace_id as "workspaceId", title, content, created_at as "createdAt", updated_at as "updatedAt" FROM documents WHERE id=$1 LIMIT 1',
        [id]
      );
      return rows[0] || null;
    },

    async create(workspaceId: string, title = 'Untitled'): Promise<DocumentRecord> {
      const id = `doc_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
      const ts = now();
      await db.query(
        'INSERT INTO documents(id, workspace_id, title, content, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6)',
        [id, workspaceId, title, '', ts, ts]
      );
      return { id, workspaceId, title, content: '', createdAt: ts, updatedAt: ts };
    },

    async save(doc: Pick<DocumentRecord, 'id' | 'title' | 'content'>): Promise<void> {
      await db.query(
        'UPDATE documents SET title=$2, content=$3, updated_at=$4 WHERE id=$1',
        [doc.id, doc.title, doc.content, now()]
      );
    },

    async remove(id: string): Promise<void> {
      await db.query('DELETE FROM documents WHERE id=$1', [id]);
    },
  };
}