// @vitest-environment node
/**
 * The Local wiki service over a real temp folder: nothing is created until the
 * first page, the location file is honored, and every write is announced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../personalPagesExportIpc', () => ({ registerPersonalPagesExportIpc: vi.fn(), logLegacyPersonalPagesHeartbeat: vi.fn() }));
const mainCheckoutOf = new Map<string, string>();
vi.mock('../../../utils/workspaceDetection', () => ({ resolveProjectPath: (p: string) => mainCheckoutOf.get(p) ?? p }));

import { LocalWikiService } from '../LocalWikiService';
import { resolveLocalWikiLocation } from '../localWikiLocation';
import {
  clearTrackerSchemaLoadFailures,
  onTrackerSchemaLoadFailuresChanged,
  recordTrackerSchemaLoadFailure,
} from '../../tracker/trackerSchemaLoadFailures';

let project: string;
let broadcast: ReturnType<typeof vi.fn<(workspacePath: string) => void>>;
let service: LocalWikiService;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'local-wiki-service-'));
  broadcast = vi.fn<(workspacePath: string) => void>();
  service = new LocalWikiService({ broadcast, watch: false });
});

afterEach(() => {
  service.dispose();
  fs.rmSync(project, { recursive: true, force: true });
});

describe('LocalWikiService', () => {
  it('creates nothing on a read, then writes the first page as a file at the default location', async () => {
    const empty = await service.snapshot(project);
    expect(empty.exists).toBe(false);
    expect(empty.items).toEqual([]);
    expect(fs.existsSync(path.join(project, 'nimbalyst-local'))).toBe(false);

    const { id } = await service.command(project, { type: 'register-document', title: 'Pricing', parentFolderId: null, body: 'Hello' });
    const root = path.join(project, 'nimbalyst-local', 'wiki');
    expect(fs.existsSync(path.join(root, '.nimbalyst-wiki.yaml'))).toBe(true);
    const text = fs.readFileSync(path.join(root, 'Pricing.md'), 'utf8');
    expect(text).toContain(`id: ${id}`);
    expect(text.trimEnd().endsWith('Hello')).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(project);

    const snapshot = await service.snapshot(project);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.items.map((item) => item.title)).toEqual(['Pricing']);
    expect(await service.pageFilePath(project, id!)).toBe(path.join(root, 'Pricing.md'));
  });

  // Before type descriptions were routed to the database, describing a Personal
  // type wrote `<Type>.md` with the description's id into the wiki. That file is
  // kept, but it must not be a page: not listed, not searchable, not opened.
  it('keeps a stray type description file on disk but out of the tree, search and page paths', async () => {
    await service.command(project, { type: 'register-document', documentId: 'type-page:competitor', title: 'Competitors', parentFolderId: null, body: 'What a competitor is' });
    await service.command(project, { type: 'register-document', title: 'Pricing', parentFolderId: null, body: 'What a competitor costs' });
    const stray = path.join(project, 'nimbalyst-local', 'wiki', 'Competitors.md');
    expect(fs.readFileSync(stray, 'utf8')).toContain('id: type-page:competitor');

    const snapshot = await service.snapshot(project);
    expect(snapshot.items.map((item) => item.title)).toEqual(['Pricing']);
    expect(snapshot.pages.map((page) => page.title)).toEqual(['Pricing']);
    expect(await service.pageFilePath(project, 'type-page:competitor')).toBeNull();
    const search = await service.search(project, { query: 'competitor' });
    expect(search.hits.map((hit) => hit.title)).toEqual(['Pricing']);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('reports type files the app could not load as malformed-type issues with the type id, once per file (NIM-7437)', async () => {
    const typesDir = path.join(project, '.nimbalyst', 'trackers');
    fs.mkdirSync(typesDir, { recursive: true });
    const lesson = path.join(typesDir, 'lesson.yaml');
    const garbled = path.join(typesDir, 'garbled.yaml');
    const lessonYaml = 'type: lesson\ndisplayName: Lesson\ndisplayNamePlural: Lessons\nstorage: table\nfields: []\n';
    fs.writeFileSync(lesson, lessonYaml);
    fs.writeFileSync(garbled, 'type: [unclosed\n');
    await service.command(project, { type: 'register-document', title: 'Home', parentFolderId: null, body: '' });
    const changed = vi.fn();
    const unsubscribe = onTrackerSchemaLoadFailuresChanged(changed);
    try {
      // The library reads `lesson` fine; only the app rejects it. `garbled` is not YAML at all.
      recordTrackerSchemaLoadFailure(project, lesson, new Error('Missing required field: modes'), lessonYaml);
      recordTrackerSchemaLoadFailure(project, garbled, new Error('bad indentation\n at line 1'), 'type: [unclosed\n');
      expect(changed).toHaveBeenCalledWith(project);

      const issues = (await service.snapshot(project)).issues.filter((issue) => issue.code === 'malformed-type');
      expect(issues).toEqual([
        { code: 'malformed-type', path: lesson, message: 'Missing required field: modes', id: 'lesson' },
        { code: 'malformed-type', path: garbled, message: 'bad indentation', id: 'garbled' },
      ]);

      clearTrackerSchemaLoadFailures(project);
      expect((await service.snapshot(project)).issues.filter((issue) => issue.id === 'lesson')).toEqual([]);
    } finally {
      unsubscribe();
      clearTrackerSchemaLoadFailures(project);
    }
  });

  it('reads the location from local-wiki.json against the main checkout, and opens an existing folder without a page', async () => {
    const worktree = path.join(project, 'worktree');
    mainCheckoutOf.set(worktree, project);
    fs.mkdirSync(path.join(project, '.nimbalyst'), { recursive: true });
    fs.writeFileSync(path.join(project, '.nimbalyst', 'local-wiki.json'), JSON.stringify({ location: 'docs/wiki/' }));
    fs.mkdirSync(path.join(project, 'docs', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(project, 'docs', 'wiki', 'Notes.md'), 'Written by hand\n');

    const location = resolveLocalWikiLocation(worktree);
    expect(location).toMatchObject({ projectRoot: project, location: 'docs/wiki', root: path.join(project, 'docs', 'wiki'), configured: true });
    const snapshot = await service.snapshot(worktree);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.items.map((item) => item.title)).toEqual(['Notes']);
    expect(fs.existsSync(path.join(project, 'docs', 'wiki', '.nimbalyst-wiki.yaml'))).toBe(true);

    fs.writeFileSync(path.join(project, '.nimbalyst', 'local-wiki.json'), JSON.stringify({ location: '../outside' }));
    expect(() => resolveLocalWikiLocation(project)).toThrow(/inside the project/);
    mainCheckoutOf.clear();
  });

  it('adds the editor types the renderer knows to the built-in ones, for files and wikis opened before or after', async () => {
    const root = path.join(project, 'nimbalyst-local', 'wiki');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'Board.excalidraw'), '{}');
    fs.writeFileSync(path.join(root, 'Names.namenym'), 'names');
    expect((await service.snapshot(project)).items.map((item) => [item.title, item.documentType])).toEqual([['Board', 'excalidraw']]);

    await service.setEditorTypes({ '.namenym': 'namenym' });
    const snapshot = await service.snapshot(project);
    expect(snapshot.items.map((item) => [item.title, item.documentType, item.fileExtension]).sort()).toEqual([
      ['Board', 'excalidraw', '.excalidraw'],
      ['Names', 'namenym', '.namenym'],
    ]);
    expect(fs.existsSync(path.join(root, '.Names.namenym.wiki.yaml'))).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(project);
    await expect(service.setEditorTypes({ '.namenym': 7 } as never)).rejects.toThrow(/editor types/);
  });

  it('Place type makes a type a wiki type; only wiki types get typed pages and new items', async () => {
    const types = path.join(project, '.nimbalyst', 'trackers');
    fs.mkdirSync(types, { recursive: true });
    const yamlText = 'type: competitor  # ours\ndisplayName: Competitor\ndisplayNamePlural: Competitors\nfields:\n  - name: title\n    type: string\n';
    fs.writeFileSync(path.join(types, 'competitor.yaml'), yamlText);
    fs.writeFileSync(path.join(types, 'bug.yaml'), 'type: bug\ndisplayName: Bug\ndisplayNamePlural: Bugs\n');
    const { id } = await service.command(project, { type: 'register-document', title: 'Acme', parentFolderId: null });

    // Decision 9: a type without `storage` keeps its items in the app database.
    await expect(service.command(project, { type: 'set-document-type', documentId: id!, pageType: 'competitor' })).rejects.toThrow(/not a Local wiki type/);
    await expect(service.trackerCommand(project, 'bug', { type: 'create-item', item: { title: 'Crash' } })).rejects.toThrow(/app database/);

    await service.command(project, { type: 'set-type-placement', typeId: 'competitor', parentFolderId: null, sortOrder: 1000 });
    expect(fs.readFileSync(path.join(types, 'competitor.yaml'), 'utf8')).toBe(`${yamlText}storage: pages\n`);
    await service.command(project, { type: 'set-document-type', documentId: id!, pageType: 'competitor' });
    const created = await service.trackerCommand(project, 'competitor', { type: 'create-item', item: { title: 'Globex', fields: { status: 'active' } } });
    const items = (await service.trackerSnapshot(project, 'competitor')).items.map((item) => item.title).sort();
    expect(items).toEqual(['Acme', 'Globex']);
    expect(fs.readFileSync(path.join(project, 'nimbalyst-local', 'wiki', 'Globex.md'), 'utf8')).toMatch(new RegExp(`^---\\nid: ${created.id}\\ntype: competitor\\n`));
  });
});
