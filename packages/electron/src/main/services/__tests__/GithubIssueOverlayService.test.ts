// @vitest-environment node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createGithubIssueOverlayService } from '../GithubIssueOverlayService';

describe('GithubIssueOverlayService', () => {
  it('converges concurrent creates on one real-schema row without regressing existing status', async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-issue-overlay-'));
    const db = new SQLiteDatabase({
      dbDir,
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      sampleRate: 0,
    });

    try {
      await db.initialize();
      const documentService = {
        async createTrackerItem(payload: any) {
          const data = {
            title: payload.title,
            status: payload.status,
            priority: payload.priority,
            ...payload.customFields,
          };
          await db.query(
            `INSERT INTO tracker_items (
              id, type, type_tags, data, workspace, document_path, sync_status, source
            ) VALUES ($1, $2, $3, $4, $5, '', 'local', 'native')`,
            [payload.id, payload.type, [payload.type], JSON.stringify(data), payload.workspace],
          );
          return { id: payload.id } as any;
        },
        async updateTrackerItem(itemId: string, updates: Record<string, unknown>) {
          const result = await db.query<{ data: unknown }>(
            'SELECT data FROM tracker_items WHERE id = $1',
            [itemId],
          );
          const current = typeof result.rows[0].data === 'string'
            ? JSON.parse(result.rows[0].data)
            : result.rows[0].data;
          await db.query('UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2', [
            JSON.stringify({ ...current, ...updates }),
            itemId,
          ]);
          return { id: itemId } as any;
        },
      };
      const service = createGithubIssueOverlayService({
        db,
        engine: 'sqlite',
        getDocumentService: () => documentService,
      });
      const input = {
        workspacePath: '/workspace',
        issueUrl: 'https://github.com/Owner/Repo/issues/42?from=panel#discussion',
        title: 'Race-safe overlay',
        status: 'ready',
        priority: 'medium',
        customFields: { author: 'alice' },
      };

      const [first, second] = await Promise.all([
        service.getOrCreate(input),
        service.getOrCreate({
          ...input,
          status: 'untriaged',
          updates: { notes: 'second caller reached the same overlay' },
        }),
      ]);

      expect(first.id).toBe(second.id);
      const stored = await db.query<{ id: string; data: unknown }>(
        `SELECT id, data FROM tracker_items WHERE workspace = $1 AND type = 'github-issue'`,
        ['/workspace'],
      );
      expect(stored.rows).toHaveLength(1);
      const data = typeof stored.rows[0].data === 'string'
        ? JSON.parse(stored.rows[0].data)
        : stored.rows[0].data as Record<string, unknown>;
      expect(data).toMatchObject({
        issueUrl: 'https://github.com/owner/repo/issues/42',
        issueNumber: 42,
        repo: 'owner/repo',
        status: 'ready',
        notes: 'second caller reached the same overlay',
      });

      await service.getOrCreate({
        ...input,
        updates: { adoptedItemId: 'bug_42', status: 'adopted' },
      });
      await service.getOrCreate({
        ...input,
        updates: { status: 'investigating', notes: 'new investigation detail' },
      });
      const adopted = await db.query<{ data: unknown }>(
        'SELECT data FROM tracker_items WHERE id = $1',
        [first.id],
      );
      const adoptedData = typeof adopted.rows[0].data === 'string'
        ? JSON.parse(adopted.rows[0].data)
        : adopted.rows[0].data as Record<string, unknown>;
      expect(adoptedData).toMatchObject({
        adoptedItemId: 'bug_42',
        status: 'adopted',
        notes: 'new investigation detail',
      });

      // A teammate's synced overlay keeps its fields nested under customFields,
      // URL as { url }. Investigating it here must reuse it (NIM-7657).
      await db.query(
        `INSERT INTO tracker_items (
          id, type, type_tags, data, workspace, document_path, sync_status, source
        ) VALUES ('ghi_synced', 'github-issue', $1, $2, '/workspace', '', 'synced', 'native')`,
        [['github-issue'], JSON.stringify({
          title: 'Synced',
          status: 'needs-triage',
          customFields: { issueUrl: { url: 'https://github.com/owner/repo/issues/77' }, issueNumber: 77 },
        })],
      );
      const synced = await service.getOrCreate({
        ...input,
        issueUrl: 'https://github.com/owner/repo/issues/77',
        updates: { status: 'investigating' },
      });
      expect(synced).toMatchObject({ id: 'ghi_synced', created: false });
    } finally {
      await db.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
