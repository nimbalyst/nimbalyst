import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  $getRoot,
  $setSelection,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  FORMAT_TEXT_COMMAND,
  type LexicalEditor,
} from 'lexical';

import type { EditorConfig } from '@nimbalyst/runtime/editor/EditorConfig';
import { $convertFromEnhancedMarkdownString, getEditorTransformers } from '@nimbalyst/runtime/editor/markdown';
import '@nimbalyst/runtime/editor/extensions/registerBuiltinExtensions';
import '@nimbalyst/runtime/editor/index.css';
import { registerBrowserReferenceNodes } from './referenceNodes';
import { registerBrowserTrackerReferenceInsertion } from './trackerReferenceInsertion';
import { BrowserPlacedViewInsertionContext, registerBrowserPlacedViewInsertion, type BrowserPlacedViewInsertionValue } from './placedViewInsertion';
import { acquireConsoleReferenceScope } from '@nimbalyst/runtime/plugins/TrackerLinkPlugin/trackerReferenceHref';
import { TrackerReferenceSourceProvider } from '@nimbalyst/runtime/plugins/TrackerLinkPlugin/trackerReferenceSource';
import { CollabLexicalProvider } from '@nimbalyst/runtime/sync/CollabLexicalProvider';
import type { DocumentSyncProvider } from '@nimbalyst/runtime/sync/DocumentSync';

import {
  BrowserEditorSurface,
  type PresenceSubscription,
} from './BrowserEditorSurface';
import './browserChrome.css';
import { applyBrowserEditorChrome } from './browserChrome';
import { deriveCollabEditorCommentsState } from './commenting';
import { resolveCollabEditorUser } from './presence';
import { createCollabDocumentSession } from './session';
import { acquireCollabAssetImageResolver } from './collabAssetImages';
import { BrowserDocumentEmbedContext, registerBrowserDocumentEmbeds } from './documentEmbeds';
import {
  TrackerReferenceInlineAppearanceContext,
  TrackerReferenceResolverProvider,
} from '@nimbalyst/collab-client/trackers-ui/references';

import type {
  CollabEditorHandle,
  CollabEditorMountOptions,
} from './types';

/** The team member id is the voting identity; personal org ids never are. */
export function decisionMembersFromComments(members: ReturnType<NonNullable<CollabEditorMountOptions['comments']>['getMembers']>) {
  return members.map(({ userId, name }) => ({ id: userId, name }));
}

// Must run before any editor mounts: `@lexical/yjs` resolves node types against
// `editor._nodes` while applying the first update, and an unregistered type
// aborts the binding so nothing paints. A call rather than a bare import on
// purpose — see the header of `./referenceNodes`.
registerBrowserReferenceNodes();
registerBrowserDocumentEmbeds();
registerBrowserTrackerReferenceInsertion();
registerBrowserPlacedViewInsertion();

