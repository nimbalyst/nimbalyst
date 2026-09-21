// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CANVAS_COMMANDS,
  getCommand,
  type CanvasCommandContext,
  type CanvasCommandId,
} from "../canvasCommands";

const node = (id: string, locked = false, group?: string) => ({
  id,
  type: "text" as const,
  text: id,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  "x-nimbalyst": { locked, group },
});
const ctx = (
  selection = [node("a"), node("b"), node("c")]
): CanvasCommandContext => ({
  selection,
  nodes: selection,
  readOnly: false,
  activeCardId: null,
  tool: "select",
});
describe("canvas commands", () => {
  it("names an unknown command in its error", () => {
    expect(() => getCommand("missing-command" as CanvasCommandId)).toThrow("Unknown canvas command: missing-command");
  });
  it("uses unlocked selection thresholds and lock/group states", () => {
    const mixed = ctx([node("a"), node("b"), node("c", true)]);
    expect(getCommand("align-left").enabled(mixed)).toBe(true);
    expect(getCommand("distribute-x").enabled(mixed)).toBe(false);
    expect(getCommand("distribute-y").enabled(ctx())).toBe(true);
    expect(getCommand("align-top").enabled(ctx([node("a")]))).toBe(false);
    expect(getCommand("group").enabled(mixed)).toBe(true);
    expect(
      getCommand("group").enabled(ctx([node("a", true), node("b", true)]))
    ).toBe(true);
    expect(getCommand("ungroup").enabled(mixed)).toBe(false);
    expect(getCommand("ungroup").enabled(ctx([node("a", false, "g")]))).toBe(
      true
    );
    expect(getCommand("lock").enabled(mixed)).toBe(true);
    expect(getCommand("unlock").enabled(mixed)).toBe(true);
    expect(getCommand("lock").enabled(ctx([node("a", true)]))).toBe(false);
    expect(getCommand("delete").enabled(ctx([node("a", true)]))).toBe(false);
    expect(getCommand("unlock").enabled(ctx())).toBe(false);
  });
  it("disables all document mutations in read-only mode and retains tools/navigation", () => {
    const context = {
      ...ctx([node("a", false, "g"), node("b"), node("c", true)]),
      readOnly: true,
    };
    for (const command of CANVAS_COMMANDS) {
      if (
        /^(tool-|fit-|zoom-|toggle-)/.test(command.id) ||
        ["escape", "saved-view", "select-all"].includes(command.id)
      )
        expect(command.enabled(context), command.id).toBe(true);
      else expect(command.enabled(context), command.id).toBe(false);
    }
    expect(new Set(CANVAS_COMMANDS.map((c) => c.id)).size).toBe(
      CANVAS_COMMANDS.length
    );
    for (const command of CANVAS_COMMANDS.filter((c) =>
      c.id.startsWith("tool-")
    ))
      expect(command.enabled({ ...ctx([]), readOnly: true })).toBe(true);
  });
});
