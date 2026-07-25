import WebSocket from 'ws';
import {
  DocumentSyncProvider,
  TeamSyncProvider,
  type DocumentSyncConfig,
} from '@nimbalyst/runtime/sync';
import type { Doc } from 'yjs';

import {
  convertFromFileIntoDoc,
  convertRecoveryPlaintext,
  describeCollabCodec,
} from './CollabConversionClient';

import { getDatabase } from '../database/initialize';
import { getCollabSyncWsUrl } from '../utils/collabSyncUrl';
import { logger } from '../utils/logger';
import {
  fetchAndUnwrapOrgKey,
  fetchTeamKeyStatus,
  getArchivedOrgKeys,
  getOrgKey,
  getOrgKeyFingerprint,
} from './OrgKeyService';
import { findTeamForWorkspace, getOrgScopedJwt } from './TeamService';
import { getEffectiveTrackerSyncPolicy, shouldSyncTrackerItem } from './TrackerPolicyService';
import {
  getCollabBackupService,
  type CollabBackupKind,
  type CollabBackupResult,
} from './CollabBackupService';
import type { CollabBackupSweepSummary } from './CollabBackupMigrationGate';
export {
  requireSuccessfulCollabBackups,
  verifyOrMarkCollabBackups,
  type CollabBackupSweepSummary,
} from './CollabBackupMigrationGate';

const SYNC_TIMEOUT_MS = 15_000;

interface OriginRow {
  document_id: string;
  document_type: string;
  relative_path: string;
  source_basename: string;
}

interface TrackerRow {
  id: string;
  issue_key: string | null;
  title: string | null;
  type: string;
  data: string | Record<string, unknown>;
  sync_id: number | string | null;
  sync_status: string | null;
}

interface SweepItem {
  documentId: string;
  documentType: string;
  title: string;
  relativePath: string | null;
  kind: CollabBackupKind;
}

interface ProjectRow {
  project_id: string | null;
}

