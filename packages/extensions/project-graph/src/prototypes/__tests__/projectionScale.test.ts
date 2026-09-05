// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildPrototypeModel } from "../model";
import {
  buildAreaIndex,
  areaConnections,
  layoutTerritories,
} from "../atlas/atlasModel";
import { buildPulseMatrix } from "../pulse/pulseModel";
import { buildTrailsIndex, buildNeighborhood } from "../trails/trailsModel";
import type { ProjectGraphSnapshot } from "../../types";

describe("large indexed projection", () => {
  it.each([10000, 50000, 100000])(
    "bounds rendered structures over %i records with dense relations",
    (size) => {
      const now = Date.parse("2026-09-05T12:00:00Z");
      const snapshot: ProjectGraphSnapshot = {
        generatedAt: now,
        nodes: Array.from({ length: size }, (_, i) => ({
          id: `n${i}`,
          label: `Record ${i}`,
          source: "tracker",
          type: i % 3 ? "task" : "decision",
          category: "delivery",
          visibility: "local",
          tags: [`area-${i % 12}`],
          fields: { createdAt: now - (i % 90) * 86400000 },
        })),
        edges: Array.from({ length: size * 4 }, (_, i) => ({
          id: `e${i}`,
          type: "references",
          sourceId: `n${i % size}`,
          targetId: `n${i % 7 === 0 ? 0 : (i * 13 + 19) % size}`,
          provenance: { kind: "recorded", basis: "Synthetic benchmark link" },
        })),
        stats: { nodeCount: size, edgeCount: size * 4, countsByType: {} },
      };
      const begin = performance.now();
      const m = buildPrototypeModel(snapshot);
      const projectionMs = performance.now() - begin;
      const range = { startMs: now - 7 * 86400000, endMs: now };
      let start = performance.now();
      const areas = buildAreaIndex(m);
      const connections = areaConnections(m, areas, m.areas[0]!.id, {
        evidenceCap: 10,
      });
      const layout = layoutTerritories(areas.order, 1400);
      const atlasMs = performance.now() - start;
      start = performance.now();
      const pulse = buildPulseMatrix(m, range, {
        selectedAreaId: null,
        unit: null,
        sort: "recent",
      });
      const pulseMs = performance.now() - start;
      start = performance.now();
      const index = buildTrailsIndex(m);
      const neighborhood = buildNeighborhood(m, index, "n0", range, {
        perLane: () => 5,
        laneLimit: 8,
        includePathDerived: true,
      });
      const trailsMs = performance.now() - start;
      expect(layout.boxes.length).toBeLessThanOrEqual(13);
      expect(pulse.rows.length).toBeLessThanOrEqual(13);
      expect(
        connections.connections.every((c) => c.evidence.length <= 10)
      ).toBe(true);
      expect(neighborhood.connectionShown).toBeLessThanOrEqual(40);
      expect(neighborhood.connectionTotal).toBeGreaterThan(1000);
      console.log(
        "[projection timing]",
        JSON.stringify({
          records: size,
          edges: snapshot.edges.length,
          projectionMs: Math.round(projectionMs),
          atlasMs: Math.round(atlasMs),
          pulseMs: Math.round(pulseMs),
          trailsMs: Math.round(trailsMs),
          serializedMB:
            Math.round(
              (Buffer.byteLength(JSON.stringify(snapshot)) / 1024 / 1024) * 10
            ) / 10,
        })
      );
    },
    30000
  );
});
