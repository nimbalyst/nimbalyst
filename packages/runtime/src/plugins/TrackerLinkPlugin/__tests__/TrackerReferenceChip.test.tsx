import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TrackerRecord } from '../../../core/TrackerRecord';
import {
  trackerItemsMapAtom,
  upsertTrackerItemAtom,
} from '../../TrackerPlugin/trackerDataAtoms';
import { TrackerReferenceChip } from '../TrackerReferenceChip';

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
  fields: {
    title: 'Theme-safe tracker preview',
    status: 'in-progress',
    priority: 'medium',
    owner: 'Morgan Reed',
  },
};

describe('TrackerReferenceChip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses canonical theme tokens for the shared chip and preview', () => {
    const store = createStore();
    store.set(
      trackerItemsMapAtom,
      new Map([[trackerRecord.id, trackerRecord]]),
    );

    const { container } = render(
      <Provider store={store}>
        <TrackerReferenceChip referenceKey="NIM-1" />
      </Provider>,
    );

    const chip = container.querySelector<HTMLElement>(
      '.tracker-reference-chip',
    );
    expect(chip?.style.background).toBe('var(--nim-bg-secondary)');
    expect(chip?.style.border).toContain('var(--nim-border)');

    fireEvent.click(screen.getByText('NIM-1'));

    const preview = document.querySelector<HTMLElement>(
      '.tracker-reference-preview > div',
    );
    expect(preview?.style.background).toBe('var(--nim-bg)');
    expect(preview?.style.color).toBe('var(--nim-text)');
    expect(preview?.style.border).toContain('var(--nim-border)');

    const button = screen.getByRole('button', { name: 'Go to item' });
    expect(button.style.background).toBe('var(--nim-bg-secondary)');
    expect(button.style.color).toBe('var(--nim-text)');
  });

  it('keeps the preview open when the transcript remounts the chip', () => {
    const store = createStore();
    store.set(
      trackerItemsMapAtom,
      new Map([[trackerRecord.id, trackerRecord]]),
    );

    const renderChip = (key: string) => (
      <Provider store={store}>
        <div className="rich-transcript-message">
          <TrackerReferenceChip
            key={key}
            referenceKey="NIM-1"
            previewStateKey="message-1:tracker-0"
          />
        </div>
      </Provider>
    );
    const { container, rerender } = render(renderChip('first'));

    fireEvent.click(
      container.querySelector<HTMLElement>('.tracker-reference-chip')!,
    );
    expect(document.querySelector('.tracker-reference-preview')).not.toBeNull();

    rerender(renderChip('replacement'));

    expect(document.querySelector('.tracker-reference-preview')).not.toBeNull();
    expect(
      container
        .querySelector('.tracker-reference-chip')
        ?.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('presents type, status, priority, and the last update as distinct metadata', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'));
    const store = createStore();
    store.set(
      trackerItemsMapAtom,
      new Map([[trackerRecord.id, trackerRecord]]),
    );

    const { container } = render(
      <Provider store={store}>
        <TrackerReferenceChip referenceKey="NIM-1" />
      </Provider>,
    );

    fireEvent.click(screen.getByText('NIM-1'));

    const previewHeader = document.querySelector(
      '.tracker-reference-preview-header',
    );
    expect(
      Array.from(previewHeader?.children ?? []).map(child => child.className),
    ).toEqual([
      'tracker-reference-preview-type',
      'tracker-reference-preview-key',
    ]);
    expect(
      document.querySelector('.tracker-reference-preview-type')?.textContent,
    ).toContain('Bug');
    expect(
      document.querySelector(
        '.tracker-reference-preview-badges .tracker-reference-preview-type',
      ),
    ).toBeNull();
    expect(
      document.querySelector('.tracker-reference-preview-status')?.textContent,
    ).toContain('In Progress');
    expect(
      document.querySelector('.tracker-reference-preview-priority')
        ?.textContent,
    ).toContain('Medium priority');
    expect(
      document.querySelector('.tracker-reference-preview-updated')?.textContent,
    ).toContain('Updated Yesterday');
    expect(
      container
        .querySelector('.tracker-reference-chip')
        ?.getAttribute('data-resolved'),
    ).toBe('true');
  });

  it('renders the five-part inline anatomy in the designed order', () => {
    const store = createStore();
    store.set(
      trackerItemsMapAtom,
      new Map([[trackerRecord.id, trackerRecord]]),
    );

    const { container } = render(
      <Provider store={store}>
        <TrackerReferenceChip referenceKey="NIM-1" />
      </Provider>,
    );

    const chip = container.querySelector<HTMLElement>(
      '.tracker-reference-chip',
    );
    const typeIcon = container.querySelector<HTMLElement>(
      '.tracker-reference-chip-type-icon',
    );
    const key = container.querySelector<HTMLElement>(
      '.tracker-reference-chip-key',
    );
    const title = container.querySelector<HTMLElement>(
      '.tracker-reference-chip-title',
    );
    const status = container.querySelector<HTMLElement>(
      '.tracker-reference-chip-status',
    );
    const owner = container.querySelector<HTMLElement>(
      '.tracker-reference-chip-owner',
    );

    expect(
      Array.from(chip?.children ?? []).map(child => child.className),
    ).toEqual([
      'material-symbols-outlined tracker-reference-chip-type-icon',
      'tracker-reference-chip-key',
      'tracker-reference-chip-title',
      'tracker-reference-chip-status',
      'tracker-reference-chip-owner',
    ]);
    expect(typeIcon?.textContent).toBe('bug_report');
    expect(typeIcon?.style.color).toBe('rgb(220, 38, 38)');
    expect(key?.textContent).toBe('NIM-1');
    expect(key?.style.color).toBe('var(--nim-text)');
    expect(title?.textContent).toBe('Theme-safe tracker preview');
    expect(title?.style.color).toBe('var(--nim-text-muted)');
    expect(title?.style.overflow).toBe('hidden');
    expect(title?.style.textOverflow).toBe('ellipsis');
    expect(status?.textContent).toContain('In Progress');
    expect(status?.style.color).toBe('var(--nim-warning)');
    expect(owner?.textContent).toBe('MR');
    expect(owner?.style.background).toBe('var(--nim-bg-tertiary)');
    expect(owner?.style.color).toBe('var(--nim-text-muted)');
  });

  it('supports a compact extension-editor variant without losing live resolution', () => {
    const store = createStore();
    store.set(
      trackerItemsMapAtom,
      new Map([[trackerRecord.id, trackerRecord]]),
    );

    const { container } = render(
      <Provider store={store}>
        <TrackerReferenceChip referenceKey="NIM-1" variant="compact" />
      </Provider>,
    );

    expect(
      container.querySelector('.tracker-reference-chip-key')?.textContent,
    ).toBe('NIM-1');
    expect(container.querySelector('.tracker-reference-chip-title')).toBeNull();
    expect(
      container.querySelector('.tracker-reference-chip-status')?.textContent,
    ).toContain('In Progress');
    expect(
      container
        .querySelector('.tracker-reference-chip')
        ?.getAttribute('data-resolved'),
    ).toBe('true');
  });

  it.each(['done', 'completed', 'implemented', 'decided'])(
    'makes the %s state unmistakably complete',
    status => {
      const store = createStore();
      store.set(
        trackerItemsMapAtom,
        new Map([
          [
            trackerRecord.id,
            {
              ...trackerRecord,
              fields: { ...trackerRecord.fields, status },
            },
          ],
        ]),
      );

      const { container } = render(
        <Provider store={store}>
          <TrackerReferenceChip referenceKey="NIM-1" />
        </Provider>,
      );

      const chip = container.querySelector<HTMLElement>(
        '.tracker-reference-chip',
      );
      expect(chip?.getAttribute('data-status')).toBe(status);
      expect(chip?.getAttribute('data-status-tone')).toBe('completed');
      expect(chip?.getAttribute('data-completed')).toBe('true');
      expect(
        container.querySelector<HTMLElement>('.tracker-reference-chip-status')
          ?.style.color,
      ).toBe('var(--nim-success)');
      expect(
        container.querySelector('.tracker-reference-chip-status')?.textContent,
      ).toContain(status.charAt(0).toUpperCase() + status.slice(1));
      expect(
        container.querySelector<HTMLElement>('.tracker-reference-chip-key')
          ?.style.textDecoration,
      ).toBe('');
      expect(
        container.querySelector<HTMLElement>('.tracker-reference-chip-title')
          ?.style.textDecoration,
      ).toBe('line-through');
    },
  );

  it('does not present unsuccessful terminal states as completed', () => {
    const store = createStore();
    store.set(
      trackerItemsMapAtom,
      new Map([
        [
          trackerRecord.id,
          {
            ...trackerRecord,
            fields: { ...trackerRecord.fields, status: 'rejected' },
          },
        ],
      ]),
    );

    const { container } = render(
      <Provider store={store}>
        <TrackerReferenceChip referenceKey="NIM-1" />
      </Provider>,
    );

    const chip = container.querySelector<HTMLElement>(
      '.tracker-reference-chip',
    );
    expect(chip?.getAttribute('data-completed')).toBe('false');
    expect(
      container.querySelector<HTMLElement>('.tracker-reference-chip-status')
        ?.style.color,
    ).toBe('var(--nim-error)');
    expect(
      container.querySelector<HTMLElement>('.tracker-reference-chip-title')
        ?.style.textDecoration,
    ).toBe('');
  });

  it.each([
    ['to-do', 'to-do', 'To Do', 'var(--nim-text-muted)'],
    ['in-progress', 'in-progress', 'In Progress', 'var(--nim-warning)'],
    ['in-review', 'in-review', 'In Review', 'var(--nim-purple)'],
    ['blocked', 'blocked', 'Blocked', 'var(--nim-error)'],
    ['custom-status', 'neutral', 'Custom Status', 'var(--nim-text-muted)'],
  ])(
    'makes the %s state readable without relying on color alone',
    (status, tone, label, color) => {
      const store = createStore();
      store.set(
        trackerItemsMapAtom,
        new Map([
          [
            trackerRecord.id,
            {
              ...trackerRecord,
              fields: { ...trackerRecord.fields, status },
            },
          ],
        ]),
      );

      const { container } = render(
        <Provider store={store}>
          <TrackerReferenceChip referenceKey="NIM-1" />
        </Provider>,
      );

      const chip = container.querySelector<HTMLElement>(
        '.tracker-reference-chip',
      );
      const statusBadge = container.querySelector<HTMLElement>(
        '.tracker-reference-chip-status',
      );
      expect(chip?.getAttribute('data-status-tone')).toBe(tone);
      expect(statusBadge?.textContent).toContain(label);
      expect(statusBadge?.style.color).toBe(color);
    },
  );

  it('updates state, title, and owner when the live tracker record changes', () => {
    const store = createStore();
    store.set(
      trackerItemsMapAtom,
      new Map([
        [
          trackerRecord.id,
          {
            ...trackerRecord,
            fields: { ...trackerRecord.fields, status: 'to-do' },
          },
        ],
      ]),
    );

    const { container } = render(
      <Provider store={store}>
        <TrackerReferenceChip referenceKey="NIM-1" />
      </Provider>,
    );

    const chip = container.querySelector<HTMLElement>(
      '.tracker-reference-chip',
    );
    expect(chip?.getAttribute('data-status')).toBe('to-do');
    expect(
      container.querySelector('.tracker-reference-chip-status')?.textContent,
    ).toContain('To Do');
    expect(
      container.querySelector('.tracker-reference-chip-title')?.textContent,
    ).toBe('Theme-safe tracker preview');
    expect(
      container.querySelector('.tracker-reference-chip-owner')?.textContent,
    ).toBe('MR');

    act(() => {
      store.set(upsertTrackerItemAtom, {
        ...trackerRecord,
        fields: {
          ...trackerRecord.fields,
          title: 'Updated live title',
          status: 'in-progress',
          owner: 'Alex Kim',
        },
      });
    });

    expect(chip?.getAttribute('data-status')).toBe('in-progress');
    expect(chip?.getAttribute('data-status-tone')).toBe('in-progress');
    expect(
      container.querySelector('.tracker-reference-chip-status')?.textContent,
    ).toContain('In Progress');
    expect(
      container.querySelector('.tracker-reference-chip-title')?.textContent,
    ).toBe('Updated live title');
    expect(
      container.querySelector('.tracker-reference-chip-owner')?.textContent,
    ).toBe('AK');

    act(() => {
      store.set(upsertTrackerItemAtom, {
        ...trackerRecord,
        fields: { ...trackerRecord.fields, status: 'done' },
      });
    });

    expect(chip?.getAttribute('data-status')).toBe('done');
    expect(chip?.getAttribute('data-completed')).toBe('true');
    expect(
      container.querySelector<HTMLElement>('.tracker-reference-chip-title')
        ?.style.textDecoration,
    ).toBe('line-through');
  });
});
