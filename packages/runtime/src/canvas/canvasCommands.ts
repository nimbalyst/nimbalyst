import type { CanvasAnyNode } from "./CanvasDocument";

export type CanvasTool =
  | "select"
  | "hand"
  | "sticky"
  | "text"
  | "frame"
  | "edge"
  | "pin";
export type CanvasCommandId =
  | "select-all"
  | "duplicate"
  | "delete"
  | "group"
  | "ungroup"
  | "lock"
  | "unlock"
  | "align-left"
  | "align-center-x"
  | "align-right"
  | "align-top"
  | "align-center-y"
  | "align-bottom"
  | "distribute-x"
  | "distribute-y"
  | "tidy"
  | "bring-front"
  | "send-back"
  | "nudge-left"
  | "nudge-right"
  | "nudge-up"
  | "nudge-down"
  | "nudge-left-10"
  | "nudge-right-10"
  | "nudge-up-10"
  | "nudge-down-10"
  | "fit-all"
  | "fit-selection"
  | "zoom-in"
  | "zoom-out"
  | "zoom-100"
  | "saved-view"
  | "tool-select"
  | "tool-hand"
  | "tool-sticky"
  | "tool-text"
  | "tool-frame"
  | "tool-edge"
  | "tool-pin"
  | "toggle-minimap"
  | "toggle-grid-snap"
  | "escape";
export interface CanvasCommandContext {
  selection: readonly CanvasAnyNode[];
  nodes: readonly CanvasAnyNode[];
  readOnly: boolean;
  activeCardId: string | null;
  tool: CanvasTool;
}
export interface CanvasCommand {
  id: CanvasCommandId;
  label: string;
  shortcut?: string;
  enabled(ctx: CanvasCommandContext): boolean;
}
export type CanvasCommandRunner = (id: CanvasCommandId) => void;

const always = () => true;
const hasUnlocked = (ctx: CanvasCommandContext, minimum: number): boolean => {
  let count = 0;
  for (const node of ctx.selection) {
    if (node["x-nimbalyst"]?.locked !== true && ++count >= minimum) return true;
  }
  return false;
};
const mutable =
  (minimum = 1) =>
  (ctx: CanvasCommandContext) =>
    !ctx.readOnly && hasUnlocked(ctx, minimum);
const command = (
  id: CanvasCommandId,
  label: string,
  enabled: CanvasCommand["enabled"] = always,
  shortcut?: string
): CanvasCommand => ({ id, label, enabled, ...(shortcut ? { shortcut } : {}) });
export const CANVAS_COMMANDS: readonly CanvasCommand[] = [
  command(
    "select-all",
    "Select all",
    (ctx) => ctx.nodes.some((node) => node.type !== "group"),
    "Mod+A"
  ),
  command(
    "duplicate",
    "Duplicate",
    (ctx) => !ctx.readOnly && ctx.selection.length > 0,
    "Mod+D"
  ),
  command("delete", "Delete", mutable(), "Backspace"),
  command(
    "group",
    "Group",
    (ctx) => !ctx.readOnly && ctx.selection.length >= 2,
    "Mod+G"
  ),
  command(
    "ungroup",
    "Ungroup",
    (ctx) =>
      !ctx.readOnly &&
      ctx.selection.some((node) => !!node["x-nimbalyst"]?.group),
    "Mod+Shift+G"
  ),
  command("lock", "Lock", mutable(), "Mod+Shift+L"),
  command(
    "unlock",
    "Unlock",
    (ctx) =>
      !ctx.readOnly &&
      ctx.selection.some((node) => node["x-nimbalyst"]?.locked === true),
    "Mod+Shift+L"
  ),
  ...(["left", "center-x", "right", "top", "center-y", "bottom"] as const).map(
    (edge) =>
      command(`align-${edge}`, `Align ${edge.replace("-", " ")}`, mutable(2))
  ),
  command("distribute-x", "Distribute horizontally", mutable(3)),
  command("distribute-y", "Distribute vertically", mutable(3)),
  command("tidy", "Tidy", mutable(2)),
  command("bring-front", "Bring to front", mutable(), "]"),
  command("send-back", "Send to back", mutable(), "["),
  ...(["left", "right", "up", "down"] as const).flatMap((direction) => [
    command(
      `nudge-${direction}`,
      `Nudge ${direction}`,
      mutable(),
      `Arrow${direction[0].toUpperCase()}${direction.slice(1)}`
    ),
    command(
      `nudge-${direction}-10`,
      `Nudge ${direction} by 10`,
      mutable(),
      `Shift+Arrow${direction[0].toUpperCase()}${direction.slice(1)}`
    ),
  ]),
  command("fit-all", "Fit all", (ctx) => ctx.nodes.length > 0, "Shift+1"),
  command(
    "fit-selection",
    "Fit selection",
    (ctx) => ctx.selection.length > 0,
    "Shift+2"
  ),
  command("zoom-in", "Zoom in", always, "+"),
  command("zoom-out", "Zoom out", always, "-"),
  command("zoom-100", "Zoom to 100%", always, "Mod+0"),
  command("saved-view", "Restore saved view", always, "Shift+0"),
  command("tool-select", "Select tool", always, "V"),
  command("tool-hand", "Hand tool", always, "H"),
  command("tool-sticky", "Sticky tool", always, "N"),
  command("tool-text", "Text tool", always, "T"),
  command("tool-frame", "Frame tool", always, "F"),
  command("tool-edge", "Edge tool"),
  command("tool-pin", "Comment tool", always, "M"),
  command("toggle-minimap", "Toggle minimap"),
  command("toggle-grid-snap", "Toggle grid snap"),
  command("escape", "Cancel or step back", always, "Escape"),
];
export function getCommand(id: CanvasCommandId): CanvasCommand {
  const command = CANVAS_COMMANDS.find((command) => command.id === id);
  if (!command) throw new Error(`Unknown canvas command: ${id}`);
  return command;
}
