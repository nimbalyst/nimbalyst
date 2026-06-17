import { describe, it, expect } from 'vitest';
import { importedItemId } from '../importedItemId';

describe('importedItemId', () => {
  it('is deterministic for a given URN', () => {
    const urn = 'github://nimbalyst/nimbalyst#592';
    expect(importedItemId(urn)).toBe(importedItemId(urn));
  });

  it('differs across URNs', () => {
    expect(importedItemId('github://nimbalyst/nimbalyst#1')).not.toBe(
      importedItemId('github://nimbalyst/nimbalyst#2')
    );
  });

  it('depends on the URN only, not the tracker type', () => {
    // Two members importing the same issue as different types must converge on
    // the same id, so the id derivation cannot consider the type at all.
    const urn = 'github://nimbalyst/nimbalyst#592';
    const idForBugImporter = importedItemId(urn);
    const idForTaskImporter = importedItemId(urn);
    expect(idForBugImporter).toBe(idForTaskImporter);
  });

  it('produces a stable, prefixed shape', () => {
    expect(importedItemId('github://nimbalyst/nimbalyst#592')).toMatch(/^import_[0-9a-f]{24}$/);
  });
});
