// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RICH_COMMENT_TEXT_BYTES } from '@nimbalyst/collab-protocol';

import { CommentComposer } from '../CommentComposer';
import {
  FULL_CAPABILITIES,
  READ_ONLY_CAPABILITIES,
  createCommentFixtures,
  createFixtureResolver,
} from '../commentFixtures';
import { detectTrigger, deriveDraft, EMPTY_POOL, urnsInText } from '../composerDraft';
import type { ConversationContext } from '../commentTypes';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const NOW = Date.parse('2026-07-26T18:00:00.000Z');

function renderComposer(
  overrides: {
    capabilities?: typeof FULL_CAPABILITIES;
    context?: Partial<ConversationContext>;
  } = {},
) {
  const fixtures = createCommentFixtures({ now: NOW });
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <CommentComposer
      capabilities={overrides.capabilities ?? FULL_CAPABILITIES}
      context={{ ...fixtures.context, ...overrides.context }}
      directory={fixtures.directory}
      orgId={fixtures.orgId}
      resolver={createFixtureResolver()}
      resourceCandidates={fixtures.candidates}
      onSubmit={onSubmit}
    />,
  );
  return { fixtures, onSubmit, ...utils };
}

/** Type into the textarea and place the caret at the end, as a user would. */
function type(value: string) {
  const input = screen.getByTestId('comment-composer-input') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  return input;
}

describe('composer trigger detection', () => {
  it('opens on @ at a word boundary and not inside a word', () => {
    expect(detectTrigger('@da', 3)).toEqual({ kind: 'mention', start: 0, end: 3, query: 'da' });
    expect(detectTrigger('hi @da', 6)?.kind).toBe('mention');
    expect(detectTrigger('greg@example.com', 16)).toBeNull();
  });

  it('opens the emoji list on a partial shortcode and not on a clock time', () => {
    expect(detectTrigger(':roc', 4)).toEqual({ kind: 'emoji', start: 0, end: 4, query: 'roc' });
    expect(detectTrigger('at 10:30', 8)).toBeNull();
    expect(detectTrigger(':rocket:', 8)).toBeNull();
  });
});

describe('composer draft derivation', () => {
  it('drops a mention when its token is deleted from the text', () => {
    const fixtures = createCommentFixtures({ now: NOW });
    const dana = fixtures.directory.people.find((person) => person.userId === 'user-dana')!;
    const pool = { ...EMPTY_POOL, people: { 'nimbalyst://user/user-dana': dana } };

    const withMention = deriveDraft(
      'hi [@Dana Okafor](nimbalyst://user/user-dana)',
      'nimbalystMarkdown',
      pool,
    );
    expect(withMention.mentionedUserIds).toEqual(['user-dana']);
    expect(withMention.body.entities).toEqual([
      {
        start: new TextEncoder().encode('hi ').byteLength,
        end: new TextEncoder().encode(withMention.body.text).byteLength,
        kind: 'userMention',
        userId: 'user-dana',
      },
    ]);

    const withoutMention = deriveDraft('hi', 'nimbalystMarkdown', pool);
    expect(withoutMention.mentionedUserIds).toEqual([]);
    expect(withoutMention.body.entities).toBeUndefined();
  });

  it('finds both labeled and bare URN tokens', () => {
    const text = '[NIM-1](nimbalyst://tracker/itm-1) and nimbalyst://document/doc-2';
    expect(urnsInText(text)).toEqual(['nimbalyst://tracker/itm-1', 'nimbalyst://document/doc-2']);
  });
});

