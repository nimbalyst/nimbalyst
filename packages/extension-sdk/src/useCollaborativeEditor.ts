/**
 * useCollaborativeEditor Hook
 *
 * Companion to `useEditorLifecycle` for collaborative documents. When the
 * host opens a file with `host.collaboration` defined, this hook manages the
 * binding lifecycle: wait for sync, optionally seed the Y.Doc from file
 * content if this client is first, create the editor's binding, destroy on
 * unmount.
 *
 * Extensions wire it like this:
 *
 * ```tsx
 * function MyEditor({ host }: EditorHostProps) {
 *   const apiRef = useRef<MyImperativeAPI | null>(null);
 *
 *   // Local-only path (unchanged for non-collab opens).
 *   const { isLoading } = useEditorLifecycle(host, { ... });
 *
 *   // Collaborative path (no-op when host.collaboration is undefined).
 *   const { isCollaborative, status, collaborators } = useCollaborativeEditor(host, {
 *     createBinding: ({ yDoc, awareness, user }) => {
 *       const b = new MyBinding(yDoc, apiRef.current!, awareness, user);
 *       return { destroy: () => b.destroy() };
 *     },
 *     initializeFromContent: (yDoc, content) => seedYDocFromFile(yDoc, content),
 *   });
 *
 *   return <MyLibrary ref={apiRef} ... />;
 * }
 * ```
 *
 * Bootstrap-race safety: if two clients both open an empty document, both
 * will call `initializeFromContent` and their CRDT updates merge. To avoid
 * duplicate elements your seeded shared types MUST use **content-derived
 * stable IDs** (e.g. element `id` from the file), not random IDs. The same
 * input yields the same Y.Doc state; merged duplicates collapse.
 */

import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import type {
  CollaborationContext,
  CollaborationStatus,
  CollaboratorInfo,
  EditorHost,
} from './types/editor.js';

/**
 * Origin tag used when the SDK wraps `initializeFromContent` in a Y.Doc
 * transaction. Extension bindings can compare a transaction's origin
 * against this to suppress their own change handlers during seeding
 * (otherwise the binding would echo the seed back into local-edit state).
 *
 * ```ts
 * yDoc.on('update', (update, origin) => {
 *   if (origin === COLLAB_INIT_ORIGIN) return;
 *   // ... apply remote change
 * });
 * ```
 */
export const COLLAB_INIT_ORIGIN = Symbol('nimbalyst:collab-init');

export interface UseCollaborativeEditorConfig {
  /**
   * Create the yJS binding that wires editor state to the Y.Doc. Called
   * once when collaboration is ready (sync done, seed applied if needed).
   * Returns a destroy fn invoked on unmount or when the binding needs to
   * be torn down.
   */
  createBinding(ctx: {
    yDoc: Y.Doc;
    awareness: import('y-protocols/awareness').Awareness;
    user: { id: string; name: string; color: string };
  }): { destroy: () => void };

  /**
   * Decide whether the Y.Doc still needs to be seeded from file content.
   * Returning `true` means "this Y.Doc has no extension content yet -- call
   * initializeFromContent". Default: `Y.encodeStateAsUpdate(yDoc).byteLength <= 2`,
   * which matches a fully empty Y.Doc.
   *
   * Override when your shared types may exist as empty containers (e.g. you
   * always call `yDoc.getMap('meta')` even on first open) and a length-2
   * encoded state would still be considered "empty" by your check.
   */
  isEmpty?(yDoc: Y.Doc): boolean;

  /**
   * Populate the Y.Doc from raw file content when this client is the first
   * to open the document. Called inside a `yDoc.transact(..., COLLAB_INIT_ORIGIN)`
   * so bindings can ignore the seeding transaction.
   *
   * Bootstrap race: see file-level docs. Use content-derived stable IDs.
   */
  initializeFromContent(yDoc: Y.Doc, content: string | ArrayBuffer): void;
}

export interface UseCollaborativeEditorResult {
  /** True when `host.collaboration` is defined. */
  isCollaborative: boolean;
  /** Current connection status. Always `'disconnected'` when not collab. */
  status: CollaborationStatus;
  /**
   * Remote collaborators keyed by their stable user id (not the y-protocols
   * client id). Mirrors awareness; updated when remote presence changes.
   */
  collaborators: Map<string, CollaboratorInfo>;
  /**
   * The binding handle once `createBinding` has run, or `null` until
   * collaboration is ready / when not collab.
   */
  binding: { destroy: () => void } | null;
}

