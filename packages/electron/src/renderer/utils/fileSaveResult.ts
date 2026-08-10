export interface FileSaveResult {
  success: boolean;
  conflict?: boolean;
  deleted?: boolean;
  errorType?: string;
  errorCode?: string;
}

export class FileSaveRejectedError extends Error {
  readonly errorType: string;
  readonly code: string;

  constructor(errorType: string, errorCode: string) {
    super(`File save failed (${errorType})`);
    this.name = 'FileSaveRejectedError';
    this.errorType = errorType;
    this.code = errorCode;
  }
}

/**
 * User-facing explanation for a failed write. Every branch ends with the same
 * reassurance that nothing was lost -- the buffer is always preserved.
 */
export function getSaveFailureMessage(
  errorType: string,
  source: 'auto' | 'manual',
): string {
  const prefix = source === 'auto' ? 'Autosave is blocked' : 'Save failed';
  switch (errorType) {
    case 'permission':
      return `${prefix} because Nimbalyst does not have permission to write this file. Your edits remain unsaved.`;
    case 'disk_full':
      return `${prefix} because the disk is full. Your edits remain unsaved.`;
    case 'not_found':
      return `${prefix} because the file is no longer available. Your edits remain unsaved.`;
    case 'is_directory':
    case 'invalid_path':
      return `${prefix} because the file location is not writable. Your edits remain unsaved.`;
    case 'resource_limit':
    case 'io':
      return `${prefix} because the operating system could not write the file. Your edits remain unsaved.`;
    case 'conflict':
      return `${prefix} because the file changed on disk. Your edits remain unsaved.`;
    default:
      return `${prefix}. Your edits remain unsaved.`;
  }
}

/**
 * Reduce a failed save result to the single error type the UI reports.
 * `deleted` and `conflict` are distinct flags rather than error types, so they
 * are folded in here to keep every caller's message selection consistent.
 */
export function resolveSaveFailureType(result: FileSaveResult | null): string {
  if (result?.deleted) return 'not_found';
  if (result?.conflict) return 'conflict';
  return result?.errorType ?? 'unknown';
}

/**
 * IPC-level write failures resolve to a structured result so the renderer can
 * preserve its dirty buffer. Automatic callers must turn that result back into
 * a rejection; otherwise they would clear dirty state after a failed write.
 */
export function assertFileSaveSucceeded(result: FileSaveResult | null): void {
  if (result?.success) return;
  throw new FileSaveRejectedError(
    resolveSaveFailureType(result),
    result?.errorCode ?? 'UNKNOWN',
  );
}
