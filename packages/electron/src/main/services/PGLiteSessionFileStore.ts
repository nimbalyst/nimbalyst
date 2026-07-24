/**
 * PGLite implementation of SessionFileStore interface from runtime package
 */

import { v4 as uuidv4 } from 'uuid';
import type { SessionFileStore, FileLink, FileLinkType } from '@nimbalyst/runtime';
import { toMillis } from '../utils/timestampUtils';
import { parseJsonObjectColumn } from '../utils/jsonColumn';

type PGliteLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
};

type EnsureReadyFn = () => Promise<void>;

function rowToFileLink(row: any): FileLink {
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    filePath: row.file_path,
    linkType: row.link_type as FileLinkType,
    timestamp: toMillis(row.timestamp)!,
    metadata: parseJsonObjectColumn(row.metadata)
  };
}

export function createPGLiteSessionFileStore(db: PGliteLike, ensureDbReady?: EnsureReadyFn): SessionFileStore {
  const ensureReady = async () => {
    if (ensureDbReady) {
      await ensureDbReady();
    }
  };

  return {
    async ensureReady(): Promise<void> {
      await ensureReady();
    },

    async addFileLink(link: Omit<FileLink, 'id'>): Promise<FileLink> {
      await ensureReady();

      const id = uuidv4();
      const now = Date.now();
      const timestampMs = link.timestamp || now;
      const timestamp = new Date(timestampMs);

      const { rows } = await db.query<any>(
        `INSERT INTO session_files (
          id, session_id, workspace_id, file_path, link_type, timestamp, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7
        )
        RETURNING id, session_id, workspace_id, file_path, link_type, timestamp, metadata`,
        [
          id,
          link.sessionId,
          link.workspaceId,
          link.filePath,
          link.linkType,
          timestamp,
          link.metadata || {}
        ]
      );

      if (!rows[0]) {
        return {
          id,
          ...link,
          timestamp: link.timestamp || now
        };
      }

      return rowToFileLink(rows[0]);
    },

    async getFilesBySession(sessionId: string, linkType?: FileLinkType): Promise<FileLink[]> {
      await ensureReady();

      const params: any[] = [sessionId];
      let sql = `
        SELECT * FROM session_files
        WHERE session_id = $1
      `;

      if (linkType) {
        sql += ` AND link_type = $2`;
        params.push(linkType);
      }

      sql += ` ORDER BY timestamp ASC`;

      const { rows } = await db.query<any>(sql, params);
      return rows.map(rowToFileLink);
    },

    async getFilesBySessionMany(sessionIds: string[], linkType?: FileLinkType): Promise<FileLink[]> {
      if (sessionIds.length === 0) return [];
      await ensureReady();

      // Use ANY($1::text[]) for batch query - single query instead of N
      // Note: session_id is text type in session_files table
      const params: any[] = [sessionIds];
      let sql = `
        SELECT * FROM session_files
        WHERE session_id = ANY($1::text[])
      `;

      if (linkType) {
        sql += ` AND link_type = $2`;
        params.push(linkType);
      }

      sql += ` ORDER BY timestamp ASC`;

      const { rows } = await db.query<any>(sql, params);
      return rows.map(rowToFileLink);
    },

    async getSessionsByFile(workspaceId: string, filePath: string, linkType?: FileLinkType): Promise<string[]> {
      await ensureReady();

      const params: any[] = [workspaceId, filePath];
      let sql = `
        SELECT DISTINCT session_id FROM session_files
        WHERE workspace_id = $1 AND file_path = $2
      `;

      if (linkType) {
        sql += ` AND link_type = $3`;
        params.push(linkType);
      }

      sql += ` ORDER BY session_id`;

      const { rows } = await db.query<{ session_id: string }>(sql, params);
      return rows.map(row => row.session_id);
    },

    async deleteFileLink(id: string): Promise<void> {
      await ensureReady();
      await db.query('DELETE FROM session_files WHERE id = $1', [id]);
    },

    async deleteSessionLinks(sessionId: string): Promise<void> {
      await ensureReady();
      await db.query('DELETE FROM session_files WHERE session_id = $1', [sessionId]);
    },

    async hasFileLink(sessionId: string, filePath: string, linkType: FileLinkType): Promise<boolean> {
      await ensureReady();

      const { rows } = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM session_files
         WHERE session_id = $1 AND file_path = $2 AND link_type = $3`,
        [sessionId, filePath, linkType]
      );

      return parseInt(rows[0]?.count || '0', 10) > 0;
    }
  };
}
