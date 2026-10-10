// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon, className }: { icon: string; className?: string }) => (
    <span data-icon={icon} className={className} />
  ),
}));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-provider={provider} />,
  resolveProviderIcon: (provider: string) => provider,
}));
vi.mock('@nimbalyst/runtime/utils/clipboard', () => ({ copyToClipboard: vi.fn() }));

vi.mock('../../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showError: vi.fn() },
}));

vi.mock('../../../dialogs', () => ({
  dialogRef: { current: null },
  DIALOG_IDS: { SHARE: 'share' },
}));

vi.mock('../SessionRelativeTime', () => ({
  SessionRelativeTime: () => <span data-testid="relative-time" />,
}));

vi.mock('../SessionContextMenu', () => ({
  SessionContextMenu: ({
    isPinned,
    onPinToggle,
  }: {
    isPinned: boolean;
    onPinToggle?: (isPinned: boolean) => void;
  }) => (
    <button onClick={() => onPinToggle?.(!isPinned)}>
      {isPinned ? 'Unpin' : 'Pin'}
    </button>
  ),
}));

import { store, sessionRegistryAtom, type SessionMeta } from '../../../store';
import { WorkstreamGroup } from '../WorkstreamGroup';
import {
  countRegistryDescendants,
  reconcileSessionPinToggle,
  workstreamChildrenNeedRefresh,
} from '../workstreamChildPinReconciliation';

const workspacePath = 'D:/workspace';
const parentId = 'parent-session';
const targetId = 'target-child';
const siblingId = 'sibling-child';

function session(overrides: Partial<SessionMeta> & Pick<SessionMeta, 'id' | 'title'>): SessionMeta {
  const { id, title, ...rest } = overrides;
  return {
    id,
    title,
    createdAt: 100,
    updatedAt: 100,
    provider: 'claude',
    sessionType: 'session',
    messageCount: 0,
    workspaceId: workspacePath,
    isArchived: false,
    isPinned: false,
    worktreeId: null,
    parentSessionId: parentId,
    childCount: 0,
    uncommittedCount: 0,
    ...rest,
  };
}

function childRows() {
  return [...document.querySelectorAll<HTMLElement>('.session-tree-row .session-list-item')].filter(row => /Target|Sibling/.test(row.textContent || ''));
}

function childTitles() {
  return childRows().map(row => within(row).getByText(/Target|Sibling/).textContent);
}

function renderExpandedWorkstream(
  children: SessionMeta[],
  onSessionPinToggle: (sessionId: string, isPinned: boolean) => void,
  onWorkstreamPinToggle = vi.fn(),
) {
  return render(
    <WorkstreamGroup
      type="workstream"
      id={parentId}
      title="Parent"
      isExpanded
      isActive={false}
      onToggle={vi.fn()}
      onSelect={vi.fn()}
      sessions={children}
      activeSessionId={targetId}
      onSessionSelect={vi.fn()}
      onSessionPinToggle={onSessionPinToggle}
      onWorkstreamPinToggle={onWorkstreamPinToggle}
      isPinned={false}
      childCount={children.length}
      projectPath={workspacePath}
    />,
  );
}

afterEach(() => {
  cleanup();
  store.set(sessionRegistryAtom, new Map());
  vi.clearAllMocks();
});

