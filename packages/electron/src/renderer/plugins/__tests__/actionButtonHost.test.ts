// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const atoms = vi.hoisted(() => ({
  workspace: Symbol('workspace'),
  scope: Symbol('scope'),
  items: Symbol('items'),
  createSession: Symbol('createSession'),
  defaultModel: Symbol('defaultModel'),
  defaultEffort: Symbol('defaultEffort'),
}));
const state = vi.hoisted(() => ({
  values: new Map<symbol, unknown>(),
  set: vi.fn(),
  invoke: vi.fn(),
  createItem: vi.fn(),
  setItemPlacement: vi.fn(),
  openPage: vi.fn(),
  types: new Map<string, { displayName?: string; sharing?: string; storage?: unknown }>(),
  warn: vi.fn(),
  createLocal: vi.fn(),
  localIds: new Map<string, string>(),
}));

vi.mock('../../store', () => ({ store: { get: (atom: symbol) => state.values.get(atom), set: state.set } }));
vi.mock('../../store/atoms/openProjects', () => ({ activeWorkspacePathAtom: atoms.workspace }));
vi.mock('../../store/actions/sessionHistoryActions', () => ({ createNewSessionActionAtom: atoms.createSession }));
vi.mock('../../store/atoms/collabDocuments', () => ({
  activeCollabScopeAtom: atoms.scope,
  getElectronCollabDocsSession: () => ({ start: async () => {}, lane: 'team' }),
  getPersonalCollabDocsSession: () => ({ start: async () => {}, lane: 'personal' }),
  getPersonalCollabHost: () => ({ source: () => ({ documentIdForFile: (path: string) => state.localIds.get(path) ?? null }) }),
}));
vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms', () => ({ trackerItemsMapAtom: atoms.items }));
vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models', () => ({ globalRegistry: { get: (id: string) => state.types.get(id) } }));
vi.mock('../../components/UnifiedAI/claudeCliInputRouting', () => ({ isClaudeCliTerminalSession: (provider: string | null) => provider === 'claude-cli' }));
vi.mock('../../components/Settings/panels/trackerConfigUpgrade', () => ({ isTeamTrackerSharing: (sharing: string) => sharing === 'team' }));
vi.mock('../../components/CollabMode/useSetPageType', () => ({
  buildSetPageTypeDependencies: () => ({ createItem: state.createItem, setItemPlacement: state.setItemPlacement }),
}));
vi.mock('../../store/atoms/appSettings', () => ({ defaultAgentModelAtom: atoms.defaultModel, defaultEffortLevelAtom: atoms.defaultEffort }));
vi.mock('../../services/ErrorNotificationService', () => ({ errorNotificationService: { showWarning: state.warn } }));
vi.mock('../../services/localWikiTrackerRecords', () => ({
  isLocalWikiType: (typeId: string) => Boolean(state.types.get(typeId)?.storage),
  createTrackerItem: state.createLocal,
}));
vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerCreatePayload', () => ({
  buildTrackerCreatePayload: (type: string, input: { title: string; content: string }) => ({ ok: true, payload: { id: 'loc_1', type, title: input.title, content: input.content } }),
  formatTrackerValidationErrors: () => 'invalid',
}));
vi.mock('../../utils/agentEditedPage', () => ({
  agentPageTitle: () => 'Release plan',
  openAgentEditedPage: state.openPage,
}));

import { createItemFromButton, resolveButtonPage, resolveSessionFromButton, startSessionFromButton } from '../registerActionButtonHost';

const TEAM_PAGE = 'collab://org:o1:doc:D1';

