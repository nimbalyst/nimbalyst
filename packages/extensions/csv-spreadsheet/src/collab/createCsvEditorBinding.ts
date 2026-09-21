import type { RefObject } from "react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { RevoGridElement } from "../revogrid-types";
import type { GridOperations, GridSourceData } from "../utils/gridOperations";
import type { SpreadsheetData } from "../types";
import type { useSpreadsheetMetadata } from "../hooks/useSpreadsheetMetadata";
import { parseCSV } from "../utils/csvParser";
import { CsvBinding } from "./csvBinding";
import {
  CsvMetaBinding,
  isMetaEmpty,
  type CsvMetaSnapshot,
} from "./metaBinding";
import { getYCsv } from "./seed";
import type { RemotePresence } from "./presence";
import type { GridHydration } from "./gridHydration";

interface Options {
  loadedCsvContentRef: RefObject<string>;
  pendingDataRef: RefObject<GridSourceData | null>;
  revoGridRef: RefObject<RevoGridElement | null>;
  dataLoadedRef: RefObject<boolean>;
  spreadsheetMetaRef: RefObject<ReturnType<typeof useSpreadsheetMetadata>>;
  metaBindingRef: RefObject<CsvMetaBinding | null>;
  lastPublishedMetaRef: RefObject<CsvMetaSnapshot | null>;
  collabBindingRef: RefObject<CsvBinding | null>;
  collabActiveRef: RefObject<boolean>;
  gridOpsRef: RefObject<GridOperations | null>;
  hydration: GridHydration;
  prepareGridData: (data: SpreadsheetData) => GridSourceData;
  applyGridSource: (grid: RevoGridElement, data: GridSourceData) => void;
  setRemotePresences: (presences: RemotePresence[]) => void;
}

