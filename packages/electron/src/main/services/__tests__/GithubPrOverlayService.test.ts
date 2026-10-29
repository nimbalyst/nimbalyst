// @vitest-environment node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createGithubPrOverlayService } from '../GithubPrOverlayService';
import { findPrReviewSessionIds } from '../prReviewSessionRecovery';

function parseData(value: unknown): Record<string, any> {
  return typeof value === 'string' ? JSON.parse(value) : value as Record<string, any>;
}

describe('GithubPrOverlayService', () => {
  it('reuses a synced item in any URL shape and converges concurrent creates on one row', async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-pr-overlay-'));
    const db = new SQLiteDatabase({
      dbDir,
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      sampleRate: 0,
    });

    try {
      await db.initialize();
      const insert = (id: string, data: Record<string, unknown>) => db.query(
        `INSERT INTO tracker_items (
          id, type, type_tags, data, workspace, document_path, sync_status, source
        ) VALUES ($1, 'github-pr', $2, $3, '/workspace', '', 'local', 'native')`,
        [id, ['github-pr'], JSON.stringify(data)],
      );
      const documentService = {
        async createTrackerItem(payload: any) {
          await insert(payload.id, { title: payload.title, status: payload.status, ...payload.customFields });
          return { id: payload.id } as any;
        },
        async updateTrackerItem(itemId: string, updates: Record<string, unknown>) {
          const result = await db.query<{ data: unknown }>('SELECT data FROM tracker_items WHERE id = $1', [itemId]);
          await db.query('UPDATE tracker_items SET data = $1 WHERE id = $2', [
            JSON.stringify({ ...parseData(result.rows[0].data), ...updates }),
            itemId,
          ]);
          return { id: itemId } as any;
        },
      };
      const service = createGithubPrOverlayService({
        db,
        engine: 'sqlite',
        getDocumentService: () => documentService,
        getDefaultStatus: () => 'to-review',
      });

      // A teammate's triage item, synced in: nested under customFields, URL as
      // { url, label }. The panel must attach to it, not create a second item.
      await insert('pr_synced', {
        title: 'Synced triage item',
        status: 'backlog',
        customFields: { prUrl: { url: 'https://github.com/Owner/Repo/pull/7', label: '#7' }, prNumber: 7 },
      });
      const reused = await service.getOrCreate({
        workspacePath: '/workspace',
        prUrl: 'https://github.com/owner/repo/pull/7/files',
        title: 'From the panel',
        status: 'reviewing',
      });
      expect(reused).toMatchObject({ id: 'pr_synced', created: false });

      const input = { workspacePath: '/workspace', prUrl: 'https://github.com/owner/repo/pull/8', title: 'New PR' };
      const [first, second] = await Promise.all([
        service.getOrCreate({ ...input, status: 'reviewing' }),
        service.getOrCreate({ ...input, updates: { notes: 'second caller' } }),
      ]);
      expect(first.id).toBe(second.id);

      const rows = await db.query<{ id: string; data: unknown }>(
        `SELECT id, data FROM tracker_items WHERE workspace = '/workspace' AND type = 'github-pr' ORDER BY id`,
      );
      expect(rows.rows.map((r) => r.id).sort()).toEqual([first.id, 'pr_synced'].sort());
      expect(parseData(rows.rows.find((r) => r.id === first.id)!.data)).toMatchObject({
        prUrl: 'https://github.com/owner/repo/pull/8',
        prNumber: 8,
        repo: 'owner/repo',
      });
    } finally {
      await db.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('finds sessions the panel started for a PR by their opening prompt, and only those', async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-recovery-'));
    const db = new SQLiteDatabase({
      dbDir,
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      sampleRate: 0,
    });
    try {
      await db.initialize();
      const prompt = (n: number) =>
        `Review pull request https://github.com/nimbalyst/nimbalyst/pull/${n} (repo nimbalyst/nimbalyst, PR #${n}) and report your findings here.`;
      const add = async (sessionId: string, workspace: string, text: string) => {
        await db.query(
          `INSERT INTO ai_sessions (id, workspace_id, provider) VALUES ($1, $2, 'claude-code')`,
          [sessionId, workspace],
        );
        await db.query(
          `INSERT INTO ai_agent_messages (session_id, source, direction, content, searchable, searchable_text)
           VALUES ($1, 'claude-code', 'input', $2, 1, $2)`,
          [sessionId, text],
        );
      };
      await add('review-1853', '/workspace', prompt(1853));
      await add('review-185', '/workspace', prompt(185));
      await add('quotes-1853', '/workspace', `Why did this fail? ${prompt(1853)}`);
      await add('other-project', '/elsewhere', prompt(1853));

      expect(await findPrReviewSessionIds(db, 'sqlite', '/workspace', 'nimbalyst/nimbalyst', 1853))
        .toEqual(['review-1853']);
      expect(await findPrReviewSessionIds(db, 'pglite', '/workspace', 'nimbalyst/nimbalyst', 1853))
        .toEqual([]);
    } finally {
      await db.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
