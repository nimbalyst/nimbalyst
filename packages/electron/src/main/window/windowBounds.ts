import type { Rectangle } from "electron";
import { MAIN_WINDOW_TITLE_BAR_HEIGHT } from "../../shared/windowChrome";

// #1535: body-only overlap is not recoverable; leave enough title bar visible
// for the user to drag the window without disturbing small intentional offsets.
const MIN_VISIBLE_TITLE_BAR_WIDTH = 64;
const MIN_VISIBLE_TITLE_BAR_HEIGHT = 16;
const WINDOW_EDGE_INSET = 100;

export interface RestorableWindowBounds extends Rectangle {
  isMaximized?: boolean;
}

function overlapLength(
  startA: number,
  lengthA: number,
  startB: number,
  lengthB: number
): number {
  return Math.max(
    0,
    Math.min(startA + lengthA, startB + lengthB) - Math.max(startA, startB)
  );
}

function hasUsableTitleBar(
  bounds: Rectangle,
  displayWorkAreas: Rectangle[]
): boolean {
  const titleBarHeight = Math.min(MAIN_WINDOW_TITLE_BAR_HEIGHT, bounds.height);
  const requiredWidth = Math.min(MIN_VISIBLE_TITLE_BAR_WIDTH, bounds.width);
  const requiredHeight = Math.min(MIN_VISIBLE_TITLE_BAR_HEIGHT, titleBarHeight);

  if (requiredWidth <= 0 || requiredHeight <= 0) return false;

  return displayWorkAreas.some(
    (workArea) =>
      overlapLength(bounds.x, bounds.width, workArea.x, workArea.width) >=
        requiredWidth &&
      overlapLength(bounds.y, titleBarHeight, workArea.y, workArea.height) >=
        requiredHeight
  );
}

export function restoreVisibleWindowBounds(
  bounds: RestorableWindowBounds,
  displayWorkAreas: Rectangle[],
  fallbackWorkArea: Rectangle
): RestorableWindowBounds {
  if (hasUsableTitleBar(bounds, displayWorkAreas)) return { ...bounds };

  const width = Math.min(Math.max(1, bounds.width), fallbackWorkArea.width);
  const height = Math.min(Math.max(1, bounds.height), fallbackWorkArea.height);

  return {
    ...bounds,
    x: Math.min(
      Math.max(bounds.x, fallbackWorkArea.x),
      fallbackWorkArea.x + fallbackWorkArea.width - width
    ),
    y: Math.min(
      Math.max(bounds.y, fallbackWorkArea.y),
      fallbackWorkArea.y + fallbackWorkArea.height - height
    ),
    width,
    height,
  };
}

export function cascadeWindowBounds(
  displayBounds: Rectangle,
  offset: number,
  size: Pick<Rectangle, "width" | "height">
): Rectangle {
  const { width, height } = size;
  let x = displayBounds.x + WINDOW_EDGE_INSET + offset;
  let y = displayBounds.y + WINDOW_EDGE_INSET + offset;

  if (x + width > displayBounds.x + displayBounds.width) {
    x = displayBounds.x + WINDOW_EDGE_INSET;
  }
  if (y + height > displayBounds.y + displayBounds.height) {
    y = displayBounds.y + WINDOW_EDGE_INSET;
  }

  return { x, y, width, height };
}
