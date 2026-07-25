import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { analyzeHeapSnapshot } from "../HeapSnapshotAnalyzer";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "tiny.heapsnapshot"
);

describe("analyzeHeapSnapshot", () => {
  it("streams node aggregates and resolves the trailing string table", async () => {
    const result = await analyzeHeapSnapshot(fixturePath);

    expect(result.nodeCount).toBe(6);
    expect(result.edgeCount).toBe(0);
    expect(result.totalHeapSizeBytes).toBe(968);
    expect(result.topByShallowSize).toEqual([
      { name: "Cache", nodeType: "object", count: 1, shallowSizeBytes: 512 },
      { name: "array", nodeType: "array", count: 1, shallowSizeBytes: 256 },
      { name: "string", nodeType: "string", count: 1, shallowSizeBytes: 120 },
      { name: "Widget", nodeType: "object", count: 2, shallowSizeBytes: 80 },
      {
        name: "synthetic",
        nodeType: "synthetic",
        count: 1,
        shallowSizeBytes: 0,
      },
    ]);
    expect(result.largestStrings).toEqual([
      {
        nodeId: 7,
        nodeType: "string",
        namePreview:
          "a long fixture string with an escaped newline\nfor preview coverage",
        shallowSizeBytes: 120,
      },
    ]);
    expect(result.largestArrays).toEqual([
      {
        nodeId: 9,
        nodeType: "array",
        namePreview: "(object elements)",
        shallowSizeBytes: 256,
      },
    ]);
  });

  it("rejects non-snapshot paths before reading them", async () => {
    await expect(
      analyzeHeapSnapshot("/tmp/not-a-snapshot.json")
    ).rejects.toThrow("must end in .heapsnapshot");
  });
});
