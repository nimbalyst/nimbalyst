/**
 * CollabContentAdapter
 *
 * Per-extension contract that lets host features (re-upload, history,
 * export, AI editing, search indexing, comments, backup, restore)
 * operate on any extension's collaborative Y.Doc without knowing the
 * internal layout.
 *
 * The interface itself is defined in `@nimbalyst/extension-sdk` so
 * extension authors get the type out of the SDK and the host stays
 * the single source of truth. This package re-exports it for
 * host-internal consumers (electron main, runtime services) that
 * shouldn't take a dep on the extension SDK.
 *
 * See `packages/extension-sdk-docs/custom-editors.md` for the
 * extension-author guide and `design/Collaboration/collab-content-adapter.md`
 * for the design + security model.
 */
import type {
  CollabContentAdapter as SdkCollabContentAdapter,
  CollabContentAdapterMigration as SdkCollabContentAdapterMigration,
  CollabContentFileSource,
} from '@nimbalyst/extension-sdk';

export type CollabContentAdapter<TStructured = unknown> = SdkCollabContentAdapter<TStructured>;
export type CollabContentAdapterMigration = SdkCollabContentAdapterMigration;
export type FileSource = CollabContentFileSource;
