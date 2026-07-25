import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import WebSocket from 'ws';
import {
  DocumentSyncProvider,
  type DocumentSyncConfig,
} from '@nimbalyst/runtime/sync';
import {
  convertFromFileIntoDoc,
  convertToPlainText,
  describeCollabCodec,
} from './CollabConversionClient';
import { database } from '../database/PGLiteDatabaseWorker';
import { getCollabSyncHttpUrl, getCollabSyncWsUrl } from '../utils/collabSyncUrl';
import { logger } from '../utils/logger';
import { encryptAndUploadCollabAsset } from './CollabAssetUploader';
import { getOrgKey, getOrgKeyFingerprint, fetchAndUnwrapOrgKey } from './OrgKeyService';
import { findTeamForWorkspace, getOrgScopedJwt } from './TeamService';
import {
  rewriteMarkdownImageRefs,
  resolveAssetRef,
  scanMarkdownImageRefs,
} from './markdownAssetScanner';

export type CollabLocalOriginResolutionStatus =
  | 'resolved'
  | 'missing'
  | 'relinked'
  | 'conflict';

export interface CollabLocalOriginBinding {
  orgId: string;
  documentId: string;
  projectId: string | null;
  gitRemoteHash: string | null;
  workspacePathHash: string | null;
  relativePath: string;
  documentType: string;
  sourceBasename: string;
  lastLocalContentHash: string | null;
  lastCollabContentHash: string | null;
  lastSyncedAt: string | null;
  lastSeenMtimeMs: number | null;
  lastSeenSizeBytes: number | null;
  resolutionStatus: CollabLocalOriginResolutionStatus;
  resolutionError: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedPath: string | null;
}

export type ReuploadConflictKind =
  | 'missing-baseline'
  | 'shared-ahead'
  | 'diverged';

export interface ReuploadLocalOriginResult {
  success: boolean;
  status:
    | 'noop'
    | 'uploaded'
    | 'conflict'
    | 'missing-source'
    | 'unsupported'
    | 'error';
  conflictKind?: ReuploadConflictKind;
  message?: string;
  binding?: CollabLocalOriginBinding | null;
  migration?: {
    okCount: number;
    failedCount: number;
  };
  /**
   * On a `conflict`, who last edited the shared doc and when (server clock, ms),
   * so the overwrite confirm can name who/when the push will clobber. Sourced
   * from the DocumentRoom's last content update (not the title-index timestamp).
   * `lastEditorId` is a room-authed userId the renderer resolves to a member.
   */
  lastEditorId?: string | null;
  lastEditedAt?: number | null;
}

