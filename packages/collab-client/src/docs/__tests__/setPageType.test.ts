// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { setPageType, type SetPageTypeDependencies } from '../setPageType';
import { listPageChildren, movePageChild, type ChildMoveSession } from '../setPageTypeChildren';

const PAGE = { documentId: 'doc-1', title: 'Sync engine', documentType: 'markdown', parentId: 'overview', parentKind: 'page' as const, sortOrder: 2048 };
const CHILDREN = [
  { kind: 'page' as const, id: 'notes' },
  { kind: 'type' as const, id: 'decision' },
  { kind: 'item' as const, id: 'mod_0' },
];
const BODY = '# Sync engine\n\nMoves documents between clients.\n';
const COPY = { markdown: BODY, version: 4 };

function harness(overrides: Partial<SetPageTypeDependencies> = {}) {
  const calls: string[] = [];
  const record = <T>(name: string, value: T) => (...args: unknown[]) => {
    calls.push(`${name}:${args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(',')}`);
    return value;
  };
  const dependencies: SetPageTypeDependencies = {
    listChildren: vi.fn(() => []),
    moveChildUnderItem: vi.fn(record('move', Promise.resolve({ ok: true as const }))),
    flushPageEditor: vi.fn(record('flush', Promise.resolve())),
    readPageMarkdown: vi.fn(record('read', Promise.resolve(COPY))),
    createItem: vi.fn(record('create', Promise.resolve({ itemId: 'mod_1', publication: 'published' as const }))),
    verifyItemBody: vi.fn(record('verify', Promise.resolve({ status: 'match' as const }))),
    removeItem: vi.fn(record('remove', Promise.resolve())),
    setItemPlacement: vi.fn(record('place', Promise.resolve({ ok: true as const }))),
    pageUnchangedSince: vi.fn(record('recheck', Promise.resolve(true))),
    trashPage: vi.fn(record('trash', Promise.resolve())),
    openItem: vi.fn(record('open', undefined)),
    wait: vi.fn(async () => {}),
    ...overrides,
  };
  return { dependencies, calls };
}

const run = (dependencies: SetPageTypeDependencies, lane: 'team' | 'personal' = 'team') =>
  setPageType({ lane, page: PAGE, typeId: 'module' }, dependencies);