/** Own the binding wiring separately from grid rendering and interactions. */
export function createCsvEditorBinding(
  { yDoc, awareness }: { yDoc: Y.Doc; awareness?: Awareness },
  options: Options
) {
  const {
    loadedCsvContentRef,
    pendingDataRef,
    revoGridRef,
    dataLoadedRef,
    spreadsheetMetaRef,
    metaBindingRef,
    lastPublishedMetaRef,
    collabBindingRef,
    collabActiveRef,
    gridOpsRef,
    hydration,
    prepareGridData,
    applyGridSource,
    setRemotePresences,
  } = options;

  const applyCsvContent = (content: string) => {
    loadedCsvContentRef.current = content;
    const { data } = parseCSV(content);
    const sharedMeta = isMetaEmpty(yDoc)
      ? null
      : metaBindingRef.current?.snapshot();
    if (sharedMeta) {
      data.headerRowCount = sharedMeta.headerRowCount;
      data.hasHeaders = sharedMeta.headerRowCount > 0;
    }
    const gridData = prepareGridData(data);
    // Stash for the deferred ref-callback path. The collab createBinding
    // can fire applyCsvContent before the grid is mounted -- if so, the
    // ref callback's pendingDataRef branch is what populates the grid on
    // mount. Without this, an earlier lifecycle applyContent('') wins by
    // leaving an empty pendingDataRef in place and the reopened tab
    // comes back blank.
    hydration.stage(
      gridData,
      () =>
        spreadsheetMetaRef.current.metadata.headerRowCount ===
          data.headerRowCount &&
        spreadsheetMetaRef.current.metadata.columnCount === data.columnCount
    );
    pendingDataRef.current = gridData;
    const grid = revoGridRef.current;
    if (grid) {
      applyGridSource(grid, gridData);
      dataLoadedRef.current = true;
    }
    spreadsheetMetaRef.current.loadFromCSV(content);
    spreadsheetMetaRef.current.markClean();
    // `loadFromCSV` re-reads metadata from the comment line, which in a
    // shared sheet is stale derived output. The map is the authority, so
    // put it back on top of whatever the text happened to carry.
    const metaBinding = metaBindingRef.current;
    if (metaBinding && !isMetaEmpty(yDoc)) {
      const snapshot = metaBinding.snapshot();
      spreadsheetMetaRef.current.applyRemoteMetadata(snapshot);
      lastPublishedMetaRef.current = snapshot;
    }
  };

  // Metadata syncs through its own map rather than the comment line inside
  // the CSV text, so two people formatting two different columns merge.
  const metaBinding = new CsvMetaBinding(yDoc, {
    onRemoteMeta: (snapshot) => {
      if (collabBindingRef.current)
        collabBindingRef.current.refreshFromShared();
      else spreadsheetMetaRef.current.applyRemoteMetadata(snapshot);
      lastPublishedMetaRef.current = snapshot;
    },
  });
  metaBindingRef.current = metaBinding;

  // Initial baseline = whatever Y.Text already has (the seed we just
  // wrote OR the content sync'd from another client).
  const initial = getYCsv(yDoc).toString();
  const binding = new CsvBinding(
    yDoc,
    initial,
    {
      isReady: () => hydration.isReady,
      getGeneration: () => hydration.version,
      waitUntilReady: () => hydration.waitUntilReady(),
      getCurrentCsv: async () => {
        const gridOps = gridOpsRef.current;
        if (!gridOps) throw new Error("CSV grid operations are not ready");
        return await gridOps.toCSV();
      },
      onRemoteContent: (content: string) => {
        // Route through the same applyContent path the host uses for
        // external file changes. The grid is reloaded; metadata gets
        // re-parsed; selection survives if the cell still exists.
        applyCsvContent(content);
        collabBindingRef.current?.noteAppliedRemote(content);
      },
      onRemoteAwareness: () => {
        // A collaborator's selection/edit changed -- refresh the presence
        // list. The overlay re-measures cell rects off this state change.
        setRemotePresences(
          collabBindingRef.current?.getRemotePresences() ?? []
        );
      },
    },
    awareness
  );
  collabBindingRef.current = binding;
  // Seed presence from whoever is already in the room (onRemoteAwareness
  // only fires on subsequent changes).
  setRemotePresences(binding.getRemotePresences());
  // Recipient opens commonly mount with `host.loadContent() === ''` and
  // rely on the already-synced Y.Text as the first real payload. Consume
  // that snapshot immediately; otherwise there may be no subsequent remote
  // change event to wake the grid up from its blank local fallback.
  if (initial.length > 0) {
    applyCsvContent(initial);
    binding.noteAppliedRemote(initial);
  }

  // Migration: a sheet shared before metadata had its own key carries it
  // only in the comment line. Whoever opens it first seeds the map from
  // what was just parsed; after that the map is the authority. Two clients
  // racing here write identical values, so the result converges either way.
  if (isMetaEmpty(yDoc)) {
    // React's loadFromCSV setter has not necessarily committed yet. Seed from
    // the same parsed document as the grid, never from that older render.
    const parsed = parseCSV(initial || loadedCsvContentRef.current);
    metaBinding.publish({
      headerRowCount: parsed.data.headerRowCount,
      frozenColumnCount: parsed.data.frozenColumnCount,
      columnFormats: parsed.data.columnFormats,
      columnWidths: parsed.metadata?.columnWidths ?? {},
      cellStyles: parsed.data.cellStyles,
    });
  } else {
    const snapshot = metaBinding.snapshot();
    spreadsheetMetaRef.current.applyRemoteMetadata(snapshot);
    lastPublishedMetaRef.current = snapshot;
  }

  if (initial.length === 0 && loadedCsvContentRef.current.length > 0) {
    // First-share opens can render from host.loadContent() before the Y.Text
    // has been populated. Push that already-loaded local CSV immediately so a
    // close/reopen does not depend on the poll interval or unmount flush.
    void binding.syncNow().catch((error) => {
      console.error(
        "[SpreadsheetEditor] Failed to push initial local CSV to collab doc:",
        error
      );
    });
  }
  collabActiveRef.current = true;
  return {
    // Drained by the host before it reports a write complete. This matters
    // more here than anywhere else: local edits reach the Y.Text on a 1s
    // poll, so without it an AI tool returns a full second before its cells
    // are in the document.
    syncNow: () => binding.syncNow(),
    destroy: () => {
      // No flush here. `destroy` runs from a passive effect cleanup, which
      // React schedules after it has already detached the grid's ref, so
      // this could only ever call `toCSV()` against a grid that is gone --
      // it threw "Grid not available" on every close and, until `syncNow`
      // started reporting failure, hid that behind a resolved promise.
      // The drain that can still read the grid is the one the host runs
      // through `registerContentFlush` before it destroys the mount.
      binding.destroy();
      metaBindingRef.current?.destroy();
      metaBindingRef.current = null;
      lastPublishedMetaRef.current = null;
      collabBindingRef.current = null;
      collabActiveRef.current = false;
      setRemotePresences([]);
    },
  };
}
