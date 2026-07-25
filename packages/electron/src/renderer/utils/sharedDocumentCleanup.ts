import type { SharedDocument } from '../store/atoms/collabDocuments';
import type { SharedDocumentEmptinessResult } from './documentSeedOrchestrator';

export interface SharedDocumentCleanupProgress {
  checked: number;
  total: number;
  moved: number;
  skipped: number;
  failed: number;
}

/**
 * Sequentially inspect shared rooms and trash only confirmed-empty documents.
 * Sequential execution bounds WebSocket/key work and makes progress stable.
 */
export async function sweepEmptySharedDocuments(
  documents: SharedDocument[],
  inspect: (document: SharedDocument) => Promise<SharedDocumentEmptinessResult>,
  trash: (documentId: string) => void,
  onProgress?: (progress: SharedDocumentCleanupProgress) => void,
): Promise<SharedDocumentCleanupProgress> {
  const candidates = documents.filter(document => !document.decryptFailed && document.trashedAt == null);
  const progress: SharedDocumentCleanupProgress = {
    checked: 0,
    total: candidates.length,
    moved: 0,
    skipped: 0,
    failed: 0,
  };
  onProgress?.({ ...progress });

  for (const document of candidates) {
    let result: SharedDocumentEmptinessResult;
    try {
      result = await inspect(document);
    } catch {
      result = { status: 'failed' };
    }
    if (result.status === 'empty') {
      trash(document.documentId);
      progress.moved++;
    } else if (result.status === 'failed') {
      progress.failed++;
    } else {
      progress.skipped++;
    }
    progress.checked++;
    onProgress?.({ ...progress });
  }

  return progress;
}
