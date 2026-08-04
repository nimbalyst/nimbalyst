/**
 * The single write path for editing one tracker field from a UI surface.
 *
 * File-backed records (frontmatter, imports, inline blocks) round-trip through
 * the document so the file stays the source of truth; everything else writes to
 * the tracker store directly. Both paths then reindex relationships.
 */

import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';

const FILE_BACKED_SOURCES = new Set(['frontmatter', 'import', 'inline']);

export async function saveTrackerField(
  item: TrackerRecord,
  fieldName: string,
  value: unknown,
): Promise<void> {
  const updates = { [fieldName]: value };
  try {
    if (FILE_BACKED_SOURCES.has(item.source) && item.system.documentPath) {
      await window.electronAPI.documentService.updateTrackerItemInFile({
        itemId: item.id,
        updates,
      });
    } else {
      await window.electronAPI.documentService.updateTrackerItem({
        itemId: item.id,
        updates,
        syncMode: globalRegistry.get(item.primaryType)?.sync?.mode ?? 'local',
      });
    }
    window.electronAPI
      .invoke('document-service:tracker-item-reindex-relationships', { itemId: item.id })
      .catch(() => {});
  } catch (error) {
    console.error('[trackerFieldSave] Failed to save field:', error);
  }
}
