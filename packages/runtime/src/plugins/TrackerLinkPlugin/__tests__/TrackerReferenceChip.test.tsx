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
import { $getNodeByKey, $getRoot, $createParagraphNode, createEditor } from 'lexical';
import { LexicalComposerContext, createLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { globalRegistry, type PredicateDefinition } from '@nimbalyst/tracker-schema';
import { $createTrackerReferenceNode, TrackerReferenceNode, TrackerReferenceNodeDecorator } from '../TrackerReferenceNode';
import { setTrackerReferenceNodeRenderer } from '../TrackerReferenceNodeRenderer';
import { setTrackerReferenceHomeScope } from '../trackerReferenceHref';
import { trackerReferenceRelationOptions } from '../TrackerReferenceRelationMenu';
import { TrackerReferenceSourceProvider } from '../trackerReferenceSource';
import { setTrackerReferenceLinksSource } from '../trackerReferencePreviewData';

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
  it.each(['chip', 'card', 'statements'] as const)('preserves %s view through DOM copy/paste', (view) => {
    const editor = createEditor({ nodes: [TrackerReferenceNode], onError: error => { throw error; } });
    editor.update(() => {
      const relation = view === 'card' ? 'built-on' : null;
      const node = $createTrackerReferenceNode('NIM-1', view, relation);
      const dom = node.createDOM({ namespace: 'test', theme: { trackerReference: 'host-theme' } });
      expect(dom.classList.contains('host-theme')).toBe(true);
      if (view !== 'chip') expect(dom.classList.contains(`tracker-reference--${view}`)).toBe(true);
      const exported = node.exportDOM().element as HTMLElement;
      const conversion = TrackerReferenceNode.importDOM()!.span(exported)!;
      const restored = conversion.conversion(exported)!.node as TrackerReferenceNode;
      expect(restored.getView()).toBe(view);
      expect(restored.getRelation()).toBe(relation);
      expect(restored.getReferenceKey()).toBe('NIM-1');
      expect(node.isInline()).toBe(true);
      expect(node.updateDOM(restored)).toBe(false);
      const other = $createTrackerReferenceNode('NIM-1', view === 'chip' ? 'card' : 'chip');
      expect(node.updateDOM(other)).toBe(true);
    }, { discrete: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers the relations allowed for the page pair and stores the chosen one on the node', async () => {
    const predicates: PredicateDefinition[] = [
      { id: 'fixes', label: 'fixes', inverseLabel: 'fixed by', subjectKinds: ['module'], objectKinds: ['bug'], valueShape: 'entity', direction: 'directed' },
      { id: 'built-on', label: 'built on', subjectKinds: ['module'], objectKinds: ['technology'], valueShape: 'entity', direction: 'directed' },
      { id: 'cost', label: 'cost', subjectKinds: ['*'], valueShape: 'quantity', direction: 'directed' },
    ];
    // The registry wiring resolves both kinds through `extends`.
    const fakeRegistry = {
      getAllPredicates: () => predicates,
      getPredicate: (id: string) => predicates.find(p => p.id === id),
      get: (type: string) => (type === 'service' ? { extends: 'module' } : undefined),
    };
    expect(trackerReferenceRelationOptions(fakeRegistry, 'service', 'bug').map(o => o.predicateId)).toEqual(['fixes']);

    const previous = globalRegistry.getAllPredicates();
    globalRegistry.setPredicates(predicates);
    try {
      const editor = createEditor({ nodes: [TrackerReferenceNode], onError: error => { throw error; } });
      let nodeKey = '';
      editor.update(() => {
        const node = $createTrackerReferenceNode('NIM-1');
        $getRoot().append($createParagraphNode().append(node));
        nodeKey = node.getKey();
      }, { discrete: true });
      const store = createStore();
      store.set(trackerItemsMapAtom, new Map([[trackerRecord.id, trackerRecord]]));
      const chip = (relation: string | null) => (
        <Provider store={store}>
          <LexicalComposerContext.Provider value={[editor, createLexicalComposerContext(null, null)]}>
            <TrackerReferenceSourceProvider value={{ itemId: 'mod_1', type: 'module' }}>
              <TrackerReferenceChip referenceKey="NIM-1" nodeKey={nodeKey} relation={relation} />
            </TrackerReferenceSourceProvider>
          </LexicalComposerContext.Provider>
        </Provider>
      );
      const { container, rerender } = render(chip(null));
      fireEvent.click(container.querySelector<HTMLElement>('.tracker-reference-chip')!);

      const radios = screen.getAllByRole('radio');
      expect(radios.map(r => r.getAttribute('data-relation'))).toEqual(['fixes', '']);
      expect(radios[1].getAttribute('aria-checked')).toBe('true');
      await act(async () => {
        fireEvent.click(radios[0]);
      });
      expect(editor.getEditorState().read(() => ($getNodeByKey(nodeKey) as TrackerReferenceNode).getRelation())).toBe('fixes');

      // Read-only: the stored relation shows, with no choice.
      editor.setEditable(false);
      rerender(chip('fixes'));
      expect(screen.queryAllByRole('radio')).toHaveLength(0);
      expect(document.querySelector('.tracker-reference-relation')?.textContent).toBe('Linked as fixes');
    } finally {
      globalRegistry.setPredicates(previous);
    }
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

  it('offers host navigation for an unresolved reference', () => {
    const store = createStore();
    const onNavigate = vi.fn();
    const { container } = render(
      <Provider store={store}>
        <TrackerReferenceChip
          referenceKey="plan_42"
          unresolvedLabel="Plan"
          onNavigate={onNavigate}
        />
      </Provider>,
    );

    expect(container.querySelector('.tracker-reference-chip')?.textContent)
      .toBe('Plan');
    fireEvent.click(container.querySelector<HTMLElement>('.tracker-reference-chip')!);
    fireEvent.click(screen.getByRole('button', { name: 'Go to item' }));

    expect(onNavigate).toHaveBeenCalledWith(null);
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

  it('says what the item is and what it connects to in the preview', async () => {
    globalRegistry.register({
      type: 'preview-competitor', displayName: 'Competitor', displayNamePlural: 'Competitors', icon: 'target', color: '#336699',
      modes: { inline: false, fullDocument: true }, idPrefix: 'c', idFormat: 'ulid',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'status', type: 'select', options: [{ value: 'active', label: 'Active' }] },
        { name: 'summary', type: 'text' },
        { name: 'segment', type: 'select', options: [{ value: 'dev-tools', label: 'Developer tools' }] },
        { name: 'website', type: 'url' },
        { name: 'notes', type: 'string' },
        { name: 'rivals', type: 'relationship' },
      ],
    } as unknown as Parameters<typeof globalRegistry.register>[0]);
    const store = createStore();
    const record: TrackerRecord = {
      ...trackerRecord,
      issueKey: undefined,
      primaryType: 'preview-competitor',
      typeTags: ['preview-competitor'],
      fields: {
        title: 'Omnigent',
        status: 'active',
        summary: '## Overview\n\n- Runs **heterogeneous** agent [runtimes](https://example.com) under one policy.\n\nSecond paragraph.',
        segment: 'dev-tools',
        website: 'https://www.omnigent.example/pricing',
        rivals: [{ itemId: 'x' }],
      },
    };
    store.set(trackerItemsMapAtom, new Map([[record.id, record]]));
    const linkGroupsFor = vi.fn(async () => [
      { label: 'Mentioned in', items: [{ itemId: 'page_1', title: 'Positioning', typeId: 'entity' }] },
      { label: 'Blocks', items: [] },
    ]);
    setTrackerReferenceLinksSource({ linkGroupsFor });
    const navigate = vi.fn();
    window.addEventListener('nimbalyst:navigate-tracker-item', navigate);

    try {
      render(
        <Provider store={store}>
          <TrackerReferenceChip referenceKey="bug_1" />
        </Provider>,
      );
      fireEvent.click(screen.getByText('Omnigent'));

      // The gist skips the heading and drops the markdown.
      expect(document.querySelector('.tracker-reference-preview-excerpt')?.textContent)
        .toBe('Runs heterogeneous agent runtimes under one policy.');
      // Status is already on the card, the summary is the excerpt, links are
      // Connections, and an empty field says nothing.
      expect(Array.from(document.querySelectorAll('.tracker-reference-preview-fields > span'), el => el.textContent))
        .toEqual(['Segment', 'Developer tools', 'Website', 'omnigent.example']);
      const link = await screen.findByRole('button', { name: 'Positioning' });
      expect(linkGroupsFor).toHaveBeenCalledWith('bug_1', 'preview-competitor');
      expect(document.querySelector('.tracker-reference-preview-links')?.textContent).not.toContain('Blocks');

      fireEvent.click(link);
      expect((navigate.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ itemId: 'page_1', fromPage: true });
      expect(document.querySelector('.tracker-reference-preview')).toBeNull();
    } finally {
      globalRegistry.unregister('preview-competitor');
      setTrackerReferenceLinksSource(null);
      window.removeEventListener('nimbalyst:navigate-tracker-item', navigate);
    }
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
    // The name carries the weight; the key is secondary.
    expect(key?.style.color).toBe('var(--nim-text-muted)');
    expect(key?.style.fontWeight).toBe('400');
    expect(title?.textContent).toBe('Theme-safe tracker preview');
    expect(title?.style.color).toBe('var(--nim-text)');
    expect(title?.style.fontWeight).toBe('600');
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

  it.each(['default', 'compact'] as const)(
    'never shows the raw item id inline for a type without a key prefix (%s)',
    variant => {
      const keyless: TrackerRecord = {
        ...trackerRecord,
        id: 'competitor_1787921177066_w5a0b2',
        issueKey: undefined,
        primaryType: 'competitor',
        typeTags: ['competitor'],
        fields: { title: 'Reddit', status: 'active' },
      };
      const store = createStore();
      store.set(trackerItemsMapAtom, new Map([[keyless.id, keyless]]));

      const { container } = render(
        <Provider store={store}>
          <TrackerReferenceChip referenceKey={keyless.id} variant={variant} />
        </Provider>,
      );

      const chip = container.querySelector<HTMLElement>('.tracker-reference-chip');
      expect(chip?.textContent).not.toContain(keyless.id);
      expect(container.querySelector('.tracker-reference-chip-key')).toBeNull();
      expect(container.querySelector('.tracker-reference-chip-title')?.textContent).toBe('Reddit');
      expect(chip?.getAttribute('title')).toContain(keyless.id);
    },
  );

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
    // Muted, not red. Rejected is `cancelled` -- work nobody is doing, which
    // asks nothing of the reader. Red is for blocked: something wrong that
    // wants attention. They were the same colour while the tone table guessed
    // from status names.
    expect(
      container.querySelector<HTMLElement>('.tracker-reference-chip-status')
        ?.style.color,
    ).toBe('var(--nim-text-muted)');
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

describe('a reference to another project', () => {
  const OTHER = 'https://console.nimbalyst.com/org/org-1/project/elsewhere/trackers/item/NIM-1';
  const HOME = 'https://console.nimbalyst.com/org/org-1/project/home/trackers/item/NIM-1';
  afterEach(() => {
    setTrackerReferenceNodeRenderer(undefined);
    setTrackerReferenceHomeScope(undefined);
  });

  function renderReference(href: string | null): void {
    const editor = createEditor({ nodes: [TrackerReferenceNode], onError: error => { throw error; } });
    let element: React.ReactNode = null;
    editor.update(() => {
      const node = $createTrackerReferenceNode('NIM-1', 'chip', null, href);
      $getRoot().append($createParagraphNode().append(node));
      element = TrackerReferenceNodeDecorator.decorate(node, editor, { namespace: 'test', theme: {} });
    }, { discrete: true });
    render(<>{element}</>);
  }

  it('is never resolved against this project; it shows as an external link to its own console page', () => {
    setTrackerReferenceNodeRenderer(({ referenceKey }) => <span data-testid="local-chip">{referenceKey}</span>);
    setTrackerReferenceHomeScope({ orgId: 'org-1', projectId: 'home' });

    renderReference(OTHER);
    expect(screen.queryByTestId('local-chip')).toBeNull();
    const external = screen.getByTestId('tracker-reference-external');
    expect(external.getAttribute('href')).toBe(OTHER);
    expect(external.textContent).toContain('NIM-1');
  });

  it('resolves this project\'s links, local links and nimbalyst:// links as before', () => {
    setTrackerReferenceNodeRenderer(({ referenceKey }) => <span data-testid="local-chip">{referenceKey}</span>);
    setTrackerReferenceHomeScope({ orgId: 'org-1', projectId: 'home' });
    renderReference(HOME);
    renderReference('https://console.nimbalyst.com/app/item/NIM-1');
    renderReference(null);
    expect(screen.getAllByTestId('local-chip')).toHaveLength(3);
    expect(screen.queryByTestId('tracker-reference-external')).toBeNull();
  });
});
