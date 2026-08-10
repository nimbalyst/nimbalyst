// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_RICH_COMMENT_TEXT_BYTES,
} from '@nimbalyst/collab-protocol';
import { act } from '@testing-library/react';
import { DRAG_DROP_PASTE } from '@lexical/rich-text';
import { PASTE_COMMAND } from 'lexical';

import { CommentComposer } from '../CommentComposer';
import {
  FULL_CAPABILITIES,
  READ_ONLY_CAPABILITIES,
  createCommentFixtures,
  createFixtureResolver,
} from '../commentFixtures';
import { detectTrigger, deriveDraft, EMPTY_POOL, urnsInText } from '../composerDraft';
import { composerEditor, composerText, type } from '../composerTestDriver';
import type { ConversationContext, MessageAttachment } from '../commentTypes';

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
    within(picker).getByTestId('mention-group-people');
    within(picker).getByTestId('mention-group-agents');
    within(picker).getByTestId('mention-option-person-user-dana');
    within(picker).getByTestId('mention-option-agent-session-sync-repro');
    expect(within(picker).getAllByTestId('mention-option-agent-glyph').length).toBe(2);
  });

  it('hides agent handles entirely when agentPostingEnabled is false', async () => {
    renderComposer({ context: { agentPostingEnabled: false } });
    type('@');

    const picker = await screen.findByTestId('mention-picker');
    within(picker).getByTestId('mention-group-people');
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

  it('sends the agent mention as both a delivery hint and a session reference', async () => {
    const { onSubmit } = renderComposer();
    type('@sync');
    fireEvent.click(await screen.findByTestId('mention-option-agent-session-sync-repro'));

    await waitFor(() => expect(composerText()).toContain('nimbalyst://session/'));
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

  it('carries no emoji control in the footer -- the `:` typeahead is the entry point', () => {
    renderComposer();

    const footer = document.querySelector('.comment-composer-footer')!;
    expect(footer).toBeTruthy();
    expect(screen.queryByTestId('composer-emoji-trigger')).toBeNull();
    expect(screen.queryByTestId('composer-emoji-picker')).toBeNull();
  });
});

describe('CommentComposer resource attachment', () => {
  afterEach(() => cleanup());

  it('attaches a reference and shows it as a removable pill', async () => {
    renderComposer();
    fireEvent.click(screen.getByTestId('composer-attach-trigger'));
    fireEvent.click(await screen.findByTestId('composer-attach-tracker-itm-2212'));

    const tray = await screen.findByTestId('comment-composer-attachments');
    within(tray).getByTestId('comment-composer-attachment-tracker');

    fireEvent.click(within(tray).getByLabelText(/^Remove /));
    await waitFor(() => expect(screen.queryByTestId('comment-composer-attachments')).toBeNull());
  });

  it('degrades an attached reference the reader cannot resolve without leaking it', async () => {
    renderComposer();
    fireEvent.click(screen.getByTestId('composer-attach-trigger'));
    fireEvent.click(await screen.findByTestId('composer-attach-document-doc-comp-review'));

    const tray = await screen.findByTestId('comment-composer-attachments');
    await waitFor(() =>
      expect(within(tray).getByTestId('comment-composer-attachment-document').textContent).toContain('Unavailable'),
    );
    expect(tray.textContent).not.toContain('Compensation review Q3');
  });

  it.each([
    {
      name: 'tracker',
      pasted: 'nimbalyst://tracker/itm-2212?orgId=org-nimbalyst',
      label: 'Tracker',
    },
    {
      name: 'plan',
      pasted: 'nimbalyst://tracker/itm-2212?orgId=org-nimbalyst&view=document',
      label: 'Plan',
    },
  ])('turns a pasted $name link into a resource chip and sends its reference', async ({
    pasted,
    label,
  }) => {
    const { onSubmit } = renderComposer();
    const event = new Event('paste', {
      bubbles: true,
      cancelable: true,
    }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [],
        getData: (type: string) => (type === 'text/plain' ? pasted : ''),
        types: ['text/plain'],
      },
    });

    act(() => {
      const editor = composerEditor();
      editor.dispatchCommand(PASTE_COMMAND, event);
      editor.update(() => {}, { discrete: true });
    });

    await waitFor(() => {
      expect(composerText()).toBe(
        `[${label}](nimbalyst://tracker/itm-2212) `,
      );
    });
    screen.getByTestId('composer-pill-resource');

    fireEvent.click(screen.getByTestId('comment-composer-send'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].resourceRefs).toEqual([
      {
        orgId: 'org-nimbalyst',
        kind: 'tracker',
        sourceId: 'itm-2212',
      },
    ]);
    expect(onSubmit.mock.calls[0][0].body.entities).toEqual([
      {
        start: 0,
        end: new TextEncoder().encode(
          `[${label}](nimbalyst://tracker/itm-2212)`,
        ).byteLength,
        kind: 'resource',
        refIndex: 0,
      },
    ]);
  });
});

