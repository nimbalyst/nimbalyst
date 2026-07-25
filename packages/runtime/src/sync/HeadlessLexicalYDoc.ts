/**
 * HeadlessLexicalYDoc
 *
 * Thin Node-side wrapper that mirrors what `@lexical/react`'s
 * `<CollaborationPlugin>` does in the renderer: it constructs a headless
 * Lexical editor, binds it to a provided Y.Doc via `createBinding`, and
 * wires the bidirectional sync handlers (`syncLexicalUpdateToYjs` and
 * `syncYjsChangesToLexical`).
 *
 * Used by `MainBodyDocService` to land MCP body writes against the same
 * Y.Doc that warm renderer peers are editing, so the change CRDT-merges
 * with concurrent live edits instead of clobbering them on the next
 * autosave.
 *
 * Awareness is intentionally NOT surfaced here -- the host provider is
 * expected to be configured without an awareness setter (e.g. by skipping
 * `setLocalAwareness`). The headless editor never registers focus
 * tracking and never writes cursor state, so warm renderer peers do not
 * see a phantom presence row from the main-process service.
 */
import type { Doc } from 'yjs';
import { UndoManager } from 'yjs';
import {
  createBinding,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
  type Provider,
  type Binding,
} from '@lexical/yjs';
import {
  createHeadlessEditor,
} from '@lexical/headless';
import { SKIP_COLLAB_TAG, type LexicalEditor, type Klass, type LexicalNode } from 'lexical';

export interface HeadlessLexicalYDocOptions {
  /** Shared Y.Doc for this body. Typically obtained from `provider.getYDoc()`. */
  doc: Doc;
  /** Yjs binding root id. Defaults to 'main', matching the renderer's
   *  CollaborationPlugin convention. */
  rootId?: string;
  /** Provider implementing the `@lexical/yjs` Provider contract. */
  provider: Provider;
  /** Lexical editor node classes -- pass the same `EditorNodes` array the
   *  renderer uses so the headless editor parses every node type the
   *  Y.Doc carries. */
  nodes: ReadonlyArray<Klass<LexicalNode> | { replace: Klass<LexicalNode>; with: any }>;
  /** Optional editor namespace. Cosmetic; affects internal node ids. */
  namespace?: string;
}

export class HeadlessLexicalYDoc {
  readonly editor: LexicalEditor;
  readonly binding: Binding;
  private readonly disposers: Array<() => void> = [];
  private destroyed = false;

  constructor(opts: HeadlessLexicalYDocOptions) {
    const docMap = new Map<string, Doc>();
    const rootId = opts.rootId ?? 'main';
    docMap.set(rootId, opts.doc);

    this.editor = createHeadlessEditor({
      namespace: opts.namespace ?? 'nimbalyst-headless-body',
      nodes: [...opts.nodes],
      onError: (err: Error) => {
        // Surface but do not throw -- a single failed merge should not
        // tear down the whole service; the metadata sync envelope still
        // carries the body_version bump for cold readers.
        // eslint-disable-next-line no-console
        console.warn('[HeadlessLexicalYDoc] editor error:', err);
      },
    });

    this.binding = createBinding(
      this.editor,
      opts.provider,
      rootId,
      opts.doc,
      docMap,
    );

    // Y.Doc -> editor. Mirrors useYjsCollaboration: we only react to
    // transactions whose `origin !== binding`, so our own writes don't
    // re-enter the editor.
    const onYjsTreeChanges = (events: unknown[], transaction: { origin: unknown }) => {
      const origin = transaction.origin;
      if (origin === this.binding) return;
      const isFromUndoManager = origin instanceof UndoManager;
      syncYjsChangesToLexical(
        this.binding,
        opts.provider,
        events as any,
        isFromUndoManager,
      );
    };
    const sharedType = this.binding.root.getSharedType();
    sharedType.observeDeep(onYjsTreeChanges);
    this.disposers.push(() => sharedType.unobserveDeep(onYjsTreeChanges));

    // Editor -> Y.Doc. `SKIP_COLLAB_TAG` is Lexical's escape hatch for
    // updates that should not produce Y.Doc deltas (we don't use it but
    // honor it to keep parity with the renderer plugin).
    const removeListener = this.editor.registerUpdateListener(({
      prevEditorState, editorState, dirtyLeaves, dirtyElements, normalizedNodes, tags,
    }) => {
      if (tags.has(SKIP_COLLAB_TAG)) return;
      syncLexicalUpdateToYjs(
        this.binding,
        opts.provider,
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      );
    });
    this.disposers.push(removeListener);
  }

  /**
   * Materialize the binding's collab tree into the Lexical editor state.
   *
   * Needed because `createBinding` does not backfill. Two things are required
   * to read an existing document headlessly, and BOTH are load-bearing:
   *
   *   1. The doc's state must arrive as a Yjs update while this binding's
   *      observer is attached, so the collab tree gets built. Binding directly
   *      to an already-populated doc skips this and leaves the tree empty --
   *      see `MarkdownCollabContentAdapter.withHeadless`, which binds to a
   *      fresh doc and applies the source state into it.
   *   2. This call, which walks that collab tree into real Lexical nodes.
   *      Step 1 alone leaves the editor state empty: the deep observer builds
   *      collab nodes but does not replay them into Lexical.
   *
   * This is the headless twin of the renderer bug in `CollabLexicalProvider`
   * (FAILURE HISTORY note 1, NIM-1764): bind to a warm doc, read blank.
   */
  hydrateFromYDoc(): void {
    if (this.destroyed) return;
    this.editor.update(
      () => {
        this.binding.root.syncChildrenFromYjs(this.binding);
      },
      { discrete: true }
    );
  }

  /**
   * Apply an editor update inside a Lexical transaction. The binding
   * propagates the resulting node changes to the bound Y.Doc, which the
   * underlying provider then broadcasts to connected peers.
   *
   * `seed` runs inside `editor.update(...)` -- typical use is
   * `(root) => { root.clear(); $convertFromEnhancedMarkdownString(md, t); }`.
   */
  applyUpdate(seed: () => void): void {
    if (this.destroyed) return;
    this.editor.update(seed, { discrete: true });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const d of this.disposers) {
      try { d(); } catch { /* ignore */ }
    }
    this.disposers.length = 0;
    try { this.binding.root.destroy(this.binding); } catch { /* ignore */ }
  }
}
