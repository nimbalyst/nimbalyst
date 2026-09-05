// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { PanelHost } from "@nimbalyst/extension-sdk";
import { databaseAdapter } from "../../adapters/databaseAdapter";
import { buildPrototypeModel } from "../model";

describe("recorded session-side links", () => {
  it.each(["object", "json"] as const)(
    "carries %s metadata through the adapter and retains loaded and unresolved, deduplicated links",
    async (shape) => {
      const metadata = {
        linkedTrackerItemIds: [
          "shared-1",
          "shared-1",
          "local-2",
          "missing",
          "file:/repo/plan.md",
          null,
          3,
        ],
      };
      const query = vi.fn(async (sql: string) => {
        if (sql.includes("FROM session_files")) return [];
        if (sql.includes("FROM ai_sessions"))
          return [
            {
              id: "s1",
              title: "Session",
              created_at: "2026-09-04T00:00:00Z",
              metadata: shape === "json" ? JSON.stringify(metadata) : metadata,
            },
          ];
        return [
          {
            id: "shared-1",
            type: "decision",
            title: "Shared decision",
            data: {},
          },
          {
            id: "local-2",
            type: "task",
            title: "Local task",
            data: { linkedSessions: ["s1"] },
          },
        ];
      });
      const result = await databaseAdapter.run({
        workspacePath: "/repo",
        data: { query },
      } as unknown as PanelHost);
      expect(result.status).toBe("ok");
      expect(query).toHaveBeenCalledTimes(3);
      const snapshot = {
        generatedAt: Date.parse("2026-09-04T12:00:00Z"),
        nodes: result.nodes,
        edges: result.edges,
        stats: {
          nodeCount: result.nodes.length,
          edgeCount: result.edges.length,
          countsByType: {},
        },
      };
      const m = buildPrototypeModel(snapshot);
      const links = m.snapshot.edges.filter((e) => e.type === "worked_on_in");
      expect(links.map((e) => [e.sourceId, e.targetId]).sort()).toEqual([
        ["file:/repo/plan.md", "session:s1"],
        ["tracker:local-2", "session:s1"],
        ["tracker:missing", "session:s1"],
        ["tracker:shared-1", "session:s1"],
      ]);
      expect(
        m.snapshot.edges
          .filter((e) => e.type === "worked_on_in")
          .every((e) => e.provenance?.kind === "recorded")
      ).toBe(true);
      expect(m.snapshot.stats.edgeCount).toBe(m.snapshot.edges.length);
      expect(m.snapshot.nodes).toBe(snapshot.nodes);
    }
  );
});
