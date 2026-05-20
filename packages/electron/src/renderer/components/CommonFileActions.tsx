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

/**
 * Derive the logical collab document type from a filename. Returns the file
 * extension without the leading dot (e.g. 'excalidraw', 'mindmap') for
 * extension-handled types, 'markdown' for `.md`/`.markdown`, or null if the
 * file is not eligible for collab share. Compound suffixes (`.mockup.html`)
 * are not yet collab-supported and return null.
 */
function deriveCollabDocumentType(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  // Look up by full filename via the registry so multi-segment extensions
  // (`.reddit.watch.json`) match the longest registered suffix.
  const registration = customEditorRegistry.findRegistrationForFile(lower);
  if (registration?.collaboration?.supported) {
    const dot = lower.lastIndexOf('.');
    if (dot < 0) return null;
    return lower.slice(dot + 1);
  }
  return null;
}

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
    () => deriveCollabDocumentType(fileName),
    [fileName]
  );
  const handleShareToTeam = useCallback(async () => {
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
        if (result?.success && result?.content) {
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
    const documentSync = window.electronAPI?.documentSync;
    let migratedContent = initialContent;
    let migrationToast: { kind: 'ok' | 'partial' | 'no-assets' | 'unavailable' | 'total-failure'; message?: string; failedCount?: number; okCount?: number } = { kind: 'no-assets' };

    if (
      documentType === 'markdown' &&
      initialContent &&
      workspacePath &&
      documentSync?.open &&
      documentSync?.migrateLocalAssets
    ) {
      try {
        const openResult = await documentSync.open(workspacePath, fileName, fileName);
        if (!openResult.success || !openResult.config) {
          throw new Error(openResult.error || 'Failed to open collab document for migration');
        }
        const { orgId, documentId } = openResult.config;
        try {
          const migration = await documentSync.migrateLocalAssets({
            workspacePath,
            orgId,
            documentId,
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
          await documentSync.closeDoc(documentId).catch(() => {});
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

    // Register in the doc index (optimistic local update is synchronous,
    // server registration happens in background)
    registerDocumentInIndex(fileName, fileName, documentType).catch(error => {
      console.error('Failed to register document in index:', error);
    });

    // Set the pending document so CollabMode auto-opens it (with content for seeding)
    store.set(pendingCollabDocumentAtom, {
      documentId: fileName,
      initialContent: migratedContent,
      documentType,
    });

    // Switch to collab mode immediately
    store.set(setWindowModeAtom, 'collab');

    switch (migrationToast.kind) {
      case 'ok':
        errorNotificationService.showInfo(
          'Shared to team',
          `"${fileName}" is now a collaborative document. Migrated ${migrationToast.okCount} attachment${migrationToast.okCount === 1 ? '' : 's'}.`,
          { duration: 4000 },
        );
        break;
      case 'partial':
        errorNotificationService.showWarning(
          'Shared with missing attachments',
          `"${fileName}" was shared but ${migrationToast.failedCount} attachment${migrationToast.failedCount === 1 ? '' : 's'} failed to upload.`,
          { duration: 8000 },
        );
        break;
      case 'unavailable':
        errorNotificationService.showWarning(
          'Shared to team',
          `"${fileName}" is now collaborative, but image attachments could not be migrated${migrationToast.message ? `: ${migrationToast.message}` : '.'}`,
          { duration: 8000 },
        );
        break;
      case 'no-assets':
      default:
        errorNotificationService.showInfo(
          'Shared to team',
          `"${fileName}" is now a collaborative document.`,
          { duration: 4000 },
        );
        break;
    }
  }, [filePath, fileName, collabDocumentType]);

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
          onClick={() => { handleShareToTeam(); onClose(); }}
        >
          {showIcons && <MaterialSymbol icon="group" size={iconSize} />}
          <span>Share to Team</span>
        </Item>
      )}
    </>
  );
}
