import React, { useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { workstreamStateAtom } from '../../../store/atoms/workstreamState';
import { AgentMode } from '../AgentMode';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';
import { selectedWorkstreamAtom } from '../../../store';

const metaAgentMode = vi.hoisted(() => vi.fn((_props: { sessionId: string }) => null));

vi.mock('../../../store', async () => {
  const { atom } = await import('jotai');
  const { store } = await import('@nimbalyst/runtime/store');
  const selected = atom<{ id: string; type: string }>({ id: 'restored-session', type: 'session' });
  const { activeWorkspacePathAtom } = await import('../../../store/atoms/openProjects');
  return {
    store,
    selectedWorkstreamAtom: () => selected,
    sessionHistoryWidthAtom: atom(260), sessionHistoryCollapsedAtom: atom(false),
    sessionAgentRoleAtom: (id: string) => atom(id.startsWith('meta-') ? 'meta-agent' : 'standard'),
    isRestoringNavigationAtom: atom(false),
    activeSessionIdAtom: atom(null), viewModeAtom: atom('list'),
    initSessionList: vi.fn(), initSessionEditors: vi.fn(),
    initAgentModeLayout: (path: string, options?: { setActive?: boolean }) => {
      if (options?.setActive !== false) store.set(activeWorkspacePathAtom, path);
    },
    registerWorkstreamSelectedHook: () => () => {},
    ...Object.fromEntries(['setSelectedWorkstreamAtom', 'setSessionHistoryWidthAtom',
      'addSessionFullAtom', 'refreshSessionListAtom', 'pushNavigationEntryAtom',
      'setViewModeAtom', 'fetchSessionSharesAtom'].map(name => [name, atom(null, () => {})])),
  };
});
vi.mock('../../../store/atoms/agentFileViewer', async () => { const { atom } = await import('jotai'); return { moveWorkstreamEditorAtom: atom(null, () => {}) }; });
vi.mock('../../../store/atoms/blitz', async () => { const { atom } = await import('jotai'); return { blitzAnalysisCreatedAtom: atom(null, () => {}) }; });
vi.mock('../../../store/atoms/agentMode', async () => { const { atom } = await import('jotai'); return { requestOpenSessionAtom: atom(null, () => {}), toggleSessionHistoryCollapsedAtom: atom(null, () => {}) }; });
vi.mock('../../../tips/atoms', async () => { const { atom } = await import('jotai'); return { tipCreateWorktreeSessionRequestAtom: atom(null, () => {}) }; });
vi.mock('../../../store/atoms/appSettings', async () => { const { atom } = await import('jotai'); return { defaultAgentModelAtom: atom(null, () => {}) }; });
vi.mock('../../../store/actions/sessionHistoryActions', async () => { const { atom } = await import('jotai'); return { blitzDialogOpenAtom: atom(null, () => {}), sessionQuickOpenRequestedAtom: atom(null, () => {}), selectSessionActionAtom: atom(null, () => {}), openSessionInTabActionAtom: atom(null, () => {}), createNewSessionActionAtom: atom(null, () => {}), createNewWorktreeSessionActionAtom: atom(null, () => {}), createWorktreeSessionCoreActionAtom: atom(null, () => {}), addSessionToWorktreeActionAtom: atom(null, () => {}) }; });
vi.mock('../../../hooks/useGitRepoProbe', () => ({ useGitRepoProbe: () => true }));
vi.mock('../../../hooks/useSuperLoop', () => ({ useSuperLoopInit: () => {} }));
vi.mock('../../../store/sessionStateListeners', () => ({ initSessionStateListeners: () => () => {}, updateSessionStateListenerWorkspace: () => {} }));
vi.mock('../../../store/listeners/fileStateListeners', () => ({ initFileStateListeners: () => () => {} }));
vi.mock('../../../store/listeners/fileTreeListeners', () => ({ initFileTreeListeners: () => () => {} }));
vi.mock('../../../store/listeners/sessionListListeners', () => ({ initSessionListListeners: () => () => {} }));
vi.mock('../../../store/listeners/sessionTranscriptListeners', () => ({ initSessionTranscriptListeners: () => () => {} }));
vi.mock('../../../store/listeners/deepLinkListeners', () => ({ initDeepLinkListeners: () => () => {} }));
vi.mock('../../../store/listeners/trayListeners', async () => ({
  initTrayListeners: () => () => {}, trayNewSessionRequestAtom: (await import('jotai')).atom(null),
}));
vi.mock('../../AgenticCoding/SessionHistory', () => ({ SessionHistory: () => null }));
vi.mock('../../TrackerMode/SessionKanbanBoard', () => ({ SessionKanbanBoard: () => null }));
vi.mock('../../BlitzDialog/BlitzDialog', () => ({ BlitzDialog: () => null }));
vi.mock('../../MetaAgentMode/MetaAgentMode', () => ({ MetaAgentMode: metaAgentMode }));
vi.mock('../../AgenticCoding/ResizablePanel', () => ({ ResizablePanel: ({ rightPanel }: { rightPanel: React.ReactNode }) => rightPanel }));
vi.mock('../AgentWorkstreamPanel', () => ({
  AgentWorkstreamPanel: ({ workspacePath, workstreamId }: { workspacePath: string; workstreamId: string }) => {
    // GitOperationsPanel clears saved staging in a passive effect when restored
    // Git status is already clean. Exercise the real persistence path here.
    useEffect(() => { store.set(workstreamStateAtom(workstreamId), { commitMessage: workspacePath }); }, [workspacePath, workstreamId]);
    return null;
  },
}));

afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('initializes persistence before restored child effects and routes writes after a project switch', async () => {
  vi.useFakeTimers();
  const invoke = vi.fn(async (channel: string) => channel === 'workspace:get-state' ? {} : true);
  vi.stubGlobal('window', Object.assign(window, { electronAPI: { invoke } }));
  // A late primary-workspace render must not steal the restored rail selection.
  store.set(activeWorkspacePathAtom, '/restored-project');
  const view = render(<AgentMode workspacePath="/project-32" workspaceName="project-32" />);
  expect(store.get(activeWorkspacePathAtom)).toBe('/restored-project');
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(invoke).toHaveBeenCalledWith('workspace:set-workstream-state', expect.objectContaining({ workspacePath: '/project-32', workstreamId: 'restored-session' }));
  invoke.mockClear();
  view.rerender(<AgentMode workspacePath="/project-01" workspaceName="project-01" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(invoke).toHaveBeenCalledWith('workspace:set-workstream-state', expect.objectContaining({ workspacePath: '/project-01', workstreamId: 'restored-session' }));
  expect(invoke).not.toHaveBeenCalledWith('workspace:set-workstream-state', expect.objectContaining({ workspacePath: '/project-32' }));
});

it('opens the active child of a meta-agent tree instead of the meta-agent view', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', Object.assign(window, { electronAPI: { invoke: vi.fn(async () => ({})) } }));
  store.set(selectedWorkstreamAtom('/project-meta'), { id: 'meta-root', type: 'workstream' });
  store.set(workstreamStateAtom('meta-root'), { activeChildId: 'worker-1' });
  metaAgentMode.mockClear();
  render(<Provider store={store}><AgentMode workspacePath="/project-meta" workspaceName="project-meta" /></Provider>);
  expect(metaAgentMode).not.toHaveBeenCalled();

  act(() => { store.set(workstreamStateAtom('meta-root'), { activeChildId: 'meta-child' }); });
  expect(metaAgentMode.mock.lastCall?.[0].sessionId).toBe('meta-child');

  act(() => { store.set(workstreamStateAtom('meta-root'), { activeChildId: 'meta-root' }); });
  expect(metaAgentMode.mock.lastCall?.[0].sessionId).toBe('meta-root');
});
