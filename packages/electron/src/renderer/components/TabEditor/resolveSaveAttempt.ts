import { resolveSaveFailureType, type FileSaveResult } from '../../utils/fileSaveResult';

export interface SaveAttemptResult extends FileSaveResult {
  /** Always set by the main process, on both the success and failure paths. */
  filePath: string;
  diskContent?: string;
}

/**
 * What the caller must do after a save attempt, and -- critically -- which
 * content the persisted baseline has to hold afterwards.
 *
 * The baseline travels with the outcome because getting it wrong is silent:
 * a baseline that does not match disk makes the *next* save look like an
 * external conflict. That regressed once when the forced-overwrite retry
 * landed on disk but left the baseline rewound to the pre-conflict content,
 * so every subsequent save re-prompted the user.
 */
export type SaveAttemptOutcome =
  /** Bytes are on disk. `forced` means the user chose to overwrite a conflict. */
  | { kind: 'saved'; result: SaveAttemptResult; forced: boolean; baseline: string }
  /** Manual conflict, user chose to discard their buffer and take disk content. */
  | { kind: 'reload'; diskContent: string; baseline: string }
  /** Autosave hit a conflict: never prompt, never clobber, keep the buffer. */
  | { kind: 'autosave-conflict'; diskContent: string; baseline: string }
  /** The write was refused. The buffer must stay dirty. */
  | { kind: 'failed'; errorType: string; baseline: string };

export interface SaveAttemptDeps {
  saveFile(
    content: string,
    filePath: string,
    lastKnownContent: string | undefined,
    source: 'auto' | 'manual',
  ): Promise<SaveAttemptResult | null>;
  /** Returns true to overwrite external changes, false to reload from disk. */
  confirmOverwrite(): boolean;
}

export interface SaveAttemptParams {
  contentToSave: string;
  expectedDiskContent: string;
  filePath: string;
  snapshotType: 'auto' | 'manual';
}

/**
 * Drive one save attempt, including the manual conflict prompt and the forced
 * retry, without touching React state or the DOM. The caller applies the
 * resulting side effects.
 */
export async function resolveSaveAttempt(
  { contentToSave, expectedDiskContent, filePath, snapshotType }: SaveAttemptParams,
  deps: SaveAttemptDeps,
): Promise<SaveAttemptOutcome> {
  const result = await deps.saveFile(
    contentToSave,
    filePath,
    expectedDiskContent,
    snapshotType,
  );

  if (!result) {
    return { kind: 'failed', errorType: 'unknown', baseline: expectedDiskContent };
  }

  if (result.conflict) {
    const diskContent = typeof result.diskContent === 'string' ? result.diskContent : '';

    if (snapshotType === 'auto') {
      return { kind: 'autosave-conflict', diskContent, baseline: expectedDiskContent };
    }

    if (!deps.confirmOverwrite()) {
      // Only reload when the main process actually handed back disk content;
      // otherwise there is nothing to replace the buffer with and this stays
      // a failure so the buffer is preserved.
      if (typeof result.diskContent !== 'string') {
        return {
          kind: 'failed',
          errorType: resolveSaveFailureType(result),
          baseline: expectedDiskContent,
        };
      }
      return { kind: 'reload', diskContent, baseline: diskContent };
    }

    // Force overwrite: retry with no conflict check.
    const forceResult = await deps.saveFile(contentToSave, filePath, undefined, 'manual');
    if (!forceResult) {
      return { kind: 'failed', errorType: 'unknown', baseline: expectedDiskContent };
    }
    if (!forceResult.success) {
      return {
        kind: 'failed',
        errorType: resolveSaveFailureType(forceResult),
        baseline: expectedDiskContent,
      };
    }
    // The forced write landed, so the baseline advances to what we just wrote.
    return { kind: 'saved', result: forceResult, forced: true, baseline: contentToSave };
  }

  if (!result.success) {
    return {
      kind: 'failed',
      errorType: resolveSaveFailureType(result),
      baseline: expectedDiskContent,
    };
  }

  return { kind: 'saved', result, forced: false, baseline: contentToSave };
}
