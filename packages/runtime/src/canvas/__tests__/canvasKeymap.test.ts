// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CANVAS_SHORTCUT_TABLE,
  resolveCanvasKey,
  type CanvasKeyEvent,
} from "../canvasKeymap";
import type { CanvasCommandContext } from "../canvasCommands";
const nodes = ["a", "b", "c"].map((id) => ({
  id,
  type: "text" as const,
  text: id,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  "x-nimbalyst": { group: "g" },
}));
const ctx: CanvasCommandContext = {
  selection: nodes,
  nodes,
  tool: "select",
  activeCardId: null,
  readOnly: false,
};
const event = (
  key: string,
  extras: Partial<CanvasKeyEvent> = {}
): CanvasKeyEvent => ({
  key,
  code: "",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...extras,
});
describe("canvas keymap", () => {
  it("maps tool, navigation, editing, and nudge chords on both platforms", () => {
    for (const [key, command] of Object.entries({
      v: "tool-select",
      h: "tool-hand",
      n: "tool-sticky",
      t: "tool-text",
      f: "tool-frame",
      m: "tool-pin",
      "+": "zoom-in",
      "=": "zoom-in",
      "-": "zoom-out",
      "[": "send-back",
      "]": "bring-front",
      Delete: "delete",
      Backspace: "delete",
      Escape: "escape",
    }))
      expect(resolveCanvasKey(event(key), ctx)).toBe(command);
    for (const modifier of ["metaKey", "ctrlKey"]) {
      for (const [key, command] of Object.entries({
        a: "select-all",
        d: "duplicate",
        g: "group",
        "0": "zoom-100",
      }))
        expect(resolveCanvasKey(event(key, { [modifier]: true }), ctx)).toBe(
          command
        );
      expect(
        resolveCanvasKey(event("G", { [modifier]: true, shiftKey: true }), ctx)
      ).toBe("ungroup");
      expect(
        resolveCanvasKey(event("L", { [modifier]: true, shiftKey: true }), ctx)
      ).toBe("lock");
      expect(
        resolveCanvasKey(event("L", { [modifier]: true, shiftKey: true }), {
          ...ctx,
          selection: nodes.map((n) => ({
            ...n,
            "x-nimbalyst": { locked: true },
          })),
        })
      ).toBe("unlock");
    }
    for (const direction of ["Left", "Right", "Up", "Down"]) {
      expect(resolveCanvasKey(event(`Arrow${direction}`), ctx)).toBe(
        `nudge-${direction.toLowerCase()}`
      );
      expect(
        resolveCanvasKey(event(`Arrow${direction}`, { shiftKey: true }), ctx)
      ).toBe(`nudge-${direction.toLowerCase()}-10`);
    }
    for (const [key, code, command] of [
      ["!", "Digit1", "fit-all"],
      ["@", "Digit2", "fit-selection"],
      [")", "Digit0", "saved-view"],
    ])
      expect(resolveCanvasKey(event(key, { code, shiftKey: true }), ctx)).toBe(
        command
      );
  });
  it("leaves typing, hot cards, unsupported modifiers, space, and undo to their owners", () => {
    for (const target of [
      { tagName: "INPUT" },
      { tagName: "textarea" },
      { isContentEditable: true },
      { parentElement: { getAttribute: () => "true" } },
    ]) {
      expect(resolveCanvasKey(event("v", { target }), ctx)).toBeNull();
      expect(resolveCanvasKey(event("Escape", { target }), ctx)).toBeNull();
      expect(resolveCanvasKey(event("Escape", { target }), { ...ctx, activeCardId: "a" })).toBeNull();
    }
    expect(
      resolveCanvasKey(event("v"), { ...ctx, activeCardId: "a" })
    ).toBeNull();
    expect(
      resolveCanvasKey(event("Escape"), { ...ctx, activeCardId: "a" })
    ).toBe("escape");
    for (const e of [
      event(" "),
      event("z", { metaKey: true }),
      event("z", { ctrlKey: true, shiftKey: true }),
      event("v", { altKey: true }),
      event("ArrowLeft", { metaKey: true }),
    ])
      expect(resolveCanvasKey(e, ctx)).toBeNull();
    expect(
      resolveCanvasKey(event("Delete"), { ...ctx, readOnly: true })
    ).toBeNull();
    expect(
      CANVAS_SHORTCUT_TABLE.find((s) => s.commandId === "group")?.keys
    ).toEqual(["Mod", "G"]);
    expect(CANVAS_SHORTCUT_TABLE.filter(s => s.keys.join("+") === "Mod+Shift+L")).toEqual([
      { commandId: "lock", label: "Lock / unlock", keys: ["Mod", "Shift", "L"] },
    ]);
  });
});
