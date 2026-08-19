/**
 * MainBodyDocService
 *
 * Main-process service that lands MCP body writes against the same Y.Doc
 * warm renderer peers are editing. Without this, a `tracker_update` with
 * `description` only updates PGLite + bumps `body_version` -- the live
 * DocumentRoom Y.Doc keeps its in-flight state, and the peer's next
 * autosave overwrites the MCP write.
 *
 * Architecture:
 *
 *   MCP -> ElectronDocumentService.updateTrackerItemContent
 *      -> MainBodyDocService.applyMarkdown(workspacePath, itemId, md)
 *         -> open body: renderer BodyDocCache's existing DocumentSyncProvider
 *         -> closed body: pooled main-process DocumentSyncProvider fallback
 *
 * Entries are pooled per (workspacePath, itemId) with a 30s idle TTL and
 * a 25-entry LRU cap per workspace. Awareness is suppressed -- the
 * provider never calls `setLocalAwareness`, so warm peers don't see the
 * service as a phantom presence.
 */
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import { ipcMain, type BrowserWindow } from 'electron';
import {
  DocumentSyncProvider,
  type DocumentSyncConfig,
  type DocumentSyncStatus,
} from '@nimbalyst/runtime/sync';
import { convertExportToFile, convertFromFileIntoDoc, convertRecoveryPlaintext } from './CollabConversionClient';
import { logger } from '../utils/logger';
import { getCollabSyncWsUrl } from '../utils/collabSyncUrl';
import { findTeamForWorkspace, getOrgScopedIdentity, getOrgScopedJwt } from './TeamService';
import { getCollabBackupService } from './CollabBackupService';
import { windows, windowStates } from '../window/windowState';

const IDLE_TTL_MS = 30_000;
const MAX_WARM_ENTRIES = 25;

/**
 * How long the renderer has to answer the apply request.
 *
 * The renderer's handler is synchronous once the message is dequeued, so this
 * budget is almost entirely main-thread queueing: a large workspace mid-render,
 * a GC pause, or an IPC burst pushes a renderer past a second routinely. The
 * previous 1s budget therefore demoted agent writes to the headless peer under
 * ordinary load -- silently, and into a body someone had open, which is the
 * exact loss this service exists to prevent. The caller is an MCP tool call,
 * where seconds are unremarkable, and this stays well under the 15s codec-host
 * conversion timeout the fallback path itself can spend.
 */
const OPEN_EDITOR_APPLY_TIMEOUT_MS = 5_000;

/**
 * Extra wait beyond the renderer's deadline before main declares a timeout.
 *
 * The renderer refuses to apply once `expiresAt` has passed, so this grace only
 * has to cover delivery of the response for a write that started before the
 * deadline. The refusal and the grace exist as a pair: without them a late
 * renderer apply could race the headless fallback and land the body twice --
 * each replica computes `clear + insert` against a different view of the room,
 * so the two inserts merge instead of replacing one another.
 */
const OPEN_EDITOR_APPLY_GRACE_MS = 250;

/**
 * How long either peer waits for the server's `docUpdateAck` after mutating the
 * Y.Doc.
 *
 * This is the only thing that makes a body write DURABLE. Callers delete the
 * plan's markdown file on the strength of this service returning true, so a
 * mutated local replica is not enough: drop the socket between the mutation and
 * the ack and the body is in no durable place at all -- the room is still empty
 * for a cold teammate and the file has already been overwritten.
 */
const SERVER_ACK_TIMEOUT_MS = 5_000;

type OpenRendererOutcome =
  /** A renderer applied the markdown AND the server acknowledged persisting it. */
  | 'applied'
  /**
   * A renderer mutated its Y.Doc but no `docUpdateAck` arrived in time. The body
   * is local-only, so the caller must treat this as failure -- and must NOT
   * retry through the headless peer, whose `clear + insert` against a replica
   * the renderer already mutated merges into two copies of the body.
   */
  | 'applied-unacknowledged'
  /** No window holds this workspace, or the window has no warm body for the item. */
  | 'no-open-editor'
  /** A window was asked and did not answer; an editor may well be open there. */
  | 'timed-out';

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
 * The single window asked to apply a body write for `workspacePath`.
 *
 * Deliberately one window, not every window holding the workspace: two
 * renderers each running `clear + insert` against their own replica produce two
 * inserts that merge into a duplicated body rather than replacing each other.
 * Asking one is also sufficient -- the applied write reaches the room, and every
 * other peer paints it from the ordinary broadcast.
 *
 * The renderer answers on the authority of its own warm entry, so a window that
 * merely has the workspace open (not active) is a legitimate target: it may hold
 * the open editor.
 */
