/**
 * CommonFileActions - Shared menu items for file operations.
 *
 * Renders the common file action items (Open in Default App, Open in External Editor,
 * Show in Finder, Copy Path, Share Link, Share to Team) used across multiple context menus:
 * - FileContextMenu (file tree right-click)
 * - TabBar context menu (tab right-click)
 * - UnifiedEditorHeaderBar (header actions dropdown)
 *
 * Each consumer provides CSS classes to match their own styling.
 */

import React, { useCallback, useMemo, useSyncExternalStore } from 'react';
import { getEmbeddableExtensions, MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { useAtomValue } from 'jotai';
import { useFileActions } from '../hooks/useFileActions';
import {
  activeTeamOrgIdAtom,
  trashSharedDocument,
  workspaceHasTeamAtom,
} from '../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { getRelativePath } from '../utils/pathUtils';
import { dialogRef, DIALOG_IDS } from '../dialogs';
import type { ShareToTeamData } from '../dialogs';
import { joinCollabPath, normalizeCollabPath } from './CollabMode/collabTree';
import { isCollabUri } from '../utils/collabUri';
import {
  getCollaborativeDocumentTypeCatalog,
  type CollaborativeDocumentTypeDescriptor,
} from '../services/CollaborativeDocumentTypeCatalog';
import {
  CollaborativeDocumentCreationError,
  createCollaborativeDocument,
} from '../services/collaborativeDocumentCreationOrchestrator';
import {
  discoverEmbeddedDocuments,
  rewriteEmbeddedDocumentLinks,
  shareEmbeddedDocuments,
  type EmbeddedDocumentCandidate,
} from '../services/embeddedDocumentShare';

interface CommonFileActionsProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
  /** CSS class for each menu item row */
  menuItemClass: string;
  /** CSS class for separator divs */
  separatorClass: string;
  /** Icon size in px (default 18) */
  iconSize?: number;
  /** Whether to show icons (default true) */
  showIcons?: boolean;
  /** Render items as <button> elements instead of <div> (default false) */
  useButtons?: boolean;
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function readShareToTeamSourceContent(
  filePath: string,
  descriptor: CollaborativeDocumentTypeDescriptor,
): Promise<string | Uint8Array> {
  const binary = descriptor.content.strategy === 'opaque-versioned';
  const api = window.electronAPI;
  const result = api?.readFileContent
    ? await api.readFileContent(filePath, binary ? { binary: true } : undefined)
    : await api?.invoke?.('read-file-content', filePath, binary ? { binary: true } : undefined);
  if (!result?.success || typeof result.content !== 'string') {
    const reason = result && 'error' in result ? result.error : 'The source file could not be read.';
    throw new Error(reason);
  }
  return binary ? decodeBase64Bytes(result.content) : result.content;
}

export function CommonFileActions({
  filePath,
  fileName,
  onClose,
  menuItemClass,
  separatorClass,
  iconSize = 18,
  showIcons = true,
  useButtons = false,
}: CommonFileActionsProps) {
  const actions = useFileActions(filePath, fileName);
  const hasTeam = useAtomValue(workspaceHasTeamAtom);
  const documentTypeCatalog = getCollaborativeDocumentTypeCatalog();
  const catalogRevision = useSyncExternalStore(
    documentTypeCatalog.subscribe,
    documentTypeCatalog.getSnapshot,
    documentTypeCatalog.getSnapshot,
  );
  const shareability = useMemo(
    () => documentTypeCatalog.resolveShareability(fileName),
    [catalogRevision, documentTypeCatalog, fileName],
  );
  const runShareToTeam = useCallback(async (
    folderId: string | null,
    folderPath: string,
    sharedName: string,
    selectedDescriptor: CollaborativeDocumentTypeDescriptor,
    embeddedDocuments: EmbeddedDocumentCandidate[] = [],
    selectedEmbeddedDocumentPaths: string[] = [],
  ) => {
    const { errorNotificationService } = await import('../services/ErrorNotificationService');
    const matchedSuffix = [...selectedDescriptor.fileExtensions]
      .sort((left, right) => right.length - left.length)
      .find(suffix => fileName.toLowerCase().endsWith(suffix.toLowerCase()))
      ?? selectedDescriptor.defaultExtension;
    const liveResolution = documentTypeCatalog.resolveMetadata(
      selectedDescriptor.documentType,
      matchedSuffix,
      documentTypeCatalog.editorIdForDescriptor(selectedDescriptor),
    );
    if (liveResolution.state !== 'ready') {
      errorNotificationService.showError(
        'Could not share to team',
        liveResolution.reason,
      );
      return;
    }
    const descriptor = liveResolution.descriptor;
    const documentType = descriptor.documentType;

    // Read file content to seed the collaborative document on first share.
    let initialContent: string | Uint8Array;
    try {
      initialContent = await readShareToTeamSourceContent(filePath, descriptor);
    } catch (err) {
      errorNotificationService.showError(
        'Could not share to team',
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    // Pre-seed migration of pasted image attachments. Local refs like
    // `assets/<hash>.png` only exist on this user's disk; without migration
    // collaborators see broken images. We upload through the encrypted
    // collab-asset path and rewrite the markdown before it ever reaches the
    // Y.Doc. Best-effort: failures are reported in the toast but don't
    // block the share unless every asset failed.
    //
    // Markdown only -- non-markdown asset shapes (Excalidraw's inline
    // base64 images, mindmap's no-attachments) are handled differently or
    // not at all; we skip the markdown rewriter for them entirely.
    const workspacePath = store.get(activeWorkspacePathAtom);
    const normalizedFolder = normalizeCollabPath(folderPath);
    const trimmedName = sharedName.trim() || fileName;
    // joinCollabPath handles empty parent -> root and normalizes separators.
    const shareTitle = joinCollabPath(normalizedFolder, trimmedName);
    const documentId = crypto.randomUUID();
    const documentSync = window.electronAPI?.documentSync;
    let migratedContent = initialContent;
    let migrationToast: { kind: 'ok' | 'partial' | 'no-assets' | 'unavailable' | 'total-failure'; message?: string; failedCount?: number; okCount?: number } = { kind: 'no-assets' };

    if (
      documentType === 'markdown' &&
      typeof initialContent === 'string' &&
      initialContent &&
      workspacePath &&
      documentSync?.open &&
      documentSync?.migrateLocalAssets
    ) {
      try {
        const openResult = await documentSync.open(workspacePath, documentId, shareTitle, documentType);
        if (!openResult.success || !openResult.config) {
          throw new Error(openResult.error || 'Failed to open collab document for migration');
        }
        const { orgId, documentId: openedDocumentId } = openResult.config;
        try {
          const migration = await documentSync.migrateLocalAssets({
            workspacePath,
            orgId,
            documentId: openedDocumentId,
            sourceFilePath: filePath,
            markdown: initialContent,
          });
          if (migration.success && migration.rewrittenMarkdown !== undefined && migration.results) {
            const okCount = migration.results.filter(r => r.status === 'ok').length;
            const failedCount = migration.results.filter(
              r => r.status === 'failed' || r.status === 'missing' || r.status === 'rejected',
            ).length;
            const attempted = okCount + failedCount;
            if (attempted > 0 && okCount === 0) {
              migrationToast = { kind: 'total-failure', failedCount };
            } else {
              migratedContent = migration.rewrittenMarkdown;
              migrationToast =
                attempted === 0
                  ? { kind: 'no-assets' }
                  : failedCount > 0
                  ? { kind: 'partial', okCount, failedCount }
                  : { kind: 'ok', okCount };
            }
          } else if (!migration.success) {
            migrationToast = { kind: 'unavailable', message: migration.error };
          }
        } finally {
          // Drop the migration-pass registration. CollabMode will reopen the
          // doc when its tab mounts; otherwise we'd permanently inflate the
          // sender refcount by 1.
          await documentSync.closeDoc(openedDocumentId).catch(() => {});
        }
      } catch (err) {
        console.warn('[ShareToTeam] Asset migration failed:', err);
        migrationToast = {
          kind: 'unavailable',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    if (migrationToast.kind === 'total-failure') {
      errorNotificationService.showError(
        'Could not share to team',
        `All ${migrationToast.failedCount ?? ''} attached images failed to upload. Check your connection and try again.`,
        { duration: 8000 },
      );
      return;
    }

    let embeddedShareResult: Awaited<ReturnType<typeof shareEmbeddedDocuments>> = {
      sharedReferences: new Map(),
      createdDocumentIds: [],
      failures: [],
    };
    if (
      documentType === 'markdown'
      && typeof migratedContent === 'string'
      && workspacePath
      && embeddedDocuments.length > 0
      && selectedEmbeddedDocumentPaths.length > 0
    ) {
      embeddedShareResult = await shareEmbeddedDocuments({
        candidates: embeddedDocuments,
        selectedPaths: new Set(selectedEmbeddedDocumentPaths),
        parentFolderId: folderId,
        readSourceContent: candidate =>
          readShareToTeamSourceContent(candidate.absolutePath, candidate.descriptor),
        createDocument: createCollaborativeDocument,
        generateId: () => crypto.randomUUID(),
        resolveOrgId: async () => {
          const orgId = store.get(activeTeamOrgIdAtom);
          if (!orgId) {
            throw new Error('The active team organization is unavailable.');
          }
          return orgId;
        },
      });
      migratedContent = rewriteEmbeddedDocumentLinks({
        markdown: migratedContent,
        sourceFilePath: filePath,
        workspacePath,
        candidates: embeddedDocuments,
        sharedReferences: embeddedShareResult.sharedReferences,
      });
    }

    let createdDocument;
    try {
      createdDocument = await createCollaborativeDocument({
        descriptor,
        requestedName: trimmedName,
        parentFolderId: folderId,
        sourceContent: migratedContent,
        localOrigin: {
          sourceFilePath: filePath,
          sourceContent: initialContent,
        },
        operationId: documentId,
        documentId,
      });
    } catch (error) {
      // The cascade already created the child documents. Without this the
      // team is left with orphaned embeds whose parent never existed.
      for (const orphanId of embeddedShareResult.createdDocumentIds) {
        try {
          trashSharedDocument(orphanId);
        } catch (rollbackError) {
          console.warn('[CommonFileActions] Could not roll back linked document:', rollbackError);
        }
      }
      const details = error instanceof CollaborativeDocumentCreationError
        ? `${error.code} (document ${error.documentId})`
        : undefined;
      errorNotificationService.showError(
        'Could not share to team',
        error instanceof Error ? error.message : String(error),
        { details, duration: 10000 },
      );
      return;
    }
    const finalTitle = createdDocument.title;
    const linkedCount = embeddedShareResult.sharedReferences.size;
    const linkedFailureCount = embeddedShareResult.failures.length;

    // Remember the destination folder so the next share defaults to it.
    if (workspacePath && window.electronAPI?.invoke) {
      window.electronAPI.invoke('workspace:update-state', workspacePath, {
        collabTree: {
          lastSharedFolderId: folderId,
          // Keep the path during migration so older clients retain their
          // last-used destination behavior.
          lastSharedFolder: normalizedFolder,
        },
      }).catch((error: unknown) => {
        console.warn('[CommonFileActions] Failed to persist lastSharedFolder:', error);
      });
    }

    // Attachment and linked-document outcomes are independent: a doc can lose
    // an image upload AND a linked embed. Report both in one toast rather than
    // letting either result hide the other.
    const linkedParts: string[] = [];
    if (linkedCount > 0) {
      linkedParts.push(`Shared ${linkedCount} linked document${linkedCount === 1 ? '' : 's'}.`);
    }
    if (linkedFailureCount > 0) {
      linkedParts.push(`${linkedFailureCount} linked document${linkedFailureCount === 1 ? '' : 's'} could not be shared and remain local links.`);
    }
    const linkedSummary = linkedParts.length > 0 ? ` ${linkedParts.join(' ')}` : '';
    const linkedDetails = linkedFailureCount > 0
      ? embeddedShareResult.failures
          .map(failure => `${failure.fileName}: ${failure.error}`)
          .join('\n')
      : undefined;

    switch (migrationToast.kind) {
      case 'ok':
      case 'no-assets':
      default: {
        const body = migrationToast.kind === 'ok'
          ? `"${finalTitle}" is now a collaborative document. Migrated ${migrationToast.okCount} attachment${migrationToast.okCount === 1 ? '' : 's'}.${linkedSummary}`
          : `"${finalTitle}" is now a collaborative document.${linkedSummary}`;
        if (linkedFailureCount > 0) {
          errorNotificationService.showWarning(
            'Shared with missing linked documents',
            body,
            { details: linkedDetails, duration: 10000 },
          );
        } else {
          errorNotificationService.showInfo('Shared to team', body, { duration: 4000 });
        }
        break;
      }
      case 'partial':
        errorNotificationService.showWarning(
          'Shared with missing attachments',
          `"${finalTitle}" was shared but ${migrationToast.failedCount} attachment${migrationToast.failedCount === 1 ? '' : 's'} failed to upload.${linkedSummary}`,
          { details: linkedDetails, duration: 8000 },
        );
        break;
      case 'unavailable':
        errorNotificationService.showWarning(
          'Shared to team',
          `"${finalTitle}" is now collaborative, but image attachments could not be migrated${migrationToast.message ? `: ${migrationToast.message}` : '.'}${linkedSummary}`,
          { details: linkedDetails, duration: 8000 },
        );
        break;
    }
  }, [documentTypeCatalog, filePath, fileName]);

  const openShareToTeamDialog = useCallback(async () => {
    if (shareability.state !== 'ready') return;
    const descriptor = shareability.descriptor;
    const workspacePath = store.get(activeWorkspacePathAtom);
    const sourceRelPath = workspacePath ? getRelativePath(workspacePath, filePath) || fileName : fileName;
    let embeddedDocuments: EmbeddedDocumentCandidate[] = [];
    if (descriptor.documentType === 'markdown' && workspacePath) {
      try {
        const source = await readShareToTeamSourceContent(filePath, descriptor);
        if (typeof source === 'string') {
          embeddedDocuments = await discoverEmbeddedDocuments({
            markdown: source,
            sourceFilePath: filePath,
            workspacePath,
            embeddableExtensions: getEmbeddableExtensions(),
            catalog: documentTypeCatalog,
            expectedOrgId: store.get(activeTeamOrgIdAtom),
            // `file:exists` stats the path. Reading the file just to learn it
            // exists pulls whole binary embeds (STEP, large drawings) into the
            // renderer on every context-menu open.
            fileExists: async absolutePath => {
              const exists = await window.electronAPI?.invoke?.('file:exists', absolutePath);
              return exists === true;
            },
            findExisting: async absolutePath => {
              const result = await window.electronAPI?.documentSync?.findLocalOriginLink?.(
                workspacePath,
                absolutePath,
              );
              const binding = result?.success ? result.binding : null;
              return binding
                ? { documentId: binding.documentId, orgId: binding.orgId }
                : null;
            },
          });
        }
      } catch (error) {
        console.warn('[CommonFileActions] Could not inspect embedded documents:', error);
      }
    }
    dialogRef.current?.open<ShareToTeamData>(DIALOG_IDS.SHARE_TO_TEAM, {
      fileName,
      sourceRelPath,
      descriptor,
      embeddedDocuments,
      onConfirm: ({
        folderId,
        folderPath,
        sharedName,
        selectedEmbeddedDocumentPaths,
      }) => {
        runShareToTeam(
          folderId,
          folderPath,
          sharedName,
          descriptor,
          embeddedDocuments,
          selectedEmbeddedDocumentPaths,
        );
      },
    });
  }, [documentTypeCatalog, filePath, fileName, runShareToTeam, shareability]);

  const Item = useButtons ? 'button' : 'div';

  return (
    <>
      {/* Open in Default App */}
      <Item
        className={menuItemClass}
        onClick={() => { actions.openInDefaultApp(); onClose(); }}
      >
        {showIcons && <MaterialSymbol icon="launch" size={iconSize} />}
        <span>Open in Default App</span>
      </Item>

      {/* Open in External Editor (conditional) */}
      {actions.hasExternalEditor && (
        <Item
          className={menuItemClass}
          onClick={() => { actions.openInExternalEditor(); onClose(); }}
        >
          {showIcons && <MaterialSymbol icon="open_in_new" size={iconSize} />}
          <span>Open in {actions.externalEditorName}</span>
        </Item>
      )}

      {/* Show in Finder */}
      <Item
        className={menuItemClass}
        onClick={() => { actions.revealInFinder(); onClose(); }}
      >
        {showIcons && <MaterialSymbol icon="folder_open" size={iconSize} />}
        <span>Show in Finder</span>
      </Item>

      {/* Copy Path */}
      {!isCollabUri(filePath) && (
        <Item
          className={menuItemClass}
          onClick={() => { actions.copyFilePath(); onClose(); }}
        >
          {showIcons && <MaterialSymbol icon="content_copy" size={iconSize} />}
          <span>Copy Path</span>
        </Item>
      )}

      {/* Share Link (conditional on file type) */}
      {actions.isShareable && (
        <Item
          className={menuItemClass}
          onClick={() => { actions.shareLink(); onClose(); }}
        >
          {showIcons && <MaterialSymbol icon="share" size={iconSize} />}
          <span>Share Link</span>
        </Item>
      )}

      {/* Team workspaces always explain catalog eligibility. Unsupported
          types stay visible but cannot open the promotion dialog. */}
      {hasTeam && !isCollabUri(filePath) && (
        <Item
          className={`${menuItemClass} ${shareability.state === 'ready' ? '' : 'opacity-55 cursor-not-allowed'}`}
          aria-disabled={shareability.state !== 'ready'}
          title={shareability.state === 'unsupported' ? shareability.reason : undefined}
          onClick={() => {
            if (shareability.state !== 'ready') return;
            void openShareToTeamDialog();
            onClose();
          }}
        >
          {showIcons && <MaterialSymbol icon="group" size={iconSize} />}
          <span className="min-w-0 flex-1">
            <span className="block">Share to Team</span>
            {shareability.state === 'unsupported' && (
              <span className="block text-[11px] leading-snug text-nim-disabled mt-0.5">
                {shareability.reason}
              </span>
            )}
          </span>
        </Item>
      )}
    </>
  );
}
