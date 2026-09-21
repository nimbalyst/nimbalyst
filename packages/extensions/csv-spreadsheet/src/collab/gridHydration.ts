import type { GridSourceData } from "../utils/gridOperations";

type Rows = readonly Record<string, unknown>[];
interface Grid extends EventTarget {
  getSource(section: "rgRow" | "rowPinStart"): Promise<Rows>;
}

/** Compare model cells, not rendered/filtered rows or CSV byte formatting. */
function sameRows(actual: Rows, expected: Rows): boolean {
  return (
    actual.length === expected.length &&
    actual.every((row, i) => {
      const keys = new Set([...Object.keys(row), ...Object.keys(expected[i])]);
      return [...keys].every(
        (key) =>
          !/^[A-Z]+$/.test(key) ||
          String(row[key] ?? "") === String(expected[i][key] ?? "")
      );
    })
  );
}

/** Publication barrier for each complete ordinary + pinned source application. */
export class GridHydration {
  private grid: Grid | null = null;
  private generation = 0;
  private expected: GridSourceData | null = null;
  private metadataReady: () => boolean = () => true;
  private ready = false;
  private destroyed = false;
  private waiters = new Set<() => void>();

  constructor(
    private readonly onReadyChange: (ready: boolean) => void = () => {}
  ) {}

  get version(): number {
    return this.generation;
  }

  get isReady(): boolean {
    return this.ready;
  }

  stage(data: GridSourceData, metadataReady: () => boolean = () => true): void {
    this.expected = data;
    this.metadataReady = metadataReady;
    this.generation++;
    this.setReady(false);
    this.check();
  }

  attach(grid: Grid | null): void {
    if (this.grid === grid) return;
    this.grid?.removeEventListener("afteranysource", this.check);
    this.grid = grid;
    this.generation++;
    this.setReady(false);
    grid?.addEventListener("afteranysource", this.check);
    this.check();
  }

  // RevoGrid emits afteranysource after updating its internal source store.
  // Both section reads must belong to this same application and mounted grid.
  check = (): void => {
    const { grid, expected, generation } = this;
    if (this.ready || !grid || !expected || this.destroyed) return;
    void Promise.all([grid.getSource("rgRow"), grid.getSource("rowPinStart")])
      .then(([source, pinned]) => {
        if (
          this.destroyed ||
          generation !== this.generation ||
          grid !== this.grid
        )
          return;
        if (
          this.metadataReady() &&
          sameRows(source, expected.source) &&
          sameRows(pinned, expected.pinnedTop)
        ) {
          this.setReady(true);
        }
      })
      .catch(() => {
        // An unconnected Stencil element cannot expose its stores yet. Its next
        // source event retries; an explicit flush remains blocked and can fail.
      });
  };

  async waitUntilReady(): Promise<void> {
    if (this.destroyed) throw new Error("CSV grid hydration was destroyed");
    if (this.ready) return;
    this.check();
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        if (!this.ready && !this.destroyed) return;
        clearTimeout(timer);
        this.waiters.delete(finish);
        if (this.destroyed)
          reject(new Error("CSV grid hydration was destroyed"));
        else resolve();
      };
      // A deadline rejects the flush; it never makes an incomplete grid ready.
      const timer = setTimeout(() => {
        this.waiters.delete(finish);
        reject(
          new Error(
            "CSV grid hydration did not complete; content was not published"
          )
        );
      }, 5000);
      this.waiters.add(finish);
      finish();
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.grid?.removeEventListener("afteranysource", this.check);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private setReady(ready: boolean): void {
    if (this.ready !== ready) {
      this.ready = ready;
      this.onReadyChange(ready);
    }
    if (ready) for (const wake of this.waiters) wake();
  }
}