class BundleEditorErrorBoundary extends React.Component<{
  children: React.ReactNode;
  onError: (error: Error) => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Mount the collaborative editor in the host's DOM.
 *
 * Network hosts provide a team-room identity and a host-owned TeamJwt callback.
 * The bundle never reads browser storage, sessions, or personal credentials.
 * In-memory hosts are the transport-free harness seam and still use the same
 * CollabLexicalProvider per-mount editor-doc bridge as a live room.
 *
 * The transport, connection state and flush guards live in `./session`, shared
 * with the extension-editor mount; this function is the Lexical renderer over
 * that session and nothing else.
 */
export function mountCollabEditor(options: CollabEditorMountOptions): CollabEditorHandle {
  const resolvedUser = resolveCollabEditorUser(options.user);
  let root: Root | null = createRoot(options.element);
  let lexicalEditor: LexicalEditor | null = null;
  let getMarkdown = (): string => '';
  let destroyed = false;
  let readyReported = false;

  const hostCanComment = (): boolean => options.comments?.canComment?.() ?? true;

  /**
   * Serves the document's `collab-asset://` images. Only a team room has an
   * origin and a JWT to fetch them with; an in-memory harness document has no
   * server behind it, so it gets no resolver and its images fall through to
   * the editor's own handling.
   */
  const assetImages = options.source.kind === 'team-room'
    ? acquireCollabAssetImageResolver({
        serverUrl: options.source.serverUrl,
        orgId: options.source.room.orgId,
        getTeamJwt: options.source.auth.getTeamJwt,
      })
    : null;
  // A reference inserted here is written as this project's console link and
  // resolved in this project (Decision 23); in-memory documents have no project.
  const releaseReferenceScope = options.source.kind === 'team-room'
    ? acquireConsoleReferenceScope({ orgId: options.source.room.orgId, projectId: options.source.room.projectId })
    : null;
  // Placed views from the slash menu link under the same project; read once, like the source above.
  const placedViewInsertion: BrowserPlacedViewInsertionValue | null = options.source.kind === 'team-room' && options.placedViewTypes
    ? { scope: { orgId: options.source.room.orgId, projectId: options.source.room.projectId }, types: options.placedViewTypes }
    : null;

  // Declared before the session because DocumentSyncProvider can report a
  // status from inside its own constructor, before the provider below exists.
  let lexicalProvider: CollabLexicalProvider | undefined;

  const session = createCollabDocumentSession({
    source: options.source,
    memberId: resolvedUser.memberId,
    readOnly: options.readOnly,
    lifecycleElement: options.element,
    hostCanComment,
    onStateChange: options.onStateChange,
    onPresenceChange: (presence) => options.onPresenceChange?.(presence),
    onWriteRejected: options.onWriteRejected,
    onTermination: options.onTermination,
    onError: options.onError,
    onBindingError: options.onBindingError,
    onStatusChange: (status) => lexicalProvider?.handleStatusChange(status),
    onSurfaceInvalidated: () => syncEditorSurface(),
  });

  const presenceSurface = session.presence;
  lexicalProvider = new CollabLexicalProvider(
    presenceSurface as unknown as DocumentSyncProvider,
    session.networkProvider ? { deferInitialSync: true } : undefined,
  );
  const boundLexicalProvider = lexicalProvider;

  // Stable across re-renders so the announcement region does not reset its
  // roster (and re-announce everyone) when read-only state flips.
  const subscribeToPresence: PresenceSubscription = (listener) => (
    presenceSurface.onPresenceChange(listener)
  );

  let renderedReadOnly = session.getState().readOnly;
  let renderedCanComment = session.canComment();
  /**
   * Re-render when what the editor is *allowed* to do has drifted from what is
   * on screen.
   *
   * Effective read-only is not a proxy for that. The runtime resolves comment
   * capability on every render and deliberately never caches it, but nothing
   * re-renders on its own: gating the re-render on a read-only flip left the
   * toolbar permanently without "Add comment" for a writer whose capability
   * changed while read-only did not. The comparison is against what was last
   * rendered rather than against one field's previous value, so every input to
   * the answer -- server access, termination, the host's role answer -- lands
   * the same way, and a change that cancels out renders nothing.
   */
  function syncEditorSurface(): void {
    // Composer configuration is initial state; update the already mounted editor too.
    lexicalEditor?.setEditable(!session.getState().readOnly);
    if (session.getState().readOnly === renderedReadOnly
      && session.canComment() === renderedCanComment) return;
    renderEditor();
  }

  const sharedDocument = session.sharedDocument;

  const providerFactory: NonNullable<EditorConfig['collaboration']>['providerFactory'] = (
    id,
    yjsDocMap,
  ) => {
    boundLexicalProvider.prepareForBinding();
    yjsDocMap.set(id, boundLexicalProvider.getYDoc());
    return boundLexicalProvider;
  };

  const handle: CollabEditorHandle = {
    getDocument: () => sharedDocument,
    getMarkdown: () => getMarkdown(),
    replaceMarkdown(markdown) {
      if (destroyed || !lexicalEditor) throw new Error('The document is not open');
      if (session.getState().readOnly) throw new Error('This document is read-only');
      lexicalEditor.update(() => {
        // Clearing a selected node without moving selection first makes
        // Lexical throw "selection has been lost".
        $setSelection(null);
        $getRoot().clear();
        $convertFromEnhancedMarkdownString(markdown, getEditorTransformers());
      }, { discrete: true });
    },
    getBasisSequence: () => session.networkProvider?.getLastSeq() ?? 0,
    getState: () => session.getState(),
    hasPendingWrites: () => session.networkProvider?.hasPendingWrites() ?? false,
    getPresence: () => presenceSurface.getPresence(),
    setPresenceActive: (active) => { presenceSurface.setActive(active); },
    flush: (flushOptions) => session.flush(flushOptions),
    setReadOnly(nextReadOnly) {
      if (destroyed) return;
      session.setReadOnly(nextReadOnly);
    },
    refreshCommentAccess() {
      if (destroyed) return;
      syncEditorSurface();
    },
    markClean: () => session.markClean(),
    focus: focusDocument,
    insertText: (text) => {
      if (!lexicalEditor || session.getState().readOnly) return;
      lexicalEditor.update(() => $getRoot().selectEnd(), { discrete: true });
      lexicalEditor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, text);
    },
    formatText: (format) => {
      if (session.getState().readOnly) return;
      lexicalEditor?.dispatchCommand(FORMAT_TEXT_COMMAND, format);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      options.onLexicalEditor?.(null);
      assetImages?.release();
      releaseReferenceScope?.();
      session.destroy({
        beforeTransportTeardown: () => {
          root?.unmount();
          root = null;
          boundLexicalProvider.destroy();
        },
      });
    },
  };

