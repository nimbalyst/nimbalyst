import { describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DocRevisionMetadata } from '@nimbalyst/collab-protocol';
import { CollabHistoryDialog, type CollabHistoryDiffProps } from '../CollabHistoryDialog';
import { restoreCollabRevision, type CollabHistoryController } from '../collabHistoryController';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const rev = (revisionId: string, createdAt: number): DocRevisionMetadata => ({
  revisionId,
  revisionKind: 'manual',
  editorType: 'markdown',
  contentFormat: 'markdown',
  contentHash: `${revisionId}-hash`,
  payloadBytes: 10,
  createdAt,
  createdBy: 'member-a',
} as DocRevisionMetadata);

function controllerWith(texts: Record<string, string>, live = 'live page') {
  const calls: string[] = [];
  let body = live;
  const controller: CollabHistoryController = {
    client: {
      // Newest first, as the server lists them.
      listRevisions: vi.fn(async () => ({ revisions: [rev('r2', 2_000), rev('r1', 1_000)], nextCursor: null })),
      loadRevision: vi.fn(async (revisionId: string) => {
        calls.push(`load:${revisionId}`);
        return { metadata: rev(revisionId, 0), plaintext: encoder.encode(texts[revisionId]) };
      }),
      createRevision: vi.fn(async (input) => {
        calls.push(`create:${input.revisionKind}:${decoder.decode(input.plaintext)}`);
        return { revisionId: `new-${input.revisionKind}`, deduped: false };
      }),
    } as unknown as CollabHistoryController['client'],
    editorType: 'markdown',
    contentFormat: 'markdown',
    exportSnapshot: () => encoder.encode(body),
    applySnapshot: (plaintext) => {
      body = decoder.decode(plaintext);
      calls.push(`apply:${body}`);
    },
    getBasisSequence: () => 7,
    getStatus: () => 'connected',
  };
  /** A collaborator's edit arriving through the live editor. */
  const edit = (text: string) => { body = text; };
  return { controller, calls, body: () => body, edit };
}

/** Lands `edit` while the given revision kind is being posted, `times` times. */
function editDuringCreate(
  controller: CollabHistoryController,
  revisionKind: string,
  edits: string[],
  edit: (text: string) => void,
) {
  const create = controller.client.createRevision as Mock;
  const original = create.getMockImplementation()!;
  create.mockImplementation(async (input) => {
    const result = await original(input);
    const next = input.revisionKind === revisionKind ? edits.shift() : undefined;
    if (next !== undefined) edit(next);
    return result;
  });
}

function renderDialog(controller: CollabHistoryController, onClose = vi.fn()) {
  const renderDiff = vi.fn(({ oldText, newText }: CollabHistoryDiffProps) => (
    <div data-testid="diff">{`${oldText} -> ${newText}`}</div>
  ));
  render(
    <CollabHistoryDialog
      controller={controller}
      onClose={onClose}
      previewRevision={(_format, bytes) => decoder.decode(bytes)}
      renderDiff={renderDiff}
    />,
  );
  return { renderDiff, onClose };
}

describe('shared page history dialog', () => {
  it('lists versions and compares a version with the previous one or the current page', async () => {
    const { controller } = controllerWith({ r1: 'first draft', r2: 'second draft' });
    renderDialog(controller);

    fireEvent.click(await screen.findByTestId('collab-revision-r2'));
    expect((await screen.findByTestId('diff')).textContent).toBe('first draft -> second draft');

    fireEvent.click(screen.getByTestId('collab-history-mode-current'));
    await waitFor(() => expect(screen.getByTestId('diff').textContent).toBe('second draft -> live page'));
  });

  it('restores through a restore-pre checkpoint, the live editor, then a restore-head revision', async () => {
    const { controller, calls, body } = controllerWith({ r1: 'first draft', r2: 'second draft' });
    const { onClose } = renderDialog(controller);

    fireEvent.click(await screen.findByTestId('collab-revision-r1'));
    const restore = screen.getByRole('button', { name: 'Restore as Current Version' });
    await waitFor(() => expect((restore as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(restore);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.filter((call) => !call.startsWith('load:r2'))).toEqual([
      'load:r1', // the diff preview
      'load:r1',
      'create:restore-pre:live page',
      'apply:first draft',
      'create:restore-head:first draft',
    ]);
    expect(body()).toBe('first draft');
    expect(controller.client.createRevision).toHaveBeenLastCalledWith(
      expect.objectContaining({ restoredFromRevisionId: 'r1', basisSequence: 7 }),
    );
  });

  it('withholds restore from a reader who cannot edit the page', async () => {
    const { controller } = controllerWith({ r1: 'first draft', r2: 'second draft' });
    renderDialog({ ...controller, isReadOnly: () => true });

    fireEvent.click(await screen.findByTestId('collab-revision-r1'));
    await screen.findByText('first draft');
    expect((screen.getByRole('button', { name: 'Restore as Current Version' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * Restore replaces the whole live body. A collaborator's edit that lands while
 * the checkpoint is being posted is in neither the checkpoint nor the restored
 * text, so replacing the body then erases it without a trace.
 */
describe('restoring while a collaborator edits', () => {
  it('checkpoints an edit that lands during the checkpoint before replacing the body', async () => {
    const { controller, calls, body, edit } = controllerWith({ r1: 'first draft' });
    editDuringCreate(controller, 'restore-pre', ['live page + their edit'], edit);

    await expect(restoreCollabRevision(controller, 'r1')).resolves.toBe(true);

    expect(calls).toContain('create:restore-pre:live page + their edit');
    expect(calls.indexOf('create:restore-pre:live page + their edit')).toBeLessThan(calls.indexOf('apply:first draft'));
    expect(body()).toBe('first draft');
  });

  it('refuses to replace a body that keeps changing, and keeps the edit', async () => {
    const { controller, calls, body, edit } = controllerWith({ r1: 'first draft' });
    editDuringCreate(controller, 'restore-pre', ['edit one', 'edit two'], edit);

    await expect(restoreCollabRevision(controller, 'r1')).rejects.toThrow(/changed while restoring/);

    expect(body()).toBe('edit two');
    expect(calls.some((call) => call.startsWith('apply:'))).toBe(false);
    expect(calls.some((call) => call.startsWith('create:restore-head'))).toBe(false);
  });

  it('does not replace the body when write access is lost during the checkpoint', async () => {
    let readOnly = false;
    const { controller, calls } = controllerWith({ r1: 'first draft' });
    const create = controller.client.createRevision as Mock;
    const original = create.getMockImplementation()!;
    create.mockImplementation(async (input) => { const result = await original(input); readOnly = true; return result; });

    await expect(restoreCollabRevision({ ...controller, isReadOnly: () => readOnly }, 'r1')).rejects.toThrow(/permission/);
    expect(calls.some((call) => call.startsWith('apply:'))).toBe(false);
  });
});
