import {
  PROJECT_TAB_DRAG_MIME,
  type ProjectTabDragPayload,
} from '../../shared/projectTabs';

export interface ProjectTabDragPoint {
  clientX: number;
  clientY: number;
  dropEffect?: string;
}

export interface ProjectTabStripBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ProjectTabPreparationResult {
  success: boolean;
  error?: string;
}

const PROJECT_TAB_PREPARATION_TIMEOUT_MS = 5_000;

/** Bound tear-out preparation so a hung editor save cannot stall forever. */
export async function waitForProjectTabPreparation(
  preparation: Promise<ProjectTabPreparationResult> | null,
  timeoutMs = PROJECT_TAB_PREPARATION_TIMEOUT_MS,
): Promise<ProjectTabPreparationResult | null> {
  if (!preparation) return null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        success: false,
        error: 'Timed out while saving the project before moving it.',
      });
    }, timeoutMs);
    void preparation.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        resolve({ success: false, error: error instanceof Error ? error.message : String(error) });
      },
    );
  });
}

export function serializeProjectTabDragPayload(payload: ProjectTabDragPayload): string {
  return JSON.stringify(payload);
}

export function parseProjectTabDragPayload(value: string): ProjectTabDragPayload | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<ProjectTabDragPayload>;
    if (
      candidate.version !== 1
      || typeof candidate.dragId !== 'string'
      || candidate.dragId.length === 0
    ) {
      return null;
    }
    return candidate as ProjectTabDragPayload;
  } catch {
    return null;
  }
}

export function hasProjectTabDragType(types: ArrayLike<string>): boolean {
  return Array.from(types).includes(PROJECT_TAB_DRAG_MIME);
}

/**
 * Return true only for a verified pointer release outside the tab strip.
 * Chromium reports (0, 0) for some cancelled/coordinate-less dragend events;
 * treating that sentinel as a tear-out would create surprise windows.
 */
export function shouldDetachProjectTabAfterDrag(
  point: ProjectTabDragPoint,
  strip: ProjectTabStripBounds,
  tolerance = 12,
): boolean {
  // A destination project rail accepted the drop. Its main-process move may
  // still be settling, so never race it by creating a third window here.
  if (point.dropEffect === 'move') return false;

  const coordinates = [
    point.clientX,
    point.clientY,
    strip.left,
    strip.right,
    strip.top,
    strip.bottom,
  ];
  if (!coordinates.every(Number.isFinite)) return false;
  if (point.clientX === 0 && point.clientY === 0) return false;

  return point.clientX < strip.left - tolerance
    || point.clientX > strip.right + tolerance
    || point.clientY < strip.top - tolerance
    || point.clientY > strip.bottom + tolerance;
}
