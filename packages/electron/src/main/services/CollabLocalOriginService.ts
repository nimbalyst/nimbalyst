import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import WebSocket from 'ws';
import { $getRoot } from 'lexical';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  EditorNodes,
  getEditorTransformers,
} from '@nimbalyst/runtime/editor';
import {
  DocumentSyncProvider,
  HeadlessLexicalYDoc,
  type DocumentSyncConfig,
} from '@nimbalyst/runtime/sync';
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
}

interface CollabLocalOriginRow {
  org_id: string;
  document_id: string;
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
        $11, $12, $13, $14, $15, $16
      )
      ON CONFLICT (org_id, document_id) DO UPDATE SET
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

async function withHeadlessMarkdownDocument<T>(
  workspacePath: string,
  documentId: string,
  callback: (helpers: {
    provider: DocumentSyncProvider;
    headless: HeadlessLexicalYDoc;
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

  const headless = new HeadlessLexicalYDoc({
    doc: provider.getYDoc(),
    nodes: EditorNodes,
    provider: {
      awareness: {
        getLocalState: () => null,
        getStates: () => new Map(),
        setLocalState: () => {},
        setLocalStateField: () => {},
        on: () => {},
        off: () => {},
      },
      connect: () => provider.connect(),
      disconnect: () => provider.disconnect(),
      on: () => {},
      off: () => {},
      getYDoc: () => provider.getYDoc(),
    } as any,
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
    return await callback({ provider, headless });
  } finally {
    try {
      headless.destroy();
    } catch {
      // Ignore cleanup failures.
    }
    try {
      provider.destroy();
    } catch {
      // Ignore cleanup failures.
    }
  }
}

async function readSharedMarkdown(
  workspacePath: string,
  documentId: string,
): Promise<string | null> {
  return withHeadlessMarkdownDocument(workspacePath, documentId, async ({ headless }) => {
    return headless.editor.getEditorState().read(() => {
      return $convertToEnhancedMarkdownString(getEditorTransformers());
    });
  });
}

async function overwriteSharedMarkdown(
  workspacePath: string,
  documentId: string,
  markdown: string,
): Promise<boolean> {
  const result = await withHeadlessMarkdownDocument(workspacePath, documentId, async ({ headless }) => {
    headless.applyUpdate(() => {
      $getRoot().clear();
      $convertFromEnhancedMarkdownString(markdown, getEditorTransformers());
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    return true;
  });
  return result === true;
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
  const sharedMarkdown =
    params.documentType === 'markdown'
      ? await readSharedMarkdown(params.workspacePath, params.documentId)
      : null;

  await upsertBinding({
    orgId: team.orgId,
    documentId: params.documentId,
    gitRemoteHash: team.gitRemoteHash ?? null,
    workspacePathHash: await computeWorkspacePathHash(params.workspacePath),
    relativePath,
    documentType: params.documentType,
    sourceBasename: path.basename(params.sourceFilePath),
    lastLocalContentHash: hashText(sourceContent),
    lastCollabContentHash: sharedMarkdown !== null ? hashText(sharedMarkdown) : null,
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

  if (binding.documentType !== 'markdown') {
    return {
      success: false,
      status: 'unsupported',
      message: 'Re-upload from local source currently supports markdown shared documents only.',
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
    const sourceContent = await fs.readFile(binding.resolvedPath, 'utf8');
    const sharedMarkdown = await readSharedMarkdown(params.workspacePath, params.documentId);
    if (sharedMarkdown === null) {
      return {
        success: false,
        status: 'error',
        message: 'Could not read the current shared document state.',
        binding,
      };
    }

    const sourceHash = hashText(sourceContent);
    const sharedHash = hashText(sharedMarkdown);
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
      };
    }

    const migrated = await migrateMarkdownAssetsForCollab({
      workspacePath: params.workspacePath,
      orgId: binding.orgId,
      documentId: params.documentId,
      sourceFilePath: binding.resolvedPath,
      markdown: sourceContent,
    });

    const applied = await overwriteSharedMarkdown(
      params.workspacePath,
      params.documentId,
      migrated.markdown,
    );
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
      gitRemoteHash: binding.gitRemoteHash,
      workspacePathHash: binding.workspacePathHash,
      relativePath: binding.relativePath,
      documentType: binding.documentType,
      sourceBasename: binding.sourceBasename,
      lastLocalContentHash: sourceHash,
      lastCollabContentHash: hashText(migrated.markdown),
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
      migration: {
        okCount: migrated.okCount,
        failedCount: migrated.failedCount,
      },
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