interface CollabLocalOriginRow {
  org_id: string;
  document_id: string;
  project_id: string | null;
  git_remote_hash: string | null;
  workspace_path_hash: string | null;
  relative_path: string;
  document_type: string;
  source_basename: string;
  last_local_content_hash: string | null;
  last_collab_content_hash: string | null;
  last_synced_at: Date | string | null;
  last_seen_mtime_ms: number | null;
  last_seen_size_bytes: number | null;
  resolution_status: CollabLocalOriginResolutionStatus;
  resolution_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface UpsertBindingInput {
  orgId: string;
  documentId: string;
  projectId: string | null;
  gitRemoteHash: string | null;
  workspacePathHash: string | null;
  relativePath: string;
  documentType: string;
  sourceBasename: string;
  lastLocalContentHash: string | null;
  lastCollabContentHash: string | null;
  lastSyncedAt: Date | null;
  lastSeenMtimeMs: number | null;
  lastSeenSizeBytes: number | null;
  resolutionStatus: CollabLocalOriginResolutionStatus;
  resolutionError: string | null;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toNullableIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function mapBinding(row: CollabLocalOriginRow, resolvedPath: string | null): CollabLocalOriginBinding {
  return {
    orgId: row.org_id,
    documentId: row.document_id,
    projectId: row.project_id,
    gitRemoteHash: row.git_remote_hash,
    workspacePathHash: row.workspace_path_hash,
    relativePath: row.relative_path,
    documentType: row.document_type,
    sourceBasename: row.source_basename,
    lastLocalContentHash: row.last_local_content_hash,
    lastCollabContentHash: row.last_collab_content_hash,
    lastSyncedAt: toNullableIso(row.last_synced_at),
    lastSeenMtimeMs: row.last_seen_mtime_ms,
    lastSeenSizeBytes: row.last_seen_size_bytes,
    resolutionStatus: row.resolution_status,
    resolutionError: row.resolution_error,
    createdAt: toNullableIso(row.created_at)!,
    updatedAt: toNullableIso(row.updated_at)!,
    resolvedPath,
  };
}

async function computeWorkspacePathHash(workspacePath: string): Promise<string> {
  try {
    const realPath = await fs.realpath(workspacePath);
    return hashText(path.resolve(realPath));
  } catch {
    return hashText(path.resolve(workspacePath));
  }
}

function ensureWorkspaceRelativePath(workspacePath: string, sourceFilePath: string): string {
  const normalizedWorkspace = path.resolve(workspacePath);
  const normalizedSource = path.resolve(sourceFilePath);
  const relativePath = path.relative(normalizedWorkspace, normalizedSource);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Local source must live inside the active workspace.');
  }
  return normalizeRelativePath(relativePath);
}

async function getSourceFileStats(sourceFilePath: string): Promise<{ mtimeMs: number | null; sizeBytes: number | null }> {
  try {
    const stats = await fs.stat(sourceFilePath);
    return { mtimeMs: Math.round(stats.mtimeMs), sizeBytes: stats.size };
  } catch {
    return { mtimeMs: null, sizeBytes: null };
  }
}

async function fetchBindingRow(orgId: string, documentId: string): Promise<CollabLocalOriginRow | null> {
  const result = await database.query<CollabLocalOriginRow>(
    `
      SELECT
        org_id,
        document_id,
        project_id,
        git_remote_hash,
        workspace_path_hash,
        relative_path,
        document_type,
        source_basename,
        last_local_content_hash,
        last_collab_content_hash,
        last_synced_at,
        last_seen_mtime_ms,
        last_seen_size_bytes,
        resolution_status,
        resolution_error,
        created_at,
        updated_at
      FROM collab_local_origins
      WHERE org_id = $1 AND document_id = $2
      LIMIT 1
    `,
    [orgId, documentId],
  );
  return result.rows[0] ?? null;
}

async function fetchBindingRowByRelativePath(orgId: string, relativePath: string): Promise<CollabLocalOriginRow | null> {
  const result = await database.query<CollabLocalOriginRow>(
    `
      SELECT
        org_id,
        document_id,
        project_id,
        git_remote_hash,
        workspace_path_hash,
        relative_path,
        document_type,
        source_basename,
        last_local_content_hash,
        last_collab_content_hash,
        last_synced_at,
        last_seen_mtime_ms,
        last_seen_size_bytes,
        resolution_status,
        resolution_error,
        created_at,
        updated_at
      FROM collab_local_origins
      WHERE org_id = $1 AND relative_path = $2
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    [orgId, relativePath],
  );
  return result.rows[0] ?? null;
}

async function upsertBinding(input: UpsertBindingInput): Promise<void> {
  const now = new Date();
  await database.query(
    `
      INSERT INTO collab_local_origins (
        org_id,
        document_id,
        project_id,
        git_remote_hash,
        workspace_path_hash,
        relative_path,
        document_type,
        source_basename,
        last_local_content_hash,
        last_collab_content_hash,
        last_synced_at,
        last_seen_mtime_ms,
        last_seen_size_bytes,
        resolution_status,
        resolution_error,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17
      )
      ON CONFLICT (org_id, document_id) DO UPDATE SET
        project_id = EXCLUDED.project_id,
        git_remote_hash = EXCLUDED.git_remote_hash,
        workspace_path_hash = EXCLUDED.workspace_path_hash,
        relative_path = EXCLUDED.relative_path,
        document_type = EXCLUDED.document_type,
        source_basename = EXCLUDED.source_basename,
        last_local_content_hash = EXCLUDED.last_local_content_hash,
        last_collab_content_hash = EXCLUDED.last_collab_content_hash,
        last_synced_at = EXCLUDED.last_synced_at,
        last_seen_mtime_ms = EXCLUDED.last_seen_mtime_ms,
        last_seen_size_bytes = EXCLUDED.last_seen_size_bytes,
        resolution_status = EXCLUDED.resolution_status,
        resolution_error = EXCLUDED.resolution_error,
        updated_at = EXCLUDED.updated_at
    `,
    [
      input.orgId,
      input.documentId,
      input.projectId,
      input.gitRemoteHash,
      input.workspacePathHash,
      input.relativePath,
      input.documentType,
      input.sourceBasename,
      input.lastLocalContentHash,
      input.lastCollabContentHash,
      input.lastSyncedAt,
      input.lastSeenMtimeMs,
      input.lastSeenSizeBytes,
      input.resolutionStatus,
      input.resolutionError,
      now,
      now,
    ],
  );
}

async function resolveStoredBinding(
  workspacePath: string,
  row: CollabLocalOriginRow,
): Promise<CollabLocalOriginBinding> {
  const resolvedPath = path.join(workspacePath, row.relative_path);
  try {
    await fs.access(resolvedPath);
    return mapBinding(
      {
        ...row,
        resolution_status: row.resolution_status === 'missing' ? 'resolved' : row.resolution_status,
        resolution_error: null,
      },
      resolvedPath,
    );
  } catch {
    return mapBinding(
      {
        ...row,
        resolution_status: 'missing',
        resolution_error: `Source file not found at ${row.relative_path}.`,
      },
      null,
    );
  }
}

async function resolveDocumentSyncConfig(
  workspacePath: string,
  documentId: string,
): Promise<DocumentSyncConfig | null> {
  const team = await findTeamForWorkspace(workspacePath);
  if (!team) return null;

  let documentKey = await getOrgKey(team.orgId);
  if (!documentKey) {
    try {
      const orgJwt = await getOrgScopedJwt(team.orgId);
      documentKey = await fetchAndUnwrapOrgKey(team.orgId, orgJwt);
    } catch (error) {
      logger.main.warn('[CollabLocalOrigin] Failed to fetch org key for headless read:', error);
    }
  }
  if (!documentKey) return null;

  return {
    serverUrl: getCollabSyncWsUrl(),
    getJwt: () => getOrgScopedJwt(team.orgId),
    orgId: team.orgId,
    documentKey,
    orgKeyFingerprint: getOrgKeyFingerprint(team.orgId) ?? undefined,
    userId: '',
    documentId,
    createWebSocket: ((url: string) => new WebSocket(url)) as unknown as DocumentSyncConfig['createWebSocket'],
    reviewGateEnabled: false,
  };
}

/**
 * Open a connected DocumentSyncProvider for a shared document and
 * yield its underlying Y.Doc to the caller. The caller is expected
 * to project / mutate the doc via a CollabContentAdapter; this
 * helper itself is adapter-agnostic.
 */
async function withSharedDocument<T>(
  workspacePath: string,
  documentId: string,
  callback: (helpers: {
    provider: DocumentSyncProvider;
    yDoc: ReturnType<DocumentSyncProvider['getYDoc']>;
  }) => Promise<T>,
): Promise<T | null> {
  const config = await resolveDocumentSyncConfig(workspacePath, documentId);
  if (!config) return null;

  let connected = false;
  const provider = new DocumentSyncProvider({
    ...config,
    onStatusChange: (status) => {
      if (status === 'connected') {
        connected = true;
      }
    },
  });

  try {
    await provider.connect();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out connecting to shared document ${documentId}`));
      }, 5000);
      const poll = () => {
        if (connected) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
    return await callback({ provider, yDoc: provider.getYDoc() });
  } finally {
    try {
      provider.destroy();
    } catch {
      // Ignore cleanup failures.
    }
  }
}

