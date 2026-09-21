import {
  CANVAS_COMMANDS,
  getCommand,
  type CanvasCommandContext,
  type CanvasCommandId,
} from "./canvasCommands";

export interface CanvasKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target?: unknown;
}
export interface CanvasShortcut {
  commandId: CanvasCommandId;
  label: string;
  keys: string[];
}
export const CANVAS_SHORTCUT_TABLE: readonly CanvasShortcut[] =
  CANVAS_COMMANDS.filter((command) => command.shortcut && command.id !== "unlock").map((command) => ({
    commandId: command.id,
    label: command.id === "lock" ? "Lock / unlock" : command.label,
    keys: command.shortcut === "+" ? ["+"] : command.shortcut!.split("+"),
  }));

function editable(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as {
    tagName?: string;
    isContentEditable?: boolean;
    parentElement?: unknown;
    getAttribute?: (name: string) => string | null;
  };
  if (
    /^(INPUT|TEXTAREA)$/i.test(element.tagName ?? "") ||
    element.isContentEditable
  )
    return true;
  const attribute = element.getAttribute?.("contenteditable");
  if (attribute !== undefined && attribute !== null)
    return attribute !== "false";
  return editable(element.parentElement);
}
export function resolveCanvasKey(
  event: CanvasKeyEvent,
  ctx: CanvasCommandContext
): CanvasCommandId | null {
  if (editable(event.target)) return null;
  if (event.key === "Escape") return "escape";
  if (ctx.activeCardId || event.altKey) return null;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  let id: CanvasCommandId | null = null;
  if (mod) {
    if (key === "g") id = event.shiftKey ? "ungroup" : "group";
    else if (key === "l" && event.shiftKey)
      id = ctx.selection.some((node) => node["x-nimbalyst"]?.locked !== true)
        ? "lock"
        : "unlock";
    else if (!event.shiftKey)
      id =
        ({ a: "select-all", d: "duplicate", "0": "zoom-100" } as const)[
          key as "a" | "d" | "0"
        ] ?? null;
  } else if (event.key.startsWith("Arrow")) {
    const direction = (
      {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      } as const
    )[event.key as "ArrowLeft"];
    if (direction) id = `nudge-${direction}${event.shiftKey ? "-10" : ""}`;
  } else if (
    event.shiftKey &&
    ["Digit1", "Digit2", "Digit0"].includes(event.code)
  ) {
    id = (
      {
        Digit1: "fit-all",
        Digit2: "fit-selection",
        Digit0: "saved-view",
      } as const
    )[event.code as "Digit1"];
  } else if (event.key === "+" || event.key === "=") id = "zoom-in";
  else if (!event.shiftKey) {
    id =
      (
        {
          v: "tool-select",
          h: "tool-hand",
          n: "tool-sticky",
          t: "tool-text",
          f: "tool-frame",
          m: "tool-pin",
          "-": "zoom-out",
          "]": "bring-front",
          "[": "send-back",
          backspace: "delete",
          delete: "delete",
        } as const
      )[key as "v"] ?? null;
  }
  return id && getCommand(id).enabled(ctx) ? id : null;
}
