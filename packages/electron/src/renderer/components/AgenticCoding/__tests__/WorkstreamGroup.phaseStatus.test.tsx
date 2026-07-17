// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore, Provider } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';
import { sessionRegistryAtom, sessionUnreadAtom } from '../../../store/atoms/sessions';
import { WorkstreamGroup } from '../WorkstreamGroup';

afterEach(cleanup);

function session(id: string, parentSessionId: string | null, title: string): SessionMeta {
  return {
    id,
    title,
    phase: 'implementing',
    provider: 'claude-code',
    sessionType: 'session',
    workspaceId: '/workspace',
    worktreeId: null,
    parentSessionId,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: Date.now() - 33 * 60_000,
    updatedAt: Date.now() - 33 * 60_000,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
  };
}

describe('WorkstreamGroup child phase/status row', () => {
  it('keeps title, phase square, compact time, and operational slot in order', () => {
    const store = createStore();
    const parent = session('parent', null, 'Parent');
    const child = session(
      'child',
      parent.id,
      'A deliberately long child session title that needs to truncate before fixed metadata',
    );
    store.set(sessionRegistryAtom, new Map([[parent.id, parent], [child.id, child]]));
    store.set(sessionUnreadAtom(child.id), true);

    const { container } = render(
      <Provider store={store}>
        <WorkstreamGroup
          type="workstream"
          id={parent.id}
          title={parent.title}
          isExpanded
          isActive={false}
          onToggle={() => {}}
          onSelect={() => {}}
          sessions={[child]}
          activeSessionId={null}
          onSessionSelect={() => {}}
        />
      </Provider>,
    );

    const row = container.querySelector('[data-testid="workstream-child-item"]');
    const title = row?.querySelector('.workstream-session-item-title');
    const square = row?.querySelector('.workstream-session-item-phase-square');
    const time = row?.querySelector('.workstream-session-item-timestamp');
    const slot = row?.querySelector('.workstream-session-item-right');

    expect(title?.nextElementSibling).toBe(square);
    expect(square?.nextElementSibling).toBe(time);
    expect(time?.nextElementSibling).toBe(slot);
    expect(title?.className).toContain('flex-1');
    expect(square?.className).toContain('shrink-0');
    expect(time?.className).toContain('shrink-0');
    expect(slot?.className).toContain('shrink-0');
    expect(time?.textContent).toBe('33 mins');
    expect(row?.getAttribute('aria-label')).toContain('Phase: Implementing.');
    expect(row?.getAttribute('aria-label')).toContain('Status: New response ready.');
    expect(row?.getAttribute('aria-label')).toContain('Updated 33 mins ago.');
  });
});