async function readSharedDocText(
  workspacePath: string,
  documentId: string,
  documentType: string,
): Promise<string | null> {
  return withSharedDocument(workspacePath, documentId, async ({ yDoc }) => {
    return convertToPlainText(documentType, yDoc, { workspacePath });
  });
}

interface SharedDocReadResult {
  text: string;
  lastWriterUserId: string | null;
  lastUpdatedAt: number | null;
}

/**
 * Read the shared doc's plaintext plus the server's last-writer attribution in
 * a single provider connection (so the overwrite confirm can name who/when last
 * edited it without a second round-trip). Returns null if the doc can't be read.
 */
async function readSharedDocWithMeta(
  workspacePath: string,
  documentId: string,
  documentType: string,
): Promise<SharedDocReadResult | null> {
  return withSharedDocument(workspacePath, documentId, async ({ yDoc, provider }) => ({
    text: await convertToPlainText(documentType, yDoc, { workspacePath }),
    lastWriterUserId: provider.getLastWriterUserId(),
    lastUpdatedAt: provider.getLastUpdatedAt(),
  }));
}

async function overwriteSharedDocFromSource(
  workspacePath: string,
  documentId: string,
  documentType: string,
  source: string | Uint8Array,
): Promise<boolean> {
  const result = await withSharedDocument(workspacePath, documentId, async ({ yDoc, provider }) => {
    logger.main.info('[CollabLocalOrigin] applyFromFile starting', {
      documentId,
      documentType,
      yDocByteLength: 0, // filled after
    });
    let writeCount = 0;
    const subDoc = yDoc;
    const onAfter = () => { writeCount += 1; };
    subDoc.on('afterTransaction', onAfter);
    try {
      // The codec runs on a host (the renderer) and returns a delta; applying
      // it here is a normal local transaction, so the provider broadcasts it
      // exactly as an in-process codec write did.
      await convertFromFileIntoDoc('applyFromFile', documentType, yDoc, source, { workspacePath });
    } finally {
      subDoc.off('afterTransaction', onAfter);
    }
    logger.main.info('[CollabLocalOrigin] applyFromFile done; transactions=' + writeCount);
    const ok = await provider.waitForPendingWrites(5_000);
    logger.main.info('[CollabLocalOrigin] waitForPendingWrites returned', { documentId, ok });
    // `waitForPendingWrites` returns once our writes have been ack'd by
    // the server, but the server's broadcast to OTHER connected peers
    // (the renderer holding the open tab) is asynchronous. Wait a beat
    // before tearing down main's provider so the broadcast has a chance
    // to land. Without this, the live editor often doesn't see the
    // update until the tab is reopened.
    await new Promise((r) => setTimeout(r, 500));
    return ok;
  });
  return result === true;
}

