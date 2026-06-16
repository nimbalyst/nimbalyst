/**
 * TrackerImportService — turns an importer {@link TrackerSnapshot} into a real
 * tracker item through the normal create path (handleTrackerCreate), so sync,
 * body Y.Doc seeding, activity, and issue-key allocation all fire identically
 * to a hand-created item.
 *
 * Re-import of an existing URN is a no-op (it never clobbers local edits);
 * {@link TrackerImportService.resnapshot} is the explicit "pull latest from
 * source" path that merges upstream changes under conservative rules.
 */

import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger';
import { getDatabase } from '../../database/initialize';
import type { ExternalSourceRef, TrackerOrigin } from '@nimbalyst/runtime';
import { handleTrackerCreate, handleTrackerUpdate } from '../../mcp/tools/trackerToolHandlers';
import { getTrackerImporterRegistry } from './TrackerImporterRegistry';
import { importedItemId } from './importedItemId';

/** Stable hash of an upstream body so re-snapshot can detect changes cheaply. */
function hashBody(body: string | undefined): string {
  return createHash('sha1').update(body ?? '').digest('hex');
}

export { importedItemId };

function unionLabels(local: string[], upstream: string[]): string[] {
  const out = [...local];
  for (const l of upstream) if (!out.includes(l)) out.push(l);
  return out;
}

export interface RunImportArgs {
  workspacePath: string;
  providerId: string;
  externalId: string;
  /** Target tracker type. Falls back to the snapshot's type, then the importer's first importsAs, then 'bug'. */
  primaryType?: string;
}

export interface RunImportResult {
  id: string;
  urn: string;
  created: boolean;
  /** Issue key if one was allocated/synced. */
  issueKey?: string;
}

/**
 * Map an upstream state snapshot ('open'/'closed'/workflow name) to a local
 * workspace status. v1 uses a coarse default; richer per-type mapping can come
 * later. Unknown states pass through unchanged so type-specific workflows that
 * already use the upstream vocabulary keep working.
 */
function mapStatus(snapshotStatus: string | undefined): string | undefined {
  if (!snapshotStatus) return undefined;
  const s = snapshotStatus.toLowerCase();
  if (s === 'open') return 'to-do';
  if (s === 'closed') return 'done';
  return snapshotStatus;
}

class TrackerImportService {
  /** Per-URN advisory lock so two concurrent imports of the same item serialize. */
  private locks = new Map<string, Promise<unknown>>();

  private async withUrnLock<T>(urn: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(urn) ?? Promise.resolve();
    // Chain fn after the previous holder settles (run regardless of its outcome).
    const run = prev.then(() => fn(), () => fn());
    // The map always points at the latest tail so the next caller waits on us.
    const tail = run.then(() => {}, () => {});
    this.locks.set(urn, tail);
    try {
      return await run;
    } finally {
      // Only clear if no newer call queued behind us.
      if (this.locks.get(urn) === tail) {
        this.locks.delete(urn);
      }
    }
  }

