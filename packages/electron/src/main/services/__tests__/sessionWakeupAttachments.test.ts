// @vitest-environment node
/**
 * Round-trip for scheduled-prompt attachments (#1497) against a REAL migrated
 * SQLite database, not a mock.
 *
 * Three things can only break here: migrations 0048/0049 not reaching a fresh
 * install, the Postgres-style `$7` placeholder not surviving dialect
 * translation, and the JSON column coming back as a string that nobody parses.
 * Each one silently loses the user's image rather than throwing, which is why
 * this asserts the value that comes back out rather than that create() resolved.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import type { ChatAttachment } from '@nimbalyst/runtime/ai/server/types';
import { createPGLiteSessionWakeupsStore } from '../PGLiteSessionWakeupsStore';
import {
  scheduleSessionWakeup,
  wakeupPromptDelivery,
  type ScheduleSessionWakeupInput,
} from '../sessionWakeupScheduling';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../RepositoryManager', () => ({ getSessionWakeupsStore: vi.fn() }));
vi.mock('../SessionWakeupScheduler', () => ({ SessionWakeupScheduler: { getInstance: vi.fn() } }));

function attachment(id: string, filename: string, type: ChatAttachment['type']): ChatAttachment {
  return { id, filename, type, filepath: `/tmp/${filename}`, mimeType: 'application/octet-stream', size: 1, addedAt: 0 };
}

async function withStore<T>(
  run: (store: ReturnType<typeof createPGLiteSessionWakeupsStore>, sqlite: SQLiteDatabase) => Promise<T>,
): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-wakeup-attach-'));
  const sqlite = new SQLiteDatabase({
    dbDir: tmpDir,
    schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  try {
    await sqlite.initialize();
    // A wakeup FKs to ai_sessions, so the session has to exist first.
    await sqlite.query(
      `INSERT INTO ai_sessions (id, title, workspace_id, provider) VALUES ($1, $2, $3, $4)`,
      ['s1', 'Test session', '/w', 'claude-code'],
    );
    const store = createPGLiteSessionWakeupsStore(createSQLiteStoreAdapter(sqlite));
    return await run(store, sqlite);
  } finally {
    try {
      await sqlite.close();
    } catch {
      // best effort
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('scheduled prompt attachments', () => {
  it('adds the attachments column to a freshly migrated database', async () => {
    await withStore(async (_store, sqlite) => {
      const { rows } = await sqlite.query<{ name: string; type: string }>(
        `SELECT name, type FROM pragma_table_info('ai_session_wakeups')`,
      );
      const column = rows.find((r) => r.name === 'attachments');
      expect(column).toBeDefined();
      expect(column?.type).toBe('TEXT');
    });
  });

  it('round-trips attachments through create and read-back', async () => {
    await withStore(async (store) => {
      const attachments = [attachment('a1', 'screenshot.png', 'image'), attachment('a2', 'spec.pdf', 'pdf')];
      const created = await store.create({
        id: 'wakeup-1',
        sessionId: 's1',
        workspaceId: '/w',
        prompt: 'look at this',
        fireAt: Date.now() + 3_600_000,
        attachments,
      });
      expect(created.attachments).toEqual(attachments);

      const reloaded = await store.get('wakeup-1');
      expect(reloaded?.attachments).toEqual(attachments);
    });
  });

  it('survives the status transitions the scheduler drives', async () => {
    await withStore(async (store) => {
      const attachments = [attachment('a1', 'shot.png', 'image')];
      await store.create({
        id: 'wakeup-2',
        sessionId: 's1',
        workspaceId: '/w',
        prompt: 'fire me',
        fireAt: Date.now() + 3_600_000,
        attachments,
      });

      // markFiring is what hands the row to the executor, which is where the
      // attachments have to still be present for them to reach the prompt.
      const firing = await store.markFiring('wakeup-2');
      expect(firing?.attachments).toEqual(attachments);
    });
  });

  it('reports no attachments for a wakeup scheduled without any', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        id: 'wakeup-3',
        sessionId: 's1',
        workspaceId: '/w',
        prompt: 'plain text only',
        fireAt: Date.now() + 3_600_000,
      });
      expect(created.attachments).toEqual([]);

      const reloaded = await store.get('wakeup-3');
      expect(reloaded?.attachments).toEqual([]);
    });
  });

  it('treats rows written before the origin column as agent wakeups', async () => {
    await withStore(async (store, sqlite) => {
      // Every wakeup that predates "Run later" came from the agent's tool.
      await sqlite.query(
        `INSERT INTO ai_session_wakeups (id, session_id, workspace_id, prompt, fire_at, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        ['legacy-1', 's1', '/w', 'old', new Date(Date.now() + 3_600_000)],
      );
      expect((await store.get('legacy-1'))?.origin).toBe('agent');
    });
  });
});

describe('scheduling a wakeup', () => {
  const inHours = (h: number) => Date.now() + h * 3_600_000;

  async function withScheduler<T>(
    run: (
      schedule: (input: Omit<ScheduleSessionWakeupInput, 'workspaceId' | 'sessionId'>) => Promise<unknown>,
      store: ReturnType<typeof createPGLiteSessionWakeupsStore>,
      broadcast: ReturnType<typeof vi.fn>,
    ) => Promise<T>,
  ): Promise<T> {
    return withStore(async (store) => {
      const broadcast = vi.fn();
      const deps = { store, onCreated: vi.fn(), broadcast };
      return run(
        (input) => scheduleSessionWakeup({ sessionId: 's1', workspaceId: '/w', ...input }, deps),
        store,
        broadcast,
      );
    });
  }

  it('keeps every prompt a person schedules', async () => {
    await withScheduler(async (schedule, store) => {
      await schedule({ origin: 'user', prompt: 'first', fireAt: inHours(1) });
      await schedule({ origin: 'user', prompt: 'second', fireAt: inHours(2) });

      const active = await store.listActiveForSession('s1');
      expect(active.map((w) => w.prompt)).toEqual(['first', 'second']);
    });
  });

  it('does not let the agent re-pacing itself cancel a prompt the user scheduled', async () => {
    await withScheduler(async (schedule, store) => {
      await schedule({ origin: 'user', prompt: 'mine', fireAt: inHours(3) });
      await schedule({ origin: 'agent', prompt: 'agent 1', fireAt: inHours(1) });
      await schedule({ origin: 'agent', prompt: 'agent 2', fireAt: inHours(1) });

      const active = await store.listActiveForSession('s1');
      expect(active.map((w) => [w.origin, w.prompt])).toEqual([
        ['agent', 'agent 2'],
        ['user', 'mine'],
      ]);
    });
  });

  it('announces the agent wakeup it replaced, so the banner drops it', async () => {
    await withScheduler(async (schedule, _store, broadcast) => {
      await schedule({ origin: 'agent', prompt: 'agent 1', fireAt: inHours(1) });
      broadcast.mockClear();

      await schedule({ origin: 'agent', prompt: 'agent 2', fireAt: inHours(1) });

      const announced = broadcast.mock.calls.map(([row]) => [row.prompt, row.status]);
      expect(announced).toContainEqual(['agent 1', 'cancelled']);
      expect(announced).toContainEqual(['agent 2', 'pending']);
    });
  });

  it('still announces the replaced wakeup when creating its successor fails', async () => {
    await withStore(async (store) => {
      const broadcast = vi.fn();
      const deps = { store, onCreated: vi.fn(), broadcast };
      await scheduleSessionWakeup(
        { sessionId: 's1', workspaceId: '/w', origin: 'agent', prompt: 'agent 1', fireAt: inHours(1) },
        deps,
      );
      broadcast.mockClear();

      const failingStore = { ...store, create: vi.fn().mockRejectedValue(new Error('disk full')) };
      await expect(
        scheduleSessionWakeup(
          { sessionId: 's1', workspaceId: '/w', origin: 'agent', prompt: 'agent 2', fireAt: inHours(1) },
          { ...deps, store: failingStore },
        ),
      ).rejects.toThrow('disk full');

      expect(broadcast.mock.calls.map(([row]) => [row.prompt, row.status])).toEqual([['agent 1', 'cancelled']]);
    });
  });
});

describe('delivering a fired wakeup', () => {
  it('sends a user-scheduled prompt as the user, so it renders as their message', () => {
    const delivery = wakeupPromptDelivery('user');
    expect(delivery.promptOrigin).not.toBe('wakeup_resume');
    expect(delivery.promptProvenance).toEqual({ actor: 'human', origin: 'composer' });
  });

  it('keeps agent wakeups as a system resume marker', () => {
    const delivery = wakeupPromptDelivery('agent');
    expect(delivery.promptOrigin).toBe('wakeup_resume');
    expect(delivery.promptProvenance.actor).toBe('system');
  });
});
