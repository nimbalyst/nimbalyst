/**
 * Raised when a personal session-index row cannot be read with this device's
 * sync key.
 *
 * The personal sync seed is generated per install and only ever leaves a
 * machine through device pairing, so a row this key cannot read is most often
 * a healthy row written by another of the user's devices. Callers skip its
 * payload, keep the last good local cache, and retain its revision for coverage.
 * Unreadable rows never authorize deletion (GitHub #1117). Reconciliation may
 * republish a matching session from the authoritative local database.
 */
export class IndexEntryDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexEntryDecryptionError';
  }
}

/**
 * Structural check so a host compiled against a different copy of this module
 * (the Electron main process loads the runtime through its own bundle) still
 * recognizes the error.
 */
export function isIndexEntryDecryptionError(err: unknown): err is IndexEntryDecryptionError {
  if (err instanceof IndexEntryDecryptionError) return true;
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'IndexEntryDecryptionError';
}
