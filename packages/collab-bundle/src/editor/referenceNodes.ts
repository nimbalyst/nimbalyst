/**
 * Teach this host the reference nodes a desktop client can write into a shared
 * document, before any editor mounts.
 *
 * Without it, opening a document containing a tracker or shared-document
 * reference throws ``Node <type> is not registered`` inside the `@lexical/yjs`
 * observer and the document never paints at all.
 *
 * THIS MUST NOT BECOME A BARE `import './referenceNodes'` AGAIN.
 *
 * It was one, and the production bundle silently dropped the whole module.
 * This package declares `sideEffects: ["**\/*.css"]`, which tells the bundler
 * that its own `.ts` files have no side effects, so a side-effect-only import
 * with no used bindings is legal to delete — and Rolldown deleted it. The
 * sibling `registerBuiltinExtensions` import survived only because it belongs
 * to `@nimbalyst/runtime`, which declares no `sideEffects` field at all and so
 * defaults to "assume side effects".
 *
 * Nothing caught it: vite dev does not tree-shake, and vitest does not bundle,
 * so the registration was present everywhere except the artifact users load.
 * The symptom was Lexical error #88 (`Node tracker-reference is not
 * registered`) thrown from inside `applyChildrenYjsDelta` while the snapshot
 * applied — logged by DocumentSync as a listener failure, and otherwise
 * invisible. Exporting a function the entry point calls keeps the module alive
 * no matter what the `sideEffects` field says.
 *
 * Read-only by design: the node classes and markdown transformers come from the
 * shared runtime registration, and the tracker chip uses the store-free
 * renderer. Creating or editing references needs the pickers and services this
 * host does not have.
 */

import { registerReferenceNodeContributions } from '@nimbalyst/runtime/plugins/referenceNodeContributions';
import { setTrackerReferenceNodeRenderer } from '@nimbalyst/runtime/plugins/TrackerLinkPlugin/TrackerReferenceNodeRenderer';
import { TrackerReferenceReadOnlyChip } from '@nimbalyst/runtime/plugins/TrackerLinkPlugin/TrackerReferenceReadOnlyChip';
// The document reference is a styled TextNode; its styles ship with the
// interactive plugin, which this host does not load. A `.css` import IS covered
// by this package's `sideEffects` field, so this one is safe as a bare import.
import '@nimbalyst/runtime/plugins/DocumentLinkPlugin/DocumentLinkPlugin.css';

let registered = false;

/**
 * Register the reference node classes with this host. Idempotent — the entry
 * point calls it at module scope, and calling it again is harmless.
 */
export function registerBrowserReferenceNodes(): void {
  if (registered) return;
  registered = true;
  registerReferenceNodeContributions();
  setTrackerReferenceNodeRenderer(TrackerReferenceReadOnlyChip);
}
