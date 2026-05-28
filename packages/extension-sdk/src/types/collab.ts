/**
 * CollabContentAdapter
 *
 * Per-extension Y.Doc content contract that lets host features
 * (re-upload, history, export, AI editing, search indexing, comments,
 * backup, restore) operate on any extension's collaborative document
 * without knowing its internal layout.
 *
 * Extensions register an adapter via
 * `context.services.collab.registerContentAdapter(...)` from their
 * `activate()` function. See
 * `packages/extension-sdk-docs/custom-editors.md` for the full guide
 * and `design/Collaboration/collab-content-adapter.md` for the design.
 *
 * Adapters run only client-side (main process, renderer, extensions).
 * The collab Worker stays adapter-agnostic and treats Y.Doc state as
 * opaque ciphertext.
 *
 * NOTE: This is the canonical definition. The host-internal
 * `@nimbalyst/collab-adapters` registry re-imports this type --
 * do not fork the interface there.
 */
import type { Doc } from 'yjs';

export type CollabContentFileSource = string | Uint8Array;

export interface CollabContentAdapterMigration {
  from: number;
  to: number;
  run(yDoc: Doc): void;
}

export interface CollabContentAdapter<TStructured = unknown> {
  /** Identifies this adapter; matches the shared doc's documentType. */
  documentType: string;

  /** File extensions this adapter is the on-disk codec for. Include
   *  the leading dot (e.g. '.md', '.mockup.html'). The first entry is
   *  used as the default by save-a-copy / export-to-file flows. */
  fileExtensions: string[];

  /** Optional MIME type used by save dialogs and asset uploads. */
  mimeType?: string;

  /** Layout schema version. Bump when the Y.Doc shape changes; pair
   *  with `migrations` to migrate older docs forward before any
   *  write op. */
  layoutVersion: number;

  /** Optional migrations from older layout versions. Run by the
   *  registry before `applyFromFile` / `applyStructuredPatch` when
   *  the Y.Doc's recorded layoutVersion is older than this adapter's
   *  layoutVersion. */
  migrations?: CollabContentAdapterMigration[];

  /** True iff the Y.Doc has no extension content yet. Used to gate
   *  the initial-share seed flow. */
  isEmpty(yDoc: Doc): boolean;

  /** Seed an empty Y.Doc from on-disk file bytes/text. Initial share
   *  only -- adapters can assume `isEmpty(yDoc) === true`. */
  seedFromFile(yDoc: Doc, source: CollabContentFileSource): void;

  /** Replace Y.Doc content with the supplied on-disk file content.
   *  Must be safe to call on a populated Y.Doc. Default behaviour is
   *  wipe-and-reseed inside a single Y.Doc transaction. Adapters
   *  that want finer-grained history can override with a
   *  diff-and-patch implementation. */
  applyFromFile(yDoc: Doc, source: CollabContentFileSource): void;

  /** Serialize the live Y.Doc back to the on-disk file format. */
  exportToFile(yDoc: Doc): string | Uint8Array;

  /** Plain-text projection for search, AI prompts, diffs, history
   *  previews. Lossy is fine; this is not a round-trip channel. */
  toPlainText(yDoc: Doc): string;

  /** Optional: structured projection for AI tool-call edits and
   *  comment anchoring. Shape is extension-defined. Paired with
   *  `applyStructuredPatch`. */
  toStructured?(yDoc: Doc): TStructured;

  /** Optional: write structured edits back. Paired with
   *  `toStructured`. AI-write surface is gated on the presence of
   *  both this and `toStructured`. */
  applyStructuredPatch?(yDoc: Doc, patch: unknown): void;

  /** Optional: produce a snapshot for revision history. Defaults to
   *  `Y.encodeStateAsUpdateV2(yDoc)`. Override if you need a denser
   *  snapshot format. */
  exportRevisionSnapshot?(yDoc: Doc): Uint8Array;

  /** Optional: restore a revision snapshot. Defaults to
   *  `Y.applyUpdateV2(yDoc, bytes)`. */
  restoreRevisionSnapshot?(yDoc: Doc, bytes: Uint8Array): void;
}

/**
 * The collab surface on the extension context. Extensions call into
 * this from their `activate()` to register a content adapter for any
 * document type they ship.
 */
export interface ExtensionCollabService {
  /**
   * Register a CollabContentAdapter for one of the extension's
   * document types. Returns a Disposable that unregisters on
   * deactivation; the host also tracks the registration in
   * `context.subscriptions` automatically.
   */
  registerContentAdapter(adapter: CollabContentAdapter): { dispose(): void };
}