describe('CommentComposer bound enforcement', () => {
  afterEach(() => cleanup());

  it('refuses to send an over-limit body, reports why, and truncates nothing', async () => {
    const { onSubmit } = renderComposer();
    const oversized = 'a'.repeat(MAX_RICH_COMMENT_TEXT_BYTES + 64);
    type(oversized);

    fireEvent.click(screen.getByTestId('comment-composer-send'));

    const errors = await screen.findByTestId('comment-composer-errors');
    expect(errors.querySelector('[data-error-code="richBodyTooLarge"]')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(composerText().length).toBe(oversized.length);

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

describe('CommentComposer attachments', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function imageFile(name = 'screenshot.png'): File {
    return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
  }

  function attachmentOf(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
    return {
      assetId: 'asset-1',
      fileName: 'screenshot.png',
      mimeType: 'image/png',
      byteSize: 2048,
      width: 800,
      height: 600,
      ...overrides,
    };
  }

  function renderWithHost(
    upload: (file: File) => Promise<MessageAttachment>,
    props: { initialAttachments?: MessageAttachment[] } = {},
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
        attachmentHost={{ upload }}
        initialAttachments={props.initialAttachments}
        onSubmit={onSubmit}
      />,
    );
    return { fixtures, onSubmit };
  }

  /** Paste and drop arrive as the same Lexical command. */
  function paste(files: File[]): void {
    const editor = composerEditor();
    act(() => {
      editor.dispatchCommand(DRAG_DROP_PASTE, files);
    });
  }

  beforeEach(() => {
    // jsdom has no object URLs; the strip only needs a distinguishable string.
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:preview-1');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  it('takes a pasted image, uploads it, and shows it in the strip', async () => {
    renderWithHost(async () => attachmentOf());

    paste([imageFile()]);

    const chip = await screen.findByTestId('comment-composer-pending-attachment');
    expect(chip.getAttribute('data-file-name')).toBe('screenshot.png');
    await waitFor(() => expect(chip.getAttribute('data-status')).toBe('ready'));
    expect(
      within(chip).getByTestId('comment-composer-pending-attachment-preview'),
    ).toBeTruthy();
  });

  it('sends an attachments-only message and clears the strip', async () => {
    const { onSubmit } = renderWithHost(async () => attachmentOf());

    paste([imageFile()]);
    await waitFor(() =>
      expect(
        screen.getByTestId('comment-composer-pending-attachment').getAttribute('data-status'),
      ).toBe('ready'));

    const send = screen.getByTestId('comment-composer-send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].body).toEqual({
      version: 1,
      format: 'nimbalystMarkdown',
      // No text at all: a screenshot with no caption is still a message.
      text: '',
      attachments: [attachmentOf()],
    });
    await waitFor(() =>
      expect(screen.queryByTestId('comment-composer-pending-attachment')).toBeNull());
  });

  it('carries the text and the files together, leaving the text seam alone', async () => {
    const { onSubmit } = renderWithHost(async () => attachmentOf());

    type('look at this');
    paste([imageFile()]);
    await waitFor(() =>
      expect(
        screen.getByTestId('comment-composer-pending-attachment').getAttribute('data-status'),
      ).toBe('ready'));
    fireEvent.click(screen.getByTestId('comment-composer-send'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].body.text).toBe('look at this');
    expect(onSubmit.mock.calls[0][0].body.attachments).toHaveLength(1);
  });

  it('does not send while an upload is still in flight', async () => {
    let settle: ((attachment: MessageAttachment) => void) | null = null;
    renderWithHost(() => new Promise((resolve) => { settle = resolve; }));

    type('with a file');
    paste([imageFile()]);

    await screen.findByTestId('comment-composer-pending-attachment');
    expect((screen.getByTestId('comment-composer-send') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { settle?.(attachmentOf()); });
    await waitFor(() =>
      expect((screen.getByTestId('comment-composer-send') as HTMLButtonElement).disabled).toBe(false));
  });

  it('states why a file was refused and holds the send until it is removed', async () => {
    renderWithHost(async () => {
      throw new Error('capture.mov is 42.0 MB. Attachments are limited to 10.0 MB.');
    });

    type('here');
    paste([imageFile('capture.mov')]);

    const errors = await screen.findByTestId('comment-composer-errors');
    expect(errors.textContent).toContain('Attachments are limited to 10.0 MB');
    expect((screen.getByTestId('comment-composer-send') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText('Remove capture.mov'));

    await waitFor(() =>
      expect((screen.getByTestId('comment-composer-send') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId('comment-composer-pending-attachment')).toBeNull();
  });

  it('drops a removed attachment from the body it would send', async () => {
    const { onSubmit } = renderWithHost(async (file) =>
      attachmentOf({ assetId: file.name, fileName: file.name }));

    type('two files');
    paste([imageFile('one.png'), imageFile('two.png')]);
    await waitFor(() =>
      expect(screen.getAllByTestId('comment-composer-pending-attachment')).toHaveLength(2));

    fireEvent.click(screen.getByLabelText('Remove one.png'));
    await waitFor(() =>
      expect(screen.getAllByTestId('comment-composer-pending-attachment')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('comment-composer-send'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].body.attachments).toEqual([
      attachmentOf({ assetId: 'two.png', fileName: 'two.png' }),
    ]);
  });

  it('refuses more than the per-message limit and says so', async () => {
    renderWithHost(async (file) => attachmentOf({ assetId: file.name, fileName: file.name }));

    paste(
      Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 2 }, (_, index) =>
        imageFile(`file-${index}.png`)),
    );

    await waitFor(() =>
      expect(screen.getAllByTestId('comment-composer-pending-attachment'))
        .toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE));
    expect(screen.getByTestId('comment-composer-errors').textContent)
      .toContain(`at most ${MAX_ATTACHMENTS_PER_MESSAGE}`);
  });

  it('keeps a message edit from silently detaching its existing files', async () => {
    const existing = attachmentOf({ assetId: 'asset-existing', fileName: 'diagram.png' });
    const { onSubmit } = renderWithHost(async () => attachmentOf(), {
      initialAttachments: [existing],
    });

    type('edited text');
    fireEvent.click(screen.getByTestId('comment-composer-send'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].body.attachments).toEqual([existing]);
  });

  it('offers no attachment affordance and ignores a paste without a host', () => {
    renderComposer();

    expect(screen.queryByTestId('comment-composer-attach-file')).toBeNull();
    paste([imageFile()]);
    expect(screen.queryByTestId('comment-composer-pending-attachment')).toBeNull();
  });

  it('uploads files chosen through the attach button', async () => {
    const upload = vi.fn(async () => attachmentOf());
    renderWithHost(upload);

    screen.getByTestId('comment-composer-attach-file');
    const input = screen.getByTestId('comment-composer-file-input') as HTMLInputElement;
    const file = imageFile();
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(upload).toHaveBeenCalledWith(file));
  });
});