/**
 * Can a codec host convert this document type right now? Main holds no codecs,
 * so "supported" is a question only a host can answer -- and the answer also
 * covers "no host is available", which must not read as "unsupported type"
 * being the user's fault.
 */
async function codecHostSupports(
  documentType: string,
  workspacePath: string,
): Promise<boolean> {
  try {
    await describeCollabCodec(documentType, { workspacePath });
    return true;
  } catch (error) {
    logger.main.info(
      `[CollabLocalOrigin] No codec host can handle document type '${documentType}'`,
      { error: error instanceof Error ? error.message : String(error) },
    );
    return false;
  }
}

async function migrateMarkdownAssetsForCollab(params: {
  workspacePath: string;
  orgId: string;
  documentId: string;
  sourceFilePath: string;
  markdown: string;
}): Promise<{ markdown: string; okCount: number; failedCount: number }> {
  const refs = scanMarkdownImageRefs(params.markdown);
  if (refs.length === 0) {
    return { markdown: params.markdown, okCount: 0, failedCount: 0 };
  }

  const substitutions = new Map<string, string>();
  let okCount = 0;
  let failedCount = 0;

  for (const ref of refs) {
    const resolved = resolveAssetRef(ref, params.sourceFilePath, params.workspacePath);
    if (resolved.kind === 'skip') continue;
    if (resolved.kind === 'rejected') {
      failedCount += 1;
      continue;
    }

    try {
      const fileBytes = await fs.readFile(resolved.absolutePath);
      const upload = await encryptAndUploadCollabAsset({
        orgId: params.orgId,
        documentId: params.documentId,
        fileBytes: fileBytes.buffer.slice(
          fileBytes.byteOffset,
          fileBytes.byteOffset + fileBytes.byteLength,
        ),
        mimeType: resolved.mimeType,
        fileName: resolved.fileName,
        syncHttpUrl: getCollabSyncHttpUrl(),
      });
      if (upload.success) {
        substitutions.set(ref, upload.uri);
        okCount += 1;
      } else {
        failedCount += 1;
      }
    } catch {
      failedCount += 1;
    }
  }

  return {
    markdown: rewriteMarkdownImageRefs(params.markdown, substitutions),
    okCount,
    failedCount,
  };
}

