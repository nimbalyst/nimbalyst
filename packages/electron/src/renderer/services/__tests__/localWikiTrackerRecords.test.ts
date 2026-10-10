// @vitest-environment node
/**
 * Local wiki items as tracker records: relationship ids are enriched for the
 * UI and stored back as ids, and a full replace from the database does not
 * drop them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { replaceAllTrackerItemsAtom, trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { globalRegistry, type TrackerDataModel } from '@nimbalyst/tracker-schema';
import type { TrackerRecord } from '@nimbalyst/tracker-core';
import type { LocalPage } from '@nimbalyst/local-wiki';
import { buildTrackerCreatePayload } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerCreatePayload';
import {
  buildLocalWikiRecords,
  createTrackerItem,
  isLocalWikiItemId,
  localWikiItemUpdate,
  markPlacedLocalWikiType,
  mergeLocalWikiRecords,
  remergeLocalWikiRecords,
} from '../localWikiTrackerRecords';
import { refuseLocalWikiArchive, saveLocalWikiItemFields } from '../localWikiTrackerWrites';
import { createCollectionItem } from '../../components/TrackerMode/createCollectionItem';

const notify = vi.hoisted(() => ({ showError: vi.fn(), showInfo: vi.fn(), showWarning: vi.fn() }));
vi.mock('../ErrorNotificationService', () => ({ errorNotificationService: notify }));

globalRegistry.register({
  type: 'competitor', displayName: 'Competitor', displayNamePlural: 'Competitors', icon: 'flag', color: '#888',
  modes: { inline: false, fullDocument: true }, idPrefix: 'cmp', idFormat: 'ulid', sharing: 'personal', storage: 'pages',
  fields: [
    { name: 'title', type: 'string', required: true },
    { name: 'rival', type: 'relationship' },
    { name: 'partners', type: 'relationship', multiValue: true },
  ],
} as TrackerDataModel);
globalRegistry.register({
  type: 'memo', displayName: 'Memo', displayNamePlural: 'Memos', icon: 'note', color: '#888',
  modes: { inline: false, fullDocument: true }, idPrefix: 'mem', idFormat: 'ulid', sharing: 'personal',
  fields: [{ name: 'title', type: 'string', required: true }, { name: 'status', type: 'string' }],
} as TrackerDataModel);

const page =(id: string, title: string, fields: Record<string, unknown>): LocalPage => ({
  id, title, type: 'competitor', fields, documentType: 'markdown', fileExtension: '.md', parentId: null, parentKind: null, order: 1000, path: `${title}.md`, dir: title,
  bodySource: 'file', version: 'v', hasContent: true, createdAt: 1, updatedAt: 2, trashedAt: null,
});

const dbItem = { id: 'db1', primaryType: 'bug', typeTags: ['bug'], source: 'native', archived: false, syncStatus: 'local', issueKey: 'NIM-9',
  system: { workspace: '/ws', createdAt: 'x', updatedAt: 'x' }, fields: { title: 'Crash' } } as TrackerRecord;

afterEach(() => {
  mergeLocalWikiRecords('/ws', []);
  store.set(replaceAllTrackerItemsAtom, []);
});

describe('Local wiki tracker records', () => {
  it('enriches relationship ids, writes them back as ids, and survives a full replace from the database', () => {
    store.set(replaceAllTrackerItemsAtom, [dbItem]);
    const records = buildLocalWikiRecords('/ws', '/ws/nimbalyst-local/wiki', [
      page('acme', 'Acme', { rival: 'globex', partners: ['db1', 'gone'] }),
      page('globex', 'Globex', {}),
    ], [], store.get(trackerItemsMapAtom));
    const acme = records.find((record) => record.id === 'acme')!;
    expect(acme).toMatchObject({ source: 'local-wiki', primaryType: 'competitor', system: { documentPath: '/ws/nimbalyst-local/wiki/Acme.md' } });
    expect(acme.fields.rival).toEqual([{ itemId: 'globex', title: 'Globex', trackerType: 'competitor' }]);
    expect(acme.fields.partners).toEqual([{ itemId: 'db1', title: 'Crash', trackerType: 'bug', issueKey: 'NIM-9' }, { itemId: 'gone' }]);
    expect(localWikiItemUpdate(acme, { rival: acme.fields.rival, partners: [], status: 'x' })).toEqual({ rival: 'globex', partners: null, status: 'x' });

    mergeLocalWikiRecords('/ws', records);
    expect(isLocalWikiItemId('acme')).toBe(true);
    expect(isLocalWikiItemId('db1')).toBe(false);
    store.set(replaceAllTrackerItemsAtom, [dbItem]);
    remergeLocalWikiRecords('/ws');
    expect([...store.get(trackerItemsMapAtom).keys()].sort()).toEqual(['acme', 'db1', 'globex']);
    mergeLocalWikiRecords('/ws', records.filter((record) => record.id !== 'globex'));
    expect([...store.get(trackerItemsMapAtom).keys()].sort()).toEqual(['acme', 'db1']);
  });

  it('shows only the active project\'s wiki items after a project switch', () => {
    const keys = () => [...store.get(trackerItemsMapAtom).keys()].sort();
    remergeLocalWikiRecords('/a');
    mergeLocalWikiRecords('/a', buildLocalWikiRecords('/a', '/a/wiki', [page('a1', 'A1', {})], [], new Map()));
    mergeLocalWikiRecords('/b', buildLocalWikiRecords('/b', '/b/wiki', [page('b1', 'B1', {})], [], new Map()));
    // B's data source refreshed while A was showing: cached, not shown.
    expect(keys()).toEqual(['a1']);

    remergeLocalWikiRecords('/b');
    expect(keys()).toEqual(['b1']);
    store.set(replaceAllTrackerItemsAtom, [dbItem]);
    remergeLocalWikiRecords('/b');
    expect(keys()).toEqual(['b1', 'db1']);
    // A's page source refreshing in the background does not bring A's items back.
    mergeLocalWikiRecords('/a', buildLocalWikiRecords('/a', '/a/wiki', [page('a1', 'A1', {})], [], new Map()));
    expect(keys()).toEqual(['b1', 'db1']);

    mergeLocalWikiRecords('/a', []);
    mergeLocalWikiRecords('/b', []);
    remergeLocalWikiRecords('/ws');
  });

  it('creates a wiki type\'s item as a file from every create surface, and any other type in the database', async () => {
    const invoke = vi.fn().mockResolvedValue({ id: 'cmp_1' });
    const createTrackerItemRow = vi.fn().mockResolvedValue({ success: true, item: { id: 'mem_1' } });
    vi.stubGlobal('window', { electronAPI: { invoke, documentService: { createTrackerItem: createTrackerItemRow } } });
    try {
      const built = buildTrackerCreatePayload('competitor', { title: 'Acme', content: 'Body', fields: { rival: 'globex' } }, { workspacePath: '/ws', generateId: () => 'cmp_1' });
      if (!built.ok) throw new Error('payload');
      expect(await createTrackerItem(built.payload)).toMatchObject({ success: true, item: { id: 'cmp_1' } });
      // Only fields the type declares reach the file: no default status or priority.
      expect(invoke).toHaveBeenCalledWith('local-wiki:tracker-command', '/ws', 'competitor', {
        type: 'create-item', item: { id: 'cmp_1', title: 'Acme', fields: { rival: 'globex' }, body: 'Body' },
      });

      // Tracker mode's collection picker goes through the same decision.
      expect(await createCollectionItem({ workspacePath: '/ws', type: 'competitor', title: 'Globex' })).toMatchObject({ itemId: 'cmp_1', trackerType: 'competitor' });
      expect(invoke).toHaveBeenCalledTimes(2);

      const memo = buildTrackerCreatePayload('memo', { title: 'Note' }, { workspacePath: '/ws' });
      if (!memo.ok) throw new Error('payload');
      await createTrackerItem(memo.payload);
      expect(createTrackerItemRow).toHaveBeenCalledWith(memo.payload);
      expect(invoke).toHaveBeenCalledTimes(2);

      // Placed in the wiki by this window before the schema watcher reloaded the YAML.
      markPlacedLocalWikiType('memo');
      await createTrackerItem(memo.payload);
      expect(createTrackerItemRow).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenLastCalledWith('local-wiki:tracker-command', '/ws', 'memo', expect.objectContaining({ type: 'create-item' }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('saves Tracker mode edits to the file and never drops a change silently', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    try {
      const [acme] = buildLocalWikiRecords('/ws', '/ws/wiki', [page('acme', 'Acme', {})], [], new Map());
      expect(await saveLocalWikiItemFields(acme, { status: 'active', rival: [{ itemId: 'globex' }], kanbanSortOrder: 'a1' })).toBe(true);
      expect(invoke).toHaveBeenCalledWith('local-wiki:tracker-command', '/ws', 'competitor', {
        type: 'update-item', input: { itemId: 'acme', updates: { status: 'active', rival: 'globex' } },
      });
      // Board order has no place in the file: said so, and nothing written for it.
      expect(notify.showInfo).toHaveBeenCalledTimes(1);
      expect(await saveLocalWikiItemFields(acme, { kanbanSortOrder: 'a2' })).toBe(false);
      expect(invoke).toHaveBeenCalledTimes(1);

      invoke.mockRejectedValueOnce(new Error('version conflict'));
      expect(await saveLocalWikiItemFields(acme, { status: 'gone' })).toBe(false);
      expect(notify.showError.mock.calls[0][1]).toContain('version conflict');

      expect(refuseLocalWikiArchive([acme, dbItem, undefined])).toEqual([acme]);
      expect(notify.showWarning).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
