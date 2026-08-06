// @vitest-environment node
/**
 * The sharer of a plan must end up in the SAME editor as their teammates.
 *
 * Before promotion, a shared file-backed plan stayed `contentMode:
 * 'file-backed'` on the sharer's machine (its row kept `documentPath` and
 * `source: 'frontmatter'`), so the sharer kept editing the markdown file while
 * everyone else edited the collab doc and the two copies forked immediately.
 */

import { describe, it, expect } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { isFileBackedRecord, isNativeItem, resolveTrackerContentMode } from '../trackerContentMode';

const REL = 'nimbalyst-local/plans/example.md';

function makeRecord(overrides: { id?: string; source?: string; documentPath?: string }): TrackerRecord {
  return {
    id: overrides.id ?? 'plan_1753900000000_a1b2c3',
    primaryType: 'plan',
    source: overrides.source,
    system: { documentPath: overrides.documentPath },
  } as unknown as TrackerRecord;
}

/** An unshared plan: still projected from its markdown file. */
const fileBacked = makeRecord({ source: 'frontmatter', documentPath: REL });
/** A shared plan after promotion: native, but still remembers its origin file. */
const promoted = makeRecord({ source: 'native', documentPath: REL });
/** An ordinary DB item. */
const native = makeRecord({ source: 'native' });

describe('isNativeItem', () => {
  it('treats a promoted item as native even though it keeps documentPath', () => {
    expect(isNativeItem(promoted)).toBe(true);
    expect(isNativeItem(native)).toBe(true);
    expect(isNativeItem(fileBacked)).toBe(false);
  });
});

describe('isFileBackedRecord', () => {
  /**
   * Shared before promotion existed: the round-trip rewrote `source` to
   * 'native' and dropped documentPath, but the id still names the file. If this
   * reads as native, the share toggle is locked and the item can never leave its
   * `fm:` id.
   */
  const legacyShared = makeRecord({ id: `fm:plan:${REL}`, source: 'native' });

  it('recognizes a legacy fm: item so its share toggle stays unlockable', () => {
    expect(isFileBackedRecord(legacyShared)).toBe(true);
  });

  it('recognizes ordinary file-backed sources', () => {
    expect(isFileBackedRecord(fileBacked)).toBe(true);
    expect(isFileBackedRecord(makeRecord({ source: 'import', documentPath: REL }))).toBe(true);
  });

  it('recognizes a freshly promoted item, which still records its origin file', () => {
    expect(isFileBackedRecord(promoted)).toBe(true);
  });

  it('still refuses a genuinely native item (unsharing would delete it)', () => {
    expect(isFileBackedRecord(native)).toBe(false);
  });
});

describe('resolveTrackerContentMode', () => {
  const team = { syncMode: 'hybrid', teamOrgId: 'organization-live-abc' };

  it('puts a SHARED file-backed plan in the collaborative editor after promotion', () => {
    expect(resolveTrackerContentMode({ item: promoted, isItemShared: true, ...team })).toBe('collaborative');
  });

  it('leaves an unshared plan on its file', () => {
    expect(resolveTrackerContentMode({ item: fileBacked, isItemShared: false, ...team })).toBe('file-backed');
  });

  it('keeps an unshared hybrid item local even once it is native', () => {
    expect(resolveTrackerContentMode({ item: native, isItemShared: false, ...team })).toBe('local-pglite');
  });

  it('falls back to local editing when the workspace has no team', () => {
    expect(resolveTrackerContentMode({
      item: promoted, isItemShared: true, syncMode: 'hybrid', teamOrgId: null,
    })).toBe('local-pglite');
  });

  it('stays collaborative while the team lookup is still pending', () => {
    expect(resolveTrackerContentMode({
      item: promoted, isItemShared: true, syncMode: 'hybrid', teamOrgId: undefined,
    })).toBe('collaborative');
  });

  it('never collaborates for a local-mode tracker type', () => {
    expect(resolveTrackerContentMode({
      item: promoted, isItemShared: true, syncMode: 'local', teamOrgId: 'organization-live-abc',
    })).toBe('local-pglite');
  });
});