function defaultIsEmpty(yDoc: Y.Doc): boolean {
  // A fully empty Y.Doc encodes to ~2 bytes (header only).
  return Y.encodeStateAsUpdate(yDoc).byteLength <= 2;
}

export function useCollaborativeEditor(
  host: EditorHost,
  config: UseCollaborativeEditorConfig
): UseCollaborativeEditorResult {
  const isCollaborative = !!host.collaboration;
  const [status, setStatus] = useState<CollaborationStatus>(
    host.collaboration?.getStatus() ?? 'disconnected'
  );
  const [collaborators, setCollaborators] = useState<
    Map<string, CollaboratorInfo>
  >(() => new Map());
  const [binding, setBinding] = useState<{ destroy: () => void } | null>(null);

  // Keep config in a ref so the binding-creation effect doesn't tear down on
  // every render. Hosts pass fresh config objects each render, but the
  // intent is "wire once, keep until the host changes".
  const configRef = useRef(config);
  configRef.current = config;

  // Status subscription.
  useEffect(() => {
    const collab = host.collaboration;
    if (!collab) {
      setStatus('disconnected');
      return;
    }
    setStatus(collab.getStatus());
    return collab.onStatusChange(setStatus);
  }, [host]);

  // Awareness subscription -> collaborators map. The host populates the
  // standard `user: { id, name, color }` field on every remote awareness
  // state via the StandardAwarenessState contract.
  useEffect(() => {
    const collab = host.collaboration;
    if (!collab) {
      setCollaborators(new Map());
      return;
    }

    const rebuild = () => {
      const next = new Map<string, CollaboratorInfo>();
      const states = collab.awareness.getStates();
      for (const [clientId, state] of states) {
        // Don't include ourselves.
        if (clientId === collab.awareness.clientID) continue;
        const user = (state as Partial<{ user: CollaboratorInfo['user'] }>).user;
        if (!user || !user.id) continue;
        next.set(user.id, { user });
      }
      setCollaborators(next);
    };

    rebuild();
    collab.awareness.on('change', rebuild);
    return () => collab.awareness.off('change', rebuild);
  }, [host]);

  // Binding lifecycle.
  useEffect(() => {
    const collab = host.collaboration;
    if (!collab) return;

    let cancelled = false;
    let handle: { destroy: () => void } | null = null;

    const tryStart = async () => {
      if (cancelled || handle) return;
      if (collab.getStatus() !== 'connected') return;

      const cfg = configRef.current;
      const isEmptyFn = cfg.isEmpty ?? defaultIsEmpty;

      if (isEmptyFn(collab.yDoc)) {
        try {
          const content = await collab.loadInitialContent();
          if (cancelled) return;
          // Re-check emptiness in case another client seeded while we were
          // awaiting -- they would have raced through the WebSocket and
          // applied their update during our await gap. Avoid double-seeding
          // in that case; CRDT merge would otherwise insert duplicate
          // content unless the seed is fully deterministic.
          if (isEmptyFn(collab.yDoc)) {
            collab.yDoc.transact(() => {
              cfg.initializeFromContent(collab.yDoc, content);
            }, COLLAB_INIT_ORIGIN);
          }
        } catch (err) {
          console.error(
            '[useCollaborativeEditor] Failed to load/seed initial content:',
            err
          );
          // Continue with bind -- the doc may still be usable once another
          // client seeds it.
        }
      }

      if (cancelled) return;
      handle = cfg.createBinding({
        yDoc: collab.yDoc,
        awareness: collab.awareness,
        user: collab.user,
      });
      setBinding(handle);
    };

    void tryStart();
    const unsubscribe = collab.onStatusChange(() => {
      void tryStart();
    });

    return () => {
      cancelled = true;
      unsubscribe();
      if (handle) {
        handle.destroy();
        handle = null;
      }
      setBinding(null);
    };
  }, [host]);

  return { isCollaborative, status, collaborators, binding };
}