export async function recordLocalOriginShare(params: {
  workspacePath: string;
  documentId: string;
  documentType: string;
  sourceFilePath: string;
  lastLocalContentHash: string | null;
  lastCollabContentHash: string | null;
}): Promise<CollabLocalOriginBinding | null> {
  const team = await findTeamForWorkspace(params.workspacePath);
  if (!team) {
    throw new Error('No team found for this workspace.');
  }

  const relativePath = ensureWorkspaceRelativePath(params.workspacePath, params.sourceFilePath);
  const stats = await getSourceFileStats(params.sourceFilePath);

  await upsertBinding({
    orgId: team.orgId,
    documentId: params.documentId,
    projectId: team.teamProjectId ?? null,
    gitRemoteHash: team.gitRemoteHash ?? null,
    workspacePathHash: await computeWorkspacePathHash(params.workspacePath),
    relativePath,
    documentType: params.documentType,
    sourceBasename: path.basename(params.sourceFilePath),
    lastLocalContentHash: params.lastLocalContentHash,
    lastCollabContentHash: params.lastCollabContentHash,
    lastSyncedAt: new Date(),
    lastSeenMtimeMs: stats.mtimeMs,
    lastSeenSizeBytes: stats.sizeBytes,
    resolutionStatus: 'resolved',
    resolutionError: null,
  });

  return getLocalOriginBinding(params.workspacePath, params.documentId);
}

export async function getLocalOriginBinding(
  workspacePath: string,
  documentId: string,
): Promise<CollabLocalOriginBinding | null> {
  const team = await findTeamForWorkspace(workspacePath);
  if (!team) return null;

  const row = await fetchBindingRow(team.orgId, documentId);
  if (!row) return null;
  return resolveStoredBinding(workspacePath, row);
}

export async function clearLocalOriginBinding(
  workspacePath: string,
  documentId: string,
): Promise<void> {
  const team = await findTeamForWorkspace(workspacePath);
  if (!team) return;
  await database.query(
    'DELETE FROM collab_local_origins WHERE org_id = $1 AND document_id = $2',
    [team.orgId, documentId],
  );
}