  async runImport(args: RunImportArgs): Promise<RunImportResult> {
    const { workspacePath, providerId, externalId } = args;
    const registry = getTrackerImporterRegistry();

    const snapshot = await registry.fetchSnapshot(workspacePath, providerId, externalId);
    const urn = snapshot.external.urn;
    if (!urn) {
      throw new Error('Importer returned a snapshot with no URN; cannot import.');
    }
    // Guard against importers that forget to populate titleSnapshot — the
    // source chip degrades to "(unknown)" without it.
    if (!snapshot.external.titleSnapshot) {
      snapshot.external.titleSnapshot = snapshot.title || urn;
    }

    return this.withUrnLock(urn, async () => {
      const existingId = await registry.findLocalIdByUrn(workspacePath, urn);
      if (existingId) {
        // Phase 4 will run the re-snapshot merge here. For now, leave the
        // existing item untouched so a duplicate import never clobbers local edits.
        logger.main.info(
          `[TrackerImportService] ${urn} already imported as ${existingId}; skipping (re-snapshot lands in Phase 4)`
        );
        return { id: existingId, urn, created: false };
      }

      const contribution = await registry.getContribution(providerId);
      const type =
        args.primaryType ||
        snapshot.primaryType ||
        contribution?.importsAs?.[0] ||
        'bug';

      const nowIso = new Date().toISOString();
      const external: ExternalSourceRef = {
        ...snapshot.external,
        importedAt: nowIso,
        lastSyncedAt: nowIso,
        bodyHash: hashBody(snapshot.body),
        upstreamBodyChanged: false,
      };
      const origin: TrackerOrigin = { kind: 'external', external };

      // Deterministic, URN-derived id so concurrent imports of the same upstream
      // item on different machines converge on one row when sync reconciles them.
      const id = importedItemId(urn);

      const result = await handleTrackerCreate(
        {
          id,
          type,
          title: snapshot.title,
          description: snapshot.body,
          status: mapStatus(snapshot.status),
          priority: snapshot.priority,
          labels: snapshot.labels,
          origin,
          createdByAgent: false,
        },
        workspacePath
      );
      if (result.isError) {
        // A teammate's identical import may have synced in between the URN check
        // above and this insert (same deterministic id → unique-violation). If a
        // row now backs the URN, treat it as already-imported rather than failing.
        const raced = await registry.findLocalIdByUrn(workspacePath, urn);
        if (raced) {
          logger.main.info(
            `[TrackerImportService] ${urn} converged with a synced copy (${raced}) during import`
          );
          return { id: raced, urn, created: false };
        }
        const text = result.content?.[0]?.text ?? 'unknown error';
        throw new Error(`Import failed while creating tracker item: ${text}`);
      }

      // The row was created under our deterministic id; no lookup needed.
      logger.main.info(`[TrackerImportService] imported ${urn} as ${id} (${type})`);
      return { id, urn, created: true };
    });
  }

