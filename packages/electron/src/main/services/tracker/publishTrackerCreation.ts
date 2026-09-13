import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { TrackerItem } from '@nimbalyst/runtime/core/DocumentService';
import type { TrackerCreationPublication } from '@nimbalyst/runtime/core/trackerCreation';
import { MAX_COLLAB_ASSET_BYTES } from '@nimbalyst/runtime/sync/collabAssetFormat';
import { database } from '../../database/PGLiteDatabaseWorker';
import {
  ensureHeadlessBodyRoom,
  initializeHeadlessBodyMarkdown,
} from '../MainBodyDocService';
import {
  resolveTrackerSharingPolicy,
  shouldSyncTrackerItem,
} from '../TrackerPolicyService';
import {
  syncTrackerItem,
  isTrackerSyncActive,
  onTrackerItemApplied,
} from '../TrackerSyncManager';
import { findTeamForWorkspace } from '../TeamService';
import { getPersonalUserId } from '../StytchAuthService';
import { getCollabAssetStore } from '../CollabAssetStore';
import { getCollabAssetOutboxDrainCoordinator } from '../CollabAssetOutboxDrainCoordinator';
import {
  resolveAssetRef,
  scanMarkdownImageRefs,
  rewriteMarkdownImageRefs,
} from '../markdownAssetScanner';
import {
  getCreationReceipt,
  setCreationPublication,
  withCreationLock,
} from './trackerCreationReceipt';

interface PublicationDependencies {
  getItem: (id: string) => Promise<TrackerItem | null>;
  /** Bound on waiting for the room to acknowledge the metadata upsert. */
  ackTimeoutMs?: number;
}

/**
 * `syncTrackerItem` resolves once the mutation is on the socket; the row only
 * turns `synced` when the room's applied echo comes back. Wait for that echo
 * (bounded) before judging metadata, or every first attempt reads as failed.
 */
export const METADATA_ACK_TIMEOUT_MS = 5_000;