  function focusDocument(): void {
    // The DOM selection survives the trip to the toolbar, so re-focusing the
    // contentEditable puts the caret back exactly where the writer left it —
    // verified in a real browser across collapsed carets, range selections and
    // a dropdown round trip.
    const editable = options.element.querySelector<HTMLElement>('[contenteditable="true"]');
    if (editable) {
      editable.focus();
      return;
    }
    lexicalEditor?.focus();
  }

  function renderEditor(): void {
    if (!root || destroyed) return;
    const state = session.getState();
    renderedReadOnly = state.readOnly;
    renderedCanComment = session.canComment();
    const config: EditorConfig = {
      isRichText: true,
      editable: !state.readOnly,
      isCodeHighlighted: true,
      hasLinkAttributes: true,
      markdownOnly: true,
      resolveImageSrc: assetImages?.resolve,
      collaboration: {
        providerFactory,
        shouldBootstrap: false,
        username: resolvedUser.displayName,
        cursorColor: resolvedUser.cursorColor,
      },
      comments: options.comments ? {
        ...options.comments,
        // Browser comment threads belong to the document-lifetime shared doc;
        // desktop uses the rotating per-binding editorDoc, which this bridge keeps converged.
        getYDoc: () => sharedDocument,
        isHydrated: () => session.hasConnectedOnce(),
        getCapabilities: () => deriveCollabEditorCommentsState({
          connection: session.getState().connection,
          serverAccess: session.getState().serverAccess,
          hasConnectedOnce: session.hasConnectedOnce(),
          hostCanComment: hostCanComment(),
        }).capabilities,
      } : undefined,
      decisions: {
        renderArtifact: options.renderDecisionArtifact,
        getYDoc: () => sharedDocument,
        currentUser: options.comments?.currentUser ?? { id: resolvedUser.memberId, name: resolvedUser.displayName },
        getMembers: () => decisionMembersFromComments(options.comments?.getMembers() ?? []),
        isHydrated: () => !session.networkProvider || session.hasConnectedOnce(),
        canVote: () => !session.getState().readOnly && (session.networkProvider ? session.canComment() : hostCanComment()),
        ...(session.networkProvider ? {
          requestDecision: (command) => session.networkProvider!.requestDecision(command),
          getDecisionState: session.networkProvider.getDecisionState,
          onDecisionState: session.networkProvider.onDecisionState,
        } : {}),
      },
      onDirtyChange: (dirty) => {
        if (dirty) session.markDirty();
      },
      onGetContent: (reader) => {
        getMarkdown = reader;
      },
      onEditorReady: (editor) => {
        lexicalEditor = editor as LexicalEditor;
        lexicalEditor.setEditable(!session.getState().readOnly);
        options.onLexicalEditor?.(lexicalEditor);
        applyBrowserEditorChrome(options.element);
        if (!readyReported) {
          readyReported = true;
          options.onReady?.(handle);
        }
      },
    };

    root.render(
      <BundleEditorErrorBoundary onError={(error) => options.onError?.(error)}>
        <BrowserDocumentEmbedContext.Provider value={options.renderDecisionArtifact}>
          <TrackerReferenceResolverProvider resolver={options.trackerReferences}>
            <TrackerReferenceInlineAppearanceContext.Provider value={options.trackerReferenceAppearance ?? 'chip'}>
              <TrackerReferenceSourceProvider value={options.trackerReferenceSource ?? null}>
                <BrowserPlacedViewInsertionContext.Provider value={placedViewInsertion}>
                  <BrowserEditorSurface
                    config={config}
                    subscribeToPresence={subscribeToPresence}
                  />
                </BrowserPlacedViewInsertionContext.Provider>
              </TrackerReferenceSourceProvider>
            </TrackerReferenceInlineAppearanceContext.Provider>
          </TrackerReferenceResolverProvider>
        </BrowserDocumentEmbedContext.Provider>
      </BundleEditorErrorBoundary>,
    );
  }

  renderEditor();
  session.emitState();
  return handle;
}