  /** Load the local row backing a URN (id + parsed data), or null. */
  private async loadByUrn(
    workspacePath: string,
    urn: string
  ): Promise<{ id: string; data: Record<string, any> } | null> {
    const db = getDatabase();
    const res = await db.query<{ id: string; data: unknown }>(
      `SELECT id, data FROM tracker_items
        WHERE workspace = $1 AND data->'origin'->'external'->>'urn' = $2
        LIMIT 1`,
      [workspacePath, urn]
    );
    const row = res.rows[0];
    if (!row) return null;
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data as any) || {};
    return { id: row.id, data };
  }

  /**
   * Pull the latest upstream snapshot and merge it conservatively:
   *   - title:  overwrite only if unchanged locally since last import
   *   - status: overwrite only if unchanged locally since last import
   *   - labels: union (local additions preserved; upstream removals ignored)
   *   - body:   never auto-overwritten — flagged for review when it changed
   *             (apply via {@link applyUpstreamBody})
   * Always refreshes the stored upstream snapshots (title/state/lastSynced/bodyHash).
   */
  async resnapshot(args: { workspacePath: string; urn: string }): Promise<{
    id: string;
    urn: string;
    titleUpdated: boolean;
    statusUpdated: boolean;
    bodyChanged: boolean;
  }> {
    const { workspacePath, urn } = args;
    const registry = getTrackerImporterRegistry();
    return this.withUrnLock(urn, async () => {
      const local = await this.loadByUrn(workspacePath, urn);
      if (!local) throw new Error(`No imported item found for URN ${urn}`);
      const ext: ExternalSourceRef | undefined = local.data.origin?.external;
      if (!ext) throw new Error(`Item ${local.id} is not an external import`);

      const snapshot = await registry.fetchSnapshot(workspacePath, ext.providerId, ext.externalId);

      const localTitle = (local.data.title as string) ?? '';
      const localStatus = (local.data.status as string) ?? '';
      const localLabels: string[] = Array.isArray(local.data.labels) ? local.data.labels : [];

      const titleUnchanged = localTitle === (ext.titleSnapshot ?? '');
      const statusUnchanged = localStatus === (mapStatus(ext.stateSnapshot) ?? '');
      const newTitle = titleUnchanged ? snapshot.title : undefined;
      const newStatus = statusUnchanged ? mapStatus(snapshot.status) : undefined;
      const newLabels = unionLabels(localLabels, snapshot.labels ?? []);

      const newBodyHash = hashBody(snapshot.body);
      const bodyChanged = Boolean(ext.bodyHash) && newBodyHash !== ext.bodyHash;

      const newExternal: ExternalSourceRef = {
        ...ext,
        titleSnapshot: snapshot.title,
        stateSnapshot: snapshot.status,
        lastSyncedAt: new Date().toISOString(),
        bodyHash: newBodyHash,
        upstreamBodyChanged: bodyChanged || ext.upstreamBodyChanged || false,
      };

      const updateArgs: Record<string, unknown> = {
        id: local.id,
        labels: newLabels,
        origin: { kind: 'external', external: newExternal } as TrackerOrigin,
      };
      if (newTitle !== undefined) updateArgs.title = newTitle;
      if (newStatus !== undefined) updateArgs.status = newStatus;

      const result = await handleTrackerUpdate(updateArgs, workspacePath);
      if (result.isError) {
        const text = result.content?.[0]?.text ?? 'unknown error';
        throw new Error(`Re-snapshot failed: ${text}`);
      }
      logger.main.info(
        `[TrackerImportService] re-snapshotted ${urn} (title:${newTitle !== undefined} status:${newStatus !== undefined} body-changed:${bodyChanged})`
      );
      return {
        id: local.id,
        urn,
        titleUpdated: newTitle !== undefined && newTitle !== localTitle,
        statusUpdated: newStatus !== undefined && newStatus !== localStatus,
        bodyChanged,
      };
    });
  }

  /** Overwrite the local body with the current upstream body and clear the change flag. */
  async applyUpstreamBody(args: { workspacePath: string; urn: string }): Promise<{ id: string }> {
    const { workspacePath, urn } = args;
    const registry = getTrackerImporterRegistry();
    return this.withUrnLock(urn, async () => {
      const local = await this.loadByUrn(workspacePath, urn);
      if (!local) throw new Error(`No imported item found for URN ${urn}`);
      const ext: ExternalSourceRef | undefined = local.data.origin?.external;
      if (!ext) throw new Error(`Item ${local.id} is not an external import`);

      const snapshot = await registry.fetchSnapshot(workspacePath, ext.providerId, ext.externalId);
      const newExternal: ExternalSourceRef = {
        ...ext,
        titleSnapshot: snapshot.title,
        stateSnapshot: snapshot.status,
        lastSyncedAt: new Date().toISOString(),
        bodyHash: hashBody(snapshot.body),
        upstreamBodyChanged: false,
      };
      const result = await handleTrackerUpdate(
        {
          id: local.id,
          description: snapshot.body ?? '',
          origin: { kind: 'external', external: newExternal } as TrackerOrigin,
        },
        workspacePath
      );
      if (result.isError) {
        const text = result.content?.[0]?.text ?? 'unknown error';
        throw new Error(`Applying upstream body failed: ${text}`);
      }
      return { id: local.id };
    });
  }

  /** Keep the local body and clear the upstream-change flag (won't re-flag until upstream changes again). */
  async dismissUpstreamBodyChange(args: { workspacePath: string; urn: string }): Promise<{ id: string }> {
    const { workspacePath, urn } = args;
    return this.withUrnLock(urn, async () => {
      const local = await this.loadByUrn(workspacePath, urn);
      if (!local) throw new Error(`No imported item found for URN ${urn}`);
      const ext: ExternalSourceRef | undefined = local.data.origin?.external;
      if (!ext) throw new Error(`Item ${local.id} is not an external import`);
      const newExternal: ExternalSourceRef = { ...ext, upstreamBodyChanged: false };
      const result = await handleTrackerUpdate(
        { id: local.id, origin: { kind: 'external', external: newExternal } as TrackerOrigin },
        workspacePath
      );
      if (result.isError) {
        const text = result.content?.[0]?.text ?? 'unknown error';
        throw new Error(`Dismiss failed: ${text}`);
      }
      return { id: local.id };
    });
  }
}

let singleton: TrackerImportService | null = null;
export function getTrackerImportService(): TrackerImportService {
  if (!singleton) singleton = new TrackerImportService();
  return singleton;
}
