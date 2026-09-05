// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ProjectGraphNode, ProjectGraphSnapshot } from "../../types";
import { buildPrototypeModel } from "../model";
const now = Date.parse("2026-09-04T12:00:00Z");
const node = (
  id: string,
  extra: Partial<ProjectGraphNode> = {}
): ProjectGraphNode => ({
  id,
  type: "ai-session",
  label: id,
  category: "delivery",
  source: "session",
  visibility: "local",
  ...extra,
});
const snap = (
  nodes: ProjectGraphNode[],
  edges: ProjectGraphSnapshot["edges"] = []
): ProjectGraphSnapshot => ({
  generatedAt: now,
  nodes,
  edges,
  stats: { nodeCount: nodes.length, edgeCount: edges.length, countsByType: {} },
});

describe("prototype projection", () => {
  it("keeps registered areas across refresh when tag frequency crosses the old top-twelve cutoff", () => {
    const original = snap(
      Array.from({ length: 12 }, (_, i) =>
        node(`n${i}`, { tags: [`topic-${String(i).padStart(2, "0")}`] })
      )
    );
    const initial = buildPrototypeModel(original);
    const areaRegistry = initial.areas.map((a, slot) => ({
      id: a.id,
      label: a.label,
      slot,
      tags: [a.id.slice(4)],
    }));
    const refreshed = snap([
      ...original.nodes,
      ...Array.from({ length: 100 }, (_, i) =>
        node(`new${i}`, { tags: ["new-dominant-topic"] })
      ),
    ]);
    const after = buildPrototypeModel(refreshed, { areaRegistry });
    expect(
      after.areas.filter((a) => a.id !== "unassigned").map((a) => a.id)
    ).toEqual(initial.areas.map((a) => a.id));
    const missing = buildPrototypeModel(snap(original.nodes.slice(1)), {
      areaRegistry,
    });
    expect(missing.areas.find((a) => a.id === "tag:topic-00")).toMatchObject({
      slot: 0,
      nodeIds: [],
    });
  });
  it("includes native GitHub creation observations without using inferred node dates", () => {
    const m = buildPrototypeModel(
      snap([
        node("pr:1", {
          source: "external",
          type: "github-pr",
          createdAt: now - 123,
          fields: { createdAt: "2026-09-01T10:00:00Z" },
        }),
        node("issue:2", {
          source: "external",
          type: "github-issue",
          createdAt: now - 123,
          fields: { createdAt: "2026-09-02T10:00:00Z" },
        }),
      ])
    );
    expect(m.events.map((e) => [e.nodeId, e.kind, e.provenance])).toEqual([
      ["pr:1", "created", "recorded"],
      ["issue:2", "created", "recorded"],
    ]);
  });
  it("merges declared display aliases and excludes import-date tags without changing source tags", () => {
    const s = snap([
      node("a", {
        tags: ["collab", "collaboration", "triage", "researched-2026-08"],
      }),
      node("b", { tags: ["trackers", "tracker"] }),
    ]);
    const m = buildPrototypeModel(s);
    expect(m.areas.map((a) => a.id)).toEqual([
      "tag:collaboration",
      "tag:tracker",
    ]);
    expect(m.memberships.get("a")).toHaveLength(1);
    expect(s.nodes[0]!.tags).toContain("collab");
  });

  it("separates direct topic tags, one-hop evidence and unassigned records without inventing semantic edges", () => {
    const s = snap(
      [
        node("s", {
          tags: ["feature", "Queue Reliability", "queue-reliability"],
        }),
        node("d", { type: "directory", source: "file" }),
        node("orphan"),
        node("next", { type: "directory", source: "file" }),
      ],
      [
        { id: "e", type: "edited_in", sourceId: "s", targetId: "d" },
        { id: "e2", type: "contains", sourceId: "d", targetId: "next" },
      ]
    );
    const m = buildPrototypeModel(s);
    expect(m.areas.map((a) => a.id)).toEqual([
      "tag:queue-reliability",
      "unassigned",
    ]);
    expect(m.areas[0]!.nodeIds).toEqual(["s", "d"]);
    expect(m.memberships.get("s")?.[0]?.basis).toContain("Tag");
    expect(m.memberships.get("d")?.[0]?.basis).toContain("edited_in");
    expect(m.memberships.get("next")?.[0]?.areaId).toBe("unassigned");
    expect(s.edges).toHaveLength(2);
    expect(m.snapshot.edges).toHaveLength(2);
  });
  it("uses native dates and point observations, never derived file dates, closedAt or lifetime intervals", () => {
    const m = buildPrototypeModel(
      snap([
        node("old", {
          createdAt: now - 1000,
          closedAt: now,
          fields: {
            createdAt: "2026-01-01T00:00:00Z",
            lastActivity: "2026-09-04T10:00:00Z",
          },
        }),
        node("doc", {
          source: "file",
          type: "plan",
          createdAt: now - 1000,
          status: "in-development",
        }),
        node("commit", {
          source: "git",
          type: "commit",
          createdAt: now - 500,
          fields: { isoDate: "2026-09-03T10:00:00Z" },
        }),
      ])
    );
    expect(
      m.events.filter((e) => e.nodeId === "old").map((e) => [e.kind, e.at])
    ).toEqual([
      ["created", Date.parse("2026-01-01T00:00:00Z")],
      ["last-activity", Date.parse("2026-09-04T10:00:00Z")],
    ]);
    expect(m.events.some((e) => e.nodeId === "doc")).toBe(false);
    expect(m.events.find((e) => e.nodeId === "commit")?.kind).toBe("commit");
  });
  it("normalizes stored history, deduplicates transitions and rejects invalid/future observations", () => {
    const activity = [
      {
        action: "status_changed",
        newValue: "in-review",
        timestamp: now - 1000,
      },
      {
        action: "status_changed",
        newValue: "in-review",
        timestamp: now - 1000,
      },
      { action: "status_changed", newValue: "done", timestamp: now + 1000 },
      { action: "edited", timestamp: now - 10 },
      { action: "status_changed", timestamp: "nonsense" },
    ];
    const m = buildPrototypeModel(
      snap([node("s", { fields: { data: JSON.stringify({ activity }) } })])
    );
    expect(m.events).toEqual([
      expect.objectContaining({
        nodeId: "s",
        kind: "status",
        at: now - 1000,
        label: "Status → in-review",
        provenance: "recorded",
      }),
    ]);
  });
  it("keeps multi-area counts distinct and geometry inputs independent of event recency, preserves display overrides", () => {
    const s = snap([
      node("a", { tags: ["sync", "memory"] }),
      node("b", { tags: ["memory"] }),
    ]);
    const m = buildPrototypeModel(s, {
      areaNames: { "tag:memory": "Knowledge" },
    });
    expect(m.memberships.get("a")).toHaveLength(2);
    expect(m.areas.find((a) => a.id === "tag:memory")?.label).toBe("Knowledge");
    expect(m.areas.find((a) => a.id === "tag:memory")?.nodeIds).toHaveLength(2);
    expect(s.nodes[0]!.tags).toEqual(["sync", "memory"]);
  });
  it("carries source coverage and retrieval bounds without substituting sample data", () => {
    const periodCoverage = {
      startMs: now - 1000,
      endMs: now,
      complete: false,
      reason: "Source interrupted",
    };
    const live = buildPrototypeModel(snap([node("x")]), {
      coverage: ["Memory source unavailable"],
      periodCoverage,
    });
    expect(live.coverage).toContain("Memory source unavailable");
    expect(live.periodCoverage).toEqual(periodCoverage);
    expect(buildPrototypeModel(snap([]), { source: "sample" }).source).toBe(
      "sample"
    );
  });
});