async function awaitMetadataAck(
  itemId: string,
  getItem: PublicationDependencies['getItem'],
  timeoutMs: number,
): Promise<TrackerItem | null> {
  let resolveApplied: () => void = () => {};
  const applied = new Promise<void>((resolve) => {
    resolveApplied = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Subscribe before the first read so an echo landing during the query is not missed.
  const unsubscribe = onTrackerItemApplied((_workspace, event) => {
    if (event.itemId === itemId) resolveApplied();
  });
  try {
    const first = await getItem(itemId);
    if (first?.syncStatus === 'synced') return first;
    await Promise.race([
      applied,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    return getItem(itemId);
  } finally {
    unsubscribe();
    clearTimeout(timer);
  }
}

export function bodyMarkdown(content: unknown): string {
  return typeof content === 'string'
    ? content
    : typeof (content as any)?.markdown === 'string'
    ? (content as any).markdown
    : '';
}

function snapshotMarkdown(content: string): string {
  return bodyMarkdown(JSON.parse(content));
}

export async function getTrackerCreationPublication(
  workspace: string,
  itemId: string,
): Promise<TrackerCreationPublication | null> {
  const receipt = await getCreationReceipt(workspace, itemId);
  if (!receipt) return null;
  const snapshot =
    receipt.publication_status === 'pending'
      ? await database.query(
          'SELECT content FROM tracker_body_cache WHERE item_id = $1 AND body_version = 1',
          [itemId],
        )
      : null;
  return {
    itemId,
    status: receipt.publication_status,
    ...(receipt.error ? { error: receipt.error } : {}),
    ...(snapshot?.rows[0]
      ? { savedContent: snapshotMarkdown(snapshot.rows[0].content) }
      : {}),
  };
}

/** Asset uploads use the existing durable store and uploader, with a stable ID on retry. */
async function publishImages(
  workspace: string,
  itemId: string,
  markdown: string,
): Promise<string> {
  const refs = scanMarkdownImageRefs(markdown);
  if (!refs.length) return markdown;
  const team = await findTeamForWorkspace(workspace);
  const accountId = getPersonalUserId();
  if (!team || !accountId)
    throw new Error('Team identity unavailable for screenshot publication');
  const substitutions = new Map<string, string>();
  for (const ref of refs) {
    const resolved = resolveAssetRef(
      ref,
      path.join(workspace, 'tracker.md'),
      workspace,
    );
    if (resolved.kind === 'skip') {
      if (/^(https?:|collab-asset:)/i.test(ref)) continue;
      throw new Error(`Screenshot cannot be published: ${resolved.reason}`);
    }
    if (resolved.kind === 'rejected') throw new Error(resolved.reason);
    // The scanner checks lexical traversal; realpath additionally rejects symlink escapes.
    const real = await fs.realpath(resolved.absolutePath);
    const relative = path.relative(await fs.realpath(workspace), real);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Screenshot is outside this workspace');
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > MAX_COLLAB_ASSET_BYTES)
      throw new Error('Screenshot exceeds the attachment size limit');
    const bytes = await fs.readFile(real);
    const hash = createHash('sha256')
      .update(itemId)
      .update(bytes)
      .digest('hex');
    const assetId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(
      13,
      16,
    )}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const documentId = `tracker-content/${itemId}`;
    const identity = { accountId, orgId: team.orgId, documentId, assetId };
    const store = getCollabAssetStore();
    const cached = await store.loadAsset(identity);
    if (cached?.uploadState !== 'cached') {
      if (!cached)
        await store.enqueueUpload({
          identity,
          bytes,
          mimeType: resolved.mimeType,
          fileName: resolved.fileName,
        });
      await getCollabAssetOutboxDrainCoordinator().drainNow(accountId);
      const delivered = await store.loadAsset(identity);
      if (delivered?.uploadState !== 'cached')
        throw new Error(
          'Screenshot upload is pending or failed. Your image remains saved locally.',
        );
    }
    substitutions.set(
      ref,
      `collab-asset://doc/${encodeURIComponent(documentId)}/asset/${assetId}`,
    );
  }
  return rewriteMarkdownImageRefs(markdown, substitutions);
}

export function publishTrackerCreation(
  workspace: string,
  itemId: string,
  dependencies: PublicationDependencies,
): Promise<TrackerCreationPublication> {
  return withCreationLock(workspace, itemId, async () => {
    const receipt = await getCreationReceipt(workspace, itemId);
    if (!receipt) throw new Error('Creation receipt not found');
    if (receipt.publication_status !== 'pending')
      return { itemId, status: receipt.publication_status };
    try {
      const item = await dependencies.getItem(itemId);
      if (!item || item.workspace !== workspace)
        throw new Error('Tracker item is not in this workspace');
      const policy = resolveTrackerSharingPolicy(workspace, item.type);
      if (!policy.known)
        throw new Error('Tracker sharing settings are not loaded');
      if (!shouldSyncTrackerItem(policy.policy, item)) {
        await setCreationPublication(workspace, itemId, 'local');
        return { itemId, status: 'local' };
      }
      if (!isTrackerSyncActive(workspace))
        throw new Error('Saved locally. Team sync is not connected.');
      await syncTrackerItem(item);
      // Always keep version 1 as the original source. Later edits are never replayed as creation.
      const snapshot = await database.query(
        'SELECT content FROM tracker_body_cache WHERE item_id = $1 AND body_version = 1',
        [itemId],
      );
      if (!snapshot.rows[0] && (item.bodyVersion ?? 0) > 0)
        throw new Error(
          'The saved creation body is unavailable; publication has not completed.',
        );
      if (snapshot.rows[0]) {
        const original = snapshotMarkdown(snapshot.rows[0].content);
        // The room must see the body upgrade before any screenshot upload
        // addresses it; see ensureHeadlessBodyRoom.
        await ensureHeadlessBodyRoom(workspace, itemId);
        const markdown = await publishImages(workspace, itemId, original);
        const latest = await dependencies.getItem(itemId);
        if (!latest) throw new Error('The created item is no longer available');
        const current = bodyMarkdown(latest.content);
        if (
          (latest.bodyVersion ?? 0) > 1 &&
          current.trimEnd() !== original.trimEnd() &&
          current.trimEnd() !== markdown.trimEnd()
        ) {
          throw new Error(
            'The local body has newer edits. Your saved creation content has been kept for review.',
          );
        }
        await initializeHeadlessBodyMarkdown(workspace, itemId, markdown);
        // Keep the original local snapshot as recovery material. The live editor
        // projects the acknowledged room state; a late local overwrite here could
        // replace edits made while publication was in flight.
      }
      const confirmedItem = await awaitMetadataAck(
        itemId,
        dependencies.getItem,
        dependencies.ackTimeoutMs ?? METADATA_ACK_TIMEOUT_MS,
      );
      if (confirmedItem?.syncStatus !== 'synced') {
        throw new Error(
          'The body is saved, but item metadata is not yet acknowledged by the team. Retry to check publication.',
        );
      }
      await setCreationPublication(workspace, itemId, 'published');
      return { itemId, status: 'published' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await setCreationPublication(workspace, itemId, 'pending', message);
      return { itemId, status: 'pending', error: message };
    }
  });
}

/**
 * Publish every creation still waiting on the team, oldest first. Runs when a
 * workspace's tracker sync connects so an item created offline reaches the room
 * without anyone finding the Retry button. Each item is independent: one
 * refusal (newer edits, missing image) does not stop the rest.
 */
export async function publishPendingTrackerCreations(
  workspace: string,
  dependencies: PublicationDependencies,
): Promise<TrackerCreationPublication[]> {
  const pending = await database.query<{ item_id: string }>(
    "SELECT item_id FROM tracker_creation_receipts WHERE workspace = $1 AND publication_status = 'pending' ORDER BY updated ASC LIMIT 100",
    [workspace],
  );
  const results: TrackerCreationPublication[] = [];
  for (const row of pending.rows) {
    results.push(await publishTrackerCreation(workspace, row.item_id, dependencies));
  }
  return results;
}
