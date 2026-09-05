import { describe, it, expect } from "vitest";
import {
  normalizeSettings,
  indexOptions,
  scopeModel,
  lensMatches,
} from "../viewSettings";
import {
  normalizeAreaRegistry,
  addAreaRule,
  createAreaRegistry,
  ruleMatches,
} from "../areaRegistry";
import { buildPrototypeModel } from "../model";
import type { ProjectGraphSnapshot } from "../../types";
const snapshot: ProjectGraphSnapshot = {
  generatedAt: 100,
  nodes: [
    {
      id: "t",
      type: "decision",
      label: "Decision",
      source: "tracker",
      visibility: "local",
      category: "strategy",
      tags: ["sync"],
    },
    {
      id: "s",
      type: "ai-session",
      label: "Session",
      source: "session",
      visibility: "local",
      category: "delivery",
      fields: { path: "packages/editor/file.ts" },
    },
  ],
  edges: [{ id: "e", type: "worked_on_in", sourceId: "t", targetId: "s" }],
  stats: { nodeCount: 2, edgeCount: 1, countsByType: {} },
};
describe("saved project scope", () => {
  it("validates persisted settings, keeps archive independent, and never silently caps indexing", () => {
    const s = normalizeSettings({
      mode: "bad",
      days: NaN,
      sources: { git: false },
      excludedTypes: [3, "partner"],
      includeArchived: false,
      safetyLimit: -3,
    });
    expect(s.mode).toBe("pulse");
    expect(s.days).toBe(7);
    expect(s.excludedTypes).toEqual(["partner"]);
    expect(indexOptions(s)).toMatchObject({
      sources: { git: false, sessions: true },
      includeArchived: false,
      safetyMax: {},
    });
  });
  it("filters displayed types without erasing unknown context or moving area slots", () => {
    const m = buildPrototypeModel(snapshot);
    const scoped = scopeModel(m, ["ai-session"]);
    expect(scoped.snapshot.nodes.map((n) => n.id)).toEqual(["t"]);
    expect(scoped.snapshot.edges).toEqual(snapshot.edges);
    expect(scoped.areas.map((a) => [a.id, a.slot])).toEqual(
      m.areas.map((a) => [a.id, a.slot])
    );
    expect(m.snapshot.nodes).toHaveLength(2);
    expect(scoped.nodeById.has("s")).toBe(false);
  });
  it("identifies a temporary override regardless of type filter order", () => {
    const s = normalizeSettings({ excludedTypes: ["b", "a"] });
    const l = { ...s, id: "l", name: "Saved" };
    expect(lensMatches(s, { ...l, excludedTypes: ["a", "b"] })).toBe(true);
    expect(lensMatches({ ...s, days: 30 }, l)).toBe(false);
  });
});
describe("persistent area rules", () => {
  it("preserves saved slots and holes across validation, rename, hiding and append", () => {
    const r = normalizeAreaRegistry([
      { id: "x", label: "Renamed", slot: 9, hidden: true },
      { id: "y", label: "Y", slot: 2 },
      { id: "x", slot: 1 },
    ]);
    expect(r.map((a) => a.slot)).toEqual([9, 2]);
    expect(r[0]?.hidden).toBe(true);
    expect(
      addAreaRule(r, { id: "z", label: "Z", tags: ["new"] }).map((a) => a.slot)
    ).toEqual([9, 2, 10]);
  });
  it("matches anchors and path boundaries without claiming a causal relationship", () => {
    expect(
      ruleMatches(
        { id: "a", label: "A", slot: 0, anchorIds: ["t"] },
        snapshot.nodes[0]!
      )
    ).toBe("Selected anchor record");
    expect(
      ruleMatches(
        { id: "a", label: "A", slot: 0, paths: ["packages/editor"] },
        snapshot.nodes[1]!
      )
    ).toBe("Path rule: packages/editor");
    expect(
      ruleMatches(
        { id: "a", label: "A", slot: 0, paths: ["packages/edit"] },
        snapshot.nodes[1]!
      )
    ).toBeUndefined();
  });
  it("keeps an empty or hidden area registered while sources and filters change", () => {
    const registry = createAreaRegistry(snapshot).map((r) =>
      r.id === "tag:sync" ? { ...r, hidden: true } : r
    );
    const model = buildPrototypeModel(snapshot, { areaRegistry: registry });
    expect(model.areas.find((a) => a.id === "tag:sync")).toBeUndefined();
    expect(registry.find((a) => a.id === "tag:sync")).toBeDefined();
    expect(
      model.areas.find((a) => a.id === "unassigned")?.nodeIds
    ).toHaveLength(2);
  });
});
