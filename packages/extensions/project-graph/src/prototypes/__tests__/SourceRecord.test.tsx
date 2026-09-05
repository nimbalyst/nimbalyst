import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import { SourceRecord } from "../SourceRecord";
import { buildPrototypeModel } from "../model";
import type { ProjectGraphSnapshot } from "../../types";
afterEach(cleanup);
it("keeps archive/current state distinct from recorded history and exposes unresolved graph navigation", () => {
  const snapshot: ProjectGraphSnapshot = {
    generatedAt: Date.parse("2026-09-05"),
    nodes: [
      {
        id: "t",
        label: "In review item",
        type: "bug",
        source: "tracker",
        visibility: "local",
        category: "delivery",
        status: "in-review",
        closedAt: Date.parse("2026-09-02"),
        fields: { archived: true, createdAt: "2026-09-01" },
      },
    ],
    edges: [
      {
        id: "e",
        sourceId: "t",
        targetId: "missing",
        type: "references",
        provenance: { kind: "recorded", basis: "Tracker field" },
      },
    ],
    stats: { nodeCount: 1, edgeCount: 1, countsByType: {} },
  };
  const model = buildPrototypeModel(snapshot);
  const resolve = vi.fn();
  render(
    <SourceRecord
      record={snapshot.nodes[0]!}
      model={model}
      sample={false}
      onClose={vi.fn()}
      onOpen={vi.fn()}
      onResolve={resolve}
      canOpen={false}
      onOpenOriginal={vi.fn()}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Recorded history" }));
  screen.getByText("Now: in-review · archived");
  screen.getByText(/Record created/);
  expect(screen.queryByText(/Status → closed/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Focused graph" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "Explore missing" }), {
    key: "Enter",
  });
  expect(resolve).toHaveBeenCalledWith("missing");
  screen.getByText(/Tracker field/);
});
