import { describe, expect, it, vi } from 'vitest';
import type { SharedDocument } from '../../store/atoms/collabDocuments';
import { sweepEmptySharedDocuments } from '../sharedDocumentCleanup';

function doc(documentId: string, overrides: Partial<SharedDocument> = {}): SharedDocument {
  return {
    documentId,
    title: documentId,
    documentType: 'markdown',
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('sweepEmptySharedDocuments', () => {
  it('trashes only rooms authoritatively confirmed empty', async () => {
    const trash = vi.fn();
    const result = await sweepEmptySharedDocuments(
      [doc('empty'), doc('full'), doc('failed'), doc('unsupported')],
      async (document) => ({
        status: document.documentId === 'empty'
          ? 'empty'
          : document.documentId === 'full'
            ? 'not-empty'
            : document.documentId === 'failed'
              ? 'failed'
              : 'unsupported',
      }),
      trash,
    );

    expect(trash).toHaveBeenCalledOnce();
    expect(trash).toHaveBeenCalledWith('empty');
    expect(result).toMatchObject({ checked: 4, moved: 1, failed: 1, skipped: 2 });
  });

  it('never inspects locked or already-trashed rows', async () => {
    const inspect = vi.fn(async () => ({ status: 'empty' as const }));
    const trash = vi.fn();
    const result = await sweepEmptySharedDocuments(
      [doc('locked', { decryptFailed: true }), doc('trashed', { trashedAt: 10 })],
      inspect,
      trash,
    );

    expect(inspect).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    expect(result.total).toBe(0);
  });
});
