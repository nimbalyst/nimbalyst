// @vitest-environment node
/**
 * Agent edits to Personal pages (Decision 20) through the same entry point as
 * every other agent edit, `applyAgentDiff`, against the real Personal pages
 * service on the real SQLite engine. The edit must change the stored body,
 * leave the pre-edit text in local history, survive a relaunch, and never
 * overwrite text someone saved between the agent's read and its write.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test'),
    getVersion: vi.fn(() => '1'),
    on: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../main/database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../../main/HistoryManager', () => ({ historyManager: { createSnapshot: vi.fn() } }));
// The shared-page routes are not under test; keep their room machinery out.
vi.mock('../HeadlessCollabDocument', () => ({
  acquireHeadlessCollabDocument: vi.fn(),
  readHeadlessCollabDocContent: vi.fn(),
  HeadlessCollabDocumentError: class extends Error {},
}));
vi.mock('../HeadlessCollabDocEdit', () => ({ applyHeadlessCollabDocEdit: vi.fn() }));
vi.mock('../collabAgentEditRevision', () => ({
  hasRecentAgentEditRevision: vi.fn(() => true),
  recordRevisionBeforeAgentEdit: vi.fn(),
  revisionSourceFromAcquisition: vi.fn(),
  revisionSourceFromOpenTab: vi.fn(),
}));

import { SQLiteDatabase } from '../../../main/database/sqlite/SQLiteDatabase';
import { PersonalPagesService, personalDocHistoryKey } from '../../../main/services/PersonalPagesService';
import { applyAgentDiff, readCollabDocForAgent } from '../agentDocumentAccess';
import { applyPersonalPageAgentEdit, restorePersonalTypedPageBody, type PersonalPageIo } from '../personalAgentEdit';

const SCHEMA_DIR = path.resolve(__dirname, '../../../main/database/sqlite/schemas');
const WS = '/ws/personal-agent-edit';

describe('agent edits to Personal pages', () => {
  let tmp: string;
  let db: SQLiteDatabase;
  let service: PersonalPagesService;
  const history = { createSnapshot: vi.fn(async (..._args: unknown[]) => undefined) };
  /** Runs once, between the agent's read and its write, when set. */
  let beforeNextWrite: (() => Promise<void>) | null = null;

  const launch = async () => {
    db = new SQLiteDatabase({ dbDir: path.join(tmp, 'sqlite-db'), schemaDir: SCHEMA_DIR, slowQueryThresholdMs: 1000, sampleRate: 0 });
    await db.initialize();
    service = new PersonalPagesService({ db: () => db, history, notify: () => {} });
  };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-personal-agent-edit-'));
    history.createSnapshot.mockClear();
    beforeNextWrite = null;
    await launch();
    (globalThis as any).window = {
      electronAPI: {
        invoke: async (channel: string, ...args: any[]) => {
          if (channel === 'personal-pages:get-body') return service.getBody(args[0], args[1]);
          if (channel === 'personal-pages:update-body') {
            const hook = beforeNextWrite;
            beforeNextWrite = null;
            await hook?.();
            return service.updateBody(args[0], args[1], args[2], args[3]);
          }
          if (channel === 'history:create-snapshot') return history.createSnapshot(args[0], args[1], args[2], args[3]);
          // Not in the Local wiki folder: a database page not exported yet.
          if (channel === 'local-wiki:page-path') return null;
          throw new Error(`unexpected channel ${channel}`);
        },
      },
    };
    await service.command(WS, {
      type: 'register-document', documentId: 'ideas', title: 'Ideas', documentType: 'markdown', parentFolderId: null,
      metadata: { metadataVersion: 2, fileExtension: '.md', editorId: 'markdown' },
    });
    await service.updateBody(WS, 'ideas', '# Ideas\n\nTables: undecided.\n', 0);
    history.createSnapshot.mockClear();
  });

  afterEach(async () => {
    delete (globalThis as any).window;
    service.dispose();
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('changes the stored body, keeps the old text in history, and survives a relaunch', async () => {
    expect(await readCollabDocForAgent('personal://ideas', WS)).toEqual({
      content: '# Ideas\n\nTables: undecided.\n',
      route: 'headless',
    });

    const result = await applyAgentDiff('personal://ideas', [
      { oldText: 'Tables: undecided.', newText: 'Tables: one shared DataTable.' },
    ], { workspacePath: WS });

    expect(result).toMatchObject({ success: true });
    expect(history.createSnapshot).toHaveBeenCalledWith(
      personalDocHistoryKey('ideas'), '# Ideas\n\nTables: undecided.\n', 'pre-apply', 'Before agent edit',
    );
    expect(history.createSnapshot).toHaveBeenCalledWith(
      personalDocHistoryKey('ideas'), '# Ideas\n\nTables: one shared DataTable.\n', 'auto-save', 'Auto-save',
    );

    service.dispose();
    await db.close();
    await launch();
    expect((await service.getBody(WS, 'ideas'))?.content).toBe('# Ideas\n\nTables: one shared DataTable.\n');
  });

  it('re-applies the edit on top of text saved between its read and its write', async () => {
    beforeNextWrite = async () => {
      const current = await service.getBody(WS, 'ideas');
      await service.updateBody(WS, 'ideas', `${current!.content}\nTyped meanwhile.\n`, current!.version);
    };

    const result = await applyAgentDiff('personal://ideas', [
      { oldText: 'Tables: undecided.', newText: 'Tables: one shared DataTable.' },
    ], { workspacePath: WS });

    expect(result).toMatchObject({ success: true });
    expect((await service.getBody(WS, 'ideas'))?.content).toBe('# Ideas\n\nTables: one shared DataTable.\n\nTyped meanwhile.\n');
  });

  it('re-applies a closed typed page edit on top of text saved between its read and its write', async () => {
    const stored = { content: '# Idea\n\nTables: undecided.\n', version: 3 };
    let beforeWrite: (() => void) | null = () => {
      stored.content += '\nTyped meanwhile.\n';
      stored.version += 1;
    };
    const io = {
      getTypedPageBody: vi.fn(async () => ({ ...stored })),
      setTypedPageBody: vi.fn(async (_itemId: string, content: string, expectedVersion: number) => {
        const hook = beforeWrite;
        beforeWrite = null;
        hook?.();
        if (expectedVersion !== stored.version) return { conflict: true as const, version: stored.version, content: stored.content };
        stored.content = content;
        stored.version += 1;
        return { version: stored.version };
      }),
      liveTypedPage: () => null,
      keepInHistory: vi.fn(async () => undefined),
    } as unknown as PersonalPageIo;

    const result = await applyPersonalPageAgentEdit('personal://tracker-content/idea_1', [
      { oldText: 'Tables: undecided.', newText: 'Tables: one shared DataTable.' },
    ], {}, io);

    expect(result).toMatchObject({ success: true });
    expect(stored.content).toBe('# Idea\n\nTables: one shared DataTable.\n\nTyped meanwhile.\n');
    expect(io.keepInHistory).toHaveBeenCalledWith('personal-doc://tracker-content/idea_1', '# Idea\n\nTables: undecided.\n', 'Before agent edit');

    // No cached text at the current version: the first write is refused, and
    // the version it reports is paired with a fresh read.
    const writes: number[] = [];
    io.getTypedPageBody = async () => ({ content: stored.content, version: null });
    io.setTypedPageBody = async (_itemId, content, expectedVersion) => {
      writes.push(expectedVersion);
      if (expectedVersion !== stored.version) return { conflict: true, version: stored.version };
      stored.content = content;
      return { written: true };
    };
    const retried = await applyPersonalPageAgentEdit('personal://tracker-content/idea_1', [
      { oldText: 'Typed meanwhile.', newText: 'Typed meanwhile, then edited.' },
    ], {}, io);
    expect(retried).toMatchObject({ success: true });
    expect(writes).toEqual([0, stored.version]);
    expect(stored.content).toContain('Typed meanwhile, then edited.');
  });

  it('restores a typed page from history through its open editor, else at the stored version', async () => {
    const replaceContent = vi.fn();
    const setTypedPageBody = vi.fn(async (_itemId: string, _content: string, expectedVersion: number) => (
      expectedVersion === 4 ? { written: true as const } : { conflict: true as const, version: 4 }
    ));
    const io = {
      getTypedPageBody: vi.fn(async () => ({ content: '# Agent text', version: null })),
      setTypedPageBody,
      liveTypedPage: () => ({ editor: {}, getContent: () => '# Agent text', replaceContent }),
    } as unknown as PersonalPageIo;

    // Open: the editor takes it, so its pending autosave cannot write over it.
    await restorePersonalTypedPageBody('idea_1', '# Before the agent', io);
    expect(replaceContent).toHaveBeenCalledWith('# Before the agent');
    expect(setTypedPageBody).not.toHaveBeenCalled();

    // Closed: written at the version the store reports.
    io.liveTypedPage = () => null;
    await restorePersonalTypedPageBody('idea_1', '# Before the agent', io);
    expect(setTypedPageBody.mock.calls.map((call) => call[2])).toEqual([0, 4]);
  });

  it('never restores a typed page over a save that landed after its read', async () => {
    const stored = { content: '# Read text', version: 4 as number | null };
    let readCount = 0;
    let afterRead: (() => void) | null = null;
    const io = {
      getTypedPageBody: vi.fn(async () => {
        readCount += 1;
        const body = { content: stored.content, version: stored.version };
        afterRead?.();
        afterRead = null;
        return body;
      }),
      setTypedPageBody: vi.fn(async (_itemId: string, content: string, expectedVersion: number) => {
        if ((stored.version ?? 7) !== expectedVersion) return { conflict: true as const, version: stored.version ?? 7 };
        stored.content = content;
        stored.version = (stored.version ?? 7) + 1;
        return { written: true as const };
      }),
      liveTypedPage: () => null,
    } as unknown as PersonalPageIo;

    // Read at version 4; another window saves version 5 before the write.
    afterRead = () => { stored.content = '# Another window'; stored.version = 5; };
    await expect(restorePersonalTypedPageBody('idea_1', '# Restored', io)).rejects.toThrow(/changed/);
    expect(stored).toEqual({ content: '# Another window', version: 5 });

    // No version came with the text, and the text moved on before the version was learned.
    stored.version = null;
    stored.content = '# Read text';
    readCount = 0;
    afterRead = () => { stored.content = '# Another window'; };
    await expect(restorePersonalTypedPageBody('idea_1', '# Restored', io)).rejects.toThrow(/changed/);
    expect(stored.content).toBe('# Another window');
    expect(readCount).toBe(2);
  });

  it('reports text that is not on the page instead of writing anything', async () => {
    const result = await applyAgentDiff('personal://ideas', [{ oldText: 'Not there', newText: 'x' }], { workspacePath: WS });
    expect(result.success).toBe(false);
    expect((await service.getBody(WS, 'ideas'))?.version).toBe(1);
  });
});
