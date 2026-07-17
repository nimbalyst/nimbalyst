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
import type { CollabCodec, CollabContentFileSource } from './types/collab.js';

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

/** Context passed to the binding factory (`bind` / `createBinding`). */
export interface CollabBindContext {
  yDoc: Y.Doc;
  awareness: import('y-protocols/awareness').Awareness;
  user: { id: string; name: string; color: string };
}

export type CollabBindResult =
  | { destroy: () => void }
  | Promise<{ destroy: () => void }>;

/**
 * Preferred config: pass the SAME pure {@link CollabCodec} the extension
 * registered via `context.services.collab.registerContentAdapter(...)`, plus
 * the one React-coupled piece (`bind`). `isEmpty` / `seedFromFile` are read
 * off the codec, so the live seed and every headless seed provably run the
 * same code -- an extension can no longer implement emptiness/seeding twice
 * and have the two disagree.
 *
 * ```tsx
 * useCollaborativeEditor(host, {
 *   codec: mindmapCodec,
 *   bind: ({ yDoc, awareness, user }) => new MindmapBinding(yDoc, api, awareness),
 * });
 * ```
 */
export interface UseCollaborativeEditorCodecConfig {
  /** The pure codec. Its `isEmpty` gates seeding and `seedFromFile` performs it. */
  codec: CollabCodec;

  /**
   * Create the yJS binding that wires editor state to the Y.Doc. Called once
   * when collaboration is ready (sync done, seed applied if needed). May return
   * a Promise so extensions can defer construction until their imperative API
   * has finished mounting; the hook awaits it and honors cancellation.
   */
  bind(ctx: CollabBindContext): CollabBindResult;

  /**
   * Optional: notified when the first-open seed fails or its flush is not
   * confirmed by the server. The host uses this to surface the failure via the
   * pending-seed machinery instead of leaving a silent `console.error`.
   */
  onSeedOutcome?(outcome: { ok: boolean; error?: unknown }): void;
}

/**
 * @deprecated Legacy config shape. Prefer {@link UseCollaborativeEditorCodecConfig}
 * (`{ codec, bind }`), which keeps the pure `isEmpty`/`seed` on the codec so
 * live and headless seeding cannot diverge. This shape traps those pure
 * functions inside React. Still accepted so existing editors keep working.
 */
export interface UseCollaborativeEditorLegacyConfig {
  /** @deprecated Use `bind` on the codec config. */
  createBinding(ctx: CollabBindContext): CollabBindResult;

  /**
   * @deprecated Provide `isEmpty` on the codec. Decide whether the Y.Doc still
   * needs seeding from file content. Default: `Y.encodeStateAsUpdate(yDoc).byteLength <= 2`.
   */
  isEmpty?(yDoc: Y.Doc): boolean;

  /**
   * @deprecated Provide `seedFromFile` on the codec. Populate the Y.Doc from
   * raw file content when this client is first. Called inside a
   * `yDoc.transact(..., COLLAB_INIT_ORIGIN)`. Use content-derived stable IDs
   * (see file-level docs) to keep the bootstrap race deterministic.
   */
  initializeFromContent(yDoc: Y.Doc, content: string | ArrayBuffer): void;

  onSeedOutcome?(outcome: { ok: boolean; error?: unknown }): void;
}

export type UseCollaborativeEditorConfig =
  | UseCollaborativeEditorCodecConfig
  | UseCollaborativeEditorLegacyConfig;

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
   * The binding handle once the binding factory has run, or `null` until
   * collaboration is ready / when not collab.
   */
  binding: { destroy: () => void } | null;
  /**
   * Non-null when the first-open seed failed or its flush was not confirmed by
   * the server. Hosts read this to surface the failure (pending-seed toast)
   * rather than leaving a silent console error.
   */
  seedError: unknown | null;
}

function defaultIsEmpty(yDoc: Y.Doc): boolean {
  // A fully empty Y.Doc encodes to ~2 bytes (header only).
  return Y.encodeStateAsUpdate(yDoc).byteLength <= 2;
}

/**
 * Normalize the config to a single internal shape. `codec` (preferred) takes
 * its `isEmpty`/`seed` from the pure codec; the legacy shape keeps the
 * hand-rolled `isEmpty`/`initializeFromContent`. Content is normalized to
 * `string | Uint8Array` for the codec path (the host's `loadInitialContent`
 * still yields `string | ArrayBuffer`).
 */
