// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
vi.mock('electron', async () => ({ app: (await import('../../../../test-stubs/privateUserData')).testApp }));
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { migrateSessionTrees } from '../sessionTreeMigration';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';

async function openWorker(root: string) {
  const worker = new Worker(path.resolve(__dirname, '../../database/worker.js'), { workerData: { userDataPath: root }, stdout: true, stderr: true });
  let serial = 0;
  const request = (type: string, payload?: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker ${type} timed out`)); }, 45000);
    const cleanup = () => { clearTimeout(timer); worker.off('message', receive); worker.off('error', reject); };
    const receive = (message: any) => {
      if (message.id !== id) return;
      cleanup();
      if (!message.success) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.data);
    };
    worker.on('message', receive); worker.once('error', reject);
    worker.postMessage({ id, type, payload });
  });
  // Drain diagnostic streams without exposing install-specific logs.
  worker.stdout?.resume(); worker.stderr?.resume();
  try { await request('init'); } catch (error) { await worker.terminate(); throw error; }
  return {
    query: <T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => request('query', { sql, params }),
    runTransaction: (statements: unknown[]) => request('transaction', { statements }),
    close: async () => { await request('close'); await worker.terminate(); },
  };
}

it.each(['pglite', 'sqlite'] as const)('%s repeated production startup preserves tree parents and empty worktree rows', async backend => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-tree-startup-'));
  const open = async () => {
    if (backend === 'pglite') return openWorker(root);
    const db = new SQLiteDatabase({ dbDir: root, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), sampleRate: 0 });
    await db.initialize(); return db;
  };
  let db: Awaited<ReturnType<typeof open>> | undefined;
  try {
    db = await open();
    const store = createPGLiteSessionStore(db);
    await db.query("INSERT INTO worktrees (id, workspace_id, name, path, branch) VALUES ('wt', '/p', 'wt', '/p/wt', 'tree-test')");
    await store.create({ id: 'orchestrator', provider: 'claude-code', workspaceId: '/p' });
    await store.create({ id: 'worker', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'orchestrator', createdBySessionId: 'orchestrator' });
    await store.create({ id: 'empty-worktree-root', provider: 'claude-code', workspaceId: '/p', worktreeId: 'wt' });
    await store.create({ id: 'empty-worktree-child', provider: 'claude-code', workspaceId: '/p', worktreeId: 'wt', parentSessionId: 'empty-worktree-root' });
    await migrateSessionTrees(db);
    await db.close(); db = undefined;
    db = await open();
    expect((await migrateSessionTrees(db)).moved).toBe(0);
    const rows = await db.query<{ id: string; session_type: string; parent_session_id: string | null }>('SELECT id, session_type, parent_session_id FROM ai_sessions ORDER BY id');
    expect(rows.rows).toEqual([
      { id: 'empty-worktree-child', session_type: 'session', parent_session_id: 'empty-worktree-root' },
      { id: 'empty-worktree-root', session_type: 'session', parent_session_id: null },
      { id: 'orchestrator', session_type: 'session', parent_session_id: null },
      { id: 'worker', session_type: 'session', parent_session_id: 'orchestrator' },
    ]);
  } finally { await db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);
