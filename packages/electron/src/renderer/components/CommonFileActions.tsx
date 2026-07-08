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

import React, { useCallback, useMemo } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { useAtomValue } from 'jotai';
import { useFileActions } from '../hooks/useFileActions';
import { registerDocumentInIndex, pendingCollabDocumentAtom, workspaceHasTeamAtom } from '../store/atoms/collabDocuments';
import { setWindowModeAtom } from '../store/atoms/windowMode';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { customEditorRegistry } from './CustomEditors';
import { deriveCollabDocumentType } from '../utils/collabDocumentType';
import { getRelativePath } from '../utils/pathUtils';
import { dialogRef, DIALOG_IDS } from '../dialogs';
import type { ShareToTeamData } from '../dialogs';
import { joinCollabPath, normalizeCollabPath } from './CollabMode/collabTree';

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
  const collabDocumentType = useMemo(
    () => deriveCollabDocumentType(fileName, customEditorRegistry),
    [fileName]
  );
  const runShareToTeam = useCallback(async (folderPath: string, sharedName: string) => {
    const { errorNotificationService } = await import('../services/ErrorNotificationService');

    if (!collabDocumentType) {
      // Defensive: button is gated on this being non-null, but guard anyway.
      console.warn('[CommonFileActions] No collab document type for:', fileName);
      return;
    }
    const documentType = collabDocumentType;

    // Read file content to seed the collaborative document on first share.
    let initialContent: string | undefined;
    try {
      if (window.electronAPI?.invoke) {
        const result = await window.electronAPI.invoke('read-file-content', filePath);
        if (result?.success && typeof result.content === 'string') {
          initialContent = result.content;
        }
      }
    } catch (err) {
      console.warn('Failed to read file content for share:', err);
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

    const hashContent = async (content: string | undefined): Promise<string | null> => {
      if (typeof content !== 'string') return null;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
      return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
    };

    if (
      documentType === 'markdown' &&
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

    // Seed the room before the doc is announced in the shared-doc index.
    // Otherwise a teammate can open the link before the sharer’s auto-open
    // tab writes the first Yjs update, and they see an empty doc.
    //
    // The seeding orchestrator owns the strategy order (renderer-headless codec
    // -> main adapter). It works for EXTERNAL, STRUCTURED editors (mindmap)
    // that can supply a renderer codec but no main-process adapter -- the case
    // that used to throw "No collab content adapter is registered". Warn
    // whenever the pre-announcement seed is not confirmed. A renderer
    // codec means the auto-open tab can retry, but that retry has its own
    // server-ack failure path; suppressing this warning made blank-room seed
    // failures silent for external structured editors.
    let seedError: string | null = null;
    if (workspacePath && typeof migratedContent === 'string') {
      const { seedSharedDocument } = await import('../utils/documentSeedOrchestrator');
      const seedResult = await seedSharedDocument({
        workspacePath,
        documentId,
        documentType,
        title: shareTitle,
        content: migratedContent,
      });
      if (!seedResult.ok) {
        seedError =
          seedResult.error ||
          (seedResult.hasRendererCodec
            ? 'The renderer codec is available, but the initial shared content was not confirmed by the server before registration.'
            : 'No collaborative codec is available to write this document type into the shared room.');
        console.warn('[ShareToTeam] Seed did not confirm before registration:', {
          documentId,
          documentType,
          strategy: seedResult.strategy,
          hasRendererCodec: seedResult.hasRendererCodec,
          error: seedResult.error,
        });
      }
    }

    // Register in the doc index (optimistic local update is synchronous,
    // server registration happens in background)
    registerDocumentInIndex(documentId, shareTitle, documentType).catch(error => {
      console.error('Failed to register document in index:', error);
    });

    // Set the pending document so CollabMode auto-opens it (with content for seeding)
    store.set(pendingCollabDocumentAtom, {
      documentId,
      initialContent: migratedContent,
      documentType,
    });

    if (workspacePath && documentSync?.saveLocalOrigin) {
      try {
        await documentSync.saveLocalOrigin({
          workspacePath,
          documentId,
          documentType,
          sourceFilePath: filePath,
          lastLocalContentHash: await hashContent(initialContent),
          lastCollabContentHash: await hashContent(migratedContent),
        });
      } catch (error) {
        console.warn('[CommonFileActions] Failed to save local origin binding:', error);
      }
    }

    // Remember the destination folder so the next share defaults to it.
    if (workspacePath && window.electronAPI?.invoke) {
      window.electronAPI.invoke('workspace:update-state', workspacePath, {
        collabTree: { lastSharedFolder: normalizedFolder },
      }).catch((error: unknown) => {
        console.warn('[CommonFileActions] Failed to persist lastSharedFolder:', error);
      });
    }

    // Switch to collab mode immediately
    store.set(setWindowModeAtom, 'collab');

    if (seedError) {
      errorNotificationService.showWarning(
        'Shared with pending seed',
        `"${shareTitle}" was shared, but its initial content could not be written to the shared room yet. Teammates may see a blank doc until it is reopened or re-uploaded.`,
        { details: seedError, duration: 10000 },
      );
      return;
    }

    switch (migrationToast.kind) {
      case 'ok':
        errorNotificationService.showInfo(
          'Shared to team',
          `"${shareTitle}" is now a collaborative document. Migrated ${migrationToast.okCount} attachment${migrationToast.okCount === 1 ? '' : 's'}.`,
          { duration: 4000 },
        );
        break;
      case 'partial':
        errorNotificationService.showWarning(
          'Shared with missing attachments',
          `"${shareTitle}" was shared but ${migrationToast.failedCount} attachment${migrationToast.failedCount === 1 ? '' : 's'} failed to upload.`,
          { duration: 8000 },
        );
        break;
      case 'unavailable':
        errorNotificationService.showWarning(
          'Shared to team',
          `"${shareTitle}" is now collaborative, but image attachments could not be migrated${migrationToast.message ? `: ${migrationToast.message}` : '.'}`,
          { duration: 8000 },
        );
        break;
      case 'no-assets':
      default:
        errorNotificationService.showInfo(
          'Shared to team',
          `"${shareTitle}" is now a collaborative document.`,
          { duration: 4000 },
        );
        break;
    }
  }, [filePath, fileName, collabDocumentType]);

  const openShareToTeamDialog = useCallback(() => {
    const workspacePath = store.get(activeWorkspacePathAtom);
    const sourceRelPath = workspacePath ? getRelativePath(workspacePath, filePath) || fileName : fileName;
    dialogRef.current?.open<ShareToTeamData>(DIALOG_IDS.SHARE_TO_TEAM, {
      fileName,
      sourceRelPath,
      onConfirm: ({ folderPath, sharedName }) => {
        runShareToTeam(folderPath, sharedName);
      },
    });
  }, [filePath, fileName, runShareToTeam]);

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
      <Item
        className={menuItemClass}
        onClick={() => { actions.copyFilePath(); onClose(); }}
      >
        {showIcons && <MaterialSymbol icon="content_copy" size={iconSize} />}
        <span>Copy Path</span>
      </Item>

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

      {/* Share to Team -- shown only when the file's type is actually
          collab-supported (built-in markdown, or an extension that declares
          `collaboration.supported: true`) AND the workspace has a team. */}
      {collabDocumentType && hasTeam && (
        <Item
          className={menuItemClass}
          onClick={() => { openShareToTeamDialog(); onClose(); }}
        >
          {showIcons && <MaterialSymbol icon="group" size={iconSize} />}
          <span>Share to Team</span>
        </Item>
      )}
    </>
  );
}
