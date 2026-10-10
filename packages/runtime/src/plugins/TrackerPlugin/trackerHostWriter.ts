/**
 * Records whose storage the host owns instead of the tracker services: on
 * desktop, the Local wiki's typed pages and table rows, which are files written
 * by `@nimbalyst/local-wiki`. The table and board write paths ask here first, so
 * an edit to such a record reaches its file instead of a database write that
 * cannot find it.
 */
import type { TrackerRecord } from '../../core/TrackerRecord';

export interface TrackerHostWriter {
  handles(item: TrackerRecord): boolean;
  /** Resolves true when written. On failure it tells the user itself and resolves false. */
  write(item: TrackerRecord, updates: Record<string, unknown>): Promise<boolean>;
}

let hostWriter: TrackerHostWriter | null = null;

export function setTrackerHostWriter(writer: TrackerHostWriter | null): void {
  hostWriter = writer;
}

/** The host writer for this record, or null when the tracker services own it. */
export function trackerHostWriterFor(item: TrackerRecord): TrackerHostWriter | null {
  return hostWriter?.handles(item) ? hostWriter : null;
}
