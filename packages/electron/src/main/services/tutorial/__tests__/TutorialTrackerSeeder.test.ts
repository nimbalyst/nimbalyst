import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  seedTutorialTrackers,
  type SeededTutorialTracker,
} from "../TutorialTrackerSeeder";

const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../../../../resources/tutorial-project/trackers.json"
);

describe("seedTutorialTrackers", () => {
  it("creates the native tutorial items and exposes the example bug reference", async () => {
    const created: SeededTutorialTracker[] = [];

    const result = await seedTutorialTrackers("/tmp/Nimbalyst Tutorial", {
      getFixturePath: () => FIXTURE_PATH,
      createTrackerItem: vi.fn(async (_workspacePath, fixture, id) => {
        const item = {
          key: fixture.key,
          id,
          issueKey: `NIM-${created.length + 1}`,
          type: fixture.type,
          title: fixture.title,
        } satisfies SeededTutorialTracker;
        created.push(item);
        return item;
      }),
      deleteTrackerItem: vi.fn(async () => undefined),
    });

    expect(result).toHaveLength(11);
    expect(result.filter((item) => item.type === "plan")).toHaveLength(2);
    expect(result.filter((item) => item.type === "decision")).toHaveLength(3);
    expect(result.filter((item) => item.type === "bug")).toHaveLength(3);
    expect(result.filter((item) => item.type === "task")).toHaveLength(3);
    expect(result.find((item) => item.key === "EXAMPLE_BUG")).toMatchObject({
      issueKey: "NIM-6",
      type: "bug",
      title: "Export remains disabled after changing the date range",
    });
    expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
  });

  it("removes already-created tracker rows when a later fixture fails", async () => {
    const deleteTrackerItem = vi.fn(async () => undefined);
    let calls = 0;

    await expect(
      seedTutorialTrackers("/tmp/Nimbalyst Tutorial", {
        getFixturePath: () => FIXTURE_PATH,
        createTrackerItem: vi.fn(async (_workspacePath, fixture, id) => {
          calls += 1;
          if (calls === 3) throw new Error("tracker store unavailable");
          return {
            key: fixture.key,
            id,
            issueKey: `NIM-${calls}`,
            type: fixture.type,
            title: fixture.title,
          };
        }),
        deleteTrackerItem,
      })
    ).rejects.toThrow("tracker store unavailable");

    expect(deleteTrackerItem).toHaveBeenCalledTimes(2);
  });
});
