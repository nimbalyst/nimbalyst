// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptQueueList } from '../PromptQueueList';
import { mergeRestoredDraftAttachments } from '../queuedPromptDraftRestore';

afterEach(cleanup);

const IMAGE = {
  id: 'att-1',
  filename: 'pasted-image-2026-07-31T12-31-38.png',
  filepath: 'C:\\Users\\Dera\\AppData\\Roaming\\@nimbalyst\\electron\\chat-attachments\\p\\s\\1_pasted.png',
  mimeType: 'image/png',
  size: 170297,
  type: 'image' as const,
  addedAt: 1785501099186,
};

describe('editing a queued prompt', () => {
  // Regression: editing a queued prompt deleted the row and put only the TEXT
  // back in the draft, so the `@filename` reference survived but the attachment
  // (and its absolute path) did not. The next send reached the CLI as a bare
  // `@filename` it could not resolve.
  it('hands the queued attachments back to the caller, not just the prompt text', () => {
    const onEdit = vi.fn();
    render(
      <PromptQueueList
        queue={[{ id: 'q1', prompt: 'look at this @pasted.png', timestamp: 1, attachments: [IMAGE] }]}
        onCancel={vi.fn()}
        onEdit={onEdit}
      />,
    );

    fireEvent.click(screen.getByTitle('Edit this prompt'));

    expect(onEdit).toHaveBeenCalledWith('q1', 'look at this @pasted.png', [IMAGE]);
  });

  it('restores attachments into the draft without duplicating ones already there', () => {
    const other = { ...IMAGE, id: 'att-2', filename: 'b.png' };

    expect(mergeRestoredDraftAttachments([], [IMAGE])).toEqual([IMAGE]);
    expect(mergeRestoredDraftAttachments([other], [IMAGE])).toEqual([other, IMAGE]);
    // Re-editing the same queued prompt twice must not stack duplicates.
    expect(mergeRestoredDraftAttachments([IMAGE], [IMAGE])).toEqual([IMAGE]);
    expect(mergeRestoredDraftAttachments([IMAGE], undefined)).toEqual([IMAGE]);
  });
});
