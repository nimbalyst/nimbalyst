import { describe, expect, it } from 'vitest';
import { reconcileExternalFieldChanges } from '../trackerDetailFieldSync';

describe('reconcileExternalFieldChanges (NIM-790)', () => {
  it('drops a stale override when its persisted value changed externally', () => {
    // Panel opened with showNotes='' (user override), then MCP set it to 'live'.
    const { clearedFields } = reconcileExternalFieldChanges({
      previousPersisted: { showNotes: '' },
      currentPersisted: { showNotes: 'live' },
      overriddenFields: ['showNotes'],
      pendingFields: new Set(),
    });
    expect(clearedFields).toEqual(['showNotes']);
  });

  it('keeps the override while the user is mid-edit (pending save)', () => {
    const { clearedFields } = reconcileExternalFieldChanges({
      previousPersisted: { showNotes: '' },
      currentPersisted: { showNotes: 'live' },
      overriddenFields: ['showNotes'],
      pendingFields: new Set(['showNotes']),
    });
    expect(clearedFields).toEqual([]);
  });

  it('leaves overrides untouched when nothing changed externally', () => {
    const { clearedFields } = reconcileExternalFieldChanges({
      previousPersisted: { showNotes: 'same', owner: 'a@b.c' },
      currentPersisted: { showNotes: 'same', owner: 'a@b.c' },
      overriddenFields: ['showNotes', 'owner'],
      pendingFields: new Set(),
    });
    expect(clearedFields).toEqual([]);
  });

  it('only considers fields that actually have a local override', () => {
    const { clearedFields } = reconcileExternalFieldChanges({
      previousPersisted: { showNotes: '', other: 1 },
      currentPersisted: { showNotes: 'live', other: 2 },
      overriddenFields: ['showNotes'], // 'other' changed but is not overridden
      pendingFields: new Set(),
    });
    expect(clearedFields).toEqual(['showNotes']);
  });
});
