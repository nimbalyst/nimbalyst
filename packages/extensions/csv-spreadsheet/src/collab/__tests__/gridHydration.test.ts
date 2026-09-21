// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GridHydration } from "../gridHydration";

class Grid extends EventTarget {
  source: Record<string, string>[] = [];
  pinnedTop: Record<string, string>[] = [];
  async getSource(section: string) {
    return section === "rgRow" ? this.source : this.pinnedTop;
  }
  changed() {
    this.dispatchEvent(new Event("afteranysource"));
  }
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("grid hydration", () => {
  it("requires full ordinary and pinned data plus metadata, then allows local changes", async () => {
    const grid = new Grid();
    const hydration = new GridHydration();
    let metadataReady = false;
    const source = Array.from({ length: 38 }, (_, i) => ({ A: `${i}` }));
    const pinnedTop = [{ A: "Header" }];
    hydration.stage({ source, pinnedTop }, () => metadataReady);
    hydration.attach(grid);
    grid.source = [source[37]];
    grid.changed();
    await tick();
    expect(hydration.isReady).toBe(false);
    grid.source = source;
    grid.changed();
    await tick();
    expect(hydration.isReady).toBe(false);
    grid.pinnedTop = pinnedTop;
    grid.changed();
    await tick();
    expect(hydration.isReady).toBe(false);
    metadataReady = true;
    hydration.check();
    await hydration.waitUntilReady();
    grid.source = [source[37]];
    grid.changed();
    await tick();
    expect(hydration.isReady).toBe(true);
    hydration.destroy();
  });

  it("cannot let an old read declare a replacement or remount ready", async () => {
    const grid = new Grid();
    const hydration = new GridHydration();
    const first = { source: [{ A: "old" }], pinnedTop: [] };
    grid.source = first.source;
    hydration.stage(first);
    hydration.attach(grid);
    const latest = { source: [{ A: "new" }], pinnedTop: [] };
    hydration.stage(latest);
    await tick();
    expect(hydration.isReady).toBe(false);
    grid.source = latest.source;
    grid.changed();
    await hydration.waitUntilReady();
    hydration.attach(new Grid());
    await tick();
    expect(hydration.isReady).toBe(false);
    const waiting = hydration.waitUntilReady();
    hydration.destroy();
    await expect(waiting).rejects.toThrow(/destroyed/);
  });
});