async function importLegacyKey(rawKeyBase64: string): Promise<CryptoKey> {
  const bytes = Buffer.from(rawKeyBase64, 'base64');
  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function resolveRoomConfig(orgId: string, documentId: string): Promise<DocumentSyncConfig> {
  const orgJwt = await getOrgScopedJwt(orgId);
  const serverManaged = (await fetchTeamKeyStatus(orgId, orgJwt)).mode === 'server-managed';
  let key = await getOrgKey(orgId);
  if (!key) {
    try {
      key = await fetchAndUnwrapOrgKey(orgId, orgJwt);
    } catch (error) {
      logger.main.warn('[CollabBackup] Could not fetch org key for sweep', { orgId, error });
    }
  }
  if (!serverManaged && !key) {
    throw new Error('The current organization encryption key is unavailable');
  }

  const legacyDocumentKeys: CryptoKey[] = [];
  if (serverManaged) {
    if (key) legacyDocumentKeys.push(key);
    for (const archived of getArchivedOrgKeys(orgId)) {
      try {
        legacyDocumentKeys.push(await importLegacyKey(archived.rawKeyBase64));
      } catch (error) {
        logger.main.warn('[CollabBackup] Could not import archived org key', {
          orgId,
          fingerprint: archived.fingerprint,
          error,
        });
      }
    }
  }

  return {
    serverUrl: getCollabSyncWsUrl(),
    getJwt: () => getOrgScopedJwt(orgId),
    orgId,
    keyCustody: serverManaged ? 'server-managed' : 'legacy-e2e',
    documentKey: serverManaged ? undefined : (key ?? undefined),
    legacyDocumentKey: serverManaged ? legacyDocumentKeys[0] : undefined,
    legacyDocumentKeys: serverManaged ? legacyDocumentKeys : undefined,
    orgKeyFingerprint: serverManaged ? undefined : (getOrgKeyFingerprint(orgId) ?? undefined),
    userId: '',
    documentId,
    createWebSocket: ((url: string) => new WebSocket(url)) as unknown as DocumentSyncConfig['createWebSocket'],
    reviewGateEnabled: false,
  };
}

async function withSyncedDocument<T>(
  orgId: string,
  documentId: string,
  callback: (provider: DocumentSyncProvider) => Promise<T>,
  options: { allowUndecoded?: boolean } = {},
): Promise<T> {
  const config = await resolveRoomConfig(orgId, documentId);
  let resolveSynced!: () => void;
  const synced = new Promise<void>((resolve) => { resolveSynced = resolve; });
  const provider = new DocumentSyncProvider({
    ...config,
    onFirstSyncComplete: () => resolveSynced(),
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Timed out syncing ${documentId}`)),
      SYNC_TIMEOUT_MS,
    );
  });
  try {
    await provider.connect();
    await Promise.race([synced, timeout]);
    // The undecoded guard is correct for the sweep (never snapshot a partial
    // doc). A force-restore of an undecryptable room is the one place we must
    // proceed anyway -- that room is exactly the disaster the backup recovers.
    if (provider.hasUndecodedContent() && !options.allowUndecoded) {
      throw new Error('The room contains content this device could not decrypt');
    }
    return await callback(provider);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    provider.destroy();
  }
}

/**
 * Capture one document via the codec host: its exact plaintext file
 * representation plus the extension to store it under.
 *
 * This is the correctness win of moving conversion off main. Main can only
 * ever hold the codecs it statically imports, so a shared document of any
 * other type used to come back "No adapter for X" -- which fails the sweep,
 * which blocks the encryption custody migration for the whole org. A codec
 * host has every extension loaded, so marketplace and structured editors are
 * backup-able for the first time.
 */
async function captureViaCodecHost(
  documentType: string,
  yDoc: Doc,
  workspacePath?: string,
): Promise<{ plaintext: string; extension: string }> {
  const [plaintext, codec] = await Promise.all([
    convertRecoveryPlaintext(documentType, yDoc, { workspacePath }),
    describeCollabCodec(documentType, { workspacePath }),
  ]);
  if (plaintext === null) {
    throw new Error(`Codec ${documentType} does not export UTF-8 plaintext`);
  }
  return { plaintext, extension: codec.fileExtensions[0] ?? '.txt' };
}

async function enumerateSweepItems(
  workspacePath: string,
  orgId: string,
  projectId: string | null,
): Promise<SweepItem[]> {
  const db = getDatabase();
  const origins = await db.query<OriginRow>(
    `SELECT document_id, document_type, relative_path, source_basename
       FROM collab_local_origins
      WHERE org_id = $1
        AND (project_id = $2 OR (project_id IS NULL AND $2 IS NULL))
      ORDER BY document_id`,
    [orgId, projectId],
  );
  const trackers = await db.query<TrackerRow>(
    `SELECT id, issue_key, title, type, data, sync_id, sync_status
       FROM tracker_items
      WHERE workspace = $1
        AND deleted_at IS NULL
      ORDER BY id`,
    [workspacePath],
  );
  const sharedTrackers = trackers.rows.filter((row) => {
    let data: Record<string, unknown>;
    try {
      data = typeof row.data === 'string'
        ? JSON.parse(row.data) as Record<string, unknown>
        : row.data;
    } catch {
      return row.sync_id != null || (row.sync_status != null && row.sync_status !== 'local');
    }
    return row.sync_id != null || (row.sync_status != null && row.sync_status !== 'local') || shouldSyncTrackerItem(
      getEffectiveTrackerSyncPolicy(workspacePath, row.type),
      data,
    );
  });
  return [
    ...origins.rows.map((row) => ({
      documentId: row.document_id,
      documentType: row.document_type,
      title: row.source_basename || row.relative_path,
      relativePath: row.relative_path,
      kind: 'document' as const,
    })),
    ...sharedTrackers.map((row) => ({
      documentId: `tracker-content/${row.id}`,
      documentType: 'markdown',
      title: row.issue_key || row.title || row.id,
      relativePath: null,
      kind: 'body' as const,
    })),
  ];
}

export async function backupCollabProject(
  workspacePath: string,
): Promise<CollabBackupSweepSummary> {
  if (!workspacePath) throw new Error('workspacePath required');
  const team = await findTeamForWorkspace(workspacePath);
  if (!team) throw new Error('No team found for this workspace');
  const orgId = team.orgId;
  const projectId = team.teamProjectId ?? null;
  const items = await enumerateSweepItems(workspacePath, orgId, projectId);
  const failures: Array<{ documentId: string; error: string }> = [];
  let backedUp = 0;
  let skipped = 0;

  for (const item of items) {
    try {
      const result = await withSyncedDocument(orgId, item.documentId, async (provider) => {
        const { plaintext, extension } = await captureViaCodecHost(
          item.documentType,
          provider.getYDoc(),
          workspacePath,
        );
        return getCollabBackupService().backupNow({
          ...item,
          orgId,
          projectId,
          extension,
          plaintext,
        });
      });
      if (result.success) {
        backedUp += 1;
      } else {
        if (result.skipped) skipped += 1;
        failures.push({
          documentId: item.documentId,
          error: result.error ?? result.skipped ?? 'Backup failed',
        });
      }
    } catch (error) {
      failures.push({
        documentId: item.documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    success: failures.length === 0,
    orgId,
    projectId,
    total: items.length,
    backedUp,
    skipped,
    failures,
  };
}

async function backupOriginProject(
  orgId: string,
  projectId: string | null,
): Promise<CollabBackupSweepSummary> {
  const db = getDatabase();
  const origins = await db.query<OriginRow>(
    `SELECT document_id, document_type, relative_path, source_basename
       FROM collab_local_origins
      WHERE org_id = $1
        AND (project_id = $2 OR (project_id IS NULL AND $2 IS NULL))
      ORDER BY document_id`,
    [orgId, projectId],
  );
  const items: SweepItem[] = origins.rows.map((row) => ({
    documentId: row.document_id,
    documentType: row.document_type,
    title: row.source_basename || row.relative_path,
    relativePath: row.relative_path,
    kind: 'document',
  }));
  const failures: Array<{ documentId: string; error: string }> = [];
  let backedUp = 0;
  let skipped = 0;
  for (const item of items) {
    try {
      const result = await withSyncedDocument(orgId, item.documentId, async (provider) => {
        const { plaintext, extension } = await captureViaCodecHost(
          item.documentType,
          provider.getYDoc(),
        );
        return getCollabBackupService().backupNow({
          ...item,
          orgId,
          projectId,
          extension,
          plaintext,
        });
      });
      if (result.success) backedUp += 1;
      else {
        if (result.skipped) skipped += 1;
        failures.push({
          documentId: item.documentId,
          error: result.error ?? result.skipped ?? 'Backup failed',
        });
      }
    } catch (error) {
      failures.push({
        documentId: item.documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    success: failures.length === 0,
    orgId,
    projectId,
    total: items.length,
    backedUp,
    skipped,
    failures,
  };
}

/**
 * Sweep every locally-known project for an organization. Workspace-backed
 * projects include tracker bodies; origin-only projects are still captured so
 * a project with shared documents but no local tracker rows is not missed.
 */
export async function backupCollabOrganization(
  orgId: string,
  workspacePaths: string[],
): Promise<CollabBackupSweepSummary[]> {
  const summaries: CollabBackupSweepSummary[] = [];
  const coveredProjects = new Set<string>();
  for (const workspacePath of workspacePaths) {
    const summary = await backupCollabProject(workspacePath);
    if (summary.orgId !== orgId) {
      throw new Error(`Workspace ${workspacePath} does not belong to organization ${orgId}`);
    }
    summaries.push(summary);
    coveredProjects.add(summary.projectId ?? '_primary');
  }

  const projects = await getDatabase().query<ProjectRow>(
    'SELECT DISTINCT project_id FROM collab_local_origins WHERE org_id = $1',
    [orgId],
  );
  for (const row of projects.rows) {
    const key = row.project_id ?? '_primary';
    if (coveredProjects.has(key)) continue;
    // No local workspace backs this project, so we only know its shared
    // documents (via collab_local_origins). Tracker bodies for a project with
    // no local workspace are enumerated per-workspace and are NOT swept here --
    // surface that gap rather than letting the sweep look complete (finding 3b).
    logger.main.warn(
      '[CollabBackup] Sweeping origin-only project with no local workspace; ' +
      'shared documents are captured but tracker bodies (if any) are not',
      { orgId, projectId: row.project_id },
    );
    summaries.push(await backupOriginProject(orgId, row.project_id));
  }
  return summaries;
}

export async function restoreCollabBackup(input: {
  workspacePath: string;
  documentId: string;
  /**
   * Force/replace mode: connect even when the server room is undecryptable and
   * overwrite its authoritative state with the plaintext backup, discarding the
   * unreadable rows. This is the deliberate needs-recovery path -- a normal
   * restore refuses an undecodable room (see withSyncedDocument).
   */
  force?: boolean;
}): Promise<CollabBackupResult> {
  const team = await findTeamForWorkspace(input.workspacePath);
  if (!team) return { success: false, error: 'No team found for this workspace' };
  const projectId = team.teamProjectId ?? null;
  const manifest = await getCollabBackupService().listProjectBackups(team.orgId, projectId);
  const entry = manifest?.documents[input.documentId];
  if (!entry) return { success: false, error: 'Backup not found' };
  return getCollabBackupService().restore({
    orgId: team.orgId,
    projectId,
    documentId: input.documentId,
    applyPlaintext: async (plaintext) => {
      await withSyncedDocument(
        team.orgId,
        input.documentId,
        async (provider) => {
          await convertFromFileIntoDoc(
            'applyFromFile',
            entry.type,
            provider.getYDoc(),
            plaintext,
            { workspacePath: input.workspacePath },
          );
          if (input.force) {
            // Promote the restored Y.Doc to the sole authoritative snapshot,
            // dropping the undecryptable server rows.
            if (!(await provider.forceReplaceServerState(SYNC_TIMEOUT_MS))) {
              throw new Error('The server did not acknowledge the force-replace of the restored content');
            }
          } else if (!(await provider.waitForPendingWrites(SYNC_TIMEOUT_MS))) {
            throw new Error('Timed out waiting for the restored content to reach the server');
          }
        },
        { allowUndecoded: input.force },
      );
    },
  });
}

/**
 * Promote a fully decoded legacy room to a current server-managed snapshot.
 * This is deliberately stricter than disaster-recovery force-replace: if even
 * one row could not be decrypted, the provider refuses to compact it away.
 */
export async function finalizeCollabDocumentMigration(
  orgId: string,
  documentId: string,
): Promise<void> {
  await withSyncedDocument(orgId, documentId, async (provider) => {
    if (!(await provider.finalizeServerManagedState(SYNC_TIMEOUT_MS))) {
      throw new Error(`The server did not acknowledge migration finalization for ${documentId}`);
    }
  });
}

/**
 * Connect the team index in a non-renderer host, recover every legacy title
 * with locally retained key epochs, and await the provider's persistence
 * verification. The server-side finalization status remains the final source
 * of truth after this returns.
 */
export async function finalizeCollabTitleMigration(orgId: string): Promise<void> {
  const legacyOrgKeys: CryptoKey[] = [];
  const current = await getOrgKey(orgId);
  if (current) legacyOrgKeys.push(current);
  for (const archived of getArchivedOrgKeys(orgId)) {
    try {
      legacyOrgKeys.push(await importLegacyKey(archived.rawKeyBase64));
    } catch (error) {
      logger.main.warn('[CollabMigration] Could not import archived title key', {
        orgId,
        fingerprint: archived.fingerprint,
        error,
      });
    }
  }
  if (legacyOrgKeys.length === 0) {
    throw new Error('This device has no retained legacy organization key for title finalization');
  }

  let resolveLoaded!: () => void;
  const loaded = new Promise<void>((resolve) => { resolveLoaded = resolve; });
  const provider = new TeamSyncProvider({
    serverUrl: getCollabSyncWsUrl(),
    getJwt: () => getOrgScopedJwt(orgId),
    orgId,
    userId: 'migration-finalizer',
    keyCustody: 'server-managed',
    legacyOrgKeys,
    orgKeyFingerprint: null,
    autoBackfillLegacyTitles: false,
    createWebSocket: ((url: string) => new WebSocket(url)) as unknown as (url: string) => globalThis.WebSocket,
    onDocumentsLoaded: () => resolveLoaded(),
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error('Timed out loading the team document index for migration')),
      SYNC_TIMEOUT_MS,
    );
  });
  try {
    await provider.connect();
    await Promise.race([loaded, timeout]);
    const result = await provider.backfillLegacyTitles();
    if (result.confirmed === null || result.confirmed < result.sent) {
      throw new Error(
        `Only ${result.confirmed ?? 0} of ${result.sent} legacy document titles were confirmed`,
      );
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    provider.destroy();
  }
}
