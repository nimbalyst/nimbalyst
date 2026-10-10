/**
 * The editor-graph half of page history for a browser host.
 *
 * The dialog, its controller contract and the restore write path ship in
 * `./docs-ui` (`CollabHistoryDialog`); turning revision bytes into markdown and
 * drawing two markdown strings as a red/green diff both need the Lexical
 * editor, so they ship here beside the editor that already carries it.
 */
import { Doc } from 'yjs';
import { getRevisionSnapshotFns } from '@nimbalyst/collab-adapters';
import { MarkdownCollabContentAdapter } from '@nimbalyst/runtime/collab-lexical';

export {
  DiffPreviewEditor,
  type DiffNavigationState,
} from '@nimbalyst/runtime/editor/plugins/DiffPlugin/DiffPreviewEditor';

/**
 * A markdown page revision as markdown, the desktop's `previewRevisionSnapshot`
 * for the one format a browser host restores. Stored markdown revisions are
 * the page's markdown text, and older ones a Y update; the adapter's restore
 * path reads both, so both sides of a diff normalize the same way.
 */
export function previewMarkdownRevisionSnapshot(bytes: Uint8Array): string {
  const { restoreRevisionSnapshot } = getRevisionSnapshotFns(MarkdownCollabContentAdapter);
  const scratch = new Doc();
  try {
    restoreRevisionSnapshot(scratch, bytes);
    return MarkdownCollabContentAdapter.toPlainText(scratch);
  } finally {
    scratch.destroy();
  }
}
