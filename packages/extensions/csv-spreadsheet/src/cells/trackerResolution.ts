/**
 * Demand-driven resolution of tracker keys found in `tracker` columns.
 *
 * RevoGrid's `cellTemplate` is Stencil hyperscript, not React, so the host's
 * `TrackerReferenceChip` cannot be mounted inside a cell. This store bridges the
 * two worlds using the pattern the grid already relies on for find highlights
 * and AI flashes: a mutable object the templates sample at paint time, plus an
 * explicit repaint when its contents change.
 *
 * Resolution is requested by the templates themselves rather than by scanning
 * the whole sheet, so only keys that actually get painted cost anything.
 */

/** What a painted tracker chip needs. */
export interface TrackerCellResolution {
  /** Internal tracker item id, used to navigate. */
  itemId: string;
  title: string;
  status?: string;
  type?: string;
}

export type TrackerResolutionListener = (keys: readonly string[]) => void;

export class TrackerResolutionStore {
  private resolutions = new Map<string, TrackerCellResolution | null>();
  private requested = new Set<string>();
  private flushHandle: ReturnType<typeof setTimeout> | null = null;
  private keysListener: TrackerResolutionListener | null = null;
  private repaint: (() => void) | null = null;
  private destroyed = false;

  /** Called with the full key set whenever a newly-seen key needs a resolver. */
  onKeysChanged(listener: TrackerResolutionListener | null): void {
    this.keysListener = listener;
  }

  /** Called when a resolution changes and painted cells are now stale. */
  onRepaintNeeded(repaint: (() => void) | null): void {
    this.repaint = repaint;
  }

  /**
   * Read a key's resolution for painting. Unknown keys are registered for
   * resolution and render as the bare key until one arrives.
   */
  read(key: string): TrackerCellResolution | null {
    if (!this.requested.has(key)) this.request(key);
    return this.resolutions.get(key) ?? null;
  }

  private request(key: string): void {
    if (this.destroyed || this.requested.has(key)) return;
    this.requested.add(key);
    // Batched: a first paint of a tracker column asks for every visible key in
    // the same tick, and one state update mounts all of their resolvers.
    if (this.flushHandle !== null) return;
    this.flushHandle = setTimeout(() => {
      this.flushHandle = null;
      if (this.destroyed) return;
      this.keysListener?.([...this.requested]);
    }, 0);
  }

  /**
   * Record a resolution. Repaints only when something a chip displays actually
   * changed, so a resolver re-running cannot drive a refresh loop.
   */
  setResolution(key: string, resolution: TrackerCellResolution | null): void {
    if (this.destroyed) return;
    const previous = this.resolutions.get(key);
    if (previous !== undefined && sameResolution(previous, resolution)) return;
    this.resolutions.set(key, resolution);
    this.repaint?.();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.flushHandle !== null) clearTimeout(this.flushHandle);
    this.flushHandle = null;
    this.keysListener = null;
    this.repaint = null;
    this.resolutions.clear();
    this.requested.clear();
  }
}

function sameResolution(a: TrackerCellResolution | null, b: TrackerCellResolution | null): boolean {
  if (a === null || b === null) return a === b;
  return a.itemId === b.itemId
    && a.title === b.title
    && a.status === b.status
    && a.type === b.type;
}

export type TrackerStatusTone =
  | 'to-do'
  | 'in-progress'
  | 'in-review'
  | 'completed'
  | 'blocked'
  | 'neutral';

/**
 * Map a raw workflow status onto the small set of tones the chip colors by.
 * Statuses are workspace-configurable, so this matches on substrings rather
 * than an exhaustive list and falls back to neutral.
 */
export function trackerStatusTone(status: string | undefined): TrackerStatusTone {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return 'neutral';
  if (normalized.includes('block')) return 'blocked';
  if (normalized.includes('review')) return 'in-review';
  if (normalized.includes('progress') || normalized.includes('doing')) return 'in-progress';
  if (
    normalized.includes('done')
    || normalized.includes('complete')
    || normalized.includes('closed')
    || normalized.includes('resolved')
  ) {
    return 'completed';
  }
  if (normalized.includes('todo') || normalized.includes('to-do') || normalized.includes('open')) {
    return 'to-do';
  }
  return 'neutral';
}