beforeEach(() => {
  vi.clearAllMocks();
  state.values = new Map<symbol, unknown>([
    [atoms.workspace, '/ws'],
    [atoms.scope, { orgId: 'o1' }],
    [atoms.items, new Map([['it_1', { primaryType: 'decision' }]])],
    [atoms.defaultModel, 'claude-code:sonnet'],
    [atoms.defaultEffort, 'high'],
  ]);
  state.localIds = new Map([['/ws/wiki/Plans.md', 'loc_page']]);
  state.createLocal.mockResolvedValue({ success: true, item: { id: 'loc_1' } });
  state.types = new Map<string, { displayName?: string; sharing?: string; storage?: unknown }>([['decision', { displayName: 'Decision', sharing: 'team' }], ['note', { displayName: 'Note', sharing: 'personal' }], ['plan', { displayName: 'Plan', sharing: 'personal', storage: { kind: 'wiki' } }]]);
  state.set.mockResolvedValue('sess-1');
  state.invoke.mockImplementation(async (channel: string) => (channel === 'sessions:get' ? { session: { provider: 'claude-code' } } : { success: true }));
  state.createItem.mockResolvedValue({ itemId: 'it_new', publication: 'published' });
  state.setItemPlacement.mockResolvedValue({ ok: true });
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      invoke: state.invoke,
      aiGetModels: async () => ({ success: true, models: [{ id: 'claude-code:sonnet', name: 'Sonnet' }, { id: 'claude-code:opus', name: 'Opus' }], grouped: {} }),
    },
    dispatchEvent: vi.fn(),
  };
  (globalThis as { CustomEvent?: unknown }).CustomEvent ??= class { constructor(public type: string, public init: unknown) {} };
});

