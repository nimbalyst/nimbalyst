/**
 * EmbedFrame -- the renderer-side implementation of an inline embedded
 * editor. Mounted by Lexical's `EmbeddedFileNode.decorate()` via the
 * runtime's `embedPluginCallbacks.renderEmbed` slot.
 *
 * Responsibilities:
 *   - Resolve the markdown link target against the host doc's directory.
 *   - Look up which extension can render the file in `customEditorRegistry`.
 *   - Build a read-only `EditorHost` for the embedded file (with the
 *     workspace file watcher wired through).
 *   - Render the chrome (file path + Edit button) above the extension
 *     component, with an error boundary so a broken embed never takes
 *     down the surrounding Lexical doc.
 *   - Provide drag-to-resize handles on the south, east, and southeast
 *     edges (matching the image-resize UX). New dimensions are written
 *     back to the `EmbeddedFileNode`'s `attrs.height` / `attrs.width` so
 *     they round-trip through markdown as link-title attributes.
 *
 * Phase 1: no IntersectionObserver gating, no mount cap. Always mount the
 * extension; performance gating lands in Phase 3.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAtomValue } from 'jotai';
import { basename } from 'pathe';
import { useEmbedFilePath } from './useEmbedFilePath';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection';
import type { EmbedFrameProps } from '@nimbalyst/runtime';
import { useDocumentPath, MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';

import { customEditorRegistry } from '../CustomEditors/registry';
import { fileChangedOnDiskAtomFamily } from '../../store/atoms/fileWatch';
import { useTheme } from '../../hooks/useTheme';
import { createEmbeddedFileHost } from './createEmbeddedFileHost';
import {
  DEFAULT_EMBED_HEIGHT_PX,
  EmbedChrome,
  EmbedErrorBoundary,
  EmbedFrameShell,
  EmbedResizeHandles,
  EmbedUnresolved,
  MIN_EMBED_HEIGHT_PX,
  MIN_EMBED_WIDTH_PX,
  parseOptionalPx,
  parsePx,
  useEmbedResize,
} from './EmbedFrameShell';
import { CollaborativeEmbedEditor } from './CollaborativeEmbedEditor';
import {
  openFileInTab,
  readFileFromDisk,
  workspaceRelativePath,
  writeFileToDisk,
} from './embeddedFileIo';
import { getSaveFailureMessage } from '../../utils/fileSaveResult';
import { createEmbeddedAutosaveController } from './embeddedAutosave';
import {
  parseCollaborativeEmbedReference,
  type CollaborativeEmbedProviderRequest,
  type CollaborativeEmbedReference,
} from '../../services/CollaborativeEmbedProviderCache';
import { resolveSharedSpaceEmbedReference } from './sharedSpaceEmbedResolution';
import { resolveCollaborativeEmbedRequest } from './resolveCollaborativeEmbedRequest';
import {
  activeCollabScopeAtom,
  activeTeamOrgIdAtom,
  pendingCollabDocumentAtom,
  sharedDocumentsAtom,
  sharedFoldersAtom,
} from '../../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { openSharedDocumentInTab as openSharedDocument } from '../../utils/openSharedDocumentInTab';
import { getCollaborativeDocumentTypeCatalog } from '../../services/CollaborativeDocumentTypeCatalog';
import { isCollabUri, parseCollabUri } from '@nimbalyst/collab-protocol';

import './EmbedFrame.css';

const openSharedDocumentInTab = (documentId: string): void => {
  openSharedDocument(documentId, 'embedded_document');
};

// ----------------------------------------------------------------------------

export const EmbedFrame: React.FC<EmbedFrameProps> = (props) => {
  const { src, label, attrs, nodeKey, detached = false } = props;
  const { documentDir, documentPath } = useDocumentPath();
  const { theme } = useTheme();
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  const sharedFolders = useAtomValue(sharedFoldersAtom);
  const activeWorkspacePath = useAtomValue(activeWorkspacePathAtom);
  const activeTeamOrgId = useAtomValue(activeTeamOrgIdAtom);
  const [editor] = useLexicalComposerContext();
  const [renderError, setRenderError] = useState<Error | null>(null);

  const frameRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const { path: absolutePath, pending: pathPending, error: pathError } = useEmbedFilePath(
    src, documentDir, activeWorkspacePath,
  );

  const localRegistration = useMemo(() => {
    if (!absolutePath) return undefined;
    return customEditorRegistry.findRegistrationForFile(absolutePath);
  }, [absolutePath]);

  const hostDocumentOrgId = useMemo(() => {
    if (!documentPath || !isCollabUri(documentPath)) return null;
    try {
      return parseCollabUri(documentPath).orgId;
    } catch {
      return null;
    }
  }, [documentPath]);

  const explicitCollaborativeReference = useMemo(
    () => parseCollaborativeEmbedReference(src),
    [src],
  );

  // Inside a SHARED host document a plain relative link names a sibling in the
  // team's collab space, not a file on this machine -- there is no workspace
  // root to resolve it against. Map it onto a shared document so it takes the
  // collaborative branch below; `null` falls through to filesystem resolution
  // exactly as before (NIM-2271). Reduced to a primitive id here for the same
  // reason the fields below are: the atoms churn on every TeamRoom broadcast.
  const sharedSpaceDocumentId = useMemo(() => {
    if (explicitCollaborativeReference) return null;
    return resolveSharedSpaceEmbedReference({
      src,
      hostOrgId: hostDocumentOrgId,
      hostDocumentId: documentPath && isCollabUri(documentPath) ? parseCollabUri(documentPath).documentId : null,
      documents: sharedDocuments,
      folders: sharedFolders,
    })?.documentId ?? null;
  }, [explicitCollaborativeReference, src, hostDocumentOrgId, documentPath, sharedDocuments, sharedFolders]);

  const collaborativeReference = useMemo<CollaborativeEmbedReference | null>(() => {
    if (explicitCollaborativeReference) return explicitCollaborativeReference;
    if (!sharedSpaceDocumentId || !hostDocumentOrgId) return null;
    return { documentId: sharedSpaceDocumentId, orgId: hostDocumentOrgId };
  }, [explicitCollaborativeReference, sharedSpaceDocumentId, hostDocumentOrgId]);

  const effectiveTeamOrgId = hostDocumentOrgId ?? activeTeamOrgId;

  // `sharedDocumentsAtom` is a derived filter: every TeamRoom broadcast --
  // any teammate creating, renaming, or trashing ANY document -- yields a new
  // array. Depending on the array directly would rebuild `request` below on
  // each broadcast, and `CollaborativeEmbedEditor` keys its provider effect on
  // that identity, so the child room would disconnect and remount constantly.
  // Read the four fields we need as primitives instead.
  const sharedDocument = useMemo(
    () => (collaborativeReference
      ? sharedDocuments.find(
          document => document.documentId === collaborativeReference.documentId,
        )
      : undefined),
    [collaborativeReference, sharedDocuments],
  );
  const sharedTitle = sharedDocument?.title ?? null;
  const sharedDocumentType = sharedDocument?.documentType ?? null;
  const sharedFileExtension = sharedDocument?.fileExtension ?? null;
  const sharedEditorId = sharedDocument?.editorId ?? null;

  const collaborativeResolution = useMemo<{
    request: CollaborativeEmbedProviderRequest;
    registration: NonNullable<ReturnType<typeof customEditorRegistry.findRegistrationForFile>>;
    displayName: string;
  } | { error: string } | null>(() => {
    if (!collaborativeReference) return null;
    if (!activeWorkspacePath || !effectiveTeamOrgId) {
      return { error: 'The active team workspace is unavailable.' };
    }
    if (collaborativeReference.orgId !== effectiveTeamOrgId) {
      return { error: 'This embedded document belongs to a different team.' };
    }

    const resolution = resolveCollaborativeEmbedRequest({
      orgId: collaborativeReference.orgId,
      documentId: collaborativeReference.documentId,
      workspacePath: activeWorkspacePath,
      sharedTitle,
      sharedDocumentType,
      sharedFileExtension,
      sharedEditorId,
      hintedExtension: attrs.embedType,
      fallbackTitle: label,
    });
    if (resolution.status !== 'ready') return { error: resolution.error };
    // Unreachable without `allowLexical`, which this caller deliberately does
    // not pass: an in-document embed is already inside a Lexical editor.
    if (resolution.editor.kind !== 'extension') {
      return { error: 'Only collaborative custom-editor documents can be embedded.' };
    }
    return {
      displayName: resolution.displayName,
      registration: resolution.editor.registration,
      request: resolution.request,
    };
  }, [
    activeWorkspacePath,
    attrs.embedType,
    collaborativeReference,
    effectiveTeamOrgId,
    label,
    sharedDocumentType,
    sharedEditorId,
    sharedFileExtension,
    sharedTitle,
  ]);

  const heightPx = parsePx(attrs.height, DEFAULT_EMBED_HEIGHT_PX, MIN_EMBED_HEIGHT_PX);
  const widthPx = parseOptionalPx(attrs.width, MIN_EMBED_WIDTH_PX);

  const { isResizing, onResizeStart } = useEmbedResize(editor, nodeKey, frameRef, bodyRef);

  // Node-selection gate. Until the user clicks (and selects) this embed,
  // a shield sits over the embedded editor swallowing pointer events --
  // so scroll/wheel bubbles past the embed to the host editor's scroller
  // instead of being eaten by Excalidraw's zoom handler or ReactFlow's
  // pan handler. Once selected, the shield drops out and the embedded
  // editor takes over directly. Clicking elsewhere creates a
  // RangeSelection, `isSelected` flips back to false, and the shield
  // reinstates itself.
  const [nodeSelected, setSelected, clearSelection] = useLexicalNodeSelection(nodeKey);
  const isSelected = detached || nodeSelected;

  const handleShieldClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Don't let the click also bubble out to Lexical -- otherwise the
      // editor's own click handler creates a RangeSelection on whatever
      // text is "nearest" and clears the node-selection we're about to
      // set, leaving the shield up.
      event.stopPropagation();
      clearSelection();
      setSelected(true);
    },
    [clearSelection, setSelected],
  );

  const handleShieldDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Mirrors the body's double-click: open the embedded file in a
      // new tab. We have to handle it here because the shield is on top
      // of the body's onDoubleClick target while it's mounted.
      event.stopPropagation();
      if (collaborativeReference) {
        openSharedDocumentInTab(collaborativeReference.documentId);
      } else if (absolutePath) {
        openFileInTab(absolutePath);
      }
    },
    [absolutePath, collaborativeReference],
  );

  const themeRef = useRef(theme);
  themeRef.current = theme;
  const themeListeners = useRef(new Set<(theme: string) => void>());
  useEffect(() => {
    themeListeners.current.forEach((cb) => cb(theme));
  }, [theme]);

  // View mode is the default. Toggling to edit mode flips host.readOnly
  // so extensions that respect it (e.g. Excalidraw via viewModeEnabled)
  // light up their editing UI. In edit mode, the host wires real
  // saveContent + setDirty + onSaveRequested so user edits autosave back
  // to the embedded file.
  const [isReadOnly, setIsReadOnly] = useState(true);
  const isReadOnlyRef = useRef(isReadOnly);
  isReadOnlyRef.current = isReadOnly;
  const readOnlyListeners = useRef(new Set<(readOnly: boolean) => void>());
  useEffect(() => {
    readOnlyListeners.current.forEach((cb) => cb(isReadOnly));
  }, [isReadOnly]);

  // ---- Save / dirty state for edit mode --------------------------------
  const [isDirty, setIsDirty] = useState(false);
  const isDirtyRef = useRef(false);
  const saveRequestListeners = useRef(new Set<() => void | Promise<void>>());
  // Content of our most recent save -- used to dedupe the file-watcher
  // event that fires when our own save hits disk (we don't want to round-
  // trip the bytes back through the extension's onFileChanged callback).
  const lastSavedContentRef = useRef<string | null>(null);

  // Surfaces the blocked state. Without it an embed stops autosaving after its
  // retries are spent and the user has no signal that their edits are only in
  // memory -- the dirty dot alone reads as "saving shortly".
  const [saveBlockedErrorType, setSaveBlockedErrorType] = useState<string | null>(null);

  // In-flight guard, bounded retry, blocked latch, and the exit-path flush --
  // all shared with the canvas card host, which grew its own thinner copy and
  // lost edits with it. See `embeddedAutosave.ts`.
  const autosave = useMemo(
    () =>
      createEmbeddedAutosaveController({
        label: '[EmbedFrame]',
        isDirty: () => isDirtyRef.current,
        onBlockedChange: setSaveBlockedErrorType,
        save: async () => {
          for (const cb of saveRequestListeners.current) {
            await cb();
          }
        },
      }),
    [],
  );

  const toggleReadOnly = useCallback(() => {
    setIsReadOnly((prev) => {
      const next = !prev;
      // Switching back to view mode while dirty -- flush before we drop the
      // editing UI. `flush` is what lets the write past the host's read-only
      // guard, which this transition is about to close. Saves are async; the
      // user will see the dot clear as the write completes.
      if (next && isDirtyRef.current) {
        void autosave.flush('view-mode');
      }
      return next;
    });
  }, [autosave]);

  // Autosave: while in edit mode and dirty, ask the extension to save on
  // a 2s cadence. The extension's `onSaveRequested` handler is what
  // actually pulls the content and calls `host.saveContent`.
  useEffect(() => {
    if (isReadOnly) return;
    const interval = setInterval(() => {
      void autosave.tick();
    }, 2000);
    return () => {
      clearInterval(interval);
      void autosave.flush('left-edit-mode');
    };
  }, [isReadOnly, autosave]);

  // An embed unmounts when its host document closes or the node is deleted,
  // and neither waits for the debounce.
  useEffect(
    () => () => {
      void autosave.flush('unmounted');
    },
    [autosave],
  );

  const host = useMemo(() => {
    if (!absolutePath) return null;
    return createEmbeddedFileHost({
      embedPath: absolutePath,
      workspaceId: (window as unknown as { __workspacePath?: string }).__workspacePath,
      getTheme: () => themeRef.current,
      subscribeToThemeChanges(cb) {
        themeListeners.current.add(cb);
        return () => {
          themeListeners.current.delete(cb);
        };
      },
      subscribeToFileChanges(path, cb) {
        const atom = fileChangedOnDiskAtomFamily(path);
        return store.sub(atom, () => {
          readFileFromDisk(path)
            .then((content) => {
              // Save-echo dedup: the file-watcher fires immediately after
              // our own write. Skip the callback if the content matches
              // what we just saved so we don't bounce the bytes through
              // the extension's onFileChanged and reset its scroll/view.
              if (
                lastSavedContentRef.current !== null &&
                content === lastSavedContentRef.current
              ) {
                return;
              }
              cb(content);
            })
            .catch((err) => {
              console.error(
                '[EmbedFrame] Failed to reload embed after file-change for',
                path,
                err,
              );
            });
        });
      },
      readFile: readFileFromDisk,
      async saveFile(path, content) {
        const text =
          typeof content === 'string'
            ? content
            : new TextDecoder().decode(content);
        lastSavedContentRef.current = text;
        await writeFileToDisk(path, text);
        // Optimistically clear dirty -- the extension will mark dirty
        // again on the next user edit. If the write threw, the dirty
        // state stays (we don't catch here).
        isDirtyRef.current = false;
        setIsDirty(false);
        autosave.reset();
      },
      getReadOnly: () => isReadOnlyRef.current,
      // Lets the exit-path flush through the guard above -- the write that
      // carries the edits from the edit session that just ended is not a
      // view-mode write. See `embeddedAutosave.ts`.
      allowSaveWhileReadOnly: () => autosave.isFlushing(),
      subscribeToReadOnlyChanges(cb) {
        readOnlyListeners.current.add(cb);
        return () => {
          readOnlyListeners.current.delete(cb);
        };
      },
      onDirtyChange(next) {
        if (next === isDirtyRef.current) return;
        isDirtyRef.current = next;
        setIsDirty(next);
        if (!next) autosave.reset();
      },
      subscribeToSaveRequests(cb) {
        saveRequestListeners.current.add(cb);
        return () => {
          saveRequestListeners.current.delete(cb);
        };
      },
    });
    // Host is stable per absolutePath. External file changes (and read-only
    // toggles) flow to the mounted extension via `host.onFileChanged(...)`
    // / `host.onReadOnlyChanged(...)` rather than re-mount, which preserves
    // the extension's view-state (pan / zoom / scroll).
  }, [absolutePath, autosave]);

  const handleEditClick = useCallback(() => {
    if (collaborativeReference) {
      openSharedDocumentInTab(collaborativeReference.documentId);
    } else if (absolutePath) {
      openFileInTab(absolutePath);
    }
  }, [absolutePath, collaborativeReference]);

  const handleBodyDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      // Stop propagation so the double-click isn't interpreted as text
      // selection by the host Lexical editor.
      event.stopPropagation();
      handleEditClick();
    },
    [handleEditClick],
  );

  const handleSelectedEmbedPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isSelected) return;
      // Once the embed is selected, interactions inside its body should
      // stay within the embedded editor. If this bubbles to Lexical, the
      // host editor converts the NodeSelection back to a RangeSelection,
      // reinstates the shield, and Monaco immediately loses focus.
      event.stopPropagation();
    },
    [isSelected],
  );

  const handleSelectedEmbedMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isSelected) return;
      event.stopPropagation();
    },
    [isSelected],
  );

  const handleSelectedEmbedClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isSelected) return;
      event.stopPropagation();
    },
    [isSelected],
  );

  const frameStyle = useMemo<React.CSSProperties>(
    () => (widthPx ? { width: widthPx, maxWidth: '100%' } : {}),
    [widthPx],
  );

  // ---- Failure / missing-capability placeholders -----------------------
  if (collaborativeReference) {
    if (!collaborativeResolution || 'error' in collaborativeResolution) {
      return (
        <EmbedUnresolved
          displayName={label || src}
          label={label}
          src={src}
          error={collaborativeResolution?.error ?? 'Could not resolve shared embed.'}
          onOpen={() => openSharedDocumentInTab(collaborativeReference.documentId)}
          testId="collaborative-embed-unresolved"
        />
      );
    }

    const { registration, request, displayName } = collaborativeResolution;
    return (
      <EmbedFrameShell
        nodeKey={nodeKey}
        attrs={attrs}
        label={label}
        detached={detached}
        displayName={displayName}
        onOpen={() => openSharedDocumentInTab(request.documentId)}
        markers={{ 'data-embed-extension': registration.extensionId ?? '', 'data-embed-collaborative': 'true' }}
        loadingText="Loading shared embed..."
      >
        <CollaborativeEmbedEditor editor={{ kind: 'extension', registration }} request={request} />
      </EmbedFrameShell>
    );
  }

  if (pathPending) {
    return <div className="embed-frame" data-testid="embed-frame-loading">Resolving embedded file…</div>;
  }

  if (!absolutePath) {
    return (
      <div className="embed-frame embed-frame--error" data-testid="embed-frame-unresolved">
        <EmbedChrome
          relativePath={src}
          absolutePath={null}
          label={label}
          isReadOnly={isReadOnly}
          isDirty={false}
          onToggleReadOnly={null}
          onEditClick={() => {}}
        />
        <div className="embed-frame__body embed-frame__body--placeholder">
          <MaterialSymbol icon="link_off" size={28} />
          <p>{pathError || 'Could not resolve embed path'}</p>
          <code>{src}</code>
        </div>
      </div>
    );
  }

  if (!localRegistration) {
    return (
      <div className="embed-frame embed-frame--no-extension" data-testid="embed-frame-no-extension">
        <EmbedChrome
          relativePath={workspaceRelativePath(absolutePath)}
          absolutePath={absolutePath}
          label={label}
          isReadOnly={isReadOnly}
          isDirty={false}
          onToggleReadOnly={null}
          onEditClick={handleEditClick}
        />
        <div className="embed-frame__body embed-frame__body--placeholder">
          <MaterialSymbol icon="extension_off" size={28} />
          <p>
            No installed extension can render <code>{basename(absolutePath)}</code> inline.
          </p>
        </div>
      </div>
    );
  }

  const ExtensionComponent = localRegistration.component;

  return (
    <div
      ref={frameRef}
      className={`embed-frame${isResizing ? ' embed-frame--resizing' : ''}${isReadOnly ? '' : ' embed-frame--edit-mode'}${isDirty ? ' embed-frame--dirty' : ''}${isSelected ? ' embed-frame--selected' : ''}`}
      data-testid="embed-frame"
      data-embed-extension={localRegistration.extensionId}
      data-embed-mode={isReadOnly ? 'view' : 'edit'}
      data-embed-dirty={isDirty ? 'true' : 'false'}
      data-embed-selected={isSelected ? 'true' : 'false'}
      style={frameStyle}
    >
      <EmbedChrome
        relativePath={workspaceRelativePath(absolutePath)}
        absolutePath={absolutePath}
        label={label}
        isReadOnly={isReadOnly}
        isDirty={isDirty}
        onToggleReadOnly={toggleReadOnly}
        onEditClick={handleEditClick}
      />
      {saveBlockedErrorType !== null && (
        <div
          className="embed-frame__save-failure flex items-center gap-2 px-3 py-2 text-[13px] bg-nim-warning-subtle border-b border-nim-warning text-nim"
          role="alert"
          data-testid="embed-save-failure-banner"
        >
          <span className="flex-1">
            {getSaveFailureMessage(saveBlockedErrorType, 'auto')}
          </span>
          <button
            type="button"
            onClick={() => {
              void autosave.retry();
            }}
            className="px-2 py-1 rounded border border-nim text-nim hover:bg-nim-active"
            data-testid="embed-save-failure-retry"
          >
            Retry
          </button>
        </div>
      )}
      <div
        ref={bodyRef}
        className="embed-frame__body"
        style={{ height: heightPx }}
        onPointerDown={handleSelectedEmbedPointerDown}
        onMouseDown={handleSelectedEmbedMouseDown}
        onClick={handleSelectedEmbedClick}
        onDoubleClick={handleBodyDoubleClick}
      >
        {/* Editor wrapper establishes its own stacking context (via
         * `isolation: isolate`) so the embedded editor's internal z-
         * indexes (Excalidraw goes up to 999999 for popovers) can't
         * escape and paint over the click-to-select shield.
         *
         * When the embed is not the active NodeSelection the wrapper
         * also gets the HTML `inert` attribute. `inert` blocks pointer
         * AND wheel events for the entire subtree -- so two-finger
         * trackpad scrolls bubble past the embed to the host editor's
         * scroller instead of being eaten by Excalidraw's onWheel
         * (which we can't reach via z-index because Excalidraw's
         * canvas/UI elements may sit above the shield in stacking
         * order). Spread-pattern keeps it off the React 18 prop list
         * entirely when selected.
         */}
        <div
          className="embed-frame__editor-host"
          {...(isSelected ? {} : { inert: true })}
        >
          <EmbedErrorBoundary onError={setRenderError} absolutePath={absolutePath}>
            {host && (
              <React.Suspense
                fallback={<div className="embed-frame__loading">Loading embed...</div>}
              >
                <ExtensionComponent host={host} />
              </React.Suspense>
            )}
          </EmbedErrorBoundary>
        </div>
        {!isSelected && (
          <div
            className="embed-frame__shield"
            data-testid="embed-frame-shield"
            onClick={handleShieldClick}
            onDoubleClick={handleShieldDoubleClick}
            aria-hidden="true"
          />
        )}
      </div>
      {renderError && (
        <div className="embed-frame__error-footer" data-testid="embed-frame-error-footer">
          {renderError.message}
        </div>
      )}
      <EmbedResizeHandles onResizeStart={onResizeStart} hidden={detached} />
    </div>
  );
};