function resolveConfig(config: UseCollaborativeEditorConfig): {
  bind: (ctx: CollabBindContext) => CollabBindResult;
  isEmpty: (yDoc: Y.Doc) => boolean;
  seed: (yDoc: Y.Doc, content: string | ArrayBuffer) => void;
  onSeedOutcome?: (outcome: { ok: boolean; error?: unknown }) => void;
} {
  if ('codec' in config) {
    const { codec, bind, onSeedOutcome } = config;
    return {
      bind,
      isEmpty: (yDoc) => codec.isEmpty(yDoc),
      seed: (yDoc, content) => codec.seedFromFile(yDoc, toCodecSource(content)),
      onSeedOutcome,
    };
  }
  return {
    bind: config.createBinding,
    isEmpty: config.isEmpty ?? defaultIsEmpty,
    seed: config.initializeFromContent,
    onSeedOutcome: config.onSeedOutcome,
  };
}

function toCodecSource(content: string | ArrayBuffer): CollabContentFileSource {
  return typeof content === 'string' ? content : new Uint8Array(content);
}

/**
 * True when `content` can legitimately seed a first-open collaborative doc.
 * Empty/whitespace content must never seed: the host returns '' when it has
 * no bytes for the document (e.g. reopening an already-shared doc), and
 * seeding from that writes a DEFAULT document into the shared room —
 * clobbering the room's real content for every client. Exported for tests.
 */
export function hasSeedableContent(
  content: string | ArrayBuffer | Uint8Array | null | undefined
): boolean {
  if (content == null) return false;
  if (typeof content === 'string') return content.trim().length > 0;
  return content.byteLength > 0;
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
  const [seedError, setSeedError] = useState<unknown | null>(null);

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

      const cfg = resolveConfig(configRef.current);

      // NEVER seed when the transport skipped payloads it could not decode:
      // the Y.Doc looking empty then means "content exists but is unreadable
      // on this client", and seeding would write a default document over the
      // real content for every client (the "Untitled map" clobber).
      const undecoded = collab.hasUndecodedContent?.() === true;

      if (!undecoded && cfg.isEmpty(collab.yDoc)) {
        try {
          const content = await collab.loadInitialContent();
          if (cancelled) return;
          // NEVER seed from empty content. A host that has no bytes for this
          // document (reopen of an already-shared doc: no in-memory share
          // payload, no file) returns ''/empty -- seeding from that writes a
          // default document into the shared room and clobbers whatever the
          // room's real content is for every client. Fall through to bind:
          // the room content (or a teammate's seed) will populate the doc.
          if (!hasSeedableContent(content)) {
            console.warn(
              '[useCollaborativeEditor] Skipping first-open seed: host returned empty initial content.'
            );
          }
          // Re-check emptiness in case another client seeded while we were
          // awaiting -- they would have raced through the WebSocket and
          // applied their update during our await gap. Avoid double-seeding
          // in that case; CRDT merge would otherwise insert duplicate
          // content unless the seed is fully deterministic.
          else if (cfg.isEmpty(collab.yDoc)) {
            collab.yDoc.transact(() => {
              cfg.seed(collab.yDoc, content);
            }, COLLAB_INIT_ORIGIN);
            // Durability: the seed the user sees locally must reach the server
            // before this provider can tear down. flushWithAck resolves only
            // after a server-persisted ack; flushLocalState is the deprecated
            // fire-and-forget fallback for older hosts.
            const flushed = collab.flushWithAck
              ? await collab.flushWithAck()
              : (await collab.flushLocalState?.(), true);
            if (!flushed) {
              const err = new Error(
                'Seed flush was not confirmed by the server before timeout; content may not have persisted.'
              );
              console.warn('[useCollaborativeEditor]', err.message);
              setSeedError(err);
              collab.reportSeedOutcome?.({ ok: false, error: err });
              cfg.onSeedOutcome?.({ ok: false, error: err });
            } else {
              setSeedError(null);
              collab.reportSeedOutcome?.({ ok: true });
              cfg.onSeedOutcome?.({ ok: true });
            }
          }
        } catch (err) {
          console.error(
            '[useCollaborativeEditor] Failed to load/seed initial content:',
            err
          );
          setSeedError(err);
          collab.reportSeedOutcome?.({ ok: false, error: err });
          cfg.onSeedOutcome?.({ ok: false, error: err });
          // Continue with bind -- the doc may still be usable once another
          // client seeds it.
        }
      }

      if (cancelled) return;
      const created = cfg.bind({
        yDoc: collab.yDoc,
        awareness: collab.awareness,
        user: collab.user,
      });
      const resolved = created instanceof Promise ? await created : created;
      if (cancelled) {
        // Effect unmounted while we were awaiting the extension's
        // imperative API. Destroy the freshly-built handle so any
        // observers/awareness subscriptions inside it get cleaned up.
        try {
          resolved.destroy();
        } catch (err) {
          console.error(
            '[useCollaborativeEditor] post-cancel destroy failed:',
            err,
          );
        }
        return;
      }
      handle = resolved;
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

  return { isCollaborative, status, collaborators, binding, seedError };
}