describe('expanded workstream child pin reconciliation', () => {
  it('reconciles true -> false without refresh or removal', async () => {
    const target = session({
      id: targetId,
      title: 'Target',
      isPinned: true,
      updatedAt: 100,
    });
    const sibling = session({
      id: siblingId,
      title: 'Sibling',
      updatedAt: 200,
    });
    const parent = session({
      id: parentId,
      title: 'Parent',
      sessionType: 'workstream',
      parentSessionId: null,
      childCount: 2,
      isPinned: false,
    });
    let sessions = [parent];
    let cache = new Map([[parentId, [target, sibling]]]);
    const invoke = vi.fn().mockResolvedValue({ success: true });
    const updateSessionStore = vi.fn();
    const parentPinToggle = vi.fn();

    const onSessionPinToggle = (sessionId: string, isPinned: boolean) => {
      void reconcileSessionPinToggle({
        sessionId,
        isPinned,
        invoke,
        updateSessionStore,
        setSessions: updater => { sessions = updater(sessions); },
        setWorkstreamChildrenCache: updater => { cache = updater(cache); },
      });
    };

    const view = renderExpandedWorkstream(
      cache.get(parentId) ?? [],
      onSessionPinToggle,
      parentPinToggle,
    );

    expect(childTitles()).toEqual(['Target', 'Sibling']);


    fireEvent.contextMenu(childRows()[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('sessions:update-pinned', targetId, false);
    });
    view.rerender(
      <WorkstreamGroup
        type="workstream"
        id={parentId}
        title="Parent"
        isExpanded
        isActive={false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        sessions={cache.get(parentId) ?? []}
        activeSessionId={targetId}
        onSessionSelect={vi.fn()}
        onSessionPinToggle={onSessionPinToggle}
        onWorkstreamPinToggle={parentPinToggle}
        isPinned={sessions[0].isPinned}
        childCount={2}
        projectPath={workspacePath}
      />,
    );

    expect(childTitles()).toEqual(['Sibling', 'Target']);
    expect(childRows()[1].querySelector('[data-icon="push_pin"]')).toBeNull();
    fireEvent.contextMenu(childRows()[1]);
    screen.getByRole('button', { name: 'Pin' });
    expect(updateSessionStore).toHaveBeenCalledWith({
      sessionId: targetId,
      updates: { isPinned: false },
    });
    expect(sessions[0].isPinned).toBe(false);
    expect(parentPinToggle).not.toHaveBeenCalled();
  });

  it('reconciles false -> true without refresh or removal', async () => {
    const target = session({
      id: targetId,
      title: 'Target',
      updatedAt: 100,
    });
    const sibling = session({
      id: siblingId,
      title: 'Sibling',
      updatedAt: 200,
    });
    let cache = new Map([[parentId, [target, sibling]]]);
    const invoke = vi.fn().mockResolvedValue({ success: true });
    const updateSessionStore = vi.fn();

    const onSessionPinToggle = (sessionId: string, isPinned: boolean) => {
      void reconcileSessionPinToggle({
        sessionId,
        isPinned,
        invoke,
        updateSessionStore,
        setSessions: vi.fn(),
        setWorkstreamChildrenCache: updater => { cache = updater(cache); },
      });
    };

    const view = renderExpandedWorkstream(cache.get(parentId) ?? [], onSessionPinToggle);

    expect(childTitles()).toEqual(['Sibling', 'Target']);
    fireEvent.contextMenu(childRows()[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('sessions:update-pinned', targetId, true);
    });
    view.rerender(
      <WorkstreamGroup
        type="workstream"
        id={parentId}
        title="Parent"
        isExpanded
        isActive={false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        sessions={cache.get(parentId) ?? []}
        activeSessionId={targetId}
        onSessionSelect={vi.fn()}
        onSessionPinToggle={onSessionPinToggle}
        isPinned={false}
        childCount={2}
        projectPath={workspacePath}
      />,
    );

    expect(childTitles()).toEqual(['Target', 'Sibling']);
    expect(childRows()[0].querySelector('[data-icon="push_pin"]')).not.toBeNull();
    fireEvent.contextMenu(childRows()[0]);
    screen.getByRole('button', { name: 'Unpin' });
  });

  it('does not require a children refetch for registry-only field updates', () => {
    const cachedChildren = [
      session({ id: targetId, title: 'Target', isPinned: false }),
      session({ id: siblingId, title: 'Sibling', isPinned: false }),
    ];
    const registryAfterPin = new Map<string, SessionMeta>([
      [targetId, { ...cachedChildren[0], isPinned: true }],
      [siblingId, cachedChildren[1]],
    ]);

    expect(workstreamChildrenNeedRefresh(cachedChildren, 2, registryAfterPin)).toBe(false);
  });

  it('skips the cold-start fetch when sessions:list already loaded the whole subtree', () => {
    const registry = new Map<string, SessionMeta>([
      ['root', session({ id: 'root', title: 'root' })],
      ['a', session({ id: 'a', title: 'a', parentSessionId: 'root' })],
      ['b', session({ id: 'b', title: 'b', parentSessionId: 'a' })],
    ]);
    const counts = countRegistryDescendants(registry);
    expect(counts.get('root')).toBe(2);
    expect(workstreamChildrenNeedRefresh(undefined, 2, registry, counts.get('root'))).toBe(false);
    expect(workstreamChildrenNeedRefresh(undefined, 3, registry, counts.get('root'))).toBe(true);
  });

  it('does not refetch forever when archived children keep the fetched list shorter than childCount', () => {
    const live = [session({ id: targetId, title: 'Target' })];
    const registry = new Map<string, SessionMeta>([[targetId, live[0]]]);
    // childCount 2 includes an archived child that list-children (archived hidden) never returns.
    expect(workstreamChildrenNeedRefresh(live, 2, registry, 1, 2)).toBe(false);
    expect(workstreamChildrenNeedRefresh(live, 3, registry, 1, 2)).toBe(true);
  });
});
