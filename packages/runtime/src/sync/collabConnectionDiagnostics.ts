/**
 * Development-only lifecycle diagnostics for collaborative document connections.
 *
 * Enable in a running development renderer with:
 *   globalThis.__NIMBALYST_COLLAB_CONNECTION_DIAGNOSTICS__ = true
 *
 * Every call site is guarded by the build-time constant below, so production
 * builds erase both the event payload construction and this module.
 */

export interface CollabConnectionDiagnosticContext {
  cache?: 'body-doc' | 'document-replica';
  cacheKey?: string;
  documentId?: string;
  itemId?: string;
  shared?: boolean;
}

type DiagnosticLayer =
  | 'BodyDocCache'
  | 'DocumentReplicaCache'
  | 'DocumentSyncProvider'
  | 'CollabLexicalProvider'
  | 'YDoc';

type LexicalAggregate = {
  adapters: Set<object>;
  liveBindings: Set<object>;
  activeBridges: Set<object>;
};

const PREFIX = '[CollabConnection]';
const ids = new WeakMap<object, string>();
const contexts = new WeakMap<object, CollabConnectionDiagnosticContext>();
const lexicalAggregates = new WeakMap<object, LexicalAggregate>();
let nextInstanceId = 1;
let sequence = 1;

/** Build-time guard. Browser collab bundles force this off even under a dev shell. */
export const COLLAB_CONNECTION_DIAGNOSTICS_COMPILED = import.meta.env.DEV
  && import.meta.env.VITE_COLLAB_CONNECTION_DIAGNOSTICS !== 'off';

function isEnabled(): boolean {
  return COLLAB_CONNECTION_DIAGNOSTICS_COMPILED
    && (globalThis as typeof globalThis & {
      __NIMBALYST_COLLAB_CONNECTION_DIAGNOSTICS__?: boolean;
    }).__NIMBALYST_COLLAB_CONNECTION_DIAGNOSTICS__ === true;
}

function prefixFor(layer: DiagnosticLayer): string {
  switch (layer) {
    case 'BodyDocCache': return 'body';
    case 'DocumentReplicaCache': return 'replica';
    case 'DocumentSyncProvider': return 'sync';
    case 'CollabLexicalProvider': return 'lexical';
    case 'YDoc': return 'ydoc';
  }
}

export function getCollabConnectionInstanceId(
  owner: object,
  layer: DiagnosticLayer,
): string {
  let id = ids.get(owner);
  if (!id) {
    id = `${prefixFor(layer)}-${nextInstanceId++}`;
    ids.set(owner, id);
  }
  return id;
}

export function setCollabConnectionDiagnosticContext(
  owner: object,
  context: CollabConnectionDiagnosticContext,
): void {
  if (!COLLAB_CONNECTION_DIAGNOSTICS_COMPILED) return;
  contexts.set(owner, { ...contexts.get(owner), ...context });
}

export function emitCollabConnectionEvent(
  owner: object,
  layer: DiagnosticLayer,
  event: string,
  details: Record<string, unknown> = {},
): void {
  if (!isEnabled()) return;
  console.debug(PREFIX, JSON.stringify({
    sequence: sequence++,
    timestamp: new Date().toISOString(),
    layer,
    event,
    instanceId: getCollabConnectionInstanceId(owner, layer),
    ...contexts.get(owner),
    ...details,
  }));
}

/**
 * Emit a Lexical-adapter event with shared-provider aggregate counts.
 * `liveBindings` follows connect/disconnect; `activeBridges` follows the Y.Doc
 * listener bridge, which intentionally survives a soft disconnect.
 */
export function emitCollabLexicalConnectionEvent(
  adapter: object,
  syncProvider: object,
  event: 'construct' | 'prepare-for-binding' | 'connect' | 'disconnect'
    | 'bridge-attach' | 'bridge-detach' | 'editor-doc-rotate' | 'destroy'
    | 'bridge-shared-to-editor' | 'bridge-editor-to-shared',
  details: Record<string, unknown> = {},
): void {
  if (!isEnabled()) return;
  const aggregate = lexicalAggregates.get(syncProvider) ?? {
    adapters: new Set<object>(),
    liveBindings: new Set<object>(),
    activeBridges: new Set<object>(),
  };
  lexicalAggregates.set(syncProvider, aggregate);

  switch (event) {
    case 'construct':
      aggregate.adapters.add(adapter);
      break;
    case 'connect':
      aggregate.liveBindings.add(adapter);
      break;
    case 'disconnect':
      aggregate.liveBindings.delete(adapter);
      break;
    case 'bridge-attach':
      aggregate.activeBridges.add(adapter);
      break;
    case 'bridge-detach':
      aggregate.activeBridges.delete(adapter);
      break;
    case 'destroy':
      aggregate.adapters.delete(adapter);
      aggregate.liveBindings.delete(adapter);
      aggregate.activeBridges.delete(adapter);
      break;
    default:
      break;
  }

  const syncContext = contexts.get(syncProvider);
  contexts.set(adapter, { ...syncContext, ...contexts.get(adapter) });
  emitCollabConnectionEvent(adapter, 'CollabLexicalProvider', event, {
    syncProviderId: getCollabConnectionInstanceId(syncProvider, 'DocumentSyncProvider'),
    adapterCount: aggregate.adapters.size,
    liveBindings: aggregate.liveBindings.size,
    activeBridges: aggregate.activeBridges.size,
    ...details,
  });
}
