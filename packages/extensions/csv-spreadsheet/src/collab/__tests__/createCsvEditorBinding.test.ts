// @vitest-environment node
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createCsvEditorBinding } from "../createCsvEditorBinding";
import { GridHydration } from "../gridHydration";
import {
  createGridOperations,
  spreadsheetDataToGridSource,
} from "../../utils/gridOperations";
import { parseCSV } from "../../utils/csvParser";
import { getYMeta } from "../metaBinding";
import type { RevoGridElement } from "../../revogrid-types";

vi.mock("@nimbalyst/extension-sdk", () => ({ copyToClipboard: vi.fn() }));

it("hydrates a shared sheet from parsed content even while React still holds the empty metadata", async () => {
  const initial =
    '# nimbalyst: {"headerRowCount":37,"hasHeaders":true}\n' +
    Array.from({ length: 38 }, (_, i) => `Row${i},${i}`).join("\n");
  const doc = new Y.Doc();
  doc.getText("csv").insert(0, initial);
  const hydration = new GridHydration();
  const empty = {
    headerRowCount: 0,
    columnCount: 0,
    frozenColumnCount: 0,
    columnFormats: {},
    columnWidths: {},
    cellStyles: {},
    hasHeaders: false,
  };
  let nextMetadata = empty;
  const metadata = {
    metadata: empty,
    delimiter: "," as const,
    loadFromCSV(content: string) {
      const parsed = parseCSV(content);
      nextMetadata = { ...empty, ...parsed.data };
    },
    markClean() {},
    applyRemoteMetadata(patch: Partial<typeof empty>) {
      nextMetadata = { ...nextMetadata, ...patch };
    },
  };
  const grid = Object.assign(new EventTarget(), {
    source: [] as Record<string, string | number>[],
    pinnedTopSource: [] as Record<string, string | number>[],
    getSource(section: string) {
      return Promise.resolve(
        section === "rgRow" ? this.source : this.pinnedTopSource
      );
    },
  });
  const gridRef = { current: grid as unknown as RevoGridElement };
  const gridOps = createGridOperations(gridRef, {
    getHeaderRowCount: () => metadata.metadata.headerRowCount,
    getColumnCount: () => metadata.metadata.columnCount,
    setColumnCount: () => {},
    getDelimiter: () => ",",
    getColumnFormats: () => ({}),
    getColumnWidths: () => ({}),
    getCellStyles: () => ({}),
    getFrozenColumnCount: () => 0,
    onDirty: () => {},
    getUndoPlugin: () => null,
  });
  hydration.attach(grid);
  const options = {
    loadedCsvContentRef: { current: "" },
    pendingDataRef: { current: null },
    revoGridRef: gridRef,
    dataLoadedRef: { current: false },
    spreadsheetMetaRef: { current: metadata },
    metaBindingRef: { current: null },
    lastPublishedMetaRef: { current: null },
    collabBindingRef: { current: null },
    collabActiveRef: { current: false },
    gridOpsRef: { current: gridOps },
    hydration,
    prepareGridData: spreadsheetDataToGridSource,
    applyGridSource: (
      _grid: unknown,
      data: {
        source: typeof grid.source;
        pinnedTop: typeof grid.pinnedTopSource;
      }
    ) => {
      grid.source = data.source;
      grid.pinnedTopSource = data.pinnedTop;
      grid.dispatchEvent(new Event("afteranysource"));
    },
    setRemotePresences: () => {},
  } as unknown as Parameters<typeof createCsvEditorBinding>[1];
  const handle = createCsvEditorBinding({ yDoc: doc }, options);
  expect(getYMeta(doc).get("headerRowCount")).toBe(37);
  expect(hydration.isReady).toBe(false);
  metadata.metadata = nextMetadata;
  hydration.check();
  await handle.syncNow();
  expect(parseCSV(doc.getText("csv").toString()).data.rows).toHaveLength(38);
  // Metadata-only remote header changes must repartition the same complete
  // content rather than reading a half-updated ordinary/pinned pair.
  getYMeta(doc).set("headerRowCount", 1);
  metadata.metadata = nextMetadata;
  hydration.check();
  await handle.syncNow();
  expect(grid.pinnedTopSource).toHaveLength(1);
  expect(parseCSV(doc.getText("csv").toString()).data.rows).toHaveLength(38);
  handle.destroy();
  hydration.destroy();
  doc.destroy();
});
