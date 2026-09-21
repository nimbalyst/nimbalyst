import { IndexEntryDecryptionError } from './indexEntryDecryptionError';
import type { IndexChangeWire } from './collabV3WireTypes';

/**
 * Contract check for one row of a v2 page, run BEFORE any decryption.
 *
 * Malformed identities and envelopes fail the page. Unreadable ciphertext is
 * classified separately after validation, retaining identity and revision so
 * coverage advances without treating the row as deletion evidence.
 */
export function assertValidIndexChange(change: IndexChangeWire): void {
  if (change.removalReason !== undefined && (!change.deleted || change.entity !== 'session'
    || !['expired', 'deleted'].includes(change.removalReason))) {
    throw new IndexEntryDecryptionError('Invalid session removal reason');
  }
  if (change.entity !== 'session' && change.entity !== 'project' && change.entity !== 'file') {
    throw new IndexEntryDecryptionError(`Unknown index entity '${String((change as { entity?: unknown }).entity)}' for ${String(change.id)}`);
  }
  if (typeof change.id !== 'string' || change.id.length === 0) {
    throw new IndexEntryDecryptionError(`Index change for ${change.entity} carried no id`);
  }
  if (!Number.isSafeInteger(change.revision) || change.revision < 0) {
    throw new IndexEntryDecryptionError(`Index change ${change.entity}:${change.id} carried an unusable revision: ${String(change.revision)}`);
  }
  if (typeof change.deleted !== 'boolean') {
    throw new IndexEntryDecryptionError(`Index change ${change.entity}:${change.id} carried a non-boolean deleted flag`);
  }

  const payloads = [change.session, change.project, change.file].filter((p) => p !== undefined);
  if (change.deleted) {
    // A tombstone with a payload is ambiguous: delete or upsert?
    if (payloads.length > 0) {
      throw new IndexEntryDecryptionError(`Tombstone ${change.entity}:${change.id} carried a payload`);
    }
    return;
  }
  if (payloads.length !== 1) {
    throw new IndexEntryDecryptionError(`Index change ${change.entity}:${change.id} carried ${payloads.length} payloads; expected exactly 1`);
  }

  // The payload has to be the one the entity names, and it has to describe the
  // same row the change id does -- otherwise the mirror would key a row by one
  // identity while holding another's data.
  if (change.entity === 'session') {
    if (!change.session) throw new IndexEntryDecryptionError(`Session change ${change.id} carried a non-session payload`);
    if (change.session.sessionId !== change.id) {
      throw new IndexEntryDecryptionError(`Session change ${change.id} carries payload for ${String(change.session.sessionId)}`);
    }
    return;
  }
  if (change.entity === 'project') {
    if (!change.project) throw new IndexEntryDecryptionError(`Project change ${change.id} carried a non-project payload`);
    // Project identity on the wire is the ENCRYPTED project id.
    if (change.project.encryptedProjectId !== change.id) {
      throw new IndexEntryDecryptionError(`Project change ${change.id} carries payload for a different encrypted project id`);
    }
    return;
  }
  if (!change.file) throw new IndexEntryDecryptionError(`File change ${change.id} carried a non-file payload`);
  if (change.file.docId !== change.id) {
    throw new IndexEntryDecryptionError(`File change ${change.id} carries payload for ${String(change.file.docId)}`);
  }
}