describe('setPageType', () => {
  it('flushes, copies, verifies, places, re-checks the page, then trashes it and opens the item', async () => {
    const { dependencies, calls } = harness();

    expect(await run(dependencies)).toEqual({ status: 'done', itemId: 'mod_1' });
    expect(calls).toEqual([
      'flush:doc-1',
      'read:doc-1',
      `create:${JSON.stringify({ typeId: 'module', title: 'Sync engine', markdown: BODY })}`,
      `verify:mod_1,${BODY}`,
      `place:mod_1,overview,${JSON.stringify({ parentKind: 'page', sortOrder: 2048 })}`,
      `recheck:doc-1,${JSON.stringify(COPY)}`,
      'trash:doc-1',
      'open:mod_1,doc-1',
    ]);
  });

  it('moves the page\'s children under the typed page once it is verified and placed, just before the trash', async () => {
    const { dependencies, calls } = harness({ listChildren: vi.fn(() => CHILDREN) });

    expect(await run(dependencies)).toEqual({ status: 'done', itemId: 'mod_1' });
    expect(calls.slice(calls.indexOf(`recheck:doc-1,${JSON.stringify(COPY)}`))).toEqual([
      `recheck:doc-1,${JSON.stringify(COPY)}`,
      ...CHILDREN.map((child) => `move:${JSON.stringify(child)},mod_1`),
      'trash:doc-1',
      'open:mod_1,doc-1',
    ]);
  });

  it('keeps the page when one of its children cannot move under the typed page', async () => {
    const moveChildUnderItem = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'timed out' });
    const { dependencies } = harness({ listChildren: vi.fn(() => CHILDREN), moveChildUnderItem });

    const outcome = await run(dependencies);

    expect(outcome).toMatchObject({ status: 'failed', itemId: 'mod_1', itemKept: true });
    expect(outcome.status === 'failed' && outcome.message).toMatch(/timed out/);
    expect(moveChildUnderItem).toHaveBeenCalledTimes(2);
    expect(dependencies.trashPage).not.toHaveBeenCalled();
    expect(dependencies.removeItem).not.toHaveBeenCalled();
  });

  it('refuses a page with images or decision answers bound to its room, before creating anything', async () => {
    for (const markdown of ['![chart](collab-asset://doc/doc-1/asset/abc)\n', 'Intro\n\n```decision\nid: d1\n```\n']) {
      const { dependencies } = harness({ readPageMarkdown: vi.fn(async () => ({ markdown })) });
      expect((await run(dependencies)).status).toBe('refused');
      expect(dependencies.createItem).not.toHaveBeenCalled();
    }
  });

  it('creates nothing when the open editor cannot be flushed or the page cannot be read', async () => {
    for (const override of [
      { flushPageEditor: vi.fn(async () => { throw new Error('unsaved edits'); }) },
      { readPageMarkdown: vi.fn(async () => { throw new Error('Timed out hydrating'); }) },
    ]) {
      const { dependencies } = harness(override);
      expect(await run(dependencies)).toMatchObject({ status: 'failed', itemKept: false });
      expect(dependencies.createItem).not.toHaveBeenCalled();
    }
  });

  it('removes an item that never reached the team, leaving the page untouched', async () => {
    const { dependencies } = harness({
      createItem: vi.fn(async () => ({ itemId: 'mod_1', publication: 'pending' as const, error: 'Saved locally. Team sync is not connected.' })),
    });

    const outcome = await run(dependencies);

    expect(outcome).toMatchObject({ status: 'failed', itemId: 'mod_1', itemKept: false });
    expect(outcome.status === 'failed' && outcome.message).toMatch(/Team sync is not connected/);
    expect(dependencies.verifyItemBody).not.toHaveBeenCalled();
    expect(dependencies.removeItem).toHaveBeenCalledWith('mod_1');
    expect(dependencies.trashPage).not.toHaveBeenCalled();
  });

  it('retries an unreadable read-back, and never deletes a published item that still cannot be read', async () => {
    const unreadable = vi.fn(async () => ({ status: 'unreadable' as const, reason: 'room unreachable' }));
    const team = harness({ verifyItemBody: unreadable });

    const outcome = await run(team.dependencies);

    expect(unreadable).toHaveBeenCalledTimes(3);
    expect(team.dependencies.wait).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ status: 'failed', itemId: 'mod_1', itemKept: true });
    expect(team.dependencies.removeItem).not.toHaveBeenCalled();
    expect(team.dependencies.trashPage).not.toHaveBeenCalled();

    // Read-back succeeding on a retry carries on as normal.
    const flaky = vi.fn()
      .mockResolvedValueOnce({ status: 'unreadable', reason: 'syncing' })
      .mockResolvedValueOnce({ status: 'match' });
    const recovered = harness({ verifyItemBody: flaky });
    expect(await run(recovered.dependencies)).toEqual({ status: 'done', itemId: 'mod_1' });

    // A local personal item nobody else can reach is still cleaned up.
    const personal = harness({
      createItem: vi.fn(async () => ({ itemId: 'idea_1', publication: 'local' as const })),
      verifyItemBody: vi.fn(async () => ({ status: 'unreadable' as const, reason: 'not found' })),
    });
    expect(await run(personal.dependencies, 'personal')).toMatchObject({ status: 'failed', itemKept: false });
    expect(personal.dependencies.removeItem).toHaveBeenCalledWith('idea_1');
  });

  it('keeps the item and the page when the read-back differs', async () => {
    const { dependencies } = harness({ verifyItemBody: vi.fn(async () => ({ status: 'mismatch' as const })) });

    expect(await run(dependencies)).toMatchObject({ status: 'failed', itemId: 'mod_1', itemKept: true });
    expect(dependencies.removeItem).not.toHaveBeenCalled();
    expect(dependencies.trashPage).not.toHaveBeenCalled();
  });

  it('keeps the page when the placement is not confirmed, saying the item sits under its type', async () => {
    const { dependencies } = harness({
      setItemPlacement: vi.fn(async () => ({ ok: false as const, error: 'timed out' })),
    });

    const outcome = await run(dependencies);

    expect(outcome).toMatchObject({ status: 'failed', itemId: 'mod_1', itemKept: true });
    expect(outcome.status === 'failed' && outcome.message).toMatch(/under its type/);
    expect(dependencies.removeItem).not.toHaveBeenCalled();
    expect(dependencies.pageUnchangedSince).not.toHaveBeenCalled();
    expect(dependencies.trashPage).not.toHaveBeenCalled();
  });

  it('keeps both when the page changed after the copy, or the trash itself fails', async () => {
    const changed = harness({ pageUnchangedSince: vi.fn(async () => false), listChildren: vi.fn(() => CHILDREN) });
    const changedOutcome = await run(changed.dependencies);
    expect(changedOutcome).toMatchObject({ status: 'failed', itemId: 'mod_1', itemKept: true });
    expect(changedOutcome.status === 'failed' && changedOutcome.message).toMatch(/changed/);
    expect(changed.dependencies.trashPage).not.toHaveBeenCalled();
    expect(changed.dependencies.removeItem).not.toHaveBeenCalled();
    // The children stay with the page that is kept.
    expect(changed.dependencies.moveChildUnderItem).not.toHaveBeenCalled();

    const trashFails = harness({ trashPage: vi.fn(async () => { throw new Error('offline'); }) });
    expect(await run(trashFails.dependencies)).toMatchObject({ status: 'failed', itemId: 'mod_1', itemKept: true });
    expect(trashFails.dependencies.removeItem).not.toHaveBeenCalled();
    expect(trashFails.dependencies.openItem).toHaveBeenCalledWith('mod_1', 'doc-1');
  });
});

