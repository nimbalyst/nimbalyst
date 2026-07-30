// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommentComposer } from '../CommentComposer';
import { FULL_CAPABILITIES, createCommentFixtures, createFixtureResolver } from '../commentFixtures';
import { EMPTY_POOL, type DraftPool } from '../composerDraft';
import { composerText, format, pressEnter, type, typeMore } from '../composerTestDriver';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const NOW = Date.parse('2026-07-26T18:00:00.000Z');

function renderComposer(
  overrides: { initialText?: string; initialPool?: DraftPool } = {},
) {
  const fixtures = createCommentFixtures({ now: NOW });
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <CommentComposer
      capabilities={FULL_CAPABILITIES}
      context={fixtures.context}
      directory={fixtures.directory}
      orgId={fixtures.orgId}
      resolver={createFixtureResolver()}
      resourceCandidates={fixtures.candidates}
      onSubmit={onSubmit}
      initialText={overrides.initialText ?? ''}
      initialPool={overrides.initialPool ?? EMPTY_POOL}
    />,
  );
  return { fixtures, onSubmit };
}

describe('composer rich input: what you type is what posts', () => {
  afterEach(() => cleanup());

  it('exports the inline marks the reader understands', () => {
    renderComposer();

    type('bold', 'bold');
    expect(composerText()).toBe('**bold**');

    type('soft', 'italic');
    expect(composerText()).toBe('*soft*');

    type('npm run dev', 'code');
    expect(composerText()).toBe('`npm run dev`');
  });

  it('keeps the marks hugging the word when the run has surrounding spaces', () => {
    renderComposer();
    type(' bold ', 'bold');
    expect(composerText()).toBe(' **bold** ');
  });

  it('renders the mark in the input instead of a separate preview', () => {
    renderComposer();
    type('bold', 'bold');

    const input = screen.getByTestId('comment-composer-input');
    expect(input.querySelector('strong, .font-semibold')).toBeTruthy();
    expect(screen.queryByTestId('comment-composer-preview')).toBeNull();
  });

  it('cannot produce a block construct', () => {
    renderComposer();
    type('# ');
    typeMore('Heading');

    const input = screen.getByTestId('comment-composer-input');
    expect(composerText()).toBe('# Heading');
    expect(input.querySelector('h1, h2, h3, ul, ol, blockquote, pre')).toBeNull();
  });

  it('drops the italic marker rather than emitting a form the reader cannot parse', () => {
    // `***x***` reads as a stray asterisk around a bold run to every recipient,
    // so bold wins outright.
    renderComposer();
    type('both', 'bold');
    format('italic');
    expect(composerText()).toBe('**both**');
  });
});

describe('composer rich input: mentions are atomic', () => {
  afterEach(() => cleanup());

  it('inserts a person mention as a pill that exports the exact token', async () => {
    renderComposer();
    type('@dan');

    fireEvent.click(await screen.findByTestId('mention-option-person-user-dana'));

    await waitFor(() =>
      expect(composerText()).toBe('[@Dana Okafor](nimbalyst://user/user-dana) '),
    );
    const input = screen.getByTestId('comment-composer-input');
    expect(within(input).getByTestId('composer-pill-person')).toBeTruthy();
    expect(within(input).getByTestId('composer-pill-avatar').textContent).toBe('DO');
  });

  it('does not let typing next to a mention extend its token', async () => {
    renderComposer();
    type('@dan');
    fireEvent.click(await screen.findByTestId('mention-option-person-user-dana'));
    await waitFor(() => expect(composerText()).toContain('nimbalyst://user/user-dana'));

    typeMore('and then some');

    expect(composerText()).toBe(
      '[@Dana Okafor](nimbalyst://user/user-dana) and then some',
    );
  });

  it('inserts an agent mention as its own pill', async () => {
    renderComposer();
    type('@sync');

    fireEvent.click(await screen.findByTestId('mention-option-agent-session-sync-repro'));

    await waitFor(() =>
      expect(composerText()).toBe('[@Sync repro](nimbalyst://session/session-sync-repro) '),
    );
    const input = screen.getByTestId('comment-composer-input');
    expect(within(input).getByTestId('composer-pill-agent')).toBeTruthy();
    expect(within(input).queryByTestId('composer-pill-person')).toBeNull();
  });

  it('completes a :shortcode: into its glyph', async () => {
    renderComposer();
    type('ship it :rock');

    fireEvent.click(await screen.findByTestId('emoji-suggestion-rocket'));

    await waitFor(() => expect(composerText()).toBe('ship it \u{1F680} '));
  });
});

describe('composer rich input: Enter', () => {
  afterEach(() => cleanup());

  it('sends on Enter and breaks the line on Shift+Enter', async () => {
    const { onSubmit } = renderComposer();

    type('first');
    pressEnter({ shift: true });
    expect(composerText()).toBe('first\n');
    expect(onSubmit).not.toHaveBeenCalled();

    typeMore('second');
    pressEnter();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].body.text).toBe('first\nsecond');
  });

  it('lets an open mention list take Enter instead of sending', async () => {
    const { onSubmit } = renderComposer();
    type('@dan');
    await screen.findByTestId('mention-picker');

    pressEnter();

    await waitFor(() => expect(composerText()).toContain('nimbalyst://user/user-dana'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clears the input after a send', async () => {
    const { onSubmit } = renderComposer();
    type('done');
    pressEnter();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(composerText()).toBe(''));
  });
});

describe('composer rich input: edit mode', () => {
  afterEach(() => cleanup());

  it('seeds an existing message without rewriting a byte of it', async () => {
    const fixtures = createCommentFixtures({ now: NOW });
    const dana = fixtures.directory.people.find((person) => person.userId === 'user-dana')!;
    const initialText = 'hi [@Dana Okafor](nimbalyst://user/user-dana) about **that** `fix`';
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <CommentComposer
        capabilities={FULL_CAPABILITIES}
        context={fixtures.context}
        directory={fixtures.directory}
        orgId={fixtures.orgId}
        resolver={createFixtureResolver()}
        submitLabel="Save"
        initialText={initialText}
        initialPool={{ ...EMPTY_POOL, people: { 'nimbalyst://user/user-dana': dana } }}
        onSubmit={onSubmit}
      />,
    );

    await waitFor(() => expect(composerText()).toBe(initialText));
    const input = screen.getByTestId('comment-composer-input');
    expect(within(input).getByTestId('composer-pill-person')).toBeTruthy();

    fireEvent.click(screen.getByTestId('comment-composer-send'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].body.text).toBe(initialText);
    expect(onSubmit.mock.calls[0][0].mentionedUserIds).toEqual(['user-dana']);
  });

  it('leaves an uncorroborated token as literal text', async () => {
    renderComposer({ initialText: 'see [Something](nimbalyst://tracker/itm-unknown)' });

    await waitFor(() =>
      expect(composerText()).toBe('see [Something](nimbalyst://tracker/itm-unknown)'),
    );
    expect(screen.queryByTestId('composer-pill-resource')).toBeNull();
  });
});
