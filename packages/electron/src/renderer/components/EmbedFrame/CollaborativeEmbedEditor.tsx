import type { LexicalEditor } from 'lexical';
import React, { useEffect, useMemo, useRef, useState } from "react";

import type { EditorHost, EditorViewport } from "@nimbalyst/runtime";

import type { CollaborativeEmbedEditorChoice } from "./resolveCollaborativeEmbedRequest";
import { CollaborativeMarkdownEmbed } from "./CollaborativeMarkdownEmbed";
import { useTheme } from "../../hooks/useTheme";
import {
  collaborativeEmbedProviderCache,
  collaborativeEmbedResourceKey,
  type CollaborativeEmbedProviderAcquisition,
  type CollaborativeEmbedProviderRequest,
} from "../../services/CollaborativeEmbedProviderCache";
import { buildCollabUri } from "@nimbalyst/collab-protocol";
import { createCollabExtensionHost } from "../TabEditor/collabExtensionHost";

interface CollaborativeEmbedEditorProps {
  /**
   * Who paints the document. An extension registration, or the app's own
   * Lexical markdown editor -- see `resolveCollaborativeEmbedRequest`. Both
   * share every line above this point: the room, the refcount, and the host.
   */
  editor: CollaborativeEmbedEditorChoice;
  request: CollaborativeEmbedProviderRequest;
  /** Defaults to the existing inline-embed behavior: read-only. */
  readOnly?: boolean;
  /** Fires only after the cache acquisition has actually released its room. */
  onConnectionReleased?: () => void;
  /**
   * Receives the editor's scroll viewport, when it publishes one.
   *
   * Only the feedback detail popover passes this, so it can carry the reader's
   * place from one design alternative to the next. An embed with no listener,
   * or an editor that never registers, simply has no viewport.
   */
  onViewportRegistered?: (viewport: EditorViewport | null) => void;
  /** Markdown only: the fixed formatting toolbar while editable (default on). */
  toolbar?: boolean;
  /**
   * Markdown only: publish this document's page history and record its
   * revisions. For a body shown as a page (a type page's prose), never for a
   * card, which would publish a second controller for a document open in a tab.
   */
  publishHistory?: boolean;
  onEditorReady?: (editor: LexicalEditor | null) => void;
}

export const CollaborativeEmbedEditor: React.FC<
  CollaborativeEmbedEditorProps
> = ({
  editor,
  request,
  readOnly = true,
  onConnectionReleased,
  onViewportRegistered,
  toolbar,
  publishHistory,
  onEditorReady,
}) => {
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const themeListeners = useRef(new Set<(nextTheme: string) => void>());
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const readOnlyListeners = useRef(new Set<(next: boolean) => void>());
  const [acquisition, setAcquisition] =
    useState<CollaborativeEmbedProviderAcquisition | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const connectionReleasedRef = useRef(onConnectionReleased);
  connectionReleasedRef.current = onConnectionReleased;

  useEffect(() => {
    for (const listener of themeListeners.current) listener(theme);
  }, [theme]);

  useEffect(() => {
    for (const listener of readOnlyListeners.current) listener(readOnly);
  }, [readOnly]);

  // Acquire on the request's VALUE, not its identity. An equal-but-new request
  // object (a parent re-render) must not disconnect and rebuild a live child
  // room; only a genuinely different room or editor configuration should.
  const resourceKey = collaborativeEmbedResourceKey(request);
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    let cancelled = false;
    let acquired: CollaborativeEmbedProviderAcquisition | null = null;
    let releaseNotified = false;
    /*
     * Captured here, not read at call time. This confirmation is late by
     * construction -- it can fire after the cache acquisition settles, which
     * may be after the parent has already swapped to a different room and
     * handed us a different `onConnectionReleased`. Reading the ref then would
     * acknowledge the *new* lease and leave the one this acquisition actually
     * held stuck in `releasing`, silently costing the shared-room ceiling a
     * slot. `useCanvasRoomConnectionLease` binds each callback to its own
     * handle so this capture names the right lease.
     */
    const notifyOwner = connectionReleasedRef.current;
    const notifyReleased = () => {
      if (releaseNotified) return;
      releaseNotified = true;
      notifyOwner?.();
    };
    setAcquisition(null);
    setError(null);
    void collaborativeEmbedProviderCache
      .acquire(requestRef.current)
      .then((next) => {
        if (cancelled) {
          next.release();
          notifyReleased();
          return;
        }
        acquired = next;
        setAcquisition(next);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error ? reason : new Error(String(reason))
          );
        } else {
          notifyReleased();
        }
      });
    return () => {
      cancelled = true;
      if (acquired) {
        acquired.release();
        notifyReleased();
      }
    };
  }, [resourceKey]);

  /*
   * Held off the host's dependencies. The host object is a mount dependency for
   * the extension component, and a caller passing a fresh arrow function each
   * render would rebuild it -- tearing down a live collaborative editor and its
   * Y.Doc on every parent re-render.
   */
  const viewportRef = useRef(onViewportRegistered);
  viewportRef.current = onViewportRegistered;

  const { orgId, documentId, title, workspacePath } = request;
  const host = useMemo<EditorHost | null>(() => {
    if (!acquisition) return null;
    const filePath = buildCollabUri(orgId, documentId);
    const base = createCollabExtensionHost({
      filePath,
      fileName: title,
      isActive: true,
      workspaceId: workspacePath,
      activeConfig: acquisition.resource.config,
      collaboration: acquisition.resource.collaboration,
      getTheme: () => themeRef.current,
      subscribeToThemeChanges: (callback) => {
        themeListeners.current.add(callback);
        return () => {
          themeListeners.current.delete(callback);
        };
      },
      embedded: true,
      readOnly: readOnlyRef.current,
      // Reads the ref at call time rather than capturing it, so a caller that
      // swaps its handler still gets the next registration.
      onViewportRegistered: (viewport) => viewportRef.current?.(viewport),
    });
    return {
      ...base,
      get readOnly() {
        return readOnlyRef.current;
      },
      onReadOnlyChanged(callback: (next: boolean) => void) {
        readOnlyListeners.current.add(callback);
        callback(readOnlyRef.current);
        return () => {
          readOnlyListeners.current.delete(callback);
        };
      },
    };
  }, [acquisition, documentId, orgId, title, workspacePath]);

  if (error) {
    return (
      <div
        className="embed-frame__body--placeholder"
        data-testid="collaborative-embed-error"
      >
        <p>Could not load shared embed</p>
        <code>{error.message}</code>
      </div>
    );
  }

  if (!host) {
    return (
      <div
        className="embed-frame__loading"
        data-testid="collaborative-embed-loading"
      >
        Loading shared embed...
      </div>
    );
  }

  if (editor.kind === "lexical") {
    // `acquisition` is non-null whenever `host` is -- they are built from the
    // same memo -- but narrowing needs it said out loud.
    return acquisition === null ? null : (
      <CollaborativeMarkdownEmbed host={host} resource={acquisition.resource} toolbar={toolbar} publishHistory={publishHistory} onEditorReady={onEditorReady} />
    );
  }

  const ExtensionComponent = editor.registration.component;
  return <ExtensionComponent host={host} />;
};