describe('moving a page\'s children under the typed page (team and personal adapter)', () => {
  const doc = (documentId: string, extra: Record<string, unknown> = {}) => ({
    documentId, teamProjectId: null, title: documentId, documentType: 'markdown', createdBy: 'm', createdAt: 1, updatedAt: 1,
    parentFolderId: 'doc-1', ...extra,
  });
  const session = (command: (cmd: { type: string }) => Promise<unknown>) => {
    const fake = {
      dataSource: { command: vi.fn(command) },
      getDocuments: () => [doc('notes', { sortOrder: 3072 }), doc('type-page:decision')],
      getItemPlacements: () => [],
      setItemPlacement: vi.fn(async () => ({ ok: false as const, error: 'refused' })),
    };
    return fake as typeof fake & ChildMoveSession;
  };
  const types = [{ typeId: 'decision', projectId: null, parentFolderId: 'doc-1', sortOrder: 7, createdBy: 'm', createdAt: 1, updatedAt: 1 }];

  it('reports a move only once the store confirmed it, and every failure as one', async () => {
    const confirmed = session(async () => ({ ok: true }));
    expect(listPageChildren(confirmed, types, 'doc-1')).toEqual([{ kind: 'page', id: 'notes' }, { kind: 'type', id: 'decision' }]);
    expect(await movePageChild(confirmed, types, { kind: 'page', id: 'notes' }, 'mod_1')).toEqual({ ok: true });
    expect(confirmed.dataSource.command).toHaveBeenCalledWith({
      type: 'move-document', documentId: 'notes', parentFolderId: 'mod_1', parentKind: 'item', sortOrder: 3072, confirm: true,
    });
    // A type moves with its prose, each confirmed.
    expect(await movePageChild(confirmed, types, { kind: 'type', id: 'decision' }, 'mod_1')).toEqual({ ok: true });
    expect(confirmed.dataSource.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'move-document', documentId: 'type-page:decision', confirm: true }));
    expect(confirmed.dataSource.command).toHaveBeenCalledWith({
      type: 'set-type-placement', typeId: 'decision', parentFolderId: 'mod_1', parentKind: 'item', sortOrder: 7, confirm: true,
    });

    // An older server never confirms an item parent.
    const unconfirmed = session(async () => { throw new Error('The server did not confirm the move in time.'); });
    expect(await movePageChild(unconfirmed, types, { kind: 'page', id: 'notes' }, 'mod_1'))
      .toEqual({ ok: false, error: 'The server did not confirm the move in time.' });
    expect(await movePageChild(unconfirmed, types, { kind: 'type', id: 'decision' }, 'mod_1')).toMatchObject({ ok: false });
    expect(await movePageChild(unconfirmed, types, { kind: 'item', id: 'mod_0' }, 'mod_1')).toEqual({ ok: false, error: 'refused' });
  });
});
