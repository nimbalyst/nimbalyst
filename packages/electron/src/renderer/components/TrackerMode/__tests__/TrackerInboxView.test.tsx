// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

vi.mock('posthog-js/react', () => ({ usePostHog: () => undefined }));

import { TrackerInboxView } from '../TrackerInboxView';

const updateTrackerItem = vi.fn(async () => undefined);

function record(id: string, fields: Record<string, unknown> = {}, createdAt = '2026-07-20T00:00:00.000Z'): TrackerRecord {
  return {
    id,
    primaryType: 'bug',
    typeTags: ['bug'],
    issueKey: `NIM-${id}`,
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/w', createdAt, updatedAt: createdAt },
    fields: { title: `Item ${id}`, status: 'to-do', ...fields },
  } as TrackerRecord;
}

function renderInbox(items: TrackerRecord[], overrides: Record<string, unknown> = {}) {
  const onArchiveItems = vi.fn();
  const onScopeChange = vi.fn();
  render(
    <TrackerInboxView
      filterType="all"
      overrideItems={items}
      onArchiveItems={onArchiveItems}
      scope="global"
      onScopeChange={onScopeChange}
      currentIdentity={{ email: 'me@example.com', displayName: 'Me', gitName: null, gitEmail: null }}
      {...overrides}
    />,
  );
  return { onArchiveItems, onScopeChange };
}

describe('TrackerInboxView', () => {
  beforeAll(() => {
    loadBuiltinTrackers();
  });

  beforeEach(() => {
    updateTrackerItem.mockClear();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      documentService: { updateTrackerItem },
    };
  });

  afterEach(() => cleanup());

  it('queues only untriaged items, newest first', () => {
    renderInbox([
      record('older'),
      record('newer', {}, '2026-07-22T00:00:00.000Z'),
      record('assigned', { owner: 'someone@example.com' }),
    ]);

    const rows = screen.getAllByTestId('tracker-inbox-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Item newer');
    expect(rows[1].textContent).toContain('Item older');
  });

  it('assigns the focused item to me on "a"', () => {
    renderInbox([record('x')]);

    fireEvent.keyDown(screen.getByTestId('tracker-inbox-queue'), { key: 'a' });

    expect(updateTrackerItem).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'x',
      updates: { owner: 'me@example.com' },
    }));
  });

  it('accepts the focused item into the working status on "e"', () => {
    renderInbox([record('x')]);

    fireEvent.keyDown(screen.getByTestId('tracker-inbox-queue'), { key: 'e' });

    expect(updateTrackerItem).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'x',
      updates: { status: 'in-progress' },
    }));
  });

  it('maps the number keys to the type\'s own priority values', () => {
    renderInbox([record('x')]);

    fireEvent.keyDown(screen.getByTestId('tracker-inbox-queue'), { key: '3' });

    expect(updateTrackerItem).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'x',
      updates: { priority: 'high' },
    }));
  });

  it('dismisses by archiving, not deleting', () => {
    const { onArchiveItems } = renderInbox([record('x')]);

    fireEvent.keyDown(screen.getByTestId('tracker-inbox-queue'), { key: 'x' });

    expect(onArchiveItems).toHaveBeenCalledWith(['x'], true);
  });

  it('leaves cmd-chords to the shared row hook', () => {
    renderInbox([record('x')]);

    fireEvent.keyDown(screen.getByTestId('tracker-inbox-queue'), { key: 'a', metaKey: true });

    expect(updateTrackerItem).not.toHaveBeenCalled();
  });

  it('moves focus with j/k', () => {
    renderInbox([record('first', {}, '2026-07-22T00:00:00.000Z'), record('second')]);
    const queue = screen.getByTestId('tracker-inbox-queue');

    fireEvent.keyDown(queue, { key: 'j' });
    fireEvent.keyDown(queue, { key: 'a' });

    expect(updateTrackerItem).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'second' }));
  });

  it('shows inbox zero when nothing needs a decision', () => {
    renderInbox([record('assigned', { owner: 'someone@example.com' })]);

    expect(screen.queryAllByTestId('tracker-inbox-row')).toHaveLength(0);
    expect(screen.getByText(/Inbox zero/)).toBeTruthy();
  });

  it('marks agent-filed items as proposals', () => {
    const proposal = record('agent');
    proposal.system.createdByAgent = true;
    renderInbox([proposal, record('human')]);

    expect(screen.getAllByTestId('tracker-inbox-agent-proposal')).toHaveLength(1);
  });
});