export async function relinkLocalOriginBinding(params: {
  workspacePath: string;
  documentId: string;
  documentType: string;
  sourceFilePath: string;
}): Promise<CollabLocalOriginBinding | null> {
  const team = await findTeamForWorkspace(params.workspacePath);
  if (!team) {
    throw new Error('No team found for this workspace.');
  }

  const relativePath = ensureWorkspaceRelativePath(params.workspacePath, params.sourceFilePath);
  const sourceContent = await fs.readFile(params.sourceFilePath, 'utf8');
  const stats = await getSourceFileStats(params.sourceFilePath);
  // A shared-side read only supplies the collab baseline hash; if no host can
  // convert this type, relinking still records the local side.
  const sharedText = await readSharedDocText(
    params.workspacePath,
    params.documentId,
    params.documentType,
  ).catch((error) => {
    logger.main.info('[CollabLocalOrigin] Could not read shared text while relinking', {
      documentId: params.documentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  await upsertBinding({
    orgId: team.orgId,
    documentId: params.documentId,
    projectId: team.teamProjectId ?? null,
    gitRemoteHash: team.gitRemoteHash ?? null,
    workspacePathHash: await computeWorkspacePathHash(params.workspacePath),
    relativePath,
    documentType: params.documentType,
    sourceBasename: path.basename(params.sourceFilePath),
    lastLocalContentHash: hashText(sourceContent),
    lastCollabContentHash: sharedText !== null ? hashText(sharedText) : null,
    lastSyncedAt: null,
    lastSeenMtimeMs: stats.mtimeMs,
    lastSeenSizeBytes: stats.sizeBytes,
    resolutionStatus: 'relinked',
    resolutionError: null,
  });

  return getLocalOriginBinding(params.workspacePath, params.documentId);
}

export async function findLinkedDocumentForLocalPath(
  workspacePath: string,
  sourceFilePath: string,
): Promise<CollabLocalOriginBinding | null> {
  const team = await findTeamForWorkspace(workspacePath);
  if (!team) return null;

  const relativePath = ensureWorkspaceRelativePath(workspacePath, sourceFilePath);
  const row = await fetchBindingRowByRelativePath(team.orgId, relativePath);
  if (!row) return null;
  return resolveStoredBinding(workspacePath, row);
}

export async function reuploadFromLocalOrigin(params: {
  workspacePath: string;
  documentId: string;
  forceOverwriteShared?: boolean;
}): Promise<ReuploadLocalOriginResult> {
  const binding = await getLocalOriginBinding(params.workspacePath, params.documentId);
  if (!binding) {
    return {
      success: false,
      status: 'error',
      message: 'No local source is linked to this shared document.',
    };
  }

  if (!(await codecHostSupports(binding.documentType, params.workspacePath))) {
    return {
      success: false,
      status: 'unsupported',
      message: `No collab codec is available for document type '${binding.documentType}'.`,
      binding,
    };
  }

  if (!binding.resolvedPath) {
    return {
      success: false,
      status: 'missing-source',
      message: 'The linked local source file is not available in this workspace.',
      binding,
    };
  }

  try {
    const sourceBuffer = await fs.readFile(binding.resolvedPath);
    const sourceText = sourceBuffer.toString('utf8');
    const sharedRead = await readSharedDocWithMeta(
      params.workspacePath,
      params.documentId,
      binding.documentType,
    );
    if (sharedRead === null) {
      return {
        success: false,
        status: 'error',
        message: 'Could not read the current shared document state.',
        binding,
      };
    }
    const sharedText = sharedRead.text;

    const sourceHash = hashText(sourceText);
    const sharedHash = hashText(sharedText);
    const baselineLocal = binding.lastLocalContentHash;
    const baselineShared = binding.lastCollabContentHash;

    let conflictKind: ReuploadConflictKind | null = null;
    if (!baselineLocal || !baselineShared) {
      conflictKind = 'missing-baseline';
    } else if (sourceHash === baselineLocal && sharedHash === baselineShared) {
      return {
        success: true,
        status: 'noop',
        message: 'The local source and shared document already match the last synced baseline.',
        binding,
      };
    } else if (sourceHash === baselineLocal && sharedHash !== baselineShared) {
      conflictKind = 'shared-ahead';
    } else if (sourceHash !== baselineLocal && sharedHash !== baselineShared) {
      conflictKind = 'diverged';
    }

    if (conflictKind && !params.forceOverwriteShared) {
      return {
        success: false,
        status: 'conflict',
        conflictKind,
        binding,
        lastEditorId: sharedRead.lastWriterUserId,
        lastEditedAt: sharedRead.lastUpdatedAt,
      };
    }

    // Asset migration is markdown-specific: it scans Markdown image
    // refs and re-uploads each local image as an encrypted collab
    // asset. Other document types either embed their own assets in
    // the Y.Doc (Excalidraw) or don't reference external files at
    // all -- the adapter contract leaves binary-attachment handling
    // to each adapter.
    let payloadForUpload: string | Uint8Array;
    let payloadForHash: string;
    let migration: { okCount: number; failedCount: number } = { okCount: 0, failedCount: 0 };
    if (binding.documentType === 'markdown') {
      const migrated = await migrateMarkdownAssetsForCollab({
        workspacePath: params.workspacePath,
        orgId: binding.orgId,
        documentId: params.documentId,
        sourceFilePath: binding.resolvedPath,
        markdown: sourceText,
      });
      payloadForUpload = migrated.markdown;
      payloadForHash = migrated.markdown;
      migration = { okCount: migrated.okCount, failedCount: migrated.failedCount };
    } else {
      // Hand the adapter the original on-disk bytes; text-shaped
      // adapters decode internally, binary-shaped adapters get the
      // raw Uint8Array.
      payloadForUpload = sourceBuffer;
      payloadForHash = sourceText;
    }

    logger.main.info('[CollabLocalOrigin] reupload dispatching to adapter', {
      documentId: params.documentId,
      documentType: binding.documentType,
      payloadKind: typeof payloadForUpload === 'string' ? 'text' : 'binary',
      payloadLength: typeof payloadForUpload === 'string' ? payloadForUpload.length : payloadForUpload.byteLength,
    });
    const applied = await overwriteSharedDocFromSource(
      params.workspacePath,
      params.documentId,
      binding.documentType,
      payloadForUpload,
    );
    logger.main.info('[CollabLocalOrigin] reupload adapter write complete', {
      documentId: params.documentId,
      applied,
    });
    if (!applied) {
      return {
        success: false,
        status: 'error',
        message: 'Failed to write the local file back into the shared document.',
        binding,
      };
    }

    const stats = await getSourceFileStats(binding.resolvedPath);
    await upsertBinding({
      orgId: binding.orgId,
      documentId: binding.documentId,
      projectId: binding.projectId,
      gitRemoteHash: binding.gitRemoteHash,
      workspacePathHash: binding.workspacePathHash,
      relativePath: binding.relativePath,
      documentType: binding.documentType,
      sourceBasename: binding.sourceBasename,
      lastLocalContentHash: sourceHash,
      lastCollabContentHash: hashText(payloadForHash),
      lastSyncedAt: new Date(),
      lastSeenMtimeMs: stats.mtimeMs,
      lastSeenSizeBytes: stats.sizeBytes,
      resolutionStatus: 'resolved',
      resolutionError: null,
    });

    return {
      success: true,
      status: 'uploaded',
      message: 'Uploaded the current local file into the shared document.',
      binding: await getLocalOriginBinding(params.workspacePath, params.documentId),
      migration,
    };
  } catch (error) {
    logger.main.error('[CollabLocalOrigin] Re-upload failed:', error);
    return {
      success: false,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      binding,
    };
  }
}

export async function seedSharedDocumentFromContent(params: {
  workspacePath: string;
  documentId: string;
  documentType: string;
  content: string | Uint8Array;
}): Promise<boolean> {
  // Main-side seeding stays OPTIONAL, not a requirement. Returning false
  // (instead of throwing) lets the renderer-side seeding orchestrator treat
  // "main can't seed this type" as a fallback, not a hard error.
  if (!(await codecHostSupports(params.documentType, params.workspacePath))) {
    logger.main.info(
      `[CollabLocalOrigin] Deferring seed of '${params.documentType}' to the renderer.`,
    );
    return false;
  }

  return overwriteSharedDocFromSource(
    params.workspacePath,
    params.documentId,
    params.documentType,
    params.content,
  );
}
