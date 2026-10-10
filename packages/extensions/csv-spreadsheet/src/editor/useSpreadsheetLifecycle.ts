/**
 * EditorHost lifecycle for the spreadsheet: loading, echo detection, external
 * changes, save, and AI diff review.
 *
 * Diff review is read-only. A diff splices phantom rows (the AI's deletions)
 * into the grid source, so grid row indices no longer line up with the file's.
 * Every mutation path addresses cells by index, so an edit made mid-review
 * lands on the wrong row, and `toCSV()` would write the phantom rows back out
 * as real ones. Whatever survived that is then thrown away: accept/reject
 * reloads from disk. Keep/Revert is the only way out of review.
 */

import { useEditorLifecycle, type DiffConfig, type EditorHost } from '@nimbalyst/extension-sdk';
import type { DiffState } from '../types';
import type { RevoGridElement } from '../revogrid-types';
import type { GridSourceData } from '../utils/gridOperations';
import { parseCSV } from '../utils/csvParser';
import { computeDiff } from '../utils/diffCompute';
import type { EditorCore } from './editorCore';
import { buildDiffGridSource } from './diffGridSource';
import { saveGridContent } from './saveGrid';

export function useSpreadsheetLifecycle(
  host: EditorHost,
  core: EditorCore,
  applyGridSource: (grid: RevoGridElement, gridData: GridSourceData) => void,
  setDiffState: (diff: DiffState | null) => void,
) {
  const {
    collabActiveRef, loadedCsvContentRef, hydration, spreadsheetMetaRef, pendingDataRef,
    revoGridRef, dataLoadedRef, diffStateRef, gridOpsRef, prepareGridData,
  } = core;

  return useEditorLifecycle(host, {
    applyContent: (content: string) => {
      // Collab guard (NIM-1529): once the collab binding is active the Y.Doc
      // owns the content. A reopen of a shared doc has no file bytes, so the
      // lifecycle loads '' here -- applying it would blank pendingDataRef
      // after the binding already staged the synced content, and the next
      // grid->Y.Text poll would push a delete-all into the shared room.
      if (collabActiveRef.current && !content) {
        return;
      }
      loadedCsvContentRef.current = content;
      // Parse CSV and set RevoGrid source imperatively
      const { data } = parseCSV(content);
      const gridData = prepareGridData(data);

      // Store data to be loaded imperatively once grid is mounted
      hydration.stage(gridData, () => spreadsheetMetaRef.current.metadata.headerRowCount === data.headerRowCount &&
        spreadsheetMetaRef.current.metadata.columnCount === data.columnCount);
      pendingDataRef.current = gridData;

      // If grid already mounted, load immediately
      const grid = revoGridRef.current;
      if (grid) {
        applyGridSource(grid, gridData);
        dataLoadedRef.current = true;
      }

      // Update metadata
      spreadsheetMetaRef.current.loadFromCSV(content);
      spreadsheetMetaRef.current.markClean();
    },
    onExternalChange: () => {
      // Clear diff state when file changes externally (e.g., after accept/reject)
      if (diffStateRef.current?.isActive) {
        // console.log('[CSV] Clearing diff state after file change');
        setDiffState(null);
      }
    },
    onSave: async () => {
      // Mid-review the grid holds the AI's content plus phantom rows for its
      // deletions. Writing that back would resurrect every deleted row as a
      // real one -- and there is nothing to save anyway, since the proposed
      // content is already the file on disk. Keep/Revert owns this.
      if (diffStateRef.current?.isActive) return;

      const gridOps = gridOpsRef.current;
      if (!gridOps) {
        console.warn('[CSV] Grid operations not available for save');
        return;
      }

      // Save to disk before recording the echo baseline or clearing dirty: a
      // rejected save must not leave the editor believing the content is
      // persisted. Dirty stays set if an edit landed while the save ran.
      await saveGridContent(gridOps, {
        saveContent: (content) => host.saveContent(content),
        updateDiskContent: (content) => spreadsheetMetaRef.current.updateDiskContent(content),
        markClean: () => spreadsheetMetaRef.current.markClean(),
      });
      // console.log('[CSV] Saved');
    },
    onDiffRequested: (config: DiffConfig) => {
      // console.log('[CSV] Diff requested:', config.tagId);

      // Compute cell-level diff between original and modified content
      const diff = computeDiff(
        config.originalContent,
        config.modifiedContent,
        config.tagId,
        config.sessionId
      );

      // Parse the modified content to get the actual data to display
      const { data: modifiedData } = parseCSV(config.modifiedContent);
      const gridData = prepareGridData(modifiedData);

      // Update grid with modified content so the new data is visible, with
      // phantom rows for the deletions spliced in at their positions.
      const grid = revoGridRef.current;
      if (grid) {
        applyGridSource(grid, buildDiffGridSource(gridData, modifiedData, diff));
      }

      spreadsheetMetaRef.current.loadFromCSV(config.modifiedContent);
      setDiffState(diff);
    },
    onDiffCleared: async () => {
      // console.log('[CSV] Diff cleared externally');
      setDiffState(null);

      // Reload content from disk to remove phantom rows
      try {
        const content = await host.loadContent();
        const { data } = parseCSV(content);
        const gridData = prepareGridData(data);

        const grid = revoGridRef.current;
        if (grid) applyGridSource(grid, gridData);

        spreadsheetMetaRef.current.loadFromCSV(content);
        spreadsheetMetaRef.current.markClean();
      } catch (error) {
        console.error('[CSV] Failed to reload content after diff cleared:', error);
      }
    },
  });
}
