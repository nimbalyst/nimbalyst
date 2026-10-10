// @vitest-environment jsdom
import React from 'react';
import { Provider } from 'jotai';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('../SessionProviderIcon', () => ({ SessionProviderIcon: () => null }));
vi.mock('../SessionSpawnerLink', () => ({ SessionSpawnerLink: () => null }));
vi.mock('../../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showInfo: vi.fn(), showError: vi.fn() },
}));
import { store } from '@nimbalyst/runtime/store';
import { SessionTree, useVisibleSessionTreeRows } from '../SessionTree.tsx';
import { SessionMovePicker } from '../SessionMovePicker';
import { useSessionTreeMove } from '../useSessionTreeMove';
import {
  sessionRegistryAtom,
  sessionUnreadAtom,
  sessionProcessingAtom,
  type SessionMeta,
} from '../../../store/atoms/sessions';
import {
  initWorkstreamState,
  workstreamStateAtom,
  loadWorkstreamStates,
} from '../../../store/atoms/workstreamState';
import { errorNotificationService } from '../../../services/ErrorNotificationService';
const row = (
  id: string,
  parentSessionId: string | null = null,
  extra: Partial<SessionMeta> = {}
): SessionMeta => ({
  id,
  title: id,
  provider: 'claude-code',
  worktreeId: null,
  uncommittedCount: 0,
  createdAt: 1,
  updatedAt: 1,
  workspaceId: '/project',
  sessionType: 'session',
  messageCount: 0,
  childCount: 0,
  isArchived: false,
  isPinned: false,
  parentSessionId,
  ...extra,
});
let rows: SessionMeta[];
let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  initWorkstreamState('/project');
  rows = [
    row('root', null, { childCount: 1 }),
    row('middle', 'root', { childCount: 1 }),
    row('leaf', 'middle'),
    row('target'),
    row('foreign', null, { worktreeId: 'elsewhere' }),
  ];
  store.set(sessionRegistryAtom, new Map(rows.map((r) => [r.id, r])));
  for (const r of rows) {
    store.set(workstreamStateAtom(r.id), { treeExpanded: null });
    store.set(sessionUnreadAtom(r.id), false);
    store.set(sessionProcessingAtom(r.id), false);
  }
  invoke = vi.fn(async (channel: string, ...args: any[]) => {
    if (channel === 'sessions:set-parent') {
      const payload = args[0];
      const old = store.get(sessionRegistryAtom).get(payload.sessionId)!;
      rows = rows.map((r) =>
        r.id === old.id
          ? {
              ...r,
              parentSessionId: payload.newParentId,
              createdBySessionId: payload.restoreManagerId ?? payload.newParentId,
            }
          : r
      );
      return {
        success: true,
        previousParentId: old.parentSessionId,
        previousManagerId: old.createdBySessionId,
      };
    }
    if (channel === 'sessions:list') return { success: true, sessions: rows };
    return { success: true };
  });
  window.electronAPI = { invoke } as any;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function tree() {
  return render(
    <Provider store={store}>
      <SessionTree
        root={rows[0]}
        sessions={rows.slice(1, 3)}
        activeSessionId={null}
        onSessionSelect={vi.fn()}
      />
    </Provider>
  );
}
describe('tree interactions', () => {
  it('flattens each tree to one entry per visible row so a virtual list never holds a whole tree', () => {
    const trees = [{ key: 'root', rows: rows.slice(0, 3) }];
    const { result } = renderHook(() => useVisibleSessionTreeRows(trees, null, '/project'), {
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    });
    const visible = () => result.current.get('root')!.map((r) => [r.node.session.id, r.node.depth - r.baseDepth]);
    expect(visible()).toEqual([['root', 0]]);
    act(() => store.set(sessionProcessingAtom('leaf'), true));
    expect(visible()).toEqual([['root', 0], ['middle', 1], ['leaf', 2]]);
    act(() => store.set(workstreamStateAtom('middle'), { treeExpanded: false }));
    expect(visible()).toEqual([['root', 0], ['middle', 1]]);
  });

  it.each([false, true])('pins and unpins a merged header using the wrapper placement identity (pinned=%s)', (isPinned) => {
    const wrapper = row('wrapper', null, {sessionType: 'workstream', childCount: 1, isPinned});
    const child = row('child', 'wrapper', {isPinned: !isPinned});
    store.set(sessionRegistryAtom, new Map([wrapper, child].map(r => [r.id, r])));
    const onPin = vi.fn((id: string, pinned: boolean) => {
      const registry = new Map(store.get(sessionRegistryAtom));
      registry.set(id, {...registry.get(id)!, isPinned: pinned});
      store.set(sessionRegistryAtom, registry);
    });
    render(<Provider store={store}><SessionTree root={wrapper} sessions={[child]}
      activeSessionId={null} onSessionSelect={vi.fn()} onSessionPinToggle={onPin} /></Provider>);
    const header = screen.getByText('child').closest('.session-list-item')!;
    expect(header.classList.contains('pinned')).toBe(isPinned);
    fireEvent.contextMenu(header);
    fireEvent.click(screen.getByRole('button', {name: isPinned ? 'Unpin' : 'Pin'}));
    expect(onPin).toHaveBeenCalledWith('wrapper', !isPinned);
    expect(store.get(sessionRegistryAtom).get('wrapper')?.isPinned).toBe(!isPinned);
    expect(header.classList.contains('pinned')).toBe(!isPinned);
    expect(store.get(sessionRegistryAtom).get('child')?.isPinned).toBe(!isPinned);
  });

  it('opens running or unread ancestor paths, honors explicit collapse and restores per-row preferences', async () => {
    act(() => store.set(sessionUnreadAtom('leaf'), true));
    const view = tree();
    screen.getByText('leaf');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse middle' }));
    expect(screen.queryByText('leaf')).toBeNull();
    act(() => store.set(sessionProcessingAtom('leaf'), true));
    expect(screen.queryByText('leaf')).toBeNull();
    view.unmount();
    const saved = { workstreamStates: { middle: { treeExpanded: false }, root: { treeExpanded: true } } };
    invoke.mockResolvedValueOnce(saved);
    await act(() => loadWorkstreamStates('/project'));
    tree();
    expect(screen.queryByText('leaf')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand middle' }));
    screen.getByText('leaf');
  });
  it('filters invalid parents and accepts a searched parent with the keyboard', async () => {
    const move = vi.fn().mockResolvedValue(true);
    const close = vi.fn();
    render(
      <Provider store={store}>
        <SessionMovePicker sessionId="root" onMove={move} onClose={close} />
      </Provider>
    );
    const input = screen.getByRole('textbox', { name: 'Search parent sessions' });
    fireEvent.change(input, { target: { value: 'leaf' } });
    expect(screen.queryByRole('option')).toBeNull();
    fireEvent.change(input, { target: { value: 'target' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(move).toHaveBeenCalledWith('target'));
    expect(close).toHaveBeenCalledOnce();
  });
  it('moves a subtree without converting the target and Undo restores its former manager', async () => {
    rows = rows.map((r) => (r.id === 'middle' ? { ...r, createdBySessionId: 'root' } : r));
    store.set(sessionRegistryAtom, new Map(rows.map((r) => [r.id, r])));
    function Move() {
      const { move } = useSessionTreeMove('middle', '/project');
      return <button onClick={() => void move('middle', 'target')}>Move</button>;
    }
    render(
      <Provider store={store}>
        <Move />
      </Provider>
    );
    fireEvent.click(screen.getByText('Move'));
    await waitFor(() => expect(errorNotificationService.showInfo).toHaveBeenCalledOnce());
    expect(store.get(sessionRegistryAtom).get('middle')?.parentSessionId).toBe('target');
    expect(store.get(sessionRegistryAtom).get('leaf')?.parentSessionId).toBe('middle');
    const options = vi.mocked(errorNotificationService.showInfo).mock.calls[0][2];
    await act(async () => options?.action?.onClick());
    await waitFor(() => expect(store.get(sessionRegistryAtom).get('middle')?.parentSessionId).toBe('root'));
    expect(invoke).toHaveBeenCalledWith(
      'sessions:set-parent',
      expect.objectContaining({ newParentId: 'root', restoreManagerId: 'root' })
    );
    expect(invoke.mock.calls.some(([channel]) => channel === 'sessions:create')).toBe(false);
  });
  it('rejects descendant and foreign-worktree drops, and dropping between rows adopts their parent', async () => {
    function DragRow({ id }: { id: string }) {
      const drag = useSessionTreeMove(id, '/project');
      return (
        <div
          data-testid={`drag-${id}`}
          draggable
          onDragStart={drag.onDragStart}
          onDragOver={drag.onDragOver}
          onDrop={drag.onDrop}
        >
          {id}
        </div>
      );
    }
    render(
      <Provider store={store}>
        <DragRow id="middle" />
        <DragRow id="leaf" />
        <DragRow id="target" />
        <DragRow id="foreign" />
      </Provider>
    );
    const payload = new Map<string, string>();
    const dataTransfer = {
      types: ['application/x-nimbalyst-session'],
      setData: (key: string, value: string) => payload.set(key, value),
      getData: (key: string) => payload.get(key),
      dropEffect: 'move',
      effectAllowed: 'move',
    };
    const dragEvent = (id: string, name: string, y = 20) => {
      const element = screen.getByTestId(`drag-${id}`);
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 40 } as DOMRect);
      const event = new MouseEvent(name, { bubbles: true, cancelable: true, clientY: y });
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      fireEvent(element, event);
    };
    dragEvent('middle', 'dragstart');
    dragEvent('leaf', 'dragover');
    expect(dataTransfer.dropEffect).toBe('none');
    dragEvent('foreign', 'dragover');
    expect(dataTransfer.dropEffect).toBe('none');
    expect(invoke.mock.calls.some(([channel]) => channel === 'sessions:set-parent')).toBe(false);
    dragEvent('target', 'dragstart');
    dragEvent('leaf', 'dragover', 1);
    expect(dataTransfer.dropEffect).toBe('move');
    dragEvent('leaf', 'drop', 1);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'sessions:set-parent',
        expect.objectContaining({ sessionId: 'target', newParentId: 'middle' })
      )
    );
  });
});