describe('CommentComposer mention picker', () => {
  afterEach(() => cleanup());

  it('shows one list containing both people and agents on a single @', async () => {
    renderComposer();
    type('@');

    const picker = await screen.findByTestId('mention-picker');
    expect(within(picker).getByTestId('mention-group-people')).toBeTruthy();
    expect(within(picker).getByTestId('mention-group-agents')).toBeTruthy();
    expect(within(picker).getByTestId('mention-option-person-user-dana')).toBeTruthy();
    expect(within(picker).getByTestId('mention-option-agent-session-sync-repro')).toBeTruthy();
    expect(within(picker).getAllByTestId('mention-option-agent-glyph').length).toBe(2);
  });

  it('hides agent handles entirely when agentPostingEnabled is false', async () => {
    renderComposer({ context: { agentPostingEnabled: false } });
    type('@');

    const picker = await screen.findByTestId('mention-picker');
    expect(within(picker).getByTestId('mention-group-people')).toBeTruthy();
    expect(within(picker).queryByTestId('mention-group-agents')).toBeNull();
    expect(within(picker).queryByTestId('mention-option-agent-session-sync-repro')).toBeNull();
    expect(within(picker).queryAllByTestId('mention-option-agent-glyph')).toHaveLength(0);
  });

  it('never offers a session that is not attached to the conversation', async () => {
    renderComposer();
    type('@');
    const picker = await screen.findByTestId('mention-picker');
    expect(within(picker).queryByTestId('mention-option-agent-session-detached')).toBeNull();
  });

  it('inserts a person pill that renders with an avatar', async () => {
    renderComposer();
    type('@dan');

    fireEvent.click(await screen.findByTestId('mention-option-person-user-dana'));

    await waitFor(() => {
      const preview = screen.getByTestId('comment-composer-preview');
      expect(within(preview).getByTestId('comment-mention-person')).toBeTruthy();
    });
    const preview = screen.getByTestId('comment-composer-preview');
    expect(within(preview).getByTestId('comment-mention-avatar').textContent).toBe('DO');
    expect(within(preview).queryByTestId('comment-mention-agent')).toBeNull();
    expect((screen.getByTestId('comment-composer-input') as HTMLTextAreaElement).value).toBe(
      '[@Dana Okafor](nimbalyst://user/user-dana) ',
    );
  });

  it('inserts an agent pill that renders with the agent glyph and session name', async () => {
    renderComposer();
    type('@sync');

    fireEvent.click(await screen.findByTestId('mention-option-agent-session-sync-repro'));

    await waitFor(() => {
      const preview = screen.getByTestId('comment-composer-preview');
      expect(within(preview).getByTestId('comment-mention-agent')).toBeTruthy();
    });
    const preview = screen.getByTestId('comment-composer-preview');
    expect(within(preview).getByTestId('comment-mention-agent-glyph')).toBeTruthy();
    expect(within(preview).getByTestId('comment-mention-agent').textContent).toContain('Sync repro');
    expect(within(preview).queryByTestId('comment-mention-person')).toBeNull();
  });

  it('sends the agent mention as both a delivery hint and a session reference', async () => {
    const { onSubmit } = renderComposer();
    type('@sync');
    fireEvent.click(await screen.findByTestId('mention-option-agent-session-sync-repro'));

    await waitFor(() =>
      expect((screen.getByTestId('comment-composer-input') as HTMLTextAreaElement).value).toContain('nimbalyst://session/'),
    );
    fireEvent.click(screen.getByTestId('comment-composer-send'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submission = onSubmit.mock.calls[0][0];
    expect(submission.mentionedAgentSessionIds).toEqual(['session-sync-repro']);
    expect(submission.resourceRefs).toEqual([
      { orgId: 'org-nimbalyst', kind: 'session', sourceId: 'session-sync-repro' },
    ]);
    expect(submission.body.entities).toEqual([
      {
        start: 0,
        end: new TextEncoder().encode(
          '[@Sync repro](nimbalyst://session/session-sync-repro)',
        ).byteLength,
        kind: 'agentMention',
        sessionId: 'session-sync-repro',
      },
    ]);
  });
});

describe('CommentComposer emoji', () => {
  afterEach(() => cleanup());

  it('completes a :shortcode: into its glyph', async () => {
    renderComposer();
    type('ship it :rock');

    fireEvent.click(await screen.findByTestId('emoji-suggestion-rocket'));

    await waitFor(() =>
      expect((screen.getByTestId('comment-composer-input') as HTMLTextAreaElement).value).toBe('ship it \u{1F680} '),
    );
  });

  it('opens the browse picker from the toolbar', async () => {
    renderComposer();
    fireEvent.click(screen.getByTestId('composer-emoji-trigger'));
    expect(await screen.findByTestId('composer-emoji-picker')).toBeTruthy();
  });
});

describe('CommentComposer resource attachment', () => {
  afterEach(() => cleanup());

  it('attaches a reference and shows it as a removable pill', async () => {
    renderComposer();
    fireEvent.click(screen.getByTestId('composer-attach-trigger'));
    fireEvent.click(await screen.findByTestId('composer-attach-tracker-itm-2212'));

    const tray = await screen.findByTestId('comment-composer-attachments');
    expect(within(tray).getByTestId('comment-composer-attachment-tracker')).toBeTruthy();

    fireEvent.click(within(tray).getByLabelText(/^Remove /));
    await waitFor(() => expect(screen.queryByTestId('comment-composer-attachments')).toBeNull());
  });

  it('degrades an attached reference the reader cannot resolve without leaking it', async () => {
    renderComposer();
    fireEvent.click(screen.getByTestId('composer-attach-trigger'));
    fireEvent.click(await screen.findByTestId('composer-attach-document-doc-comp-review'));

    const preview = await screen.findByTestId('comment-composer-preview');
    await waitFor(() => {
      expect(within(preview).getByTestId('resource-pill-document').getAttribute('data-availability')).toBe('unavailable');
    });
    expect(within(preview).getByTestId('resource-pill-document').textContent).toContain('Unavailable');
    expect(preview.textContent).not.toContain('Compensation review Q3');
  });
});

describe('CommentComposer bound enforcement', () => {
  afterEach(() => cleanup());

  it('refuses to send an over-limit body, reports why, and truncates nothing', async () => {
    const { onSubmit } = renderComposer();
    const oversized = 'a'.repeat(MAX_RICH_COMMENT_TEXT_BYTES + 64);
    const input = type(oversized);

    fireEvent.click(screen.getByTestId('comment-composer-send'));

    const errors = await screen.findByTestId('comment-composer-errors');
    expect(errors.querySelector('[data-error-code="richBodyTooLarge"]')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value.length).toBe(oversized.length);

    const bounds = screen.getByTestId('comment-composer-bounds');
    expect(bounds.textContent).toContain('32K');
  });

  it('sends once the body is back within the limit', async () => {
    const { onSubmit } = renderComposer();
    type('a'.repeat(MAX_RICH_COMMENT_TEXT_BYTES + 64));
    fireEvent.click(screen.getByTestId('comment-composer-send'));
    await screen.findByTestId('comment-composer-errors');

    type('short enough');
    fireEvent.click(screen.getByTestId('comment-composer-send'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].body).toEqual({
      version: 1,
      format: 'nimbalystMarkdown',
      text: 'short enough',
    });
  });

  it('keeps send unavailable for an empty draft', () => {
    renderComposer();
    const send = screen.getByTestId('comment-composer-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });
});

describe('CommentComposer read-only', () => {
  afterEach(() => cleanup());

  it('explains the missing permission instead of hiding the composer', () => {
    renderComposer({ capabilities: READ_ONLY_CAPABILITIES });

    expect(screen.queryByTestId('comment-composer-input')).toBeNull();
    const restricted = screen.getByTestId('comment-composer-restricted');
    expect(within(restricted).getByTestId('comment-composer-restriction-title').textContent).toContain('read-only');
    expect(within(restricted).getByTestId('comment-composer-restriction-detail').textContent).toContain('comment');
  });

  it('explains an archived conversation distinctly from a permission gap', () => {
    renderComposer({ context: { archived: true } });
    expect(screen.getByTestId('comment-composer-restriction-title').textContent).toContain('archived');
  });
});
