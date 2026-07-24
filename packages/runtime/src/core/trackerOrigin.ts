/**
 * Helpers for the structured {@link TrackerOrigin} field on tracker items.
 *
 * `origin` superseded the loose `source` / `sourceRef` pair. Legacy items
 * (written before `origin` existed) carry only the deprecated fields, so every
 * read path should funnel through {@link normalizeTrackerOrigin} to get a
 * well-formed origin without a destructive schema migration. The field lives
 * inside the `data` JSONB column, so this is additive — no PGLite/SQLite DDL is
 * required for the value itself (only the URN index, handled separately).
 */

import type {
  ExternalSourceRef,
  TrackerItemSource,
  TrackerOrigin,
} from './DocumentService';

/** Minimal shape needed to derive an origin — works on partial/legacy rows. */
export interface OriginCarrier {
  origin?: TrackerOrigin;
  source?: TrackerItemSource;
  sourceRef?: string;
  /** Legacy file-path field for inline/frontmatter items. */
  module?: string;
}

/**
 * Best-effort parse of a legacy `sourceRef` string into an external ref.
 * Legacy imports stored values like `linear:NIM-123` (single colon) or a bare
 * URL. We synthesize a URN and fall back gracefully when the shape is unknown.
 */
function parseLegacySourceRef(sourceRef: string): ExternalSourceRef | null {
  const trimmed = sourceRef.trim();
  if (!trimmed) return null;

  // `<scheme>:<id>` (the format earmarked in the original comment).
  const colon = trimmed.indexOf(':');
  if (colon > 0 && !trimmed.startsWith('http')) {
    const providerId = trimmed.slice(0, colon);
    const externalId = trimmed.slice(colon + 1);
    if (providerId && externalId) {
      return {
        providerId,
        externalId,
        urn: `${providerId}://${externalId}`,
        url: '',
        titleSnapshot: '',
        importedAt: '',
        lastSyncedAt: '',
      };
    }
  }

  // Bare URL — keep it as the canonical URL with an opaque id.
  if (trimmed.startsWith('http')) {
    return {
      providerId: 'unknown',
      externalId: trimmed,
      urn: `external://${trimmed}`,
      url: trimmed,
      titleSnapshot: '',
      importedAt: '',
      lastSyncedAt: '',
    };
  }

  return null;
}

/**
 * Resolve a tracker item's origin, synthesizing one from the deprecated
 * `source`/`sourceRef` fields when `origin` is absent. Always returns a value;
 * defaults to `{ kind: 'native' }`.
 */
export function normalizeTrackerOrigin(item: OriginCarrier): TrackerOrigin {
  if (item.origin) return item.origin;

  switch (item.source) {
    case 'inline':
      return { kind: 'inline', filePath: item.sourceRef ?? item.module ?? '' };
    case 'frontmatter':
      return { kind: 'frontmatter', filePath: item.sourceRef ?? item.module ?? '' };
    case 'import': {
      const external = item.sourceRef ? parseLegacySourceRef(item.sourceRef) : null;
      if (external) return { kind: 'external', external };
      return { kind: 'native' };
    }
    default:
      return { kind: 'native' };
  }
}

/** Returns the external ref if the item was imported, else null. */
export function getExternalOrigin(item: OriginCarrier): ExternalSourceRef | null {
  const origin = normalizeTrackerOrigin(item);
  return origin.kind === 'external' ? origin.external : null;
}

/** True when the item originated from an external provider import. */
export function isImportedItem(item: OriginCarrier): boolean {
  return normalizeTrackerOrigin(item).kind === 'external';
}

/** The URN of an imported item, or null for non-imports. */
export function getOriginUrn(item: OriginCarrier): string | null {
  return getExternalOrigin(item)?.urn ?? null;
}

/**
 * Map a {@link TrackerOrigin} back onto the deprecated `source`/`sourceRef`
 * fields so older clients (and the legacy frontmatter/inline code paths) keep
 * working while both representations are written during the deprecation window.
 */
export function originToLegacyFields(origin: TrackerOrigin): {
  source: TrackerItemSource;
  sourceRef?: string;
} {
  switch (origin.kind) {
    case 'native':
      return { source: 'native' };
    case 'inline':
      return { source: 'inline', sourceRef: origin.filePath };
    case 'frontmatter':
      return { source: 'frontmatter', sourceRef: origin.filePath };
    case 'external':
      return { source: 'import', sourceRef: origin.external.urn };
  }
}
