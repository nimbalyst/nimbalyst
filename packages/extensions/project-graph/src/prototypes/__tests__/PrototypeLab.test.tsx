import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelHost } from "@nimbalyst/extension-sdk";
import type { PrototypeViewProps } from "../contracts";
import { PrototypeLab } from "../PrototypeLab";

const { loadSnapshot } = vi.hoisted(() => ({ loadSnapshot: vi.fn() }));
vi.mock("../../indexing/projectIndex", () => ({
  ProjectIndex: class {
    listeners = new Set<(state: unknown) => void>();
    state = {
      status: "idle",
      records: [] as { id: string }[],
      edges: [],
      coverage: {},
      timings: {},
      generatedAt: 0,
      progress: { recordsIndexed: 0, completedSources: 0, totalSources: 7 },
    };
    getState() {
      return this.state;
    }
    subscribe(fn: (state: unknown) => void) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    async load() {
      try {
        const result = await loadSnapshot();
        this.state = {
          ...this.state,
          status: "ready",
          records: result.snapshot.nodes,
          edges: result.snapshot.edges,
          generatedAt: result.snapshot.generatedAt,
        };
        for (const fn of this.listeners) fn(this.state);
        return this.state;
      } catch (e) {
        throw e;
      }
    }
    async loadDetail(){return null}
    async loadCommitEvidence(){return {covered:0,truncated:false}}
    async hydrateFromCache() {
      return false;
    }
    async refresh() {
      return this.load();
    }
    async resolveNode(id: string) {
      return (
        this.state.records.find((n: { id: string }) => n.id === id) ?? null
      );
    }
    dispose() {
      this.listeners.clear();
    }
    cancel() {}
  },
}));
function View(props: PrototypeViewProps) {
  return (
    <div>
      <span data-testid="projection">
        {props.model.source}:{props.model.snapshot.nodes.length}:
        {props.selectedAreaId}:{props.selectedNodeId}
      </span>
      <span data-testid="comparison">
        {props.comparisonRange
          ? `${props.comparisonRange.endMs}:${props.range.startMs}`
          : "off"}
      </span>
      <button onClick={() => props.onNavigate("pulse", "s", "tag:sync")}>
        Follow evidence
      </button>
      <button onClick={() => props.onOpenNode(props.model.snapshot.nodes[0]!)}>
        Inspect first source
      </button>
    </div>
  );
}
vi.mock("../atlas/AtlasPrototype", () => ({ AtlasPrototype: View }));
vi.mock("../pulse/PulsePrototype", () => ({ PulsePrototype: View }));
vi.mock("../trails/TrailsPrototype", () => ({ TrailsPrototype: View }));
const loaded = {
  snapshot: {
    generatedAt: Date.parse("2026-09-04T12:00:00Z"),
    nodes: [
      {
        id: "s",
        label: "Actual session",
        type: "ai-session",
        source: "session",
        category: "delivery",
        visibility: "local",
        tags: ["sync"],
        fields: { id: "session-id", createdAt: "2026-09-01T12:00:00Z" },
      },
    ],
    edges: [],
    stats: { nodeCount: 1, edgeCount: 0, countsByType: {} },
  },
  diagnostics: { adapters: [] },
};
function host(): PanelHost {
  return {
    workspacePath: "/workspace",
    storage: { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined) },
    close: vi.fn(),
    openFile: vi.fn(),
  } as unknown as PanelHost;
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("prototype lab integration", () => {
  it("never substitutes illustrative data for a failed live source", async () => {
    loadSnapshot.mockRejectedValueOnce(new Error("Source unavailable"));
    render(<PrototypeLab host={host()} />);
    await screen.findByRole("alert");
    expect(screen.queryByTestId("projection")).toBeNull();
    fireEvent.change(screen.getByLabelText("Prototype data source"), {
      target: { value: "sample" },
    });
    expect(screen.getByTestId("projection").textContent).toContain(
      "sample:3080"
    );
  });
  it("carries area and artifact selection between views without reloading sources, and clears them when the corpus changes", async () => {
    loadSnapshot.mockResolvedValue(loaded);
    render(<PrototypeLab host={host()} />);
    await screen.findByTestId("projection");
    fireEvent.click(screen.getByText("Follow evidence"));
    expect(screen.getByTestId("projection").textContent).toBe(
      "live:1:tag:sync:s"
    );
    fireEvent.click(screen.getByRole("button", { name: "Evidence Trails" }));
    expect(screen.getByTestId("projection").textContent).toBe(
      "live:1:tag:sync:s"
    );
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("Prototype data source"), {
      target: { value: "sample" },
    });
    expect(screen.getByTestId("projection").textContent).toBe("sample:3080::");
  });
  it("does not let a pending live load overwrite sample mode", async () => {
    let resolve!: (value: unknown) => void;
    loadSnapshot.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    render(<PrototypeLab host={host()} />);
    await waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Prototype data source"), {
      target: { value: "sample" },
    });
    resolve(loaded);
    await waitFor(() =>
      expect(screen.getByTestId("projection").textContent).toContain(
        "sample:3080"
      )
    );
    fireEvent.click(screen.getByText("Inspect first source"));
    expect(
      screen.queryByRole("button", { name: "Open original tracker" })
    ).toBeNull();
    screen.getByText("Sample sources do not open real project artifacts.");
  });
});

it("defaults to Pulse and persists range, comparison, filters and saved lenses without reloading metadata", async () => {
  loadSnapshot.mockResolvedValue(loaded);
  const h = host();
  render(<PrototypeLab host={h} />);
  await screen.findByTestId("projection");
  expect(
    screen.getByRole("button", { name: "Pulse" }).getAttribute("aria-pressed")
  ).toBe("true");
  fireEvent.change(screen.getByLabelText("Prototype time range"), {
    target: { value: "30" },
  });
  fireEvent.click(screen.getByLabelText("Compare previous period"));
  expect(screen.getByTestId("comparison").textContent).not.toBe("off");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.change(screen.getByLabelText("Lens name"), {
    target: { value: "Recent delivery" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save current lens" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply settings" }));
  expect(
    (screen.getByLabelText("Saved lens") as HTMLSelectElement)
      .selectedOptions[0]?.text
  ).toBe("Recent delivery");
  await waitFor(() =>
    expect(h.storage.set).toHaveBeenCalledWith(
      "project-understanding.settings.v1",
      expect.objectContaining({ days: 30, compare: true })
    )
  );
  expect(loadSnapshot).toHaveBeenCalledTimes(1);
});
