import { it, expect } from "vitest";
import { periodCoverageForIndex, indexCoverageMessages } from "../coverage";
import { emptyCoverage } from "../../indexing/types";
import type { ProjectIndexState } from "../../indexing/projectIndex";
it("never substitutes requested bounds or complete metadata for retrieved event history", () => {
  const coverage = {
    ...emptyCoverage("git", "Commits", true),
    availability: "available" as const,
    complete: true,
    indexed: 100,
    total: 100,
    window: { startMs: 1, endMs: 100 },
  };
  const state = {
    coverage: { git: coverage },
    generatedAt: 100,
  } as ProjectIndexState;
  expect(periodCoverageForIndex(state)).toMatchObject({
    startMs: 0,
    complete: false,
  });
  expect(indexCoverageMessages(state).join(" ")).toContain(
    "Additional event history not retrieved"
  );
  expect(indexCoverageMessages(state).join(" ")).not.toContain(
    "retrieved history"
  );
});
it("uses the intersection of genuinely retrieved complete histories", () => {
  const c = {
    ...emptyCoverage("git", "Commits", true),
    availability: "available" as const,
    complete: true,
    events: {
      retrieved: true,
      complete: true,
      scope: "windowed" as const,
      window: { startMs: 20, endMs: 80 },
    },
  };
  const state = {
    coverage: {
      git: c,
      sessions: {
        ...c,
        events: { ...c.events, window: { startMs: 30, endMs: 90 } },
      },
    },
    generatedAt: 100,
  } as unknown as ProjectIndexState;
  expect(periodCoverageForIndex(state)).toMatchObject({
    startMs: 30,
    endMs: 80,
    complete: true,
  });
});
