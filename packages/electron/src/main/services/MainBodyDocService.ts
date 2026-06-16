/**
 * MainBodyDocService
 *
 * Main-process service that lands MCP body writes against the same Y.Doc
 * warm renderer peers are editing. Without this, a `tracker_update` with
 * `description` only updates PGLite + bumps `body_version` -- the live
 * DocumentRoom Y.Doc keeps its in-flight state, and the peer's next
 * autosave overwrites the MCP write.
 *
 * Architecture (Option A in tracker-sync-limitations-resolution.md):
 *
 *   MCP -> ElectronDocumentService.updateTrackerItemContent
 *      -> MainBodyDocService.applyMarkdown(workspacePath, itemId, md)
 *         -> acquire / create entry { DocumentSyncProvider, HeadlessLexicalYDoc }
 *         -> HeadlessLexicalYDoc.applyUpdate(seedFromMarkdown)
 *            -> Y.Doc update -> DocumentSyncProvider broadcasts -> peers receive
 *
 * Entries are pooled per (workspacePath, itemId) with a 30s idle TTL and
 * a 25-entry LRU cap per workspace. Awareness is suppressed -- the
 * provider never calls `setLocalAwareness`, so warm peers don't see the
 * service as a phantom presence.
 */
import WebSocket from 'ws';
import {
  DocumentSyncProvider,
  HeadlessLexicalYDoc,
  type DocumentSyncConfig,
  type DocumentSyncStatus,
} from '@nimbalyst/runtime/sync';
import { HeadlessBodyNodes, getEditorTransformers, $convertFromEnhancedMarkdownString } from '@nimbalyst/runtime/editor';
import { $getRoot } from 'lexical';
import { logger } from '../utils/logger';
import { getCollabSyncWsUrl } from '../utils/collabSyncUrl';
import { findTeamForWorkspace, getOrgScopedJwt } from './TeamService';
import { getOrgKey, getOrgKeyFingerprint, fetchAndUnwrapOrgKey } from './OrgKeyService';

const IDLE_TTL_MS = 30_000;
const MAX_WARM_ENTRIES = 25;

interface BodyEntry {
  workspacePath: string;
  itemId: string;
  provider: DocumentSyncProvider;
  ydoc: HeadlessLexicalYDoc;
  /** When the next idle eviction is scheduled. Reset on every apply. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Last touch time -- used for LRU eviction when the cap is hit. */
  touchedAt: number;
  /** Resolves once the provider reaches 'connected'. Subsequent
   *  `applyMarkdown` calls await this so the binding writes against a
   *  populated Y.Doc, not an empty one. */
  ready: Promise<boolean>;
  destroyed: boolean;
}

const entries = new Map<string, BodyEntry>();

function entryKey(workspacePath: string, itemId: string): string {
  return `${workspacePath}::${itemId}`;
}

/**
 * Resolve a DocumentSyncConfig for `(workspacePath, itemId)` using the
 * team's org key and JWT. Returns null when the workspace has no team or
 * the org envelope hasn't been shared yet.
 */
async function resolveConfig(
  workspacePath: string,
  itemId: string,
): Promise<DocumentSyncConfig | null> {
  const team = await findTeamForWorkspace(workspacePath);
  if (!team) return null;

  let key = await getOrgKey(team.orgId);
  if (!key) {
    try {
      const orgJwt = await getOrgScopedJwt(team.orgId);
      key = await fetchAndUnwrapOrgKey(team.orgId, orgJwt);
    } catch (err) {
      logger.main.warn('[MainBodyDocService] failed to fetch org key envelope:', err);
    }
  }
  if (!key) return null;

  const fingerprint = getOrgKeyFingerprint(team.orgId);
  const documentId = `tracker-content/${itemId}`;

  return {
    serverUrl: getCollabSyncWsUrl(),
    getJwt: () => getOrgScopedJwt(team.orgId),
    orgId: team.orgId,
    documentKey: key,
    orgKeyFingerprint: fingerprint ?? undefined,
    // `userId` is informational; the server treats the JWT sub as
    // authoritative. Empty is fine.
    userId: '',
    documentId,
    // Node's bundled global WebSocket is unavailable on older Electron
    // versions; use the `ws` package consistently with TrackerSyncManager.
    createWebSocket: ((url: string) => new WebSocket(url)) as unknown as DocumentSyncConfig['createWebSocket'],
    // No reviewGate -- the service-as-peer must never block on user
    // approval; it just lands the merge and exits.
    reviewGateEnabled: false,
  };
}

