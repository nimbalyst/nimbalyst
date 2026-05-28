/**
 * Runtime registry for CollabContentAdapter instances.
 *
 * One adapter per `documentType`. Extensions that ship multiple
 * document types (e.g. mockuplm with `.mockup.html` and
 * `.mockupproject`) register multiple adapters.
 *
 * The registry is process-local. Main, renderer, and the extension
 * SDK each maintain their own registry instance; the host startup
 * code is responsible for populating each one with the built-in
 * adapters and walking the extension contributions.
 */
import type { Doc } from 'yjs';
import type {
  CollabContentAdapter,
  CollabContentAdapterMigration,
} from './CollabContentAdapter';
import {
  defaultExportRevisionSnapshot,
  defaultRestoreRevisionSnapshot,
} from './snapshot';

const adaptersByDocumentType = new Map<string, CollabContentAdapter>();
const adaptersByExtension = new Map<string, CollabContentAdapter>();
const listeners = new Set<() => void>();

function normalizeExtension(ext: string): string {
  return ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
}

export interface CollabContentAdapterRegistration {
  unregister(): void;
}

export function registerCollabContentAdapter(
  adapter: CollabContentAdapter,
): CollabContentAdapterRegistration {
  if (adaptersByDocumentType.has(adapter.documentType)) {
    // Last-registered wins; this is intentional so extension hot-
    // reload can re-register without a host restart.
    adaptersByDocumentType.delete(adapter.documentType);
    for (const [ext, current] of adaptersByExtension.entries()) {
      if (current.documentType === adapter.documentType) {
        adaptersByExtension.delete(ext);
      }
    }
  }

  adaptersByDocumentType.set(adapter.documentType, adapter);
  for (const ext of adapter.fileExtensions) {
    adaptersByExtension.set(normalizeExtension(ext), adapter);
  }

  for (const listener of listeners) {
    try { listener(); } catch { /* swallow */ }
  }

  return {
    unregister: () => {
      if (adaptersByDocumentType.get(adapter.documentType) !== adapter) return;
      adaptersByDocumentType.delete(adapter.documentType);
      for (const ext of adapter.fileExtensions) {
        const key = normalizeExtension(ext);
        if (adaptersByExtension.get(key) === adapter) {
          adaptersByExtension.delete(key);
        }
      }
      for (const listener of listeners) {
        try { listener(); } catch { /* swallow */ }
      }
    },
  };
}

export function getCollabContentAdapter(
  documentType: string,
): CollabContentAdapter | undefined {
  return adaptersByDocumentType.get(documentType);
}

export function getCollabContentAdapterForExtension(
  extension: string,
): CollabContentAdapter | undefined {
  return adaptersByExtension.get(normalizeExtension(extension));
}

export function listRegisteredCollabContentAdapters(): CollabContentAdapter[] {
  return Array.from(adaptersByDocumentType.values());
}

export function clearCollabContentAdapters(): void {
  adaptersByDocumentType.clear();
  adaptersByExtension.clear();
  for (const listener of listeners) {
    try { listener(); } catch { /* swallow */ }
  }
}

export function onCollabContentAdaptersChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Apply registered migrations to bring the Y.Doc forward to the
 * adapter's current `layoutVersion`. Adapters are responsible for
 * recording the new version inside the Y.Doc (typically in their
 * `meta` map); migrations are pure data transforms.
 *
 * `currentVersion` is the value the adapter discovers in the Y.Doc
 * (e.g. `meta.get('layoutVersion')`). Returns the number of
 * migrations that ran.
 */
export function runAdapterMigrations(
  adapter: CollabContentAdapter,
  yDoc: Doc,
  currentVersion: number,
): number {
  if (!adapter.migrations || adapter.migrations.length === 0) return 0;
  if (currentVersion >= adapter.layoutVersion) return 0;

  const path = orderMigrations(adapter.migrations, currentVersion, adapter.layoutVersion);
  if (!path) return 0;

  let ran = 0;
  yDoc.transact(() => {
    for (const migration of path) {
      migration.run(yDoc);
      ran += 1;
    }
  });
  return ran;
}

function orderMigrations(
  migrations: CollabContentAdapterMigration[],
  fromVersion: number,
  toVersion: number,
): CollabContentAdapterMigration[] | null {
  const path: CollabContentAdapterMigration[] = [];
  let current = fromVersion;
  while (current < toVersion) {
    const next = migrations.find((m) => m.from === current);
    if (!next) return null;
    path.push(next);
    if (next.to <= current) return null; // guard against bad migrations
    current = next.to;
  }
  return path;
}

/**
 * SDK helper: resolve `exportRevisionSnapshot` / `restoreRevisionSnapshot`
 * for an adapter, falling back to the default Y state-vector pair.
 */
export function getRevisionSnapshotFns(adapter: CollabContentAdapter): {
  exportRevisionSnapshot: (yDoc: Doc) => Uint8Array;
  restoreRevisionSnapshot: (yDoc: Doc, bytes: Uint8Array) => void;
} {
  return {
    exportRevisionSnapshot:
      adapter.exportRevisionSnapshot?.bind(adapter) ?? defaultExportRevisionSnapshot,
    restoreRevisionSnapshot:
      adapter.restoreRevisionSnapshot?.bind(adapter) ?? defaultRestoreRevisionSnapshot,
  };
}