describe('start session button host', () => {
  const request = { label: 'Draft\nnotes', prompt: 'Summarize.', pagePath: TEAM_PAGE };

  it('resolves the default model and clamps the effort for it before the review', async () => {
    const resolved = await resolveSessionFromButton({ ...request, effort: 'ultra' });
    expect(resolved).toEqual({ ok: true, launch: expect.objectContaining({
      model: 'claude-code:sonnet', modelName: 'Sonnet', usesDefaultModel: true, requestedEffort: 'ultra', effortClamped: true,
    }) });
    expect(resolved.ok && resolved.launch.effort).not.toBe('ultra');

    const unclamped = await resolveSessionFromButton({ ...request, model: 'claude-code:opus' });
    expect(unclamped).toEqual({ ok: true, launch: expect.objectContaining({ model: 'claude-code:opus', usesDefaultModel: false, effort: 'high', effortClamped: false }) });
  });

  it('refuses a model that is not available, and hidden characters', async () => {
    expect(await resolveSessionFromButton({ ...request, model: 'claude-code:nope' })).toEqual({ ok: false, error: expect.stringContaining('not available') });
    expect(await resolveSessionFromButton({ ...request, prompt: 'Hi\u{E0064}' })).toEqual({ ok: false, error: expect.stringContaining('hidden') });
  });

  it('starts exactly the reviewed launch: its model and effort, the page as context, the page cited', async () => {
    const resolved = await resolveSessionFromButton({ ...request, model: 'claude-code:sonnet', effort: 'ultra' });
    if (!resolved.ok) throw new Error(resolved.error);
    expect(await startSessionFromButton(resolved.launch)).toEqual({ ok: true });
    expect(state.set).toHaveBeenCalledWith(atoms.createSession, {
      title: 'Draft notes',
      selectSession: false,
      model: 'claude-code:sonnet',
      metadata: { effortLevel: resolved.launch.effort },
    });
    expect(state.invoke).toHaveBeenCalledWith(
      'ai:sendMessage',
      `Summarize.\n\n(Started from the "Draft notes" button on [Release plan](${TEAM_PAGE}).)`,
      expect.objectContaining({ filePath: TEAM_PAGE, mode: 'agent', inputType: 'user' }),
      'sess-1',
      '/ws',
    );
    expect((window as unknown as { dispatchEvent: ReturnType<typeof vi.fn> }).dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('routes the genuine CLI through the prompt queue and maps a Personal page body to its page uri', async () => {
    state.invoke.mockImplementation(async (channel: string) => (channel === 'sessions:get' ? { session: { provider: 'claude-cli' } } : undefined));
    const resolved = await resolveSessionFromButton({ label: 'Go', prompt: 'Do it.', pagePath: 'personal-doc://P1' });
    if (!resolved.ok) throw new Error(resolved.error);
    await startSessionFromButton(resolved.launch);
    expect(state.invoke).toHaveBeenCalledWith('ai:createQueuedPrompt', 'sess-1', expect.stringContaining('(personal://P1)'), [], expect.objectContaining({ filePath: 'personal://P1' }));
  });
});

describe('new item button host', () => {
  it('reads the page a button sits on from each tab path form', () => {
    expect(resolveButtonPage(TEAM_PAGE)).toEqual({ kind: 'page', section: 'team', documentId: 'D1' });
    expect(resolveButtonPage('personal-doc://P1')).toEqual({ kind: 'page', section: 'personal', documentId: 'P1' });
    expect(resolveButtonPage('tracker://it_1')).toEqual({ kind: 'item', itemId: 'it_1' });
    expect(resolveButtonPage('collab://tracker-content/it_1')).toEqual({ kind: 'item', itemId: 'it_1' });
    expect(resolveButtonPage('/ws/notes.md')).toEqual({ kind: 'file', path: '/ws/notes.md' });
  });

  it('creates through Set type\'s path, places the item under the page, and opens it in this tab', async () => {
    const result = await createItemFromButton({ type: 'decision', title: 'Pick a DB', body: '## Context', pagePath: TEAM_PAGE, newTab: false });
    expect(result).toEqual({ ok: true });
    expect(state.createItem).toHaveBeenCalledWith({ typeId: 'decision', title: 'Pick a DB', markdown: '## Context' });
    expect(state.setItemPlacement).toHaveBeenCalledWith('it_new', 'D1', { parentKind: 'page', sortOrder: null });
    expect(state.openPage).toHaveBeenCalledWith('tracker://it_new', '/ws', { source: 'embedded_document', options: { newTab: false } });

    await createItemFromButton({ type: 'decision', title: 'Child', body: '', pagePath: 'tracker://it_1', newTab: true });
    expect(state.setItemPlacement).toHaveBeenLastCalledWith('it_new', 'it_1', { parentKind: 'item', sortOrder: null });
  });

  it('refuses an unknown type, a type from the other section, and a page outside Pages, creating nothing', async () => {
    const request = { title: 'X', body: '', newTab: false };
    expect(await createItemFromButton({ ...request, type: 'nope', pagePath: TEAM_PAGE })).toEqual({ ok: false, error: expect.stringContaining('no "nope" page type') });
    expect(await createItemFromButton({ ...request, type: 'note', pagePath: TEAM_PAGE })).toEqual({ ok: false, error: expect.stringContaining('personal type') });
    expect(await createItemFromButton({ ...request, type: 'decision', pagePath: '/ws/notes.md' })).toEqual({ ok: false, error: expect.stringContaining('Pages') });
    expect(state.createItem).not.toHaveBeenCalled();
  });

  it('returns the create path\'s own error, such as a permission refusal', async () => {
    state.createItem.mockRejectedValue(new Error('You cannot create items in this project'));
    expect(await createItemFromButton({ type: 'decision', title: 'X', body: '', pagePath: TEAM_PAGE, newTab: false }))
      .toEqual({ ok: false, error: 'You cannot create items in this project' });
    expect(state.openPage).not.toHaveBeenCalled();
  });

  it('resolves a Local wiki page by its file path and creates a wiki-type item through the Local wiki create path', async () => {
    expect(resolveButtonPage('/ws/wiki/Plans.md', '/ws')).toEqual({ kind: 'page', section: 'personal', documentId: 'loc_page' });
    expect(await createItemFromButton({ type: 'plan', title: 'Q4', body: '# Q4', pagePath: '/ws/wiki/Plans.md', newTab: false })).toEqual({ ok: true });
    expect(state.createLocal).toHaveBeenCalledWith(expect.objectContaining({ id: 'loc_1', type: 'plan', title: 'Q4', content: '# Q4' }));
    expect(state.createItem).not.toHaveBeenCalled();
    expect(state.setItemPlacement).toHaveBeenCalledWith('loc_1', 'loc_page', { parentKind: 'page', sortOrder: null });
  });

  it('says a plain file is not a page instead of failing silently', async () => {
    expect(await createItemFromButton({ type: 'note', title: 'X', body: '', pagePath: '/ws/notes.md', newTab: false }))
      .toEqual({ ok: false, error: expect.stringContaining('not a page') });
  });

  it('checks placement before opening the item and reports an unplaced item persistently, saying where it is', async () => {
    const order: string[] = [];
    state.setItemPlacement.mockImplementation(async () => { order.push('place'); return { ok: false, error: 'refused' }; });
    state.openPage.mockImplementation(async () => { order.push('open'); });
    const result = await createItemFromButton({ type: 'decision', title: 'Pick a DB', body: '', pagePath: TEAM_PAGE, newTab: false });
    expect(order).toEqual(['place', 'open']);
    expect(state.warn).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/Pick a DB.*refused.*Decision/s), expect.objectContaining({ duration: 0 }));
    expect(result).toEqual({ ok: false, error: expect.stringContaining('refused') });
  });
});