async function acquireEntry(
  workspacePath: string,
  itemId: string,
): Promise<BodyEntry | null> {
  const key = entryKey(workspacePath, itemId);
  let entry = entries.get(key);
  if (entry) {
    entry.touchedAt = Date.now();
    bumpIdleTimer(entry);
    return entry;
  }

  // Cap enforcement: evict the oldest entry for this workspace if we're
  // at the limit. LRU by `touchedAt`.
  const sameWorkspace = Array.from(entries.values()).filter((e) => e.workspacePath === workspacePath);
  if (sameWorkspace.length >= MAX_WARM_ENTRIES) {
    const oldest = sameWorkspace.sort((a, b) => a.touchedAt - b.touchedAt)[0];
    destroyEntry(oldest);
  }

  const config = await resolveConfig(workspacePath, itemId);
  if (!config) return null;

  // Awareness suppression: the headless binding never registers focus
  // tracking, and we never call `provider.setLocalAwareness`. The
  // CollabLexicalProvider wrapper exposes a Provider-shaped `awareness`
  // object whose setLocalState is a no-op when nothing's wired through
  // it, so a warm renderer peer will not see this service as a phantom
  // user. (`@lexical/yjs createBinding` reads from the provider's
  // awareness only on demand.)
  const provider = new DocumentSyncProvider(config);
  const ydoc = provider.getYDoc();

  // Build a thin adapter that meets the @lexical/yjs Provider contract
  // backed by our DocumentSyncProvider. We don't share the renderer's
  // CollabLexicalProvider because that wrapper is renderer-flavored
  // (deferred sync semantics intended for a populated room); the
  // headless service wants the simplest possible "connect, broadcast,
  // disconnect" shape.
  const headless = new HeadlessLexicalYDoc({
    doc: ydoc,
    // Full markdown-producible node set (list/link/image/...), not the minimal
    // EditorNodes -- otherwise list-bearing bodies throw "Node list is not
    // registered" and never seed (NIM imported-body bug).
    nodes: HeadlessBodyNodes,
    provider: makeHeadlessProviderShim(provider),
  });

  let connected = false;
  const ready = new Promise<boolean>((resolve) => {
    const interval = setInterval(() => {
      if (connected) {
        clearInterval(interval);
        resolve(true);
      }
    }, 50);
    setTimeout(() => {
      clearInterval(interval);
      if (!connected) resolve(false);
    }, 5_000);
  });

  config.onStatusChange = (status: DocumentSyncStatus) => {
    if (status === 'connected') connected = true;
  };

  entry = {
    workspacePath,
    itemId,
    provider,
    ydoc: headless,
    idleTimer: null,
    touchedAt: Date.now(),
    ready,
    destroyed: false,
  };
  entries.set(key, entry);
  bumpIdleTimer(entry);

  try {
    await provider.connect();
  } catch (err) {
    logger.main.warn('[MainBodyDocService] connect failed for', itemId, ':', err);
    destroyEntry(entry);
    return null;
  }

  return entry;
}

function bumpIdleTimer(entry: BodyEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    destroyEntry(entry);
  }, IDLE_TTL_MS);
}

function destroyEntry(entry: BodyEntry): void {
  if (entry.destroyed) return;
  entry.destroyed = true;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  try { entry.ydoc.destroy(); } catch { /* ignore */ }
  try { entry.provider.destroy(); } catch { /* ignore */ }
  entries.delete(entryKey(entry.workspacePath, entry.itemId));
}

/**
 * Adapter from our `DocumentSyncProvider` to the `Provider` interface
 * `@lexical/yjs.createBinding` expects. Awareness is a no-op so the
 * service doesn't emit phantom presence.
 */
function makeHeadlessProviderShim(provider: DocumentSyncProvider): any {
  const noopAwareness = {
    getLocalState: () => null,
    getStates: () => new Map(),
    setLocalState: () => { /* intentional no-op */ },
    setLocalStateField: () => { /* intentional no-op */ },
    on: () => { /* no awareness events surface from this client */ },
    off: () => { /* no-op */ },
  };
  const noopListeners = new Map<string, Set<(...args: any[]) => void>>();
  const shim = {
    awareness: noopAwareness,
    connect: () => provider.connect(),
    disconnect: () => provider.disconnect(),
    on: (type: string, cb: (...args: any[]) => void) => {
      // `createBinding` watches 'sync' and 'reload' events. We don't
      // surface those from DocumentSyncProvider because the binding only
      // uses them for cursor reset / awareness reload, which we don't
      // need.
      let set = noopListeners.get(type);
      if (!set) {
        set = new Set();
        noopListeners.set(type, set);
      }
      set.add(cb);
    },
    off: (type: string, cb: (...args: any[]) => void) => {
      noopListeners.get(type)?.delete(cb);
    },
    // Pass through the Y.Doc reference so callers don't accidentally
    // create a second doc.
    getYDoc: () => provider.getYDoc(),
  };
  return shim;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Apply a markdown body write to the live Y.Doc for `itemId`. If the
 * workspace has no team, this is a no-op. Errors are logged but never
 * thrown -- the caller's PGLite write + metadata `bodyVersion` bump is
 * the durable record; this is the best-effort fan-out to warm peers.
 */
export async function applyHeadlessBodyMarkdown(
  workspacePath: string,
  itemId: string,
  markdown: string,
): Promise<void> {
  try {
    const entry = await acquireEntry(workspacePath, itemId);
    if (!entry) return;
    await entry.ready;
    entry.ydoc.applyUpdate(() => {
      const root = $getRoot();
      root.clear();
      $convertFromEnhancedMarkdownString(markdown, getEditorTransformers());
    });
  } catch (err) {
    logger.main.warn('[MainBodyDocService] applyHeadlessBodyMarkdown failed for', itemId, ':', err);
  }
}

/**
 * Destroy all warm entries for a workspace. Called when a workspace
 * window closes or the user disconnects from sync.
 */
export function shutdownHeadlessBodyWritesForWorkspace(workspacePath: string): void {
  for (const entry of Array.from(entries.values())) {
    if (entry.workspacePath === workspacePath) destroyEntry(entry);
  }
}

/**
 * Destroy every warm entry across all workspaces. Used on app shutdown.
 */
export function shutdownAllHeadlessBodyWrites(): void {
  for (const entry of Array.from(entries.values())) destroyEntry(entry);
}
