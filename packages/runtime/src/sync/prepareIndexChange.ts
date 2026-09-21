import type { IndexChangeWire } from './collabV3WireTypes';
import type { DecryptedIndexChange } from './indexReplicationClient';
import { assertValidIndexChange } from './indexChangeValidation';
import { IndexEntryDecryptionError } from './indexEntryDecryptionError';

/** Validate identity before classifying unreadable ciphertext: malformed rows still fail the page. */
export async function prepareIndexChange<S, P, F>(
  change: IndexChangeWire,
  decryptValue: () => Promise<Pick<DecryptedIndexChange<S, P, F>, 'session' | 'project' | 'file'>>,
): Promise<DecryptedIndexChange<S, P, F>> {
  assertValidIndexChange(change);
  const identity = { entity: change.entity, id: change.id, revision: change.revision };
  if (change.deleted) return { ...identity, deleted: true, removalReason: change.removalReason };
  try {
    return { ...identity, deleted: false, ...await decryptValue() };
  } catch (error) {
    if (!(error instanceof IndexEntryDecryptionError)) throw error;
    // Retain ordering and coverage, never payloads or deletion evidence.
    return { ...identity, unreadable: true };
  }
}
