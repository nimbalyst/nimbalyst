import { describe, it, expect } from 'vitest';
import {
  normalizeTrackerOrigin,
  getExternalOrigin,
  isImportedItem,
  getOriginUrn,
  originToLegacyFields,
} from '../trackerOrigin';
import type { ExternalSourceRef, TrackerOrigin } from '../DocumentService';

const externalRef: ExternalSourceRef = {
  providerId: 'github-issues',
  externalId: '42',
  urn: 'github://nimbalyst/nimbalyst#42',
  url: 'https://github.com/nimbalyst/nimbalyst/issues/42',
  titleSnapshot: 'Something is broken',
  stateSnapshot: 'open',
  importedAt: '2026-06-07T00:00:00.000Z',
  lastSyncedAt: '2026-06-07T00:00:00.000Z',
};

describe('normalizeTrackerOrigin', () => {
  it('returns an explicit origin unchanged', () => {
    const origin: TrackerOrigin = { kind: 'external', external: externalRef };
    expect(normalizeTrackerOrigin({ origin })).toBe(origin);
  });

  it('defaults legacy items with no source to native', () => {
    expect(normalizeTrackerOrigin({})).toEqual({ kind: 'native' });
  });

  it('maps legacy inline/frontmatter source to the structured kind', () => {
    expect(normalizeTrackerOrigin({ source: 'inline', sourceRef: 'docs/a.md' })).toEqual({
      kind: 'inline',
      filePath: 'docs/a.md',
    });
    expect(
      normalizeTrackerOrigin({ source: 'frontmatter', module: 'docs/b.md' }),
    ).toEqual({ kind: 'frontmatter', filePath: 'docs/b.md' });
  });

  it('synthesizes an external ref from a legacy "scheme:id" import sourceRef', () => {
    const origin = normalizeTrackerOrigin({ source: 'import', sourceRef: 'linear:NIM-123' });
    expect(origin.kind).toBe('external');
    if (origin.kind !== 'external') throw new Error('expected external');
    expect(origin.external.providerId).toBe('linear');
    expect(origin.external.externalId).toBe('NIM-123');
    expect(origin.external.urn).toBe('linear://NIM-123');
  });

  it('falls back to native for an import with an unparseable sourceRef', () => {
    expect(normalizeTrackerOrigin({ source: 'import' })).toEqual({ kind: 'native' });
  });
});

describe('origin accessors', () => {
  it('extracts the external ref and urn for imported items', () => {
    const item = { origin: { kind: 'external', external: externalRef } as TrackerOrigin };
    expect(isImportedItem(item)).toBe(true);
    expect(getExternalOrigin(item)).toBe(externalRef);
    expect(getOriginUrn(item)).toBe('github://nimbalyst/nimbalyst#42');
  });

  it('returns null for native items', () => {
    expect(isImportedItem({})).toBe(false);
    expect(getExternalOrigin({})).toBeNull();
    expect(getOriginUrn({})).toBeNull();
  });
});

describe('originToLegacyFields', () => {
  it('round-trips an external origin to source=import + urn sourceRef', () => {
    expect(originToLegacyFields({ kind: 'external', external: externalRef })).toEqual({
      source: 'import',
      sourceRef: 'github://nimbalyst/nimbalyst#42',
    });
  });

  it('maps native/inline/frontmatter', () => {
    expect(originToLegacyFields({ kind: 'native' })).toEqual({ source: 'native' });
    expect(originToLegacyFields({ kind: 'inline', filePath: 'a.md' })).toEqual({
      source: 'inline',
      sourceRef: 'a.md',
    });
  });
});
