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

    expect(
      document.querySelector('.tracker-reference-preview-type')?.textContent,
    ).toContain('Bug');
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

    expect(container.querySelector('.tracker-reference-chip-key')?.textContent).toBe('NIM-1');
    expect(container.querySelector('.tracker-reference-chip-title')).toBeNull();
    expect(container.querySelector('.tracker-reference-chip-status')?.textContent).toContain('In Progress');
    expect(container.querySelector('.tracker-reference-chip')?.getAttribute('data-resolved')).toBe('true');
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
      ).toBe('line-through');
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
    ['in-review', 'in-review', 'In Review', 'var(--nim-info)'],
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

  it('updates the visible state treatment when the live tracker record changes', () => {
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

    act(() => {
      store.set(upsertTrackerItemAtom, {
        ...trackerRecord,
        fields: { ...trackerRecord.fields, status: 'in-progress' },
      });
    });

    expect(chip?.getAttribute('data-status')).toBe('in-progress');
    expect(chip?.getAttribute('data-status-tone')).toBe('in-progress');
    expect(
      container.querySelector('.tracker-reference-chip-status')?.textContent,
    ).toContain('In Progress');

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
