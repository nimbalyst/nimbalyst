/**
 * End-to-end wiring of the tracker-key and session-UUID autolinkers through the
 * full MarkdownRenderer react-markdown pipeline (rehype plugin -> `a` override
 * -> reference chip).
 */

import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as rtl from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { trackerItemsMapAtom } from '../../../../plugins/TrackerPlugin/trackerDataAtoms';
import { sessionRefMapAtom } from '../../session/sessionRefAtoms';
import { MarkdownRenderer } from '../MarkdownRenderer';

const { render, screen, fireEvent, cleanup } = rtl;

const SESSION = '72989f55-3c63-48e3-9abc-0123456789ab';

const trackerRecord: TrackerRecord = {
  id: 'bug_1',
  issueKey: 'NIM-1',
  primaryType: 'bug',
  typeTags: ['bug'],
  source: 'native',
  archived: false,
  syncStatus: 'synced',
  system: {
    workspace: '/workspace',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  },
  fields: { title: 'Autolinked bug', status: 'in-progress', priority: 'medium' },
};

function renderWith(content: string) {
  const store = createStore();
  store.set(trackerItemsMapAtom, new Map([[trackerRecord.id, trackerRecord]]));
  store.set(
    sessionRefMapAtom,
    new Map([[SESSION, { id: SESSION, title: 'Child session', phase: 'implementing' }]]),
  );
  return render(
    <Provider store={store}>
      <MarkdownRenderer content={content} />
    </Provider>,
  );
}

describe('MarkdownRenderer reference autolinking', () => {
  afterEach(() => cleanup());

  it('autolinks a bare tracker key into a live chip', () => {
    const { container } = renderWith('This is fixed by NIM-1 today.');
    const chip = container.querySelector('.tracker-reference-chip');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('data-issue-key')).toBe('NIM-1');
    // Resolves the live title from the seeded record.
    expect(screen.getByText('Autolinked bug')).toBeDefined();
  });

  it('does not autolink a token whose prefix is not a workspace tracker prefix', () => {
    const { container } = renderWith('Encoding is UTF-8 here.');
    expect(container.querySelector('.tracker-reference-chip')).toBeNull();
  });

  it('autolinks a bare known session UUID into a session chip that opens on click', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const { container } = renderWith(`spawned ${SESSION} for the work`);
    const chip = container.querySelector<HTMLElement>('.session-reference-chip');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('data-session-id')).toBe(SESSION);
    expect(screen.getByText('Child session')).toBeDefined();

    fireEvent.click(chip!);
    const openEvent = dispatchSpy.mock.calls
      .map((c) => c[0] as Event)
      .find((e) => e.type === 'open-ai-session') as CustomEvent | undefined;
    expect(openEvent?.detail.sessionId).toBe(SESSION);
    dispatchSpy.mockRestore();
  });
});