function findWorkspaceWindow(workspacePath: string): BrowserWindow | null {
  let secondary: BrowserWindow | null = null;
  for (const [windowId, candidate] of windows) {
    if (candidate.isDestroyed() || candidate.webContents.isDestroyed()) continue;
    const state = windowStates.get(windowId);
    if (!state) continue;
    const activeWorkspacePath = state.activeWorkspacePath ?? state.workspacePath;
    if (activeWorkspacePath === workspacePath) return candidate;
    if (
      !secondary &&
      (state.workspacePath === workspacePath || state.additionalWorkspacePaths?.includes(workspacePath))
    ) {
      secondary = candidate;
    }
  }
  return secondary;
}

/**
 * Ask the workspace renderer to replace the body through its warm
 * BodyDocCache entry. That is the exact DocumentSyncProvider the open Lexical
 * editor is bound to, so the write is painted locally before a metadata refresh
 * can remount the editor.
 *
 * The outcomes are NOT interchangeable: `no-open-editor` means the headless peer
 * is the correct answer, `timed-out` means an editor may be open and the caller
 * is about to do something riskier than it looks, and `applied-unacknowledged`
 * means the renderer holds the only copy of the write -- nobody else may retry.
 */
async function applyViaOpenRenderer(
  workspacePath: string,
  itemId: string,
  markdown: string,
): Promise<OpenRendererOutcome> {
  const win = findWorkspaceWindow(workspacePath);
  if (!win) return 'no-open-editor';

  const responseChannel = `tracker-body:apply-markdown-result:${randomUUID()}`;
  const expiresAt = Date.now() + OPEN_EDITOR_APPLY_TIMEOUT_MS;
  return new Promise<OpenRendererOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: OpenRendererOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ipcMain.removeListener(responseChannel, onResponse);
      resolve(outcome);
    };
    const onResponse = (
      event: Electron.IpcMainEvent,
      result: { applied?: boolean; acknowledged?: boolean } | undefined,
    ) => {
      if (event.sender.id !== win.webContents.id) return;
      if (result?.applied !== true) return finish('no-open-editor');
      // A missing `acknowledged` reads as unacknowledged on purpose: the field
      // is the whole durability claim, so its absence must never be optimism.
      finish(result.acknowledged === true ? 'applied' : 'applied-unacknowledged');
    };
    // The renderer's own budget is `expiresAt` to START, then the ack wait; main
    // has to outlast both or it would declare a timeout over a write that is
    // still legitimately in flight and fall back on top of it.
    const timeout = setTimeout(
      () => finish('timed-out'),
      OPEN_EDITOR_APPLY_TIMEOUT_MS + SERVER_ACK_TIMEOUT_MS + OPEN_EDITOR_APPLY_GRACE_MS,
    );

    // A per-request response channel cannot go through `safeOn`: that helper
    // de-duplicates listeners by channel name for the life of the process,
    // which is right for the fixed channels registered during IPC setup and
    // wrong for a listener that must be added and removed per call.
    // `CollabConversionClient` uses this same ipcMain.on/removeListener pair
    // for its per-request response channel.
    ipcMain.on(responseChannel, onResponse);
    try {
      win.webContents.send('tracker-body:apply-markdown', {
        workspacePath,
        itemId,
        markdown,
        responseChannel,
        expiresAt,
      });
    } catch {
      finish('no-open-editor');
    }
  });
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

  const documentId = `tracker-content/${itemId}`;
  const { teamMemberId } = await getOrgScopedIdentity(team.orgId);

  return {
    serverUrl: getCollabSyncWsUrl(),
    getJwt: () => getOrgScopedJwt(team.orgId),
    orgId: team.orgId,
    teamMemberId,
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
 * Returns whether the SERVER acknowledged persisting the write -- not whether a
 * local Y.Doc was mutated. That distinction is the contract: publication deletes
 * the plan's markdown body from disk when this returns true, so anything short
 * of a `docUpdateAck` has to read as failure and leave the file intact.
 *
 * Neither the caller's PGLite write nor its `bodyVersion` bump substitutes for
 * that: both are local markers, set before this call is even attempted.
 *
 * Offline is the ordinary false: the provider never syncs (or the flush is never
 * acked), the wait is bounded by `SERVER_ACK_TIMEOUT_MS`, and the caller reports
 * a failed publication with the file untouched rather than hanging.
 */
export async function applyHeadlessBodyMarkdown(
  workspacePath: string,
  itemId: string,
  markdown: string,
): Promise<boolean> {
  try {
    const outcome = await applyViaOpenRenderer(workspacePath, itemId, markdown);
    if (outcome === 'applied') return true;
    if (outcome === 'applied-unacknowledged') {
      // Deliberately no headless retry: that replica has already been mutated,
      // and a second `clear + insert` computed against a different view of the
      // room merges into two copies of the body instead of replacing one.
      // The renderer's provider keeps the write queued and replays it on
      // reconnect; the caller's job is to keep the file until it can prove it
      // landed.
      logger.main.error(
        '[MainBodyDocService] The open editor applied the body but the server never acknowledged it; reporting failure so the origin file is kept',
        { itemId, workspacePath, ackTimeoutMs: SERVER_ACK_TIMEOUT_MS },
      );
      return false;
    }
    if (outcome === 'timed-out') {
      // Falling through is still the least-bad option -- the room must receive
      // the write or every peer and every later reopen keeps the old body --
      // but it is a demotion to the path this service exists to avoid, so it is
      // never silent.
      logger.main.error(
        '[MainBodyDocService] Renderer did not answer the body-apply request in time; falling back to the headless room peer, which a warm editor peer can overwrite',
        { itemId, workspacePath, timeoutMs: OPEN_EDITOR_APPLY_TIMEOUT_MS },
      );
    }
    const entry = await acquireEntry(workspacePath, itemId);
    if (!entry) return false;
    // An unsynced peer's Y.Doc does not hold the body being replaced, so
    // `applyFromFile`'s clear-then-insert has nothing to clear: the delta is
    // pure insertion and merges into the room as a SECOND copy of the body.
    // Refuse rather than write that. `ready` latches at construction, so a
    // pooled entry that connected later is re-checked against live state.
    if (!(await entry.ready) && !entry.provider.isSynced()) {
      logger.main.error(
        '[MainBodyDocService] Headless peer never synced; refusing a write that would duplicate the room copy of the body',
        { itemId, workspacePath },
      );
      return false;
    }
    await convertFromFileIntoDoc(
      'applyFromFile',
      'markdown',
      entry.provider.getYDoc(),
      markdown,
      { workspacePath },
    );
    // The mutation is local until the room says otherwise. `flushWithAck`
    // settles only when the inflight `docUpdate` is cleared by a matching
    // `docUpdateAck`, which the DocumentRoom sends after persisting to DO
    // storage -- that is the durability signal, and the only one.
    if (!(await entry.provider.flushWithAck(SERVER_ACK_TIMEOUT_MS))) {
      logger.main.error(
        '[MainBodyDocService] Headless peer wrote the body but the server never acknowledged it; the room may still be empty',
        { itemId, workspacePath, ackTimeoutMs: SERVER_ACK_TIMEOUT_MS },
      );
      return false;
    }
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
 * Read the markdown body currently in the live Y.Doc for `itemId`. Returns null
 * if the workspace has no team or the room cannot be reached.
 *
 * The inverse of `applyHeadlessBodyMarkdown`, used when an item's body has to be
 * carried from one room to another: the room is the authoritative copy there,
 * not the local PGLite row and not the markdown file it was seeded from, so
 * re-seeding from either would drop every edit made since the share.
 *
 * `null` means UNREACHABLE and an empty string means "the room is genuinely
 * empty". Callers that collapse a content-bearing file rely on that split, so an
 * unsynced peer -- whose Y.Doc reads empty because it has been told nothing yet
 * -- must never be reported as an empty room. Same for a doc that skipped an
 * undecodable payload: the room holds content this client cannot read.
 */
export async function readHeadlessBodyMarkdown(
  workspacePath: string,
  itemId: string,
): Promise<string | null> {
  try {
    const entry = await acquireEntry(workspacePath, itemId);
    if (!entry) return null;
    if (!(await entry.ready) && !entry.provider.isSynced()) {
      logger.main.warn(
        '[MainBodyDocService] Headless peer never synced; the room contents are unknown, not empty',
        { itemId, workspacePath },
      );
      return null;
    }
    if (entry.provider.hasUndecodedContent()) {
      logger.main.warn(
        '[MainBodyDocService] Room holds content this client could not decode; refusing to report its body',
        { itemId, workspacePath },
      );
      return null;
    }
    const exported = await convertExportToFile('markdown', entry.provider.getYDoc(), { workspacePath });
    return typeof exported === 'string' ? exported : new TextDecoder().decode(exported);
  } catch (err) {
    logger.main.error('[MainBodyDocService] Headless body read failed', {
      itemId,
      workspacePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
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
