import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LexicalEditor, ParagraphNode } from 'lexical';
import { $createNodeSelection, $createParagraphNode, $getRoot, $setSelection } from 'lexical';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  $createTrackerReferenceNode,
  TrackerReferenceNode,
} from '@nimbalyst/runtime/plugins/TrackerLinkPlugin/TrackerReferenceNode';
import { setTrackerReferenceNodeRenderer } from '@nimbalyst/runtime/plugins/TrackerLinkPlugin/TrackerReferenceNodeRenderer';

import { createTrackerReferenceResolver } from '../trackerReferenceResolver';
import { TrackerReferenceResolverProvider } from '../TrackerReferenceResolverContext';
import { LiveTrackerReferenceRenderer } from '../TrackerReferenceViews';
import { TrackerReferenceInlineAppearanceContext } from '../TrackerReferenceQuietLink';
import { fakeDataSource, fakeSchema, item } from './referenceFixtures';

afterEach(cleanup);

describe('LiveTrackerReferenceRenderer', () => {
  it('renders quiet inline references as the full title, keeps the key for the peek, and strikes a missing key', async () => {
    const fake = fakeDataSource();
    const resolver = createTrackerReferenceResolver(fake.source, { schema: fakeSchema() });
    const longTitle = 'How do we differentiate from each competitor on the team workspace?';
    const question = item({ id: 'q-1', issueKey: 'KB-37', type: 'question', title: longTitle, status: 'open' });
    const gateway = item({
      id: 'ent-gateway', issueKey: 'KB-1', type: 'entity', title: 'API gateway', status: 'active',
      customFields: { summary: 'Routes every public request. Owned by platform.' },
    });

    const { container } = render(
      <TrackerReferenceResolverProvider resolver={resolver}>
        <TrackerReferenceInlineAppearanceContext.Provider value="quiet">
          <LiveTrackerReferenceRenderer referenceKey="KB-37" nodeKey="n1" view="chip" />
          <LiveTrackerReferenceRenderer referenceKey="KB-1" nodeKey="n2" view="chip" />
          <LiveTrackerReferenceRenderer referenceKey="KB-99" nodeKey="n3" view="chip" />
          <LiveTrackerReferenceRenderer referenceKey="KB-1" nodeKey="n4" view="card" />
        </TrackerReferenceInlineAppearanceContext.Provider>
      </TrackerReferenceResolverProvider>,
    );
    await act(() => fake.release([question, gateway]));

    const links = [...container.querySelectorAll('.tracker-reference-quiet')];
    expect(links.map((link) => [link.textContent, link.getAttribute('data-type'), link.getAttribute('data-state')])).toEqual([
      [longTitle, 'question', null],
      ['API gateway', 'entity', null],
      ['KB-99', null, 'missing'],
    ]);
    // Block views are not prose; the card keeps its own presentation.
    expect(container.querySelector('.tracker-reference-card')).not.toBeNull();

    act(() => { fireEvent.focus(links[1]); });
    // The peek module loads lazily on first focus or hover.
    const peek = await waitFor(() => {
      const element = document.querySelector('.tracker-reference-peek');
      expect(element).not.toBeNull();
      return element;
    });
    expect(peek?.textContent).toContain('KB-1');
    expect(peek?.textContent).toContain('Routes every public request.');
    expect(peek?.textContent).not.toContain('Owned by platform');
  });

  it('never shows a keyless item\'s raw id inline in the chip appearance', async () => {
    const fake = fakeDataSource();
    const resolver = createTrackerReferenceResolver(fake.source, { schema: fakeSchema() });
    const competitor = item({ id: 'competitor_1787921177066_w5a0b2', type: 'entity', title: 'Reddit', status: 'active' });
    const keyed = item({ id: 'ent-gateway', issueKey: 'KB-1', type: 'entity', title: 'API gateway', status: 'active' });

    const { container } = render(
      <TrackerReferenceResolverProvider resolver={resolver}>
        <LiveTrackerReferenceRenderer referenceKey={competitor.id} nodeKey="n1" view="chip" />
        <LiveTrackerReferenceRenderer referenceKey="KB-1" nodeKey="n2" view="chip" />
      </TrackerReferenceResolverProvider>,
    );
    await act(() => fake.release([competitor, keyed]));

    const chips = [...container.querySelectorAll('.tracker-reference-live-chip')];
    const parts = (chip: Element) =>
      [...chip.querySelectorAll('.tracker-reference-live-chip-key, .tracker-reference-live-chip-title')].map((el) => el.textContent);
    expect(chips.map(parts)).toEqual([['Reddit'], ['KB-1', 'API gateway']]);
    expect(chips[0].textContent).not.toContain(competitor.id);
    expect(chips[0].getAttribute('title')).toContain(competitor.id);
  });

  it('renders a card from live resolver data and follows item changes', async () => {
    const fake = fakeDataSource();
    const onOpenItem = vi.fn();
    const resolver = createTrackerReferenceResolver(fake.source, { schema: fakeSchema(), onOpenItem });
    const claim = item({
      id: 'c-1', issueKey: 'KB-7', type: 'claim', title: 'Gateway depends on auth', status: 'asserted',
      customFields: { subject: { itemId: 'ent-gateway' }, predicate: 'depends-on-service', object: { itemId: 'ent-auth' } },
    });
    const gateway = item({ id: 'ent-gateway', issueKey: 'KB-1', type: 'entity', title: 'API gateway', status: 'active' });
    const auth = item({ id: 'ent-auth', issueKey: 'KB-2', type: 'entity', title: 'Auth service', status: 'active' });

    const { container } = render(
      <TrackerReferenceResolverProvider resolver={resolver}>
        <LiveTrackerReferenceRenderer referenceKey="KB-7" nodeKey="n1" view="card" />
      </TrackerReferenceResolverProvider>,
    );
    expect(container.querySelector('.tracker-reference-card')?.getAttribute('data-state')).toBe('loading');

    await act(() => fake.release([claim, gateway, auth]));
    screen.getByText('Gateway depends on auth');
    // A claim in its normal state shows the kind alone.
    expect(screen.queryByText('Asserted')).toBeNull();
    // Subject and object render as nested live chips, the predicate by its registry label.
    screen.getByText('API gateway');
    screen.getByText('Auth service');
    screen.getByText('Depends on');

    act(() => {
      fake.emit({ type: 'items-upserted', items: [{ ...claim, title: 'Gateway calls auth', status: 'disputed' }] });
    });
    screen.getByText('Gateway calls auth');
    screen.getByText('Disputed'); // a deviation from the normal state is shown
    expect(screen.queryByText('Gateway depends on auth')).toBeNull();

    act(() => { screen.getByText('Gateway calls auth').click(); });
    expect(onOpenItem).toHaveBeenCalledWith('c-1');
    resolver.dispose();
  });

  it('node-selects a card on click (not on its links) and marks it selected', async () => {
    const fake = fakeDataSource();
    const onOpenItem = vi.fn();
    const resolver = createTrackerReferenceResolver(fake.source, { schema: fakeSchema(), onOpenItem });
    setTrackerReferenceNodeRenderer(LiveTrackerReferenceRenderer);
    let editor!: LexicalEditor;
    let cardKey = '';
    function CaptureEditor() {
      [editor] = useLexicalComposerContext();
      return null;
    }
    const { container } = render(
      <TrackerReferenceResolverProvider resolver={resolver}>
        <LexicalComposer
          initialConfig={{
            namespace: 'tracker-reference-selection-test',
            nodes: [TrackerReferenceNode],
            onError: (error) => { throw error; },
            editorState: () => {
              const card = $createTrackerReferenceNode('KB-7', 'card');
              cardKey = card.getKey();
              $getRoot().append($createParagraphNode().append(card));
            },
          }}
        >
          <RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
          <CaptureEditor />
        </LexicalComposer>
      </TrackerReferenceResolverProvider>,
    );
    await act(() => fake.release([item({ id: 'c-1', issueKey: 'KB-7', type: 'claim', title: 'A claim' })]));
    const block = () => container.querySelector('.tracker-reference-block');
    expect(block()?.getAttribute('data-selected')).toBe('false');

    await act(async () => {
      editor.update(() => {
        const selection = $createNodeSelection();
        selection.add(cardKey);
        $setSelection(selection);
      });
    });
    expect(block()?.getAttribute('data-selected')).toBe('true');

    await act(async () => {
      editor.update(() => { $getRoot().getFirstChildOrThrow<ParagraphNode>().selectStart(); });
    });
    expect(block()?.getAttribute('data-selected')).toBe('false');

    // The title is a link: it opens the item and leaves selection alone.
    await act(async () => { screen.getByText('A claim').click(); });
    expect(onOpenItem).toHaveBeenCalledWith('c-1');
    expect(block()?.getAttribute('data-selected')).toBe('false');

    await act(async () => { container.querySelector<HTMLElement>('.tracker-reference-card-header')!.click(); });
    expect(block()?.getAttribute('data-selected')).toBe('true');
    setTrackerReferenceNodeRenderer(undefined);
    resolver.dispose();
  });

  it('writes the menu transition: accepting a question position, rejecting a decision with why not', async () => {
    const fake = fakeDataSource();
    const command = vi.spyOn(fake.source, 'command');
    const resolver = createTrackerReferenceResolver(fake.source, {
      schema: fakeSchema(),
      onOpenItem: vi.fn(),
      currentActor: () => ({ email: 'sam@example.test', name: 'Sam' }),
      personName: (email) => (email === 'sam@example.test' ? 'Sam Lee' : null),
    });
    const question = item({
      id: 'q-1', issueKey: 'KW-14', type: 'question', title: 'Built in or from the marketplace?', status: 'investigating',
      customFields: { owner: 'karl@example.test', position: 'Built in for the beta.', positionState: 'proposed' },
      lastModifiedBy: { email: 'karl@example.test', displayName: 'Karl', gitName: null, gitEmail: null },
    });
    const decision = item({ id: 'd-1', issueKey: 'KW-13', type: 'wiki-decision', title: 'Store pages as files', status: 'proposed' });
    render(
      <TrackerReferenceResolverProvider resolver={resolver}>
        <LiveTrackerReferenceRenderer referenceKey="KW-14" nodeKey="n1" view="card" />
        <LiveTrackerReferenceRenderer referenceKey="KW-13" nodeKey="n2" view="card" />
      </TrackerReferenceResolverProvider>,
    );
    await act(() => fake.release([question, decision]));
    // The host directory wins over the actor's own name; item identities fill in the rest.
    expect([resolver.personName?.('sam@example.test'), resolver.personName?.('karl@example.test')]).toEqual(['Sam Lee', 'Karl']);
    const today = expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/);

    await act(async () => { screen.getByRole('button', { name: 'Investigating' }).click(); });
    await act(async () => { screen.getByRole('menuitem', { name: /Answered: accept Karl's position/ }).click(); });
    expect(command).toHaveBeenLastCalledWith({
      type: 'update-item',
      input: {
        itemId: 'q-1',
        updates: { status: 'answered', positionState: 'accepted', decidedBy: 'sam@example.test', decidedAt: today },
        sharing: 'team',
      },
    });
    screen.getByText(/You answered/);

    await act(async () => { screen.getByRole('button', { name: 'Proposed' }).click(); });
    await act(async () => { screen.getByRole('menuitem', { name: /Rejected/ }).click(); });
    expect(command).toHaveBeenCalledTimes(1); // asks why not before committing
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Files cannot carry owners' } });
    await act(async () => { screen.getByRole('button', { name: 'Reject' }).click(); });
    expect(command).toHaveBeenLastCalledWith({
      type: 'update-item',
      input: {
        itemId: 'd-1',
        updates: { status: 'rejected', whyNot: 'Files cannot carry owners', decidedBy: 'sam@example.test', decidedAt: today },
        sharing: 'team',
      },
    });
    resolver.dispose();
  });
});
