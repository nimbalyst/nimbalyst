// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  alignNodes,
  distributeNodes,
  tidyNodes,
  nudgeNodes,
  type CanvasAlignment,
} from "../canvasArrange";
const nodes = [
  { id: "a", x: 10, y: 20, width: 40, height: 20 },
  { id: "b", x: 100, y: 120, width: 20, height: 40 },
  { id: "c", x: 210, y: 220, width: 60, height: 60 },
];
const locked = {
  id: "locked",
  x: -1000,
  y: -1000,
  width: 9999,
  height: 9999,
  locked: true,
};
describe("canvas arrange", () => {
  it("aligns all six union bounds, skips locked nodes, and emits only changes", () => {
    const expected = {
      left: [10, 10, 10],
      "center-x": [120, 130, 110],
      right: [230, 250, 210],
      top: [20, 20, 20],
      "center-y": [140, 130, 120],
      bottom: [260, 240, 220],
    };
    for (const edge of Object.keys(expected) as CanvasAlignment[]) {
      const patches = alignNodes([...nodes, locked], edge);
      const axis = ["left", "center-x", "right"].includes(edge) ? "x" : "y";
      expect(
        nodes.map((n) => patches.find((p) => p.id === n.id)?.[axis] ?? n[axis])
      ).toEqual(expected[edge]);
      expect(patches.some((p) => p.id === locked.id)).toBe(false);
      expect(
        patches.every(
          (p) =>
            p.x !== nodes.find((n) => n.id === p.id)!.x ||
            p.y !== nodes.find((n) => n.id === p.id)!.y
        )
      ).toBe(true);
    }
    expect(alignNodes([nodes[0], locked], "left")).toEqual([]);
  });
  it("distributes unequal sizes with even gaps and a single changed-node patch", () => {
    expect(distributeNodes([...nodes, locked], "x")).toEqual([
      { id: "b", x: 120, y: 120 },
    ]);
    expect(distributeNodes([...nodes, locked], "y")).toEqual([
      { id: "b", x: 100, y: 110 },
    ]);
    expect(distributeNodes(nodes.slice(0, 2), "x")).toEqual([]);
  });
  it("tidies row-major at the movable top-left origin without changing input", () => {
    const before = JSON.stringify(nodes);
    expect(tidyNodes([nodes[2], locked, nodes[1], nodes[0]])).toEqual([
      { id: "b", x: 98, y: 20 },
      { id: "c", x: 10, y: 108 },
    ]);
    expect(tidyNodes(nodes, 0)).toEqual([
      { id: "b", x: 70, y: 20 },
      { id: "c", x: 10, y: 80 },
    ]);
    expect(JSON.stringify(nodes)).toBe(before);
    expect(tidyNodes([{ ...nodes[1], y: 20 }, nodes[0]], 0)).toEqual([
      { id: "b", x: 50, y: 20 },
    ]);
    expect(tidyNodes([])).toEqual([]);
  });
  it("nudges only unlocked nodes, rounds, and suppresses no-ops", () => {
    expect(nudgeNodes([nodes[0], locked], 0.6, -1.6)).toEqual([
      { id: "a", x: 11, y: 18 },
    ]);
    expect(nudgeNodes(nodes, 0, 0)).toEqual([]);
    expect(nudgeNodes([locked], 10, 10)).toEqual([]);
  });
});
