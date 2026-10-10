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

// Pass-through spy: counts markdown parses without changing the output.
const markdownParses = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-markdown')>();
  const Counted = (props: any) => {
    markdownParses.count++;
    return actual.default(props);
  };
  return { ...actual, default: Counted };
});

const { render, screen, fireEvent, cleanup } = rtl;

const SESSION = '72989f55-3c63-48e3-9abc-0123456789ab';

const trackerRecord: TrackerRecord = {
  id: 'bug_1',
  issueKey: 'NIM-123',
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
  const result = render(
    <Provider store={store}>
      <MarkdownRenderer content={content} />
    </Provider>,
  );
  return { ...result, store };
}

describe('MarkdownRenderer reference autolinking', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('autolinks a bare tracker key into a live chip', () => {
    const { container } = renderWith('This is fixed by NIM-123 today.');
    const chip = container.querySelector('.tracker-reference-chip');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('data-issue-key')).toBe('NIM-123');
    // Resolves the live title from the seeded record.
    expect(screen.getByText('Autolinked bug')).toBeDefined();
  });

  it('keeps a tracker card open through a transcript markdown rerender', () => {
    const store = createStore();
    store.set(
      trackerItemsMapAtom,
      new Map([[trackerRecord.id, trackerRecord]]),
    );
    const renderMessage = () => (
      <Provider store={store}>
        <div className="rich-transcript-message">
          <MarkdownRenderer
            content="See [NIM-123](nimbalyst://NIM-123)."
            messageId="message-1"
          />
        </div>
      </Provider>
    );
    const { container, rerender } = render(renderMessage());

    fireEvent.click(
      container.querySelector<HTMLElement>('.tracker-reference-chip')!,
    );
    expect(document.querySelector('.tracker-reference-preview')).not.toBeNull();

    rerender(renderMessage());

    expect(document.querySelector('.tracker-reference-preview')).not.toBeNull();
    expect(
      container
        .querySelector('.tracker-reference-chip')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  // A streaming session rewrites the session and tracker maps constantly. The
  // rendered markdown must update in place: a remount repaints every message
  // in the transcript (the visible flashing).
  it('keeps rendered markdown DOM nodes when session and tracker maps change', () => {
    const { container, store } = renderWith(
      `Intro paragraph for ${SESSION}.\n\n- item\n\n\`\`\`ts\nconst a = 1;\nconst b = 2;\n\`\`\``,
    );
    const paragraph = container.querySelector('p');
    const listItem = container.querySelector('li');
    const codeBlock = container.querySelector('pre, .markdown-content code');
    expect(paragraph).not.toBeNull();

    rtl.act(() => {
      // Same ids, new identities: must not reach the renderer at all.
      store.set(trackerItemsMapAtom, new Map([[trackerRecord.id, { ...trackerRecord }]]));
      store.set(sessionRefMapAtom, new Map([[SESSION, { id: SESSION, title: 'Renamed', phase: 'implementing' }]]));
    });
    rtl.act(() => {
      // A new known session id legitimately re-renders; nodes still survive.
      const other = '11111111-2222-4333-8444-555555555555';
      store.set(sessionRefMapAtom, new Map([
        [SESSION, { id: SESSION, title: 'Renamed' }],
        [other, { id: other, title: 'Other' }],
      ]));
    });

    expect(container.querySelector('p')).toBe(paragraph);
    expect(container.querySelector('li')).toBe(listItem);
    expect(container.querySelector('pre, .markdown-content code')).toBe(codeBlock);
    expect(screen.getByText('Renamed')).toBeDefined();
  });

  // Every new message re-renders the transcript rows; re-parsing each visible
  // message's unchanged markdown cost ~60-120ms per streamed message.
  it('does not re-parse unchanged markdown when its parent re-renders', () => {
    const onOpenFile = vi.fn();
    const renderMessage = (tick: number) => (
      <div data-tick={tick}>
        <MarkdownRenderer content="Some **bold** text." messageId="m1" onOpenFile={onOpenFile} />
      </div>
    );
    const { rerender } = render(renderMessage(0));
    const parsesAfterMount = markdownParses.count;

    rerender(renderMessage(1));
    rerender(renderMessage(2));
    expect(markdownParses.count).toBe(parsesAfterMount);

    rerender(
      <div data-tick={3}>
        <MarkdownRenderer content="Changed text." messageId="m1" onOpenFile={onOpenFile} />
      </div>,
    );
    expect(markdownParses.count).toBe(parsesAfterMount + 1);
    expect(screen.getByText('Changed text.')).toBeDefined();
  });

  it('does not autolink a token whose prefix is not a workspace tracker prefix', () => {
    const { container } = renderWith('Encoding is UTF-8 here.');
    expect(container.querySelector('.tracker-reference-chip')).toBeNull();
  });

  it('dispatches an app-action link instead of rendering a tracker chip', () => {
    const send = vi.fn();
    vi.stubGlobal('electronAPI', { send });

    const { container } = renderWith(
      '[Open projects](nimbalyst://action/open-project-manager)',
    );

    expect(container.querySelector('.tracker-reference-chip')).toBeNull();
    const link = screen.getByRole('link', { name: 'Open projects' });
    expect(link.getAttribute('target')).toBeNull();

    fireEvent.click(link);

    expect(send).toHaveBeenCalledWith(
      'app-action:dispatch',
      'nimbalyst://action/open-project-manager',
    );
  });

  it('keeps an unknown app action inert instead of opening it externally', () => {
    const send = vi.fn();
    const open = vi.spyOn(window, 'open');
    vi.stubGlobal('electronAPI', { send });
    renderWith('[Unknown](nimbalyst://action/not-allowed)');

    const link = screen.getByRole('link', { name: 'Unknown' });
    expect(fireEvent.click(link)).toBe(false);
    expect(send).toHaveBeenCalledWith(
      'app-action:dispatch',
      'nimbalyst://action/not-allowed',
    );
    expect(open).not.toHaveBeenCalled();
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
