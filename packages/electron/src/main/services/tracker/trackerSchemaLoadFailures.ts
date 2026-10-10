/**
 * Tracker type files in `.nimbalyst/trackers` that did not load, per workspace.
 * A type that fails to load is missing from the registry, so everything built
 * on it (a Local wiki table, its typed pages) would vanish with only a log
 * line. The Local wiki reads these to show the type as broken instead
 * (NIM-7437).
 */
import * as path from 'path';
import yaml from 'js-yaml';

export interface TrackerSchemaLoadFailure {
  /** The type the file declares, or the file name without its extension when it cannot be read. */
  typeId: string;
  /** Absolute path of the type file. */
  filePath: string;
  message: string;
}

const failures = new Map<string, Map<string, TrackerSchemaLoadFailure>>();
const listeners = new Set<(workspacePath: string) => void>();

function notify(workspacePath: string): void {
  for (const listener of listeners) listener(workspacePath);
}

/** The declared `type:` when the file is at least valid YAML; else the file name. */
function failedTypeId(filePath: string, content: string | null): string {
  if (content !== null) {
    try {
      const data = yaml.load(content) as { type?: unknown } | null;
      if (data && typeof data.type === 'string' && data.type) return data.type;
    } catch {
      // Not YAML at all; fall back to the file name.
    }
  }
  return path.basename(filePath).replace(/\.ya?ml$/, '');
}

export function recordTrackerSchemaLoadFailure(
  workspacePath: string,
  filePath: string,
  error: unknown,
  content: string | null = null,
): void {
  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0];
  const failure = { typeId: failedTypeId(filePath, content), filePath, message };
  const forWorkspace = failures.get(workspacePath) ?? new Map<string, TrackerSchemaLoadFailure>();
  const previous = forWorkspace.get(filePath);
  forWorkspace.set(filePath, failure);
  failures.set(workspacePath, forWorkspace);
  if (previous?.message !== failure.message || previous.typeId !== failure.typeId) notify(workspacePath);
}

export function clearTrackerSchemaLoadFailure(workspacePath: string, filePath: string): void {
  if (failures.get(workspacePath)?.delete(filePath)) notify(workspacePath);
}

/** Before a full directory load, which records every failure again. */
export function clearTrackerSchemaLoadFailures(workspacePath: string): void {
  const had = (failures.get(workspacePath)?.size ?? 0) > 0;
  failures.delete(workspacePath);
  if (had) notify(workspacePath);
}

export function getTrackerSchemaLoadFailures(workspacePath: string): TrackerSchemaLoadFailure[] {
  return [...(failures.get(workspacePath)?.values() ?? [])];
}

export function onTrackerSchemaLoadFailuresChanged(listener: (workspacePath: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
