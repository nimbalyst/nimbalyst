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
  type DocumentSyncConfig,
  type DocumentSyncStatus,
} from '@nimbalyst/runtime/sync';
import { convertFromFileIntoDoc, convertRecoveryPlaintext } from './CollabConversionClient';
import { logger } from '../utils/logger';
import { getCollabSyncWsUrl } from '../utils/collabSyncUrl';
import { findTeamForWorkspace, getOrgScopedJwt } from './TeamService';
import { getOrgKey, getOrgKeyFingerprint, fetchAndUnwrapOrgKey, fetchTeamKeyStatus, getLastKnownTeamKeyStatus } from './OrgKeyService';
import { getCollabBackupService } from './CollabBackupService';

const IDLE_TTL_MS = 30_000;
const MAX_WARM_ENTRIES = 25;

interface BodyEntry {
  workspacePath: string;
  itemId: string;
  provider: DocumentSyncProvider;
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

  // Determine key custody (NIM-878). On failure, fall back to the LAST-KNOWN
  // mode for the org (NIM-1778) -- hardcoding legacy-e2e misroutes a
  // server-managed team into the legacy encrypt/decrypt lane. Only an org we
  // have never successfully resolved defaults to legacy-e2e, so a status
  // hiccup still can't cause us to send plaintext into a legacy room.
  let serverManaged = false;
  try {
    const orgJwt = await getOrgScopedJwt(team.orgId);
    serverManaged = (await fetchTeamKeyStatus(team.orgId, orgJwt)).mode === 'server-managed';
  } catch (err) {
    serverManaged = getLastKnownTeamKeyStatus(team.orgId)?.mode === 'server-managed';
    logger.main.warn('[MainBodyDocService] key-status resolve failed; using last-known mode (serverManaged:', serverManaged, '):', err);
  }

  let key = await getOrgKey(team.orgId);
  if (!key) {
    try {
      const orgJwt = await getOrgScopedJwt(team.orgId);
      key = await fetchAndUnwrapOrgKey(team.orgId, orgJwt);
    } catch (err) {
      logger.main.warn('[MainBodyDocService] failed to fetch org key envelope:', err);
    }
  }
  // Legacy mode REQUIRES the org key (it encrypts/decrypts with it). Server-
  // managed mode writes PLAINTEXT, so it can proceed without the key -- the key,
  // when available, is only used to read PRE-MIGRATION legacy rows.
  if (!key && !serverManaged) return null;

  const fingerprint = getOrgKeyFingerprint(team.orgId);
  const documentId = `tracker-content/${itemId}`;

  return {
    serverUrl: getCollabSyncWsUrl(),
    getJwt: () => getOrgScopedJwt(team.orgId),
    orgId: team.orgId,
    // In server-managed mode the body syncs PLAINTEXT (no AES on write); the org
    // key (if present) is supplied as the LEGACY key so the headless peer can
    // still read pre-migration ciphertext rows when it loads the room.
    keyCustody: serverManaged ? 'server-managed' : 'legacy-e2e',
    documentKey: serverManaged ? undefined : (key ?? undefined),
    legacyDocumentKey: serverManaged ? (key ?? undefined) : undefined,
    orgKeyFingerprint: serverManaged ? undefined : (fingerprint ?? undefined),
    // `userId` is informational; the server treats the JWT sub as
    // authoritative. Empty is fine.
    userId: '',
    documentId,
    onContentChanged: (yDoc) => {
      getCollabBackupService().onContentChanged({
        documentId,
        orgId: team.orgId,
        projectId: team.teamProjectId ?? null,
        documentType: 'markdown',
        title: itemId,
        relativePath: null,
        kind: 'body',
        extension: '.md',
        // Serialization is deliberately deferred: the backup service calls
        // this only after its debounce settles, so a burst of edits costs one
        // conversion round trip instead of one per change -- and the captured
        // text is the doc as of the write, not as of the first keystroke.
        getPlaintext: async () => {
          const plaintext = await convertRecoveryPlaintext('markdown', yDoc, { workspacePath });
          if (plaintext === null) {
            throw new Error('The markdown codec did not return UTF-8 plaintext');
          }
          return plaintext;
        },
      });
    },
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

  // Awareness suppression: this peer never registers focus tracking and we
  // never call `provider.setLocalAwareness`, so a warm renderer peer will not
  // see this service as a phantom user.
  const provider = new DocumentSyncProvider(config);

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
  try { entry.provider.destroy(); } catch { /* ignore */ }
  entries.delete(entryKey(entry.workspacePath, entry.itemId));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Apply a markdown body write to the live Y.Doc for `itemId`. If the workspace
 * has no team, this is a no-op.
 *
 * Returns whether the write reached the room. The caller's PGLite write +
 * `bodyVersion` bump is the durable record, so a failure here is not fatal --
 * but it means warm peers did NOT get the update, so it is logged at error
 * level rather than swallowed as a warning.
 */
export async function applyHeadlessBodyMarkdown(
  workspacePath: string,
  itemId: string,
  markdown: string,
): Promise<boolean> {
  try {
    const entry = await acquireEntry(workspacePath, itemId);
    if (!entry) return false;
    await entry.ready;
    await convertFromFileIntoDoc(
      'applyFromFile',
      'markdown',
      entry.provider.getYDoc(),
      markdown,
      { workspacePath },
    );
    return true;
  } catch (err) {
    logger.main.error(
      '[MainBodyDocService] Live body fan-out failed; warm peers did not receive this write',
      { itemId, workspacePath, error: err instanceof Error ? err.message : String(err) },
    );
    return false;
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
